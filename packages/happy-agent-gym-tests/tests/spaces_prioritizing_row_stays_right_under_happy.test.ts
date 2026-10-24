import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;

it("keeps Prioritizing's row right under Happy as new work arrives, and puts it back on start unless the person moved it", async () => {
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

        // New work goes below the pair, never between Happy and Prioritizing's row.
        const tasks = [
            (await h.gym.client.createTask({ name: "Release notes" })).task.id,
            (await h.gym.client.createTask({ name: "Webhook retries" })).task.id,
        ];
        let made: string[] = [];
        const placed = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            made = tasks.map((id) => doc.spaces.find((row) => row.target.id === id)?.id ?? "");
            return made.every((id) => id !== "" && doc.html.includes(id)) ? doc : undefined;
        }, "both new rows");
        expect(placed.html).toContain(
            `${line(happy.id)}${line(own.id)}${line(made[1]!)}${line(made[0]!)}`,
        );
        await h.settle();

        // What Prioritizing puts right after Happy lands after its own row instead.
        const before = await h.read();
        await h.call("edit_sidebar", {
            baseVersion: before.version,
            edits: [
                { oldText: line(made[0]!), newText: "" },
                { oldText: line(happy.id), newText: `${line(happy.id)}${line(made[0]!)}` },
            ],
        });
        await h.settle();
        expect((await h.read()).html).toContain(
            `${line(happy.id)}${line(own.id)}${line(made[0]!)}${line(made[1]!)}`,
        );

        // Something that came between the two before this release is repaired on start, once.
        const split = await h.read();
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "between",
            baseVersion: split.version,
            operations: [{ type: "move", id: made[1]!, to: { after: happy.id } }],
        });
        expect((await h.read()).html).toContain(
            `${line(happy.id)}${line(made[1]!)}${line(own.id)}`,
        );
        await h.gym.restart();
        const repaired = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.html.includes(`${line(happy.id)}${line(own.id)}${line(made[1]!)}`)
                ? doc
                : undefined;
        }, "Prioritizing's row back under Happy");
        await h.gym.restart();
        expect((await h.read()).version).toBe(repaired.version);

        // Once the person moves Prioritizing's row themselves, it stays where they put it.
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "own-row-down",
            baseVersion: repaired.version,
            operations: [{ type: "move", id: own.id, to: { after: made[0]! } }],
        });
        const moved = await h.read();
        await h.gym.restart();
        expect((await h.read()).html).toBe(moved.html);
    } finally {
        await h.gym.dispose();
    }
}, 180_000);
