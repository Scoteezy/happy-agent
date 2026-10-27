import { runGymSql } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;
const under = (parent: string, child: string) =>
    `  <happy-space id="${parent}">\n    <happy-space id="${child}"/>\n  </happy-space>\n`;

it("lets Focus take out its own top-level row and live under Happy, tells it once after an update, and keeps a row the person placed", async () => {
    const h = await sidebarGym();
    try {
        const first = await h.read();
        const focus = await h.manager();
        const happy = first.spaces.find((row) => row.title === "Happy")!;
        const own = first.spaces.find((row) => row.target.agentId === focus)!;
        // An older Focus put a row of its own right after Happy, as Kirill's sidebar still has.
        await h.call("edit_sidebar", {
            baseVersion: first.version,
            edits: [{ oldText: line(happy.id), newText: `${line(happy.id)}${line(own.id)}` }],
        });
        await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.html.includes(`${line(happy.id)}${line(own.id)}`) ? true : undefined;
        }, "Focus's old row under Happy");
        await h.settle();
        await h.unseed();
        await h.settle();

        // Taking out its own row and showing its conversation under Happy needs no proposal.
        const shown = await h.read();
        const moved = await h.call("edit_sidebar", {
            baseVersion: shown.version,
            edits: [
                { oldText: `${line(happy.id)}${line(own.id)}`, newText: under(happy.id, focus) },
            ],
        });
        expect(moved.text).toContain("queued");
        await h.settle();
        const nested = await h.read();
        expect(nested.html).toContain(under(happy.id, focus));
        expect(nested.html).not.toContain(own.id);

        // A Focus from before its current instructions is told once after an update.
        const told = () =>
            h.gym.inference.requests.filter((request) =>
                JSON.stringify(request.messages.at(-1)).includes(
                    "Happy Agent was updated, and your instructions may have changed.",
                ),
            ).length;
        expect(told()).toBe(0);
        await h.gym.restart({
            whileStopped: async () =>
                await runGymSql(h.gym.happyHome, [
                    "UPDATE happy_agent_module_space_owners SET state_json = json_remove(state_json, '$.prioritizingRevision')",
                ]),
        });
        await h.gym.waitUntil(() => (told() === 1 ? true : undefined), "the update notice");
        await h.settle();
        await h.gym.restart();
        await h.read();
        await h.settle();
        expect(told()).toBe(1);

        // A row of its own the person placed stays where they put it.
        const before = await h.read();
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "own-row-down",
            baseVersion: before.version,
            operations: [
                { type: "insert", node: { type: "space", id: own.id }, to: { after: "tasks" } },
            ],
        });
        await h.settle();
        const placed = await h.read();
        expect(placed.html).toContain(line(own.id));
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: placed.version,
                    edits: [{ oldText: line(own.id), newText: "" }],
                })
            ).text,
        ).toContain("Keep the person's manual placement.");
        await h.settle();
        expect((await h.read()).html).toBe(placed.html);
    } finally {
        await h.gym.dispose();
    }
}, 180_000);
