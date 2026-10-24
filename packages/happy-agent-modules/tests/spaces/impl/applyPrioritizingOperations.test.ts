import { describe, expect, it } from "vitest";
import {
    applySpaceSidebarOperations,
    formatSpaceSidebar,
    parseSpaceSidebar,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import type { SidebarAuthorship } from "../../../sources/spaces/Space.js";
import {
    applyPrioritizingOperations,
    projectSidebar,
} from "../../../sources/spaces/impl/applyPrioritizingOperations.js";
import {
    affirmSidebarAuthorship,
    recordSidebarAuthorship,
} from "../../../sources/spaces/impl/recordSidebarAuthorship.js";
import { type PrioritizingRules } from "../../../sources/spaces/impl/reviewPrioritizingOperation.js";

const doc = (...items: string[]) =>
    parseSpaceSidebar(`<nav><happy-search/><happy-create/>${items.join("")}</nav>`);

const base = doc(
    '<happy-space id="happy"/>',
    '<happy-space id="fresh"/>',
    '<happy-section id="desktop" label="Desktop"/>',
    '<happy-space id="mine"/>',
    '<happy-space id="busy"/>',
    '<happy-space id="quiet"/>',
    '<happy-section id="bots" label="Bots"/>',
    '<happy-space id="helper"/>',
);

function rules(
    authorship: Record<string, SidebarAuthorship> = {},
    overrides: Partial<PrioritizingRules> = {},
): PrioritizingRules {
    return {
        person: (id, aspect) => authorship[id]?.[aspect] === "person",
        rows: new Set(["happy", "fresh", "mine", "busy", "quiet", "helper"]),
        manual: new Set(),
        fresh: new Set(["fresh"]),
        focusId: undefined,
        direct: false,
        ...overrides,
    };
}

describe("Prioritizing's operations", () => {
    it("keeps a row open that the person opened again, though their set changed nothing", () => {
        const open = applySpaceSidebarOperations(base, [
            { type: "set", id: "mine", expanded: true },
        ]).document;
        const requested: SpaceSidebarOperation[] = [{ type: "set", id: "mine", expanded: true }];
        // The client drops a set that changes nothing, so the person's batch applies no operation.
        expect(applySpaceSidebarOperations(open, requested).operations).toEqual([]);
        const authorship = affirmSidebarAuthorship({}, open, [
            ...requested,
            { type: "set", id: "gone", expanded: true },
        ]);
        expect(authorship).toEqual({ mine: { fold: "person" } });
        const result = applyPrioritizingOperations(
            open,
            [{ type: "set", id: "mine", expanded: false }],
            rules(authorship, { direct: false }),
            undefined,
        );
        expect(result.operations).toEqual([]);
        expect(result.notes.join(" ")).toContain("Keep the person's own folds.");
    });

    it("drops only what overrides the person, and applies the rest", () => {
        const authorship = recordSidebarAuthorship(
            {},
            base,
            applySpaceSidebarOperations(base, [
                { type: "move", id: "mine", to: { after: "quiet" } },
                { type: "set", id: "desktop", collapsed: false },
            ]).document,
            [
                { type: "move", id: "mine", to: { after: "quiet" } },
                { type: "set", id: "desktop", collapsed: false },
            ],
            "person",
        );
        expect(authorship).toEqual({ mine: { place: "person" }, desktop: { fold: "person" } });
        const result = applyPrioritizingOperations(
            base,
            [
                { type: "move", id: "mine", to: { after: "helper" } },
                { type: "set", id: "desktop", collapsed: true },
                { type: "set", id: "desktop", label: "Desktop app" },
                { type: "move", id: "quiet", to: { after: "helper" } },
            ],
            rules(authorship),
            undefined,
        );
        expect(result.operations).toEqual([
            { type: "set", id: "desktop", label: "Desktop app" },
            { type: "move", id: "quiet", to: { after: "helper" } },
        ]);
        expect(result.notes).toEqual([
            "Dropped move mine after helper: Keep the person's manual placement.",
            "Dropped set collapsed on desktop: Keep the person's own folds.",
        ]);
    });

    it("leaves where things go to Prioritizing when the person asked for it", () => {
        // Happy, new work, recent work, the default sections, and section names are its call.
        const operations: SpaceSidebarOperation[] = [
            { type: "move", id: "happy", to: { after: "helper" } },
            { type: "move", id: "fresh", to: { after: "helper" } },
            { type: "set", id: "desktop", collapsed: true },
            { type: "set", id: "desktop", label: "Older" },
            { type: "remove", id: "bots" },
        ];
        const result = applyPrioritizingOperations(base, operations, rules(), undefined);
        expect(result.notes).toEqual([]);
        expect(result.operations).toEqual(operations);
    });

    it("applies without a proposal only new work's placement, Distractions, its own row, and nested changes", () => {
        const sidebar = doc(
            '<happy-space id="happy"/>',
            '<happy-space id="cell"/>',
            '<happy-section id="desktop" label="Desktop"/>',
            '<happy-space id="a"/>',
            '<happy-space id="b"/>',
            '<happy-section id="bots" label="Bots"/>',
            '<happy-space id="helper"/>',
        );
        const direct = rules(
            {},
            {
                rows: new Set(["happy", "cell", "a", "b", "helper", "focus"]),
                fresh: new Set(["cell"]),
                focusId: "focus",
                direct: true,
            },
        );
        const allowed: SpaceSidebarOperation[] = [
            { type: "insert", node: { type: "space", id: "focus" }, to: { after: "happy" } },
            // Its own row is its to keep right under Happy, wherever something pushed it.
            { type: "move", id: "focus", to: { after: "cell" } },
            { type: "move", id: "focus", to: { after: "happy" } },
            {
                type: "insert",
                node: {
                    type: "section",
                    id: "distractions",
                    label: "Distractions",
                    collapsed: true,
                },
                to: { after: "helper" },
            },
            { type: "move", id: "cell", to: { after: "distractions" } },
            { type: "insert", node: { type: "space", id: "session1" }, to: { parent: "a" } },
            { type: "set", id: "a", expanded: true },
        ];
        const refused: SpaceSidebarOperation[] = [
            { type: "move", id: "a", to: { after: "helper" } },
            { type: "move", id: "desktop", to: { after: "helper" } },
            {
                type: "insert",
                node: { type: "section", id: "research", label: "Research" },
                to: { after: "helper" },
            },
            // A heading among placed rows regroups them, which needs consent.
            { type: "insert", node: { type: "separator", id: "split" }, to: { after: "a" } },
            { type: "set", id: "desktop", collapsed: true },
            { type: "set", id: "desktop", label: "Desktop app" },
            { type: "remove", id: "b" },
            {
                type: "insert",
                node: { type: "widget", id: "card", html: "<b>2 waiting</b>" },
                to: { after: "happy-create" },
            },
        ];
        const result = applyPrioritizingOperations(
            sidebar,
            [...allowed, ...refused],
            direct,
            undefined,
        );
        expect(result.operations).toEqual(allowed);
        expect(result.notes).toHaveLength(refused.length);
        for (const note of result.notes) expect(note).toContain("propose_sidebar");
        // Lifting its row by moving a neighbour below it is refused with the move that works.
        const underHappy = applySpaceSidebarOperations(sidebar, [allowed[0]!]).document;
        const neighbour = applyPrioritizingOperations(
            underHappy,
            [{ type: "move", id: "a", to: { after: "focus" } }],
            direct,
            undefined,
        );
        expect(neighbour.operations).toEqual([]);
        expect(neighbour.notes[0]).toContain("move your own row instead; that applies directly");
        expect(result.notes.join("\n")).not.toContain("move your own row instead");
        // What the person asked for in their own words needs no proposal.
        expect(
            applyPrioritizingOperations(sidebar, refused, { ...direct, direct: false }, undefined)
                .operations,
        ).toEqual(refused);
        // Once the person placed its row, it stays where they put it.
        const placed = applySpaceSidebarOperations(sidebar, [allowed[0]!]).document;
        expect(
            applyPrioritizingOperations(
                placed,
                [{ type: "move", id: "focus", to: { after: "helper" } }],
                { ...direct, person: (id, aspect) => id === "focus" && aspect === "place" },
                undefined,
            ).notes[0],
        ).toContain("Keep the person's manual placement.");
    });

    it("keeps a widget the person last edited", () => {
        const withCard = doc('<happy-widget id="card">Mine</happy-widget>');
        const result = applyPrioritizingOperations(
            withCard,
            [
                { type: "set", id: "card", html: "Theirs" },
                {
                    type: "insert",
                    node: { type: "widget", id: "summary", html: "<b>2 waiting</b>" },
                    to: { after: "happy-create" },
                },
            ],
            rules({ card: { html: "person" } }, { rows: new Set() }),
            undefined,
        );
        expect(result.notes).toEqual([
            "Dropped set html on card: Keep the person's widget as they left it.",
        ]);
        expect(formatSpaceSidebar(result.document)).toContain(
            '<happy-widget id="summary"><b>2 waiting</b></happy-widget>',
        );
    });

    it("rebases onto the person's later change and drops what no longer applies", () => {
        // The person removed the anchor and the row Prioritizing wanted to fold.
        const current = applySpaceSidebarOperations(base, [
            { type: "remove", id: "quiet" },
            { type: "remove", id: "helper" },
        ]).document;
        const result = applyPrioritizingOperations(
            current,
            [
                {
                    type: "insert",
                    node: { type: "separator", id: "later" },
                    to: { after: "quiet" },
                },
                { type: "set", id: "helper", expanded: true },
            ],
            rules(),
            base,
        );
        expect(result.operations).toEqual([
            { type: "insert", node: { type: "separator", id: "later" }, to: { after: "busy" } },
        ]);
        expect(result.notes).toEqual([
            "Dropped set expanded on helper: helper is no longer in the sidebar.",
        ]);
    });

    it("draws queued proposals in order, skipping what no longer applies", () => {
        const projected = projectSidebar(base, [
            { operations: [{ type: "move", id: "quiet", to: { after: "helper" } }] },
            {
                operations: [
                    { type: "remove", id: "gone" },
                    { type: "set", id: "missing", expanded: true },
                    { type: "move", id: "helper", to: { after: "bots" } },
                ],
            },
        ]);
        expect(projected.items.at(-1)?.id).toBe("quiet");
    });
});

describe("sidebar authorship", () => {
    it("records the person per aspect, a section drag at its heading only, and the daemon's removals take theirs", () => {
        const operations: SpaceSidebarOperation[] = [
            { type: "move", id: "desktop", to: { after: "helper" } },
            { type: "set", id: "desktop", label: "Desk" },
            { type: "set", id: "nav", foldRibbon: "always" },
        ];
        const after = applySpaceSidebarOperations(base, operations).document;
        const authorship = recordSidebarAuthorship(
            { quiet: { fold: "prioritizing" } },
            base,
            after,
            operations,
            "person",
        );
        expect(authorship).toEqual({
            quiet: { fold: "prioritizing" },
            desktop: { place: "person", label: "person" },
            nav: { foldRibbon: "person" },
        });
        const removal: SpaceSidebarOperation[] = [{ type: "remove", id: "quiet" }];
        expect(
            recordSidebarAuthorship(
                authorship,
                after,
                applySpaceSidebarOperations(after, removal).document,
                removal,
                "daemon",
            ),
        ).toEqual({
            desktop: { place: "person", label: "person" },
            nav: { foldRibbon: "person" },
        });
    });
});
