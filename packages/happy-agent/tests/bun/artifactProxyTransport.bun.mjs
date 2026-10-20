import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";

import { createAgentGym } from "../../../happy-agent-gym/sources/index.ts";

/**
 * The live artifact proxy through the real daemon on both of Bun's front doors: the standalone
 * Unix socket and the team TCP listener. Each admits the artifact's tunnel and enforces its
 * destination policy on the requests and tunnels inside it.
 */
let standalone;
let team;
let site;
let other;

function teamConfig() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const encoded = [
        { alg: "EdDSA", typ: "JWT" },
        {
            sub: "alice",
            iss: "https://artifacts.test",
            aud: "artifact-tests",
            exp: Math.floor(Date.now() / 1000) + 3600,
        },
    ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .join(".");
    return {
        config: `
[feature.team]
enabled = true
host = "127.0.0.1"
port = 0
authentication = "jwt"
owner_user_id = "alice"
[feature.team.jwt]
name = "Artifact test sign-in"
authorization_url = "https://artifacts.test/authorize"
token_url = "https://artifacts.test/token"
client_id = "artifact-tests"
issuer = "https://artifacts.test"
audience = "artifact-tests"
algorithms = ["EdDSA"]
public_key = """
${pem}"""
`,
        token: `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`,
    };
}

/** A gym whose model creates one live artifact at `url` when asked. */
async function liveArtifactGym(url, options = {}) {
    let pending = true;
    const gym = await createAgentGym({
        ...options,
        timeoutMs: 20_000,
        permissionMode: "full_access",
        inference: (request) => {
            if (!request.sessionId.startsWith("naming:") && pending) {
                pending = false;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_artifact",
                            arguments: { type: "html", title: "Preview", url },
                            callId: "liveartifact",
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    await gym.send("Show the preview.", { permissionMode: "full_access" });
    const artifact = await gym.waitUntil(
        async () => (await gym.client.listArtifacts()).artifacts[0],
        "the live artifact",
    );
    return { gym, artifactId: artifact.id };
}

beforeAll(async () => {
    const listen = async (server) => {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        return server;
    };
    site = await listen(
        createServer((request, response) => response.end(`site saw ${request.url}`)),
    );
    other = await listen(createServer((request, response) => response.end("other")));
    const url = `http://localhost:${site.address().port}/`;
    standalone = await liveArtifactGym(url);
    const credentials = teamConfig();
    team = await liveArtifactGym(url, {
        config: credentials.config,
        teamUser: { token: credentials.token, name: "Alice" },
    });
}, 60_000);

afterAll(async () => {
    for (const server of [site, other]) {
        server?.closeAllConnections();
        await new Promise((resolve) => (server === undefined ? resolve() : server.close(resolve)));
    }
    await standalone?.gym.dispose();
    await team?.gym.dispose();
});

/** Send a `CONNECT` as a fresh connection's first request; resolve with its answer and socket. */
async function attach(gym, path, authorization = `Bearer ${gym.token}`) {
    // A team client's URLs carry its listener's address; a standalone one speaks over the socket.
    const endpoint = new URL(gym.client.networkProxyUrl("host"));
    const socket =
        gym === team?.gym
            ? connect({ host: endpoint.hostname, port: Number(endpoint.port) })
            : connect(gym.socketPath);
    await once(socket, "connect");
    const answered = once(socket, "data");
    socket.write(
        `CONNECT ${path} HTTP/1.1\r\nHost: daemon\r\nAuthorization: ${authorization}\r\n\r\n`,
    );
    const [bytes] = await answered;
    return { socket, answer: bytes.toString("latin1") };
}

async function readAll(socket) {
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString()));
    await new Promise((resolve) => {
        socket.once("end", resolve);
        socket.once("close", resolve);
    });
    return text;
}

async function request(gym, path, target) {
    const { socket, answer } = await attach(gym, path);
    expect(answer).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    const reply = readAll(socket);
    socket.write(`GET ${target} HTTP/1.1\r\nHost: preview\r\nConnection: close\r\n\r\n`);
    return await reply;
}

async function nested(gym, path, authority) {
    const { socket, answer } = await attach(gym, path);
    expect(answer).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    const answered = once(socket, "data");
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const [bytes] = await answered;
    socket.destroy();
    return bytes.toString("latin1");
}

for (const [name, running] of [
    ["the standalone socket", () => standalone],
    ["the team listener", () => team],
]) {
    test(`${name} admits an artifact's tunnel and enforces its destination policy`, async () => {
        const { gym, artifactId } = running();
        const path = `/v0/artifacts/${artifactId}/proxy`;
        const port = site.address().port;
        expect(await request(gym, path, `http://localhost:${port}/page`)).toContain(
            "site saw /page",
        );
        for (const target of [
            `http://localhost:${other.address().port}/`,
            `http://127.0.0.1:${port}/`,
            "http://10.0.0.1/",
            "http://169.254.169.254/",
        ])
            expect(await request(gym, path, target)).toStartWith("HTTP/1.1 403 ");
        expect(await nested(gym, path, `localhost:${port}`)).toStartWith("HTTP/1.1 200 ");
        expect(await nested(gym, path, `localhost:${other.address().port}`)).toStartWith(
            "HTTP/1.1 403 ",
        );

        const unauthorized = await attach(gym, path, "Bearer not-the-token");
        unauthorized.socket.destroy();
        expect(unauthorized.answer).toStartWith("HTTP/1.1 401 ");
        for (const artifactId of ["missingartifact", "Not-An-Id", "1artifact"]) {
            const missing = await attach(gym, `/v0/artifacts/${artifactId}/proxy`);
            missing.socket.destroy();
            expect(missing.answer).toStartWith("HTTP/1.1 404 ");
        }
        const stranger = await attach(gym, "/v0/artifacts/Not-An-Id/proxy", "Bearer not-the-token");
        stranger.socket.destroy();
        expect(stranger.answer).toStartWith("HTTP/1.1 401 ");
    }, 30_000);
}
