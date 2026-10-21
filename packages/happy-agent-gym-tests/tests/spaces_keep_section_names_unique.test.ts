import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("keeps authored section identities unique when the manager attempts a duplicate", async () => {
    const h = await sidebarGym();
    try {
        const initial = await h.read();
        await h.hold();
        const section = '<happy-section id="movies" label="Movies"></happy-section>';
        expect((await h.edit(initial.html.replace("</nav>", `${section}</nav>`))).text).toContain(
            "queued",
        );
        await h.calm();
        const valid = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.version > initial.version ? doc : undefined;
        }, "the Movies section");
        await h.hold();
        const duplicate = valid.html.replace("</nav>", `${section}</nav>`);
        expect((await h.edit(duplicate)).text).toContain("Duplicate section ID movies");
        const rejected = await h.gym.http.put("/v0/spaces/sidebar", {
            html: duplicate,
            baseVersion: valid.version,
            mutationId: "duplicate",
        });
        expect(rejected.status).toBe(400);
        expect(rejected.body).toHaveProperty("diagnostics");
        expect((await h.read()).html).toBe(valid.html);
        expect(
            (await h.gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
        ).toHaveLength(1);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
