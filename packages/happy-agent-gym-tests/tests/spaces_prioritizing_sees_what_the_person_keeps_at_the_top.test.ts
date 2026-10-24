import { expect, it } from "vitest";
import { sidebarGym, type SidebarStem } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;

it("marks the rows the person keeps above the separator, and leaves what to do with them to Prioritizing", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const kept = await h.gym.http.ok<SidebarStem>("POST", "/v0/spaces/stem-cells", {
            sectionId: "tasks",
        });
        const below = await h.gym.http.ok<SidebarStem>("POST", "/v0/spaces/stem-cells", {
            sectionId: "tasks",
        });
        const initial = await h.read();
        // The person drags one row above the separator.
        await h.gym.http.ok("PUT", "/v0/spaces/sidebar", {
            html: initial.html
                .replace(line(kept.space.id), "")
                .replace(
                    '  <happy-separator id="divider"/>\n',
                    `${line(kept.space.id)}  <happy-separator id="divider"/>\n`,
                ),
            baseVersion: initial.version,
            mutationId: "keep-at-top",
        });
        const listed = JSON.parse((await h.call("list_sidebar", {})).text) as {
            version: number;
            spaces: { id: string; keepInPlace?: true }[];
        };
        expect(listed.spaces.find((row) => row.id === kept.space.id)?.keepInPlace).toBe(true);
        expect(listed.spaces.find((row) => row.id === below.space.id)?.keepInPlace).toBeUndefined();
        // The mark is for the prompt only: a proposal that moves the row is not refused.
        const proposed = await h.call("propose_sidebar", {
            baseVersion: listed.version,
            edits: [
                { oldText: line(kept.space.id), newText: "" },
                { oldText: "</nav>", newText: `${line(kept.space.id)}</nav>` },
            ],
        });
        expect(proposed.text).not.toContain("Dropped");
        expect(proposed.text).toMatch(/^Proposal [a-z0-9]+ /);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
