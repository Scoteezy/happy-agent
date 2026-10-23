import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;

it("refuses to move, remove, or fold away recent or running work", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const cells = [await h.create(), await h.create(), await h.create()];
        for (const cell of cells)
            await h.gym.send("Start this work.", { sessionId: cell.agent.id });
        await h.unseed();
        await h.hold();
        const current = await h.read();
        const without = cells.reduce(
            (html, cell) => html.replace(line(cell.space.id), ""),
            current.html,
        );
        const grouped = without.replace(
            "</nav>",
            `  <happy-section id="work" label="Work"/>\n${cells.map((cell) => line(cell.space.id)).join("")}</nav>`,
        );
        // New pending work may receive its first placement even though it is recent.
        expect((await h.edit(grouped)).text).toContain("queued");
        await h.calm();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === grouped ? true : undefined),
            "the initial Work placements",
        );
        await h.gym.send("Keep running while the sidebar is tidied.", {
            sessionId: cells[1]!.agent.id,
            wait: false,
        });
        await h.gym.waitUntil(
            async () =>
                (await h.read()).spaces.find((row) => row.id === cells[1]!.space.id)?.working
                    ? true
                    : undefined,
            "the running task",
        );
        await h.hold();
        expect((await h.edit(without)).text).toContain("last two hours");
        expect(
            (await h.edit(grouped.replace('label="Work"', 'label="Work" collapsed="true"'))).text,
        ).toContain("last two hours");
        await h.calm();
        expect((await h.read()).html).toBe(grouped);
        expect(
            (await h.gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
        ).toHaveLength(1);
        await h.gym.abort(cells[1]!.agent.id);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
