import { once } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("restricts live artifact connections and applies the current URL to the next connection", async () => {
    let command: GymTurn | undefined;
    const gym = await createAgentGym({
        permissionMode: "full_access",
        inference: (input) => {
            if (!input.sessionId.startsWith("naming:") && command !== undefined) {
                const next = command;
                command = undefined;
                return next;
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    cleanups.push(() => gym.dispose());
    let calls = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
        const callId = `artifactproxy${++calls}`;
        command = { content: [{ type: "tool_call", name, arguments: args, callId }] };
        await gym.send(`Run ${name} for this page.`, { permissionMode: "full_access" });
        await gym.waitUntil(
            async () => gym.inference.toolResults().find((result) => result.callId === callId),
            "the artifact tool result",
        );
    };
    const first = await site("first site");
    const second = await site("second site");
    await call("create_artifact", {
        type: "html",
        title: "Local preview",
        url: `http://localhost:${first}/`,
    });
    const artifact = (await gym.client.listArtifacts()).artifacts[0]!;
    const open = () => attach(gym, artifact.id);

    const tunnel = await open();
    expect(tunnel.status).toBe(200);
    expect(
        await exchange(
            tunnel.socket,
            `GET http://localhost:${first}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        ),
    ).toMatchObject({ status: 200, body: "first site" });

    for (const target of [`localhost:${second}`, `127.0.0.1:${first}`]) {
        const denied = await open();
        expect(
            await exchange(denied.socket, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
        ).toMatchObject({ status: 403 });
    }

    // The route is not a policy snapshot: this same outer tunnel now allows the new origin.
    await call("update_artifact", { artifactId: artifact.id, url: `http://localhost:${second}/` });
    expect(
        await exchange(
            tunnel.socket,
            `GET http://localhost:${second}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        ),
    ).toMatchObject({ status: 200, body: "second site" });
    expect(
        await exchange(
            tunnel.socket,
            `GET http://localhost:${first}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        ),
    ).toMatchObject({ status: 403 });

    await call("update_artifact", { artifactId: artifact.id, url: `http://127.0.0.1:${first}/` });
    const alias = await open();
    expect(
        await exchange(
            alias.socket,
            `CONNECT 2130706433:${first} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        ),
    ).toMatchObject({ status: 403 });

    await call("update_artifact", { artifactId: artifact.id, url: "http://169.254.169.254/" });
    for (const line of [
        "CONNECT 169.254.169.254:80 HTTP/1.1",
        "GET http://169.254.169.254/ HTTP/1.1",
    ]) {
        const denied = await open();
        expect(
            await exchange(denied.socket, `${line}\r\nHost: 169.254.169.254\r\n\r\n`),
        ).toMatchObject({ status: 403 });
    }
    const beforeDelete = await open();
    const current = (await gym.client.getArtifact(artifact.id)).artifact;
    await gym.client.deleteArtifact(artifact.id, { ifMatch: current.version });
    expect(
        await exchange(
            beforeDelete.socket,
            `CONNECT localhost:${first} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        ),
    ).toMatchObject({ status: 403 });
    expect((await open()).status).toBe(404);
    expect((await attach(gym, "missingartifact")).status).toBe(404);
    const file = (
        await gym.client.createArtifact({
            type: "html",
            title: "Files",
            files: [{ path: "index.html", text: "<p>Files</p>" }],
        })
    ).artifact;
    expect((await attach(gym, file.id)).status).toBe(404);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
});

it("answers a malformed artifact ID 404 after authentication and admits no nested path", async () => {
    const gym = await createAgentGym({ inference: [] });
    cleanups.push(() => gym.dispose());
    for (const artifactId of ["Not-An-Id", "1artifact", "artifact_one", "%61rtifact", ""])
        expect(await attachPath(gym, `/v0/artifacts/${artifactId}/proxy`), artifactId).toEqual({
            status: 404,
            code: "not_found",
        });
    // Authentication is checked before the ID, so a malformed ID reveals nothing to a stranger.
    expect(await attachPath(gym, "/v0/artifacts/Not-An-Id/proxy", "wrong-token")).toMatchObject({
        status: 401,
    });
    // Only one path segment names the artifact; deeper or different paths are not this route.
    for (const path of [
        "/v0/artifacts/artifactone/files/proxy",
        "/v0/artifacts/artifactone/proxy/extra",
        "/v0/artifacts/a/b/proxy",
    ])
        expect((await attachPath(gym, path)).status, path).not.toBe(200);
    expect(gym.machineConnections).toEqual([]);
    expect(gym.errors).toEqual([]);
});

/** Attach to a raw proxy path, answering its status and error code, or `0` when it was dropped. */
function attachPath(
    gym: AgentGym,
    path: string,
    token = gym.token,
): Promise<{ status: number; code?: string }> {
    return new Promise((resolve, reject) => {
        const call = request({
            socketPath: gym.socketPath,
            method: "CONNECT",
            path,
            headers: { authorization: `Bearer ${token}` },
        });
        call.once("error", (error: NodeJS.ErrnoException) =>
            error.code === "ECONNRESET" ? resolve({ status: 0 }) : reject(error),
        );
        call.once("connect", (response, socket, head) => {
            let body = head.toString();
            socket.on("data", (chunk: Buffer) => (body += chunk.toString()));
            const done = () => {
                socket.destroy();
                const code = /"code":"([a-z_]+)"/u.exec(body)?.[1];
                resolve({ status: response.statusCode!, ...(code === undefined ? {} : { code }) });
            };
            if (response.statusCode === 200) return done();
            socket.once("end", done);
            socket.once("close", done);
        });
        call.setTimeout(10_000, () =>
            call.destroy(new Error("The artifact proxy did not answer.")),
        );
        call.end();
    });
}

it("keeps an established destination stream open when the live URL changes", async () => {
    const first = await site("established site");
    const second = await site("new site");
    let command: GymTurn | undefined = {
        content: [
            {
                type: "tool_call",
                name: "create_artifact",
                arguments: {
                    type: "html",
                    title: "Live stream",
                    url: `http://localhost:${first}/`,
                },
                callId: "createheldartifact",
            },
        ],
    };
    const gym = await createAgentGym({
        permissionMode: "full_access",
        inference: (input) => {
            if (!input.sessionId.startsWith("naming:") && command !== undefined) {
                const next = command;
                command = undefined;
                return next;
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    cleanups.push(() => gym.dispose());
    await gym.send("Create the live page.", { permissionMode: "full_access" });
    await gym.waitUntil(
        async () =>
            gym.inference.toolResults().find((result) => result.callId === "createheldartifact"),
        "the live page",
    );
    const artifact = (await gym.client.listArtifacts()).artifacts[0]!;
    const held = await attach(gym, artifact.id);
    expect(
        await exchange(
            held.socket,
            `CONNECT localhost:${first} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        ),
    ).toMatchObject({ status: 200 });
    command = {
        content: [
            {
                type: "tool_call",
                name: "update_artifact",
                arguments: { artifactId: artifact.id, url: `http://localhost:${second}/` },
                callId: "updateheldartifact",
            },
        ],
    };
    await gym.send("Update the live page URL.", { permissionMode: "full_access" });
    await gym.waitUntil(
        async () =>
            gym.inference.toolResults().find((result) => result.callId === "updateheldartifact"),
        "the changed URL",
    );
    expect(await exchange(held.socket, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")).toMatchObject({
        status: 200,
        body: "established site",
    });
    const next = await attach(gym, artifact.id);
    expect(
        await exchange(
            next.socket,
            `CONNECT localhost:${first} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        ),
    ).toMatchObject({ status: 403 });
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
});

async function site(body: string): Promise<number> {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "content-length": Buffer.byteLength(body) });
        response.end(body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return (server.address() as AddressInfo).port;
}

function attach(gym: AgentGym, artifactId: string): Promise<{ status: number; socket: Socket }> {
    return new Promise((resolve, reject) => {
        const call = request({
            socketPath: gym.socketPath,
            method: "CONNECT",
            path: new URL(gym.client.artifactProxyUrl(artifactId)).pathname,
            headers: { authorization: `Bearer ${gym.token}` },
        });
        call.once("error", reject);
        call.once("connect", (response, socket, head) => {
            cleanups.push(() => void socket.destroy());
            if (head.length > 0) socket.unshift(head);
            resolve({ status: response.statusCode!, socket });
        });
        call.setTimeout(10_000, () =>
            call.destroy(new Error("The artifact proxy did not answer.")),
        );
        call.end();
    });
}

/** Transport only: send one request on the outer tunnel and read its bounded HTTP response. */
function exchange(socket: Socket, request: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        const finish = (error?: Error) => {
            socket.off("data", data);
            socket.off("end", ended);
            socket.off("error", finish);
            if (error !== undefined) reject(error);
        };
        const ended = () => finish(new Error("The proxy closed before its response."));
        const data = (chunk: Buffer) => {
            bytes = Buffer.concat([bytes, chunk]);
            if (bytes.length > 64 * 1024) return finish(new Error("Oversized proxy response."));
            const end = bytes.indexOf("\r\n\r\n");
            if (end < 0) return;
            const headers = bytes.subarray(0, end).toString();
            const length = Number(/content-length: (\d+)/i.exec(headers)?.[1] ?? 0);
            if (bytes.length < end + 4 + length) return;
            finish();
            resolve({
                status: Number(headers.split(" ")[1]),
                body: bytes.subarray(end + 4, end + 4 + length).toString(),
            });
        };
        socket.on("data", data);
        socket.once("end", ended);
        socket.once("error", finish);
        socket.write(request);
    });
}
