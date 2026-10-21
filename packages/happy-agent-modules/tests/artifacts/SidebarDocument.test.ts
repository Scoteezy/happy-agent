import { describe, expect, it } from "vitest";
import {
    parseSidebar,
    sidebarNodes,
    SidebarValidationError,
} from "../../sources/artifacts/index.js";
import {
    changedSidebarRefs,
    insertSidebarSpace,
    removeSidebarSpace,
} from "../../sources/spaces/impl/sidebarLayout.js";

describe("sidebar document validation", () => {
    it("keeps authored nesting, entity labels and boolean disclosures", () => {
        const root = parseSidebar(
            '<nav><happy-space ref="happy" tree></happy-space><happy-section id="desktop" label="Desktop &amp; Tools" collapsed><div class="muted note"><happy-space ref="task" tree collapsed></happy-space><p><strong>Shared work</strong></p></div></happy-section></nav>',
            new Set(["happy", "task"]),
        );
        const nodes = sidebarNodes(root);
        expect(nodes.find((node) => node.attrs["ref"] === "task")?.parent?.tag).toBe("div");
        expect(nodes.find((node) => node.tag === "happy-section")?.attrs["label"]).toBe(
            "Desktop & Tools",
        );
    });

    it.each([
        "<script>alert(1)</script>",
        '<p onclick="alert(1)">bad</p>',
        '<div style="display:none">bad</div>',
        '<a href="https://example.com">url</a>',
        '<img src="https://example.com">',
        "<svg></svg>",
        "<math></math>",
        "<form></form>",
        "<iframe></iframe>",
        "<style>nav{display:none}</style>",
        '<p class="unknown">bad</p>',
        '<happy-space ref="missing"></happy-space>',
        '<happy-space ref="happy"></happy-space><happy-space ref="happy"></happy-space>',
        '<happy-section id="same" label="A"></happy-section><happy-section id="same" label="B"></happy-section>',
        '<happy-space ref="happy"><happy-space ref="task"></happy-space></happy-space>',
        "<happy-space tree></happy-space>",
        '<happy-space ref="happy" hidden></happy-space>',
        '<happy-space ref="happy" tree="true"></happy-space>',
        '<div class="note" class="muted"></div>',
        '<happy-space ref="happy"/>',
        "<p><div></div></p>",
        "<ul><div></div></ul>",
        "<div><span></div></span>",
        "<nav></nav>",
    ])("rejects unsafe, ambiguous or unauthorized content: %s", (fragment) => {
        expect(() => parseSidebar(`<nav>${fragment}</nav>`, new Set(["happy", "task"]))).toThrow(
            SidebarValidationError,
        );
    });

    it("reports source offsets and enforces byte, node and depth bounds", () => {
        expect(() => parseSidebar("<nav>\ud800</nav>")).toThrow("valid Unicode");
        expect(() => parseSidebar("<nav>\0</nav>")).toThrow("valid Unicode");
        try {
            parseSidebar("<nav>\n<script></script></nav>");
            throw new Error("accepted");
        } catch (error) {
            expect(error).toMatchObject({
                diagnostics: [{ offset: 6, message: "Element script is not allowed." }],
            });
        }
        expect(() => parseSidebar(`<nav>${"é".repeat(66000)}</nav>`)).toThrow("128 KiB");
        expect(() => parseSidebar(`<nav>${"<span></span>".repeat(1000)}</nav>`)).toThrow("1,000");
        expect(() =>
            parseSidebar(`<nav>${"<div>".repeat(16)}${"</div>".repeat(16)}</nav>`),
        ).toThrow("depth 16");
    });
});

describe("sidebar lifecycle", () => {
    const html =
        '<nav><happy-space ref="happy" tree></happy-space><happy-space ref="new" tree></happy-space><happy-section id="desktop" label="Desktop"><happy-space ref="manual" tree></happy-space></happy-section></nav>';
    it("inserts a new space after Happy or at the start of the requested section", () => {
        expect(insertSidebarSpace(html, "added", "happy")).toContain(
            '<happy-space ref="happy" tree></happy-space>\n<happy-space ref="added" tree></happy-space>',
        );
        expect(insertSidebarSpace(html, "added", "happy", "desktop")).toContain(
            'label="Desktop">\n<happy-space ref="added" tree></happy-space><happy-space ref="manual"',
        );
        expect(insertSidebarSpace(html, "new", "happy")).toBe(html);
    });
    it("promotes an archived space's authored children in place", () => {
        expect(
            removeSidebarSpace(
                '<nav><happy-space ref="old" tree><p class="note">Keep me</p></happy-space><hr></nav>',
                "old",
            ),
        ).toBe('<nav><p class="note">Keep me</p><hr></nav>');
    });
    it("does not mistake cross-section movement for movement of an untouched manual row", () => {
        const moved = html
            .replace('<happy-space ref="new" tree></happy-space>', "")
            .replace(
                'label="Desktop">',
                'label="Desktop"><happy-space ref="new" tree></happy-space>',
            );
        expect(changedSidebarRefs(html, moved)).toEqual(["new"]);
        expect(
            changedSidebarRefs(html, html.replace('label="Desktop"', 'label="Desktop" collapsed')),
        ).toEqual(["manual"]);
    });
    it("detects ancestor section reordering and movement between anonymous containers", () => {
        const first =
            '<happy-section id="one" label="One"><happy-space ref="first"></happy-space></happy-section>';
        const second =
            '<happy-section id="two" label="Two"><happy-space ref="second"></happy-space></happy-section>';
        expect(
            changedSidebarRefs(`<nav>${first}${second}</nav>`, `<nav>${second}${first}</nav>`),
        ).toEqual(["first", "second"]);
        expect(
            changedSidebarRefs(
                '<nav><div><happy-space ref="first"></happy-space></div><div></div></nav>',
                '<nav><div></div><div><happy-space ref="first"></happy-space></div></nav>',
            ),
        ).toEqual(["first"]);
        expect(changedSidebarRefs(`<nav>${first}</nav>`, `<nav>${second}${first}</nav>`)).toEqual(
            [],
        );
    });
});
