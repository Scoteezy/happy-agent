import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("rejects section removal that would move recent or running work", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const cells = [await h.create(), await h.create(), await h.create()];
        await h.hold();
        const current = await h.read();
        const nodes = cells.map(
            (cell) => `<happy-space ref="${cell.space.id}" tree></happy-space>`,
        );
        const without = nodes.reduce((html, node) => html.replace(node, ""), current.html);
        const grouped = without.replace(
            "</nav>",
            `<happy-section id="work" label="Work">${nodes.join("")}</happy-section></nav>`,
        );
        expect((await h.edit(grouped)).text).toContain("queued");
        await h.calm();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === grouped ? true : undefined),
            "the initial Work placements",
        );
        await h.gym.send("Recently active work.", { sessionId: cells[0]!.agent.id });
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
        expect((await h.edit(without.replace("</nav>", `${nodes.join("")}</nav>`))).text).toContain(
            "last two hours",
        );
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

it("rechecks recent activity when a quiet row's queued fold reaches calm", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const cell = await h.create();
        await h.hold();
        const current = await h.read();
        const node = `<happy-space ref="${cell.space.id}" tree></happy-space>`;
        const placed = current.html.replace(
            node,
            `<happy-section id="work" label="Work">${node}</happy-section>`,
        );
        await h.edit(placed);
        await h.calm();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === placed ? true : undefined),
            "the first placement",
        );
        await h.hold();
        expect(
            (
                await h.edit(
                    placed.replace('id="work" label="Work"', 'id="work" label="Work" collapsed'),
                )
            ).text,
        ).toContain("queued");
        await h.gym.send("Make this work active again before calm.", { sessionId: cell.agent.id });
        await h.calm();
        expect((await h.read()).html).toBe(placed);
        expect(
            (await h.gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
        ).toHaveLength(1);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
