import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const pinned = (pin: string) => `  <happy-separator id="divider" pin="${pin}"/>\n`;
const unpinned = '  <happy-separator id="divider"/>\n';
const later = '  <happy-section id="later" label="Later"/>\n';

it("keeps the person's separator pin through Prioritizing's edits, its proposals, and accepting them", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        await h.settle();
        const health = await h.gym.client.getHealth();
        expect(health.capabilities?.sidebarSeparatorPins).toBe(true);

        // The person pins the separator; the document keeps it after the ID.
        const start = await h.read();
        expect(start.html).toContain(unpinned);
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "pin-top",
            baseVersion: start.version,
            operations: [{ type: "set", id: "divider", pin: "top" }],
        });
        await h.settle();
        const top = await h.read();
        expect(top.html).toContain(pinned("top"));

        // Prioritizing's own batch cannot unpin it, even by redrawing the separator without it.
        const edit = await h.call("edit_sidebar", {
            baseVersion: top.version,
            edits: [{ oldText: pinned("top"), newText: unpinned }],
        });
        expect(edit.text).toContain("Keep the person's separator pins as they are.");
        await h.settle();
        expect((await h.read()).html).toContain(pinned("top"));

        // A proposal that drops the pin keeps everything else it proposes.
        const view = JSON.parse((await h.call("list_sidebar", {})).text) as { version: number };
        const proposed = await h.call("propose_sidebar", {
            baseVersion: view.version,
            edits: [
                { oldText: pinned("top"), newText: unpinned },
                { oldText: "</nav>", newText: `${later}</nav>` },
            ],
        });
        expect(proposed.text).toMatch(/^Proposal [a-z0-9]+ is at version 2\./);
        expect(proposed.text).toContain("Keep the person's separator pins as they are.");
        const first = /^Proposal ([a-z0-9]+) /.exec(proposed.text)![1]!;
        const draft = await h.gym.client.getSpaceSidebarProposal(first);
        expect(draft.html).toContain(pinned("top"));
        expect(draft.html).toContain(later);
        await h.settle();
        const accepted = await h.gym.client.acceptSpaceSidebarProposal(first, {
            mutationId: "accept-first",
        });
        expect(accepted.sidebar.html).toContain(pinned("top"));
        expect(accepted.sidebar.html).toContain(later);
        await h.settle();

        // A pin the person changes after a proposal was drafted survives accepting it.
        const current = JSON.parse((await h.call("list_sidebar", {})).text) as { version: number };
        const second = await h.call("propose_sidebar", {
            baseVersion: current.version,
            edits: [{ oldText: later, newText: "" }],
        });
        const secondId = /^Proposal ([a-z0-9]+) /.exec(second.text)![1]!;
        await h.settle();
        const live = await h.read();
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "pin-bottom",
            baseVersion: live.version,
            operations: [{ type: "set", id: "divider", pin: "bottom" }],
        });
        await h.settle();
        const again = await h.gym.client.acceptSpaceSidebarProposal(secondId, {
            mutationId: "accept-second",
        });
        expect(again.sidebar.html).toContain(pinned("bottom"));
        expect(again.sidebar.html).not.toContain(later);
        await h.settle();
        expect((await h.read()).html).toContain(pinned("bottom"));
    } finally {
        await h.gym.dispose();
    }
}, 180_000);
