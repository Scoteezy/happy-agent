import { runGymSql } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;

it("lets Prioritizing move its own row back under Happy itself, tells it once after an update, and keeps a row the person placed", async () => {
    const h = await sidebarGym();
    try {
        const first = await h.read();
        const prioritizing = await h.manager();
        const happy = first.spaces.find((row) => row.title === "Happy")!;
        const own = first.spaces.find((row) => row.target.agentId === prioritizing)!;
        await h.call("edit_sidebar", {
            baseVersion: first.version,
            edits: [{ oldText: line(happy.id), newText: `${line(happy.id)}${line(own.id)}` }],
        });
        await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.html.includes(`${line(happy.id)}${line(own.id)}`) ? true : undefined;
        }, "Prioritizing's own row under Happy");
        await h.settle();
        await h.unseed();
        await h.settle();

        // New work goes right below Happy, as always; the daemon does not move Prioritizing's row.
        const task = (await h.gym.client.createTask({ name: "Release notes" })).task.id;
        const above = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            const id = doc.spaces.find((row) => row.target.id === task)?.id;
            return id !== undefined &&
                doc.html.includes(`${line(happy.id)}${line(id)}${line(own.id)}`)
                ? id
                : undefined;
        }, "the new row between Happy and Prioritizing's row");
        await h.settle();

        // Prioritizing moves its own row back with an ordinary edit, no proposal needed.
        const pushed = await h.read();
        const moved = await h.call("edit_sidebar", {
            baseVersion: pushed.version,
            edits: [
                { oldText: line(own.id), newText: "" },
                { oldText: line(happy.id), newText: `${line(happy.id)}${line(own.id)}` },
            ],
        });
        expect(moved.text).toContain("queued");
        await h.settle();
        const restored = await h.read();
        expect(restored.html).toContain(`${line(happy.id)}${line(own.id)}${line(above)}`);

        // A Prioritizing from before its current instructions is told once after an update.
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

        // Once the person places Prioritizing's row, it stays where they put it.
        const before = await h.read();
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "own-row-down",
            baseVersion: before.version,
            operations: [{ type: "move", id: own.id, to: { after: "tasks" } }],
        });
        await h.settle();
        const placed = await h.read();
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: placed.version,
                    edits: [
                        { oldText: line(own.id), newText: "" },
                        { oldText: line(happy.id), newText: `${line(happy.id)}${line(own.id)}` },
                    ],
                })
            ).text,
        ).toContain("Keep the person's manual placement.");
        await h.settle();
        expect((await h.read()).html).toBe(placed.html);
    } finally {
        await h.gym.dispose();
    }
}, 180_000);
