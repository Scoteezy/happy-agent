import { createAgentGym, frameEvent, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

it("keeps queued HTML when ordinary artifact tools change only metadata", async () => {
    const h = await sidebarGym();
    try {
        const initial = await h.read();
        const html = initial.html.replace(
            "</nav>",
            '<p class="note">Keep this queued HTML</p></nav>',
        );
        await h.hold();
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: initial.version,
                    edits: [
                        {
                            oldText: "</nav>",
                            newText: '<p class="note">Keep this queued HTML</p></nav>',
                        },
                    ],
                })
            ).text,
        ).toContain("queued");
        expect(
            (
                await h.call("update_artifact", {
                    artifactId: initial.artifactId,
                    baseVersion: initial.version + 1,
                    title: "Renamed sidebar",
                    background: "#ABC",
                })
            ).text,
        ).toContain("proposal accepted");
        expect((await h.read()).version).toBe(initial.version);
        await h.calm();
        const applied = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.version === initial.version + 2 ? doc : undefined;
        }, "both artifact versions");
        expect(applied.html).toBe(html);
        expect((await h.gym.client.getArtifact(initial.artifactId)).artifact).toMatchObject({
            title: "Renamed sidebar",
            background: "#abc",
        });
        expect(
            (await h.gym.client.listArtifactVersions(initial.artifactId)).versions.map(
                (version) => version.title,
            ),
        ).toEqual(["Renamed sidebar", "Sidebar", "Sidebar"]);
        await h.hold();
        await h.call("update_artifact", {
            artifactId: initial.artifactId,
            baseVersion: applied.version,
            title: "Sidebar final",
        });
        await h.calm();
        await h.gym.waitUntil(
            async () => ((await h.read()).version === applied.version + 1 ? true : undefined),
            "the metadata-only version",
        );
        expect((await h.read()).html).toBe(html);
        expect(
            (await h.gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
        ).toHaveLength(2);
    } finally {
        await h.gym.dispose();
    }
}, 120000);

const running = new Set<AgentGym>();

it("lets Tidy move untouched rows after the person drags one row above them", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const redesign = await h.create();
        const lightbox = await h.create();
        const table = await h.create();
        const later = await h.create();
        const node = (id: string) => `<happy-space ref="${id}" tree></happy-space>`;
        await h.hold();
        const initial = await h.read();
        const happy = initial.spaces.find((space) => space.title === "Happy")!;
        const layout = (ids: string[]) =>
            `<nav>${node(happy.id)}${ids.map(node).join("")}<happy-section id="desktop" label="Desktop"></happy-section></nav>`;
        const arranged = layout([
            redesign.space.id,
            lightbox.space.id,
            table.space.id,
            later.space.id,
        ]);
        expect((await h.edit(arranged)).text).toContain("queued");
        await h.calm();
        const seeded = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.html === arranged ? doc : undefined;
        }, "Prioritizing's initial arrangement");
        await h.hold();
        const dragged = layout([
            table.space.id,
            redesign.space.id,
            lightbox.space.id,
            later.space.id,
        ]);
        const current = await h.gym.http.ok<Sidebar>("PUT", "/v0/spaces/sidebar", {
            html: dragged,
            baseVersion: seeded.version,
            mutationId: "drag-table-above-redesign",
        });
        expect(JSON.parse((await h.call("list_sidebar", {})).text)).toMatchObject({
            manualSpaceIds: [table.space.id],
        });
        const tidy = dragged
            .replace(node(lightbox.space.id), "")
            .replace('label="Desktop">', `label="Desktop">${node(lightbox.space.id)}`);
        expect((await h.edit(tidy)).text).toContain("queued");
        await h.calm();
        const applied = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.version === current.version + 1 ? doc : undefined;
        }, "Tidy moving the untouched Lightbox row");
        expect(applied.html).toBe(tidy);
        await h.hold();
        const undoDrag = tidy
            .replace(node(table.space.id), "")
            .replace('label="Desktop">', `label="Desktop">${node(table.space.id)}`);
        expect((await h.edit(undoDrag)).text).toContain("manual placement");
    } finally {
        await h.gym.dispose();
    }
}, 120000);

it("keeps each person's sidebar references and ordinary writes owner-authorized", async () => {
    const { gym, alice, bob, aliceHttp, bobHttp } = await surfaceTeamClients({
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    running.add(gym);
    const own = await aliceHttp.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const other = await bobHttp.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    expect(own.artifactId).not.toBe(other.artifactId);
    const resource = (await alice.getArtifact(own.artifactId)).artifact;
    const change = {
        baseVersion: own.version,
        files: [
            { path: "index.html", text: own.html.replace("</nav>", "<p>Unauthorized</p></nav>") },
        ],
    };
    await expect(
        bob.updateArtifact(own.artifactId, change, { ifMatch: resource.version }),
    ).rejects.toMatchObject({ status: 404 });
    const unknown = await bobHttp.request("PUT", "/v0/spaces/sidebar", {
        baseVersion: other.version,
        mutationId: "other-ref",
        html: other.html.replace(
            "</nav>",
            `<happy-space ref="${own.spaces[0]!.id}"></happy-space></nav>`,
        ),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toHaveProperty("diagnostics");
    expect((await aliceHttp.ok<Sidebar>("GET", "/v0/spaces/sidebar")).html).toBe(own.html);
}, 120000);
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});
type Sidebar = {
    artifactId: string;
    version: number;
    html: string;
    spaces: { id: string; title: string | null; target: { id: string; agentId: string | null } }[];
};
type StemCell = { space: { id: string; target: { id: string } }; agent: { id: string } };

it("validates every write, preserves CAS, replays mutations and persists sidebar versions", async () => {
    const gym = await createAgentGym({
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    running.add(gym);
    const get = () => gym.http.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const initial = await get();
    const html = initial.html.replace("</nav>", '<p class="note">Shared work</p></nav>');
    const body = { html, baseVersion: initial.version, mutationId: "first-document".repeat(50) };
    const committed = await gym.http.ok<Sidebar>("PUT", "/v0/spaces/sidebar", body);
    expect(committed.version).toBe(initial.version + 1);
    expect(await gym.http.ok("PUT", "/v0/spaces/sidebar", body)).toMatchObject({
        version: committed.version,
        html,
    });
    const retries = await Promise.all(
        Array.from({ length: 3 }, () => gym.http.ok<Sidebar>("PUT", "/v0/spaces/sidebar", body)),
    );
    expect(retries.map((document) => document.version)).toEqual([
        committed.version,
        committed.version,
        committed.version,
    ]);
    expect(
        (await gym.http.request("PUT", "/v0/spaces/sidebar", { ...body, mutationId: "stale" }))
            .status,
    ).toBe(409);
    const mismatch = await gym.http.request("PUT", "/v0/spaces/sidebar", {
        ...body,
        html: initial.html,
    });
    expect(mismatch.status).toBe(409);
    for (const invalid of [
        "<nav><script>alert(1)</script></nav>",
        '<nav><happy-space ref="unknown"></happy-space></nav>',
    ]) {
        const response = await gym.http.request("PUT", "/v0/spaces/sidebar", {
            html: invalid,
            baseVersion: committed.version,
            mutationId: "invalid",
        });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            diagnostics: [{ offset: expect.any(Number), message: expect.any(String) }],
        });
    }
    const artifact = (await gym.client.getArtifact(initial.artifactId)).artifact;
    const ordinary = {
        baseVersion: committed.version,
        files: [{ path: "index.html", text: "<nav><script></script></nav>" }],
    };
    await expect(
        gym.client.updateArtifact(initial.artifactId, ordinary, { ifMatch: artifact.version }),
    ).rejects.toMatchObject({ status: 400, body: { diagnostics: expect.any(Array) } });
    const extraFile = {
        baseVersion: committed.version,
        files: [{ path: "extra.html", text: "<p>extra</p>" }],
    };
    await expect(
        gym.client.updateArtifact(initial.artifactId, extraFile, { ifMatch: artifact.version }),
    ).rejects.toMatchObject({ status: 400, body: { diagnostics: expect.any(Array) } });
    expect((await get()).html).toBe(html);
    await gym.restart();
    expect(await get()).toMatchObject({
        artifactId: initial.artifactId,
        version: committed.version,
        html,
    });
    expect((await gym.client.listArtifactVersions(initial.artifactId)).versions).toHaveLength(2);
}, 120_000);

it("guards manual and recent placements, versions each edit once, and briefs observations at calm", async () => {
    let command: { token: string; name: string; arguments: unknown } | undefined;
    let index = 0;
    const gym = await createAgentGym({
        timeoutMs: 30000,
        inference: (request) => {
            if (
                command !== undefined &&
                request.instructions.includes("You are Prioritizing") &&
                request.messages.at(-1)?.role === "user" &&
                JSON.stringify(request.messages.at(-1)).includes(command.token)
            ) {
                const next = command;
                command = undefined;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: next.name,
                            arguments: next.arguments,
                            callId: next.token,
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    running.add(gym);
    const get = () => gym.http.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const initial = await get();
    const manager = await gym.waitUntil(
        () =>
            gym.inference.requests.find((request) =>
                request.instructions.includes("You are Prioritizing"),
            )?.sessionId,
        "Prioritizing's opening turn",
    );
    const call = async (name: string, args: unknown) => {
        const token = `sidebar_guard_${++index}`;
        command = { token, name, arguments: args };
        await gym.send(`Execute sidebar request ${token}.`, { sessionId: manager });
        return await gym.waitUntil(
            () => gym.inference.toolResults().find((result) => result.callId === token),
            "the sidebar tool result",
        );
    };
    await gym.http.ok("PUT", "/v0/spaces/sidebar", {
        html: initial.html.replace(
            "</nav>",
            '<happy-section id="desktop" label="Desktop"></happy-section></nav>',
        ),
        baseVersion: initial.version,
        mutationId: "manual-section",
    });
    const manual = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {
        sectionId: "desktop",
    });
    await gym.http.ok("POST", "/v0/spaces/attention", { state: "interacting" });
    let current = await get();
    const manualNode = `<happy-space ref="${manual.space.id}" tree></happy-space>`;
    expect(
        (
            await call("edit_sidebar", {
                baseVersion: current.version,
                edits: [
                    {
                        oldText: manualNode,
                        newText: `<happy-section id="moved" label="Moved">${manualNode}</happy-section>`,
                    },
                ],
            })
        ).text,
    ).toContain("manual placement");
    const happyNode = `<happy-space ref="${initial.spaces.find((row) => row.title === "Happy")!.id}" tree></happy-space>`;
    expect(
        (
            await call("edit_sidebar", {
                baseVersion: current.version,
                edits: [
                    {
                        oldText: happyNode,
                        newText: `<happy-section id="moved" label="Moved">${happyNode}</happy-section>`,
                    },
                ],
            })
        ).text,
    ).toContain("Happy");
    expect(
        (
            await call("edit_sidebar", {
                baseVersion: current.version - 1,
                edits: [{ oldText: "</nav>", newText: "<p>stale</p></nav>" }],
            })
        ).text,
    ).toContain("sidebar changed");
    expect((await get()).version).toBe(current.version);
    const pending = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {});
    current = await get();
    const pendingNode = `<happy-space ref="${pending.space.id}" tree></happy-space>`;
    expect(
        (
            await call("edit_sidebar", {
                baseVersion: current.version,
                edits: [
                    {
                        oldText: pendingNode,
                        newText: `<happy-section id="release" label="Release">${pendingNode}</happy-section>`,
                    },
                ],
            })
        ).text,
    ).toContain("queued");
    await gym.http.ok("POST", "/v0/spaces/attention", { state: "calm" });
    await gym.waitUntil(
        async () => ((await get()).version > current.version ? true : undefined),
        "the initial placement",
    );
    await gym.send("Continue this work.", { sessionId: pending.agent.id });
    await gym.http.ok("POST", "/v0/spaces/attention", { state: "interacting" });
    current = await get();
    expect(
        (
            await call("edit_sidebar", {
                baseVersion: current.version,
                edits: [
                    {
                        oldText: `<happy-section id="release" label="Release">${pendingNode}</happy-section>`,
                        newText: pendingNode,
                    },
                ],
            })
        ).text,
    ).toContain("last two hours");
    expect((await call("read_artifact", { artifactId: current.artifactId })).text).toContain(
        current.html,
    );
    expect(
        (
            await call("edit_sidebar", {
                baseVersion: current.version,
                edits: [{ oldText: "</nav>", newText: '<p class="note">First</p></nav>' }],
            })
        ).text,
    ).toContain("queued");
    expect(
        (
            await call("edit_sidebar", {
                baseVersion: current.version + 1,
                edits: [{ oldText: "</nav>", newText: '<p class="muted">Second</p></nav>' }],
            })
        ).text,
    ).toContain("queued");
    expect((await get()).version).toBe(current.version);
    await gym.http.ok("POST", "/v0/spaces/sidebar/observations", {
        visibleSpaceIds: [manual.space.id],
        collapsed: ["release"],
    });
    await gym.http.ok("POST", "/v0/spaces/attention", { state: "calm" });
    const applied = await gym.waitUntil(async () => {
        const doc = await get();
        return doc.version === current.version + 2 ? doc : undefined;
    }, "one version per accepted call");
    expect(applied.html).toContain('<p class="note">First</p><p class="muted">Second</p>');
    expect(
        (await gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
    ).toHaveLength(2);
    await gym.waitUntil(
        () =>
            gym.inference.requests.some(
                (request) =>
                    request.instructions.includes("You are Prioritizing") &&
                    JSON.stringify(request.messages.at(-1)).includes("visibleSpaceIds") &&
                    JSON.stringify(request.messages.at(-1)).includes(manual.space.id),
            )
                ? true
                : undefined,
        "the coalesced visibility brief",
    );
}, 120_000);

it("inserts a section stem cell at its authored start and removes archived nodes with children promoted", async () => {
    const gym = await createAgentGym({
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    running.add(gym);
    const get = () => gym.http.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const initial = await get();
    const html = initial.html.replace(
        "</nav>",
        '<happy-section id="desktop" label="Desktop"><p class="note">Existing note</p></happy-section></nav>',
    );
    await gym.http.ok("PUT", "/v0/spaces/sidebar", {
        html,
        baseVersion: initial.version,
        mutationId: "section",
    });
    const created = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {
        sectionId: "desktop",
    });
    const document = await get();
    const node = `<happy-space ref="${created.space.id}" tree></happy-space>`;
    expect(document.html).toContain(`label="Desktop">\n${node}<p`);
    expect((await gym.http.post("/v0/spaces/stem-cells", { sectionId: "missing" })).status).toBe(
        404,
    );
    await gym.http.ok("PUT", "/v0/spaces/sidebar", {
        html: document.html.replace(
            node,
            node.replace("</happy-space>", '<p class="note">Keep after archive</p></happy-space>'),
        ),
        baseVersion: document.version,
        mutationId: "children",
    });
    const task = (await gym.client.getTask(created.space.target.id)).task;
    await gym.client.archiveTask(task.id, { ifMatch: task.version });
    const archived = await gym.waitUntil(async () => {
        const doc = await get();
        return doc.html.includes(created.space.id) ? undefined : doc;
    }, "archive removal from the document");
    expect(archived.html).toContain('<p class="note">Keep after archive</p>');
    expect(
        (await gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
    ).toEqual([]);
}, 120_000);

it("Prioritizing authors Release with one edit and one live Happy note while preserving Desktop +", async () => {
    let latest: Sidebar | undefined;
    let target: string | undefined;
    let edited = false;
    const gym = await createAgentGym({
        timeoutMs: 30000,
        inference: (request) => {
            if (!request.instructions.includes("You are Prioritizing"))
                return { content: [{ type: "text", text: "Done." }] };
            const last = request.messages.at(-1);
            const text = JSON.stringify(last);
            if (
                last?.role === "user" &&
                target !== undefined &&
                text.includes(`New work started in row ${target}`)
            )
                return { content: [{ type: "tool_call", name: "list_sidebar", arguments: {} }] };
            if (
                last?.role === "tool" &&
                text.includes("artifactId") &&
                latest !== undefined &&
                target !== undefined &&
                !edited
            ) {
                edited = true;
                const node = `<happy-space ref="${target}" tree></happy-space>`;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "edit_sidebar",
                            arguments: {
                                baseVersion: latest.version,
                                edits: [
                                    {
                                        oldText: node,
                                        newText: `<happy-section id="release" label="Release">${node}</happy-section>`,
                                    },
                                ],
                            },
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    running.add(gym);
    const get = () => gym.http.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const initial = await get();
    const happy = initial.spaces.find((space) => space.title === "Happy")!;
    await gym.http.ok("PUT", "/v0/spaces/sidebar", {
        html: initial.html.replace(
            "</nav>",
            '<happy-section id="desktop" label="Desktop"></happy-section></nav>',
        ),
        baseVersion: initial.version,
        mutationId: "desktop",
    });
    const manual = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {
        sectionId: "desktop",
    });
    const created = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {});
    target = created.space.id;
    const task = (await gym.client.getTask(created.space.target.id)).task;
    await gym.client.renameTask(
        task.id,
        { name: "Windows installer signing" },
        { ifMatch: task.version },
    );
    latest = await get();
    await gym.http.ok("POST", "/v0/spaces/attention", { state: "interacting" });
    const stream = gym.stream("/v0/events/stream");
    try {
        await stream.opened();
        await gym.send("Help with Windows installer signing.", { sessionId: created.agent.id });
        await gym.waitUntil(() => (edited ? true : undefined), "the manager's edit_sidebar call");
        await gym.waitUntil(
            () =>
                gym.inference.requests.some(
                    (request) =>
                        request.instructions.includes("You are Prioritizing") &&
                        JSON.stringify(request.messages.at(-1)).includes(
                            "queued for the next calm batch",
                        ),
                )
                    ? true
                    : undefined,
            "the queued exact edit",
        );
        expect((await get()).version).toBe(latest.version);
        await gym.http.ok("POST", "/v0/spaces/attention", { state: "calm" });
        const placed = await gym.waitUntil(async () => {
            const doc = await get();
            return doc.html.includes('id="release"') ? doc : undefined;
        }, "Release placement");
        expect(placed.version).toBe(latest.version + 1);
        expect(placed.html).toContain(
            `id="release" label="Release"><happy-space ref="${target}" tree></happy-space>`,
        );
        expect(placed.html).toContain(
            `id="desktop" label="Desktop">\n<happy-space ref="${manual.space.id}" tree></happy-space>`,
        );
        const batches = (
            await gym.http.ok<{ batches: { note: string; noteMessageId: string }[] }>(
                "GET",
                "/v0/spaces/batches",
            )
        ).batches;
        expect(batches).toHaveLength(1);
        expect(batches[0]!.note).toBe("Put Windows installer signing in Release.");
        await stream.waitFor((frame) => {
            const event = frameEvent(frame);
            return (
                event?.type === "message.created" &&
                JSON.stringify(event.payload).includes(batches[0]!.noteMessageId)
            );
        });
        const notes = (
            await gym.http.ok<{ runs: { messages: { id: string }[] }[] }>(
                "GET",
                `/v0/agents/${happy.target.agentId}/messages`,
            )
        ).runs.flatMap((run) => run.messages);
        expect(notes.map((message) => message.id)).toEqual([batches[0]!.noteMessageId]);
        expect(
            (await gym.sessionEvents(happy.target.agentId!)).filter(
                (event) => event.type === "run.finished",
            ),
        ).toHaveLength(1);
        const tools = gym.inference.requests
            .findLast((request) => request.instructions.includes("You are Prioritizing"))!
            .tools.map((tool) => tool.name);
        expect(tools).toContain("edit_sidebar");
        expect(tools).not.toContain("place_space");
    } finally {
        stream.close();
    }
}, 120_000);
