import { describe, expect, it } from "vitest";
import {
    applySpaceSidebarOperations,
    diffSpaceSidebar,
    formatSpaceSidebar,
    parseSpaceSidebar,
} from "@slopus/happy-agent-client";

import { readSidebarDocument, SidebarValidationError } from "../../sources/artifacts/index.js";
import { migrateLegacySidebar } from "../../sources/spaces/impl/migrateLegacySidebar.js";
import {
    newSpacePosition,
    regroupedSidebarIds,
    seedSidebar,
    shownSidebarRows,
    sidebarPlacement,
} from "../../sources/spaces/impl/sidebarLayout.js";

const doc = (...items: string[]) =>
    parseSpaceSidebar(`<nav><happy-search/><happy-create/>${items.join("")}</nav>`);

describe("sidebar document validation", () => {
    it("reads with the client's parser and refuses with diagnostics", () => {
        expect(readSidebarDocument(formatSpaceSidebar(doc('<happy-space id="a"/>')))).toEqual(
            doc('<happy-space id="a"/>'),
        );
        let refused: unknown;
        try {
            readSidebarDocument("<nav><happy-search/><script></script></nav>");
        } catch (error: unknown) {
            refused = error;
        }
        expect(refused).toBeInstanceOf(SidebarValidationError);
        expect((refused as SidebarValidationError).diagnostics[0]?.offset).toBeGreaterThan(0);
    });
});

describe("sidebar seeding and migration", () => {
    it("mirrors the classic sidebar: Happy, Surfaces, a separator, then Bots and Tasks, rows only", () => {
        const html = seedSidebar({
            happy: "happy",
            surfaces: ["list"],
            bots: ["helper"],
            tasks: ["task"],
        });
        expect(parseSpaceSidebar(html).items.map((item) => `${item.type}:${item.id}`)).toEqual([
            "search:happy-search",
            "create:happy-create",
            "space:happy",
            "space:list",
            "separator:divider",
            "section:bots",
            "space:helper",
            "section:tasks",
            "space:task",
        ]);
        expect(html).not.toContain("expanded");
        expect(html).toContain('<happy-section id="bots" label="Bots"/>');
        expect(seedSidebar({ happy: undefined, surfaces: [], bots: [], tasks: [] })).toContain(
            '<happy-section id="tasks" label="Tasks"/>',
        );
    });

    it("counts drawn rows, widgets, and the sessions shown under expanded rows", () => {
        expect(
            shownSidebarRows(
                doc(
                    '<happy-space id="happy"/>',
                    '<happy-space id="open" expanded="true"><happy-space id="sub"><happy-space id="deep"/></happy-space></happy-space>',
                    '<happy-space id="closed"><happy-space id="hidden"/></happy-space>',
                    '<happy-widget id="status"><b>3 waiting</b></happy-widget>',
                    '<happy-separator id="rule"/>',
                    '<happy-space id="after-rule"/>',
                    '<happy-section id="quiet" label="Quiet" collapsed="true"/>',
                    '<happy-space id="folded" expanded="true"><happy-space id="folded-sub"/></happy-space>',
                    '<happy-widget id="folded-card"/>',
                    '<happy-section id="open-section" label="Open"/>',
                    '<happy-space id="last"/>',
                ),
            ),
        ).toEqual(["happy", "open", "sub", "closed", "status", "after-rule", "last"]);
    });

    it("rewrites a first-grammar document once, keeping titled sections and known rows", () => {
        const legacy =
            '<nav>\n<happy-space ref="happy" tree></happy-space>\n<happy-space ref="gone" tree></happy-space>\n<happy-section id="rel" label="Releases">\n<happy-space ref="android" tree collapsed></happy-space>\n<p class="note">Note</p>\n</happy-section>\n<happy-section id="lab" label="Experiments" collapsed>\n<happy-space ref="probe" tree></happy-space>\n</happy-section>\n<happy-section id="older" label="Older" collapsed>\n<happy-space ref="old" tree></happy-space>\n</happy-section>\n</nav>';
        const migrated = migrateLegacySidebar(legacy, (id) => id !== "gone")!;
        expect(migrated).toBe(
            [
                "<nav>",
                "  <happy-search/>",
                "  <happy-create/>",
                '  <happy-space id="happy"/>',
                '  <happy-section id="rel" label="Releases"/>',
                '  <happy-space id="android"/>',
                '  <happy-section id="lab" label="Experiments" collapsed="true"/>',
                '  <happy-space id="probe"/>',
                '  <happy-separator id="older"/>',
                '  <happy-space id="old"/>',
                "</nav>",
                "",
            ].join("\n"),
        );
        expect(migrateLegacySidebar(migrated, () => true)).toBeUndefined();
        expect(migrateLegacySidebar("<nav><script></script></nav>", () => true)).toBeUndefined();
    });
});

describe("sidebar lifecycle", () => {
    const document = doc(
        '<happy-space id="happy" expanded="true"><happy-space id="sub"/></happy-space>',
        '<happy-space id="new"/>',
        '<happy-section id="desktop" label="Desktop"/>',
        '<happy-space id="manual"/>',
        '<happy-separator id="rule"/>',
        '<happy-space id="quiet"/>',
    );

    it("inserts new work right below Happy, or right after Create when Happy is folded away", () => {
        expect(newSpacePosition(document, { happyId: "happy" })).toEqual({ after: "happy" });
        expect(newSpacePosition(document)).toEqual({ after: "happy-create" });
        const tucked = doc(
            '<happy-section id="mine" label="Mine" collapsed="true"/>',
            '<happy-space id="happy"/>',
        );
        expect(newSpacePosition(tucked, { happyId: "happy" })).toEqual({ after: "happy-create" });
        // After Happy means after everything nested in it.
        const inserted = applySpaceSidebarOperations(document, [
            { type: "insert", node: { type: "space", id: "added" }, to: { after: "happy" } },
        ]).document;
        expect(formatSpaceSidebar(inserted)).toContain(
            '  </happy-space>\n  <happy-space id="added"/>\n  <happy-space id="new"/>',
        );
    });

    it("inserts after the section or separator the work was made under", () => {
        expect(newSpacePosition(document, { headingId: "desktop", happyId: "happy" })).toEqual({
            after: "desktop",
        });
        expect(newSpacePosition(document, { headingId: "rule" })).toEqual({ after: "rule" });
        expect(newSpacePosition(document, { headingId: "manual", happyId: "happy" })).toEqual({
            after: "happy",
        });
    });

    it("counts an item that now sits under another heading as regrouped", () => {
        const regrouped = applySpaceSidebarOperations(document, [
            {
                type: "insert",
                node: { type: "section", id: "release", label: "Releases" },
                to: { after: "desktop" },
            },
        ]).document;
        expect(regroupedSidebarIds(document, regrouped)).toEqual(["manual"]);
        // A section dragged as a block carries its rows: they keep their heading.
        const dragged = applySpaceSidebarOperations(document, [
            { type: "move", id: "desktop", to: { after: "quiet" } },
        ]).document;
        expect(regroupedSidebarIds(document, dragged)).toEqual([]);
    });

    it("places items by the heading above them, folding only under a collapsed section", () => {
        const folded = applySpaceSidebarOperations(document, [
            { type: "set", id: "desktop", collapsed: true },
        ]).document;
        expect(sidebarPlacement(folded, "manual")).toEqual({
            sectionId: "desktop",
            sectionName: "Desktop",
            index: 5,
            visibility: "folded",
        });
        expect(sidebarPlacement(folded, "quiet")).toEqual({
            sectionId: "rule",
            sectionName: null,
            index: 7,
            visibility: "shown",
        });
        expect(sidebarPlacement(document, "sub")).toMatchObject({
            sectionId: null,
            visibility: "shown",
        });
        const closed = applySpaceSidebarOperations(document, [
            { type: "set", id: "happy", expanded: false },
        ]).document;
        expect(sidebarPlacement(closed, "sub")).toMatchObject({ visibility: "folded" });
        expect(sidebarPlacement(document, "gone")).toMatchObject({ visibility: "hidden" });
    });

    it("turns a whole-document edit into the moves a person made, keeping hidden widgets", () => {
        const withCard = doc(
            '<happy-space id="a"/>',
            '<happy-widget id="card"><i>hi</i></happy-widget>',
            '<happy-space id="b"/>',
        );
        const proposed = doc('<happy-space id="b"/>', '<happy-space id="a"/>');
        const operations = diffSpaceSidebar(withCard, proposed, { widgets: false });
        expect(operations).toHaveLength(1);
        const after = applySpaceSidebarOperations(withCard, operations).document;
        expect(formatSpaceSidebar(after, { widgets: false })).toBe(formatSpaceSidebar(proposed));
        expect(formatSpaceSidebar(after)).toContain("<i>hi</i>");
    });
});
