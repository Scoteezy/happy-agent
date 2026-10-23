import { describe, expect, it } from "vitest";
import {
    formatSidebar,
    parseSidebar,
    sidebarNodes,
    SidebarValidationError,
} from "../../sources/artifacts/index.js";
import {
    insertSidebarSpace,
    migrateLegacySidebar,
    removeSidebarNode,
    seedSidebar,
    shownSidebarRows,
    sidebarEdits,
    sidebarPlacement,
} from "../../sources/spaces/impl/sidebarLayout.js";

const doc = (...items: string[]) => `<nav><happy-search/><happy-create/>${items.join("")}</nav>`;

describe("sidebar document validation", () => {
    it("reads nested sessions, titled sections, separators and quoted switches", () => {
        const root = parseSidebar(
            doc(
                '<happy-space id="happy" expanded="true"><happy-space id="sub"><happy-space id="deep"/></happy-space></happy-space>',
                '<happy-section id="work" label="Desktop &amp; web" collapsed="true"/>',
                '<happy-space id="task"></happy-space>',
                '<happy-separator id="rule"/>',
            ),
        );
        const nodes = sidebarNodes(root);
        expect(nodes.find((node) => node.attrs["id"] === "deep")?.parent?.attrs["id"]).toBe("sub");
        expect(nodes.find((node) => node.tag === "happy-section")?.attrs).toEqual({
            id: "work",
            label: "Desktop & web",
            collapsed: "true",
        });
        expect(nodes.find((node) => node.tag === "happy-separator")?.attrs).toEqual({
            id: "rule",
        });
        expect(root.children.map((node) => node.tag)).toEqual([
            "happy-search",
            "happy-create",
            "happy-space",
            "happy-section",
            "happy-space",
            "happy-separator",
        ]);
        expect(formatSidebar(root)).toContain(
            '<happy-section id="work" label="Desktop &amp; web" collapsed="true"/>',
        );
    });

    it("lets Search and Create sit anywhere in the list", () => {
        expect(() =>
            parseSidebar(
                '<nav><happy-space id="happy"/><happy-separator id="s"/><happy-create/><happy-search/></nav>',
            ),
        ).not.toThrow();
    });

    it.each([
        "<script>alert(1)</script>",
        '<p class="note">text</p>',
        "plain text",
        '<happy-space id="happy" onclick="alert(1)"/>',
        '<happy-space id="happy" style="display:none"/>',
        '<happy-space id="happy" expanded/>',
        '<happy-space id="happy" expanded="yes"/>',
        '<happy-space ref="happy"/>',
        '<happy-space id="happy"/><happy-space id="happy"/>',
        '<happy-separator id="same"/><happy-separator id="same"/>',
        '<happy-space id="happy"><happy-separator id="s"/></happy-space>',
        '<happy-space id="happy"><happy-search/></happy-space>',
        '<happy-separator id="s"><happy-space id="x"/></happy-separator>',
        '<happy-separator id="has space"/>',
        '<happy-separator id="titled" label="Bots"/>',
        '<happy-separator id="s" collapsed="true"/>',
        '<happy-section id="s"/>',
        '<happy-section id="s" label=""/>',
        '<happy-section id="s" label="   "/>',
        '<happy-section id="s" label="Bots" expanded="true"/>',
        '<happy-section id="s" label="Bots"><happy-space id="x"/></happy-section>',
        '<happy-space id="happy"><happy-section id="s" label="Bots"/></happy-space>',
        '<happy-section id="same" label="A"/><happy-separator id="same"/>',
        "<happy-search/>",
        "<happy-space id='a'><happy-space id='b'></happy-space>",
    ])("rejects anything outside the grammar: %s", (fragment) => {
        expect(() => parseSidebar(doc(fragment))).toThrow(SidebarValidationError);
    });

    it("accepts a fold-ribbon choice on the nav and on a row, and nothing else", () => {
        expect(() =>
            parseSidebar(
                '<nav fold-ribbon="always"><happy-search/><happy-create/><happy-space id="a" fold-ribbon="hover"/></nav>',
            ),
        ).not.toThrow();
        expect(() =>
            parseSidebar('<nav fold-ribbon="sometimes"><happy-search/><happy-create/></nav>'),
        ).toThrow(SidebarValidationError);
        expect(() => parseSidebar(doc('<happy-separator id="s" fold-ribbon="always"/>'))).toThrow(
            SidebarValidationError,
        );
    });

    it("requires exactly one Search and one Create", () => {
        expect(() => parseSidebar("<nav><happy-create/></nav>")).toThrow("happy-search");
        expect(() => parseSidebar("<nav><happy-search/></nav>")).toThrow("happy-create");
    });

    it("reports source offsets and enforces byte, node and depth bounds", () => {
        try {
            parseSidebar("<nav>\n<script></script></nav>");
            throw new Error("accepted");
        } catch (error) {
            expect(error).toMatchObject({
                diagnostics: [{ offset: 6, message: "Element script is not allowed." }],
            });
        }
        expect(() => parseSidebar("<nav>\ud800</nav>")).toThrow("valid Unicode");
        expect(() =>
            parseSidebar(
                doc(
                    Array.from(
                        { length: 999 },
                        (_, i) => `<happy-separator id="${"x".repeat(120)}${i}"/>`,
                    ).join(""),
                ),
            ),
        ).toThrow("128 KiB");
        expect(() =>
            parseSidebar(
                doc(
                    Array.from({ length: 1000 }, (_, i) => `<happy-separator id="s${i}"/>`).join(
                        "",
                    ),
                ),
            ),
        ).toThrow("1,000");
        expect(() =>
            parseSidebar(
                doc(
                    `${Array.from({ length: 16 }, (_, i) => `<happy-space id="d${i}">`).join("")}${"</happy-space>".repeat(16)}`,
                ),
            ),
        ).toThrow("depth 16");
    });

    it("formats one element a line and reads back the same tree", () => {
        const html = formatSidebar(
            parseSidebar(
                doc('<happy-space id="a" expanded="true"><happy-space id="b"/></happy-space>'),
            ),
        );
        expect(html).toBe(
            [
                "<nav>",
                "  <happy-search/>",
                "  <happy-create/>",
                '  <happy-space id="a" expanded="true">',
                '    <happy-space id="b"/>',
                "  </happy-space>",
                "</nav>",
                "",
            ].join("\n"),
        );
        expect(formatSidebar(parseSidebar(html))).toBe(html);
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
        const root = parseSidebar(html);
        expect(root.children.map((node) => `${node.tag}:${node.attrs["id"] ?? ""}`)).toEqual([
            "happy-search:",
            "happy-create:",
            "happy-space:happy",
            "happy-space:list",
            "happy-separator:divider",
            "happy-section:bots",
            "happy-space:helper",
            "happy-section:tasks",
            "happy-space:task",
        ]);
        // Sessions are not shown: no row nests or expands anything.
        expect(html).toContain('<happy-space id="happy"/>');
        expect(html).toContain('<happy-space id="task"/>');
        expect(html).not.toContain("expanded");
        expect(html).toContain('<happy-section id="bots" label="Bots"/>');
        expect(html).toContain('<happy-section id="tasks" label="Tasks"/>');
        expect(html).not.toMatch(/older|done/i);
    });

    it("counts drawn rows and the sessions shown under expanded rows, not folded ones", () => {
        expect(
            shownSidebarRows(
                doc(
                    '<happy-space id="happy"/>',
                    '<happy-space id="open" expanded="true"><happy-space id="sub"><happy-space id="deep"/></happy-space></happy-space>',
                    '<happy-space id="closed"><happy-space id="hidden"/></happy-space>',
                    '<happy-separator id="rule"/>',
                    '<happy-space id="after-rule"/>',
                    '<happy-section id="quiet" label="Quiet" collapsed="true"/>',
                    '<happy-space id="folded" expanded="true"><happy-space id="folded-sub"/></happy-space>',
                    '<happy-section id="open-section" label="Open"/>',
                    '<happy-space id="last"/>',
                ),
            ),
        ).toEqual(["happy", "open", "sub", "closed", "after-rule", "last"]);
    });

    it("keeps the default sections even when they have no rows yet", () => {
        expect(
            parseSidebar(
                seedSidebar({ happy: undefined, surfaces: [], bots: [], tasks: [] }),
            ).children.map((node) => node.attrs["id"] ?? node.tag),
        ).toEqual(["happy-search", "happy-create", "divider", "bots", "tasks"]);
    });

    it("rewrites a first-grammar document once, keeping titled sections and dropping Older", () => {
        const legacy =
            '<nav>\n<happy-space ref="happy" tree></happy-space>\n<happy-space ref="new" tree></happy-space>\n<happy-section id="rel" label="Releases">\n<happy-space ref="android" tree collapsed></happy-space>\n<p class="note">Note</p>\n</happy-section>\n<happy-section id="lab" label="Experiments" collapsed>\n<happy-space ref="probe" tree></happy-space>\n</happy-section>\n<happy-section id="older" label="Older" collapsed>\n<happy-space ref="old" tree></happy-space>\n</happy-section>\n</nav>';
        const migrated = migrateLegacySidebar(legacy)!;
        expect(migrated).toBe(
            [
                "<nav>",
                "  <happy-search/>",
                "  <happy-create/>",
                '  <happy-space id="happy"/>',
                '  <happy-space id="new"/>',
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
        expect(migrateLegacySidebar(migrated)).toBeUndefined();
        expect(migrateLegacySidebar("<nav><script></script></nav>")).toBeUndefined();
    });
});

describe("sidebar lifecycle", () => {
    const html = formatSidebar(
        parseSidebar(
            doc(
                '<happy-space id="happy" expanded="true"><happy-space id="sub"/></happy-space>',
                '<happy-space id="new"/>',
                '<happy-section id="desktop" label="Desktop"/>',
                '<happy-space id="manual"/>',
                '<happy-separator id="rule"/>',
                '<happy-space id="quiet"/>',
            ),
        ),
    );
    it("inserts new work right below Happy, after everything nested under it", () => {
        expect(insertSidebarSpace(html, "added", { happyId: "happy" })).toContain(
            '  </happy-space>\n  <happy-space id="added"/>\n  <happy-space id="new"/>',
        );
        expect(insertSidebarSpace(html, "new", { happyId: "happy" })).toBe(html);
    });
    it("falls back to right after Create when Happy is gone or folded away", () => {
        const afterCreate = '  <happy-create/>\n  <happy-space id="added"/>\n';
        expect(insertSidebarSpace(html, "added")).toContain(afterCreate);
        expect(
            insertSidebarSpace(removeSidebarNode(html, "happy"), "added", { happyId: "happy" }),
        ).toContain(afterCreate);
        const tucked = formatSidebar(
            parseSidebar(
                doc(
                    '<happy-section id="mine" label="Mine" collapsed="true"/>',
                    '<happy-space id="happy"/>',
                ),
            ),
        );
        expect(insertSidebarSpace(tucked, "added", { happyId: "happy" })).toContain(afterCreate);
    });
    it("inserts after the section or separator the work was made under", () => {
        expect(
            insertSidebarSpace(html, "added", { headingId: "desktop", happyId: "happy" }),
        ).toContain('label="Desktop"/>\n  <happy-space id="added"/>\n  <happy-space id="manual"/>');
        expect(insertSidebarSpace(html, "added", { headingId: "rule" })).toContain(
            'id="rule"/>\n  <happy-space id="added"/>\n  <happy-space id="quiet"/>',
        );
    });
    it("removes a row or session together with the sessions under it", () => {
        expect(removeSidebarNode(html, "sub")).toContain(
            '<happy-space id="happy" expanded="true"/>',
        );
        expect(removeSidebarNode(html, "happy")).not.toContain("sub");
        expect(removeSidebarNode(html, "unknown")).toBe(html);
    });
    it("attributes a drag to the moved item, separators and buttons included", () => {
        const order = (ids: string[]) =>
            `<nav>${ids.map((id) => (id.startsWith("happy-") ? `<${id}/>` : `<happy-space id="${id}"/>`)).join("")}</nav>`;
        expect(
            sidebarEdits(
                order(["happy-search", "happy-create", "a", "b", "c", "d"]),
                order(["happy-search", "happy-create", "d", "a", "b", "c"]),
            ).moved,
        ).toEqual(["d"]);
        expect(
            sidebarEdits(
                order(["happy-search", "happy-create", "a", "b"]),
                order(["happy-create", "a", "b", "happy-search"]),
            ).moved,
        ).toEqual(["happy-search"]);
        expect(sidebarEdits(html, removeSidebarNode(html, "sub")).moved).toEqual(["sub"]);
    });
    it("counts a row that now sits under another section or separator as moved, and a fold as a fold", () => {
        const regrouped = html.replace(
            'label="Desktop"/>\n',
            'label="Desktop"/>\n  <happy-section id="release" label="Releases"/>\n',
        );
        expect(sidebarEdits(html, regrouped)).toEqual({
            moved: ["release", "manual"],
            carried: [],
            folded: [],
        });
        const ruled = html.replace(
            'label="Desktop"/>\n',
            'label="Desktop"/>\n  <happy-separator id="break"/>\n',
        );
        expect(sidebarEdits(html, ruled).moved).toEqual(["break", "manual"]);
        expect(sidebarEdits(html, html.replace(' expanded="true"', ""))).toEqual({
            moved: [],
            carried: [],
            folded: ["happy"],
        });
        expect(
            sidebarEdits(html, html.replace('label="Desktop"', 'label="Desktop" collapsed="true"')),
        ).toEqual({ moved: [], carried: [], folded: ["desktop"] });
    });
    describe("a section moves as one block", () => {
        const layout = (...blocks: string[][]) =>
            doc(
                ...blocks.flatMap(([heading, ...rows]) => [
                    heading!.startsWith("sep:")
                        ? `<happy-separator id="${heading!.slice(4)}"/>`
                        : `<happy-section id="${heading}" label="${heading!.toUpperCase()}"/>`,
                    ...rows.map((row) => `<happy-space id="${row}"/>`),
                ]),
            );
        const bots = ["bots", "b1", "b2", "b3"];
        const tasks = ["tasks", "t1"];
        it("blames the heading alone, however many rows it carries", () => {
            // The old row-level diff blamed the smaller Tasks block for this drag.
            expect(
                sidebarEdits(
                    layout(["sep:divider"], bots, tasks),
                    layout(["sep:divider"], tasks, bots),
                ),
            ).toEqual({ moved: ["bots"], carried: ["b1", "b2", "b3"], folded: [] });
        });
        it("still sees a row reordered inside the moved block", () => {
            expect(
                sidebarEdits(layout(bots, tasks), layout(tasks, ["bots", "b2", "b1", "b3"])),
            ).toEqual({ moved: ["bots", "b1"], carried: ["b2", "b3"], folded: [] });
        });
        it("keeps rows that stay in their section unmoved when another section moves past them", () => {
            const edits = sidebarEdits(
                layout(["sep:divider", "h"], bots, tasks, ["mine", "m1"]),
                layout(["sep:divider", "h"], ["mine", "m1"], bots, tasks),
            );
            expect(edits.moved).toEqual(["mine"]);
            expect(edits.carried).toEqual(["m1"]);
        });
    });
    it("places items by the heading above them, folding only under a collapsed section", () => {
        const folded = html.replace('label="Desktop"', 'label="Desktop" collapsed="true"');
        expect(sidebarPlacement(folded, "manual")).toEqual({
            sectionId: "desktop",
            sectionName: "Desktop",
            index: 5,
            visibility: "folded",
        });
        // A separator ends the collapsed section's run, and is unnamed.
        expect(sidebarPlacement(folded, "quiet")).toEqual({
            sectionId: "rule",
            sectionName: null,
            index: 7,
            visibility: "shown",
        });
        expect(sidebarPlacement(folded, "desktop")).toMatchObject({ visibility: "shown" });
        expect(sidebarPlacement(html, "sub")).toMatchObject({
            sectionId: null,
            visibility: "shown",
        });
        expect(sidebarPlacement(html.replace(' expanded="true"', ""), "sub")).toMatchObject({
            visibility: "folded",
        });
        expect(sidebarPlacement(html, "gone")).toMatchObject({ visibility: "hidden" });
    });
});
