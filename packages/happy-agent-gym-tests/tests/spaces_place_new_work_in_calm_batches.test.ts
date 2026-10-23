import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("applies one factual calm batch while legacy row actions stay independent", async () => {
    const h = await sidebarGym();
    try {
        const legacy = await h.gym.http.ok<{
            spaces: { id: string; target: { agentId: string } }[];
            sections: unknown[];
        }>("GET", "/v0/spaces");
        const happy = legacy.spaces[0]!;
        expect((await h.gym.client.getAgent(happy.target.agentId)).agent.subtasks).toEqual([]);
        await h.read();
        const created = await h.create();
        await h.hold();
        await h.gym.send("Plan this release.", { sessionId: created.agent.id });
        const current = await h.read();
        const node = `  <happy-space id="${created.space.id}"/>
`;
        const placed = current.html.replace(node, "").replace(
            "</nav>",
            `  <happy-section id="release" label="Releases"/>
${node}</nav>`,
        );
        expect((await h.edit(placed)).text).toContain("queued");
        expect((await h.read()).html).toBe(current.html);
        expect(
            (await h.gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
        ).toEqual([]);
        await h.calm();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === placed ? true : undefined),
            "the calm placement",
        );
        const batches = await h.gym.http.ok<{ batches: { note: string; noteMessageId: string }[] }>(
            "GET",
            "/v0/spaces/batches",
        );
        expect(batches.batches).toHaveLength(1);
        expect(batches.batches[0]!.note).toMatch(/^Put .+ in Releases\.$/);
        const notes = (
            await h.gym.http.ok<{ runs: { messages: { id: string }[] }[] }>(
                "GET",
                `/v0/agents/${happy.target.agentId}/messages`,
            )
        ).runs.flatMap((run) => run.messages);
        expect(notes.map((note) => note.id)).toEqual([batches.batches[0]!.noteMessageId]);
        const snapshot = await h.gym.http.ok<typeof legacy>("GET", "/v0/spaces");
        expect(snapshot.sections).toEqual(legacy.sections);
        await h.gym.http.ok("PATCH", `/v0/spaces/${created.space.id}`, { visibility: "folded" });
        expect((await h.read()).html).toBe(placed);
        await h.gym.http.ok("PATCH", `/v0/spaces/${created.space.id}`, { visibility: "shown" });
        expect((await h.gym.http.patch(`/v0/spaces/${happy.id}`, {})).status).toBe(400);
        expect(
            (await h.gym.http.patch(`/v0/spaces/${created.space.id}`, { removed: true })).status,
        ).toBe(409);
        expect(
            (await h.gym.http.patch(`/v0/spaces/${happy.id}`, { afterId: happy.id })).status,
        ).toBe(409);
        const tools = h.gym.inference.requests
            .findLast((request) => request.instructions.includes("You are Prioritizing"))!
            .tools.map((tool) => tool.name)
            .sort();
        expect(tools).toEqual([
            "edit_sidebar",
            "get_sidebar_styles",
            "list_sidebar",
            "read_artifact",
            "read_artifact_file",
            "read_row_conversation",
            "set_space_icon",
            "update_artifact",
        ]);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
