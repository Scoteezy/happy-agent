import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("refuses a sidebar with a duplicate ID from Prioritizing and the person alike", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const initial = await h.read();
        const section = '  <happy-section id="movies" label="Movies"/>\n';
        expect((await h.edit(initial.html.replace("</nav>", `${section}</nav>`))).text).toContain(
            "queued",
        );
        await h.settle();
        const valid = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.version > initial.version ? doc : undefined;
        }, "the movies section");
        const append = (item: string) => valid.html.replace("</nav>", `${item}</nav>`);
        const duplicate = append('  <happy-separator id="movies"/>\n');
        expect((await h.edit(duplicate)).text).toContain("Duplicate ID movies");
        const rejected = await h.gym.http.put("/v0/spaces/sidebar", {
            html: duplicate,
            baseVersion: valid.version,
            mutationId: "duplicate",
        });
        expect(rejected.status).toBe(400);
        expect(rejected.body).toHaveProperty("diagnostics");
        // The person names their own sections however they like.
        const personal = await h.gym.http.put("/v0/spaces/sidebar", {
            html: append('  <happy-section id="past" label="Done"/>\n'),
            baseVersion: valid.version,
            mutationId: "personal",
        });
        expect(personal.status).toBeLessThan(300);
        expect(
            (await h.gym.http.ok<{ batches: { note: string }[] }>("GET", "/v0/spaces/batches"))
                .batches,
        ).toMatchObject([{ note: "Added Movies." }]);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
