import { describe, expect, it } from "vitest";
import {
    applySpaceSidebarOperations,
    diffSpaceSidebar,
    formatSpaceSidebar,
    parseSpaceSidebar,
} from "@slopus/happy-agent-client";

import {
    liftAttachmentsOut,
    liftRemovedAttachments,
} from "../../../sources/spaces/impl/liftSidebarAttachments.js";
import { applyPrioritizingOperations } from "../../../sources/spaces/impl/applyPrioritizingOperations.js";
import { recordSidebarAuthorship } from "../../../sources/spaces/impl/recordSidebarAuthorship.js";
import type { PrioritizingRules } from "../../../sources/spaces/impl/reviewPrioritizingOperation.js";

const doc = (...items: string[]) =>
    parseSpaceSidebar(`<nav><happy-search/><happy-create/>${items.join("")}</nav>`);
const rows = new Set(["release", "pricing", "todo", "notes", "chat"]);
const isSpace = (id: string) => rows.has(id);
const text = (document: ReturnType<typeof doc>) =>
    formatSpaceSidebar(document).split("\n").slice(3, -2).join("\n");

const attached = doc(
    '<happy-space id="release" expanded="true">',
    '<happy-space id="session1"/>',
    '<happy-space id="todo"/>',
    '<happy-space id="notes"/>',
    "</happy-space>",
    '<happy-space id="pricing"/>',
    '<happy-space id="chat"/>',
);

describe("sidebar attachments", () => {
    it("moves an attached space from another row, so it stands in one place only", () => {
        const { document } = applySpaceSidebarOperations(attached, [
            { type: "move", id: "todo", to: { parent: "pricing" } },
            { type: "move", id: "chat", to: { after: "todo" } },
        ]);
        expect(text(document)).toBe(
            [
                '  <happy-space id="release" expanded="true">',
                '    <happy-space id="session1"/>',
                '    <happy-space id="notes"/>',
                "  </happy-space>",
                '  <happy-space id="pricing">',
                '    <happy-space id="todo"/>',
                '    <happy-space id="chat"/>',
                "  </happy-space>",
            ].join("\n"),
        );
        // Inserting a space that already stands somewhere is refused: it is never shown twice.
        expect(() =>
            applySpaceSidebarOperations(attached, [
                {
                    type: "insert",
                    node: { type: "space", id: "todo" },
                    to: { parent: "pricing" },
                },
            ]),
        ).toThrow(/already in the sidebar/);
    });

    it("puts a removed attachment back at the top level right after its row", () => {
        const lifted = liftRemovedAttachments(
            attached,
            [
                { type: "remove", id: "notes" },
                { type: "remove", id: "session1" },
                { type: "remove", id: "chat" },
            ],
            isSpace,
        );
        // Sessions and top-level rows still leave; only an attachment is lifted.
        expect(lifted).toEqual([
            { type: "move", id: "notes", to: { after: "release" } },
            { type: "remove", id: "session1" },
            { type: "remove", id: "chat" },
        ]);
        expect(text(applySpaceSidebarOperations(attached, lifted).document)).toBe(
            [
                '  <happy-space id="release" expanded="true">',
                '    <happy-space id="todo"/>',
                "  </happy-space>",
                '  <happy-space id="notes"/>',
                '  <happy-space id="pricing"/>',
            ].join("\n"),
        );
        // A whole-document write that leaves the attachment out reads the same way.
        const proposed = doc(
            '<happy-space id="release" expanded="true">',
            '<happy-space id="session1"/>',
            '<happy-space id="notes"/>',
            "</happy-space>",
            '<happy-space id="pricing"/>',
            '<happy-space id="chat"/>',
        );
        const ops = liftRemovedAttachments(attached, diffSpaceSidebar(attached, proposed), isSpace);
        expect(ops).toEqual([{ type: "move", id: "todo", to: { after: "release" } }]);
    });

    it("lifts the attachments out of a row that leaves, in order, before its sessions go with it", () => {
        const nested = doc(
            '<happy-space id="release" expanded="true">',
            '<happy-space id="session1">',
            '<happy-space id="chat"/>',
            "</happy-space>",
            '<happy-space id="todo"/>',
            "</happy-space>",
            '<happy-space id="pricing"/>',
        );
        const operations = [
            ...liftAttachmentsOut(nested, "release", isSpace),
            { type: "remove" as const, id: "release" },
        ];
        expect(operations).toEqual([
            { type: "move", id: "chat", to: { after: "release" } },
            { type: "move", id: "todo", to: { after: "chat" } },
            { type: "remove", id: "release" },
        ]);
        expect(text(applySpaceSidebarOperations(nested, operations).document)).toBe(
            [
                '  <happy-space id="chat"/>',
                '  <happy-space id="todo"/>',
                '  <happy-space id="pricing"/>',
            ].join("\n"),
        );
        // An attached space that itself leaves goes wherever it stands, with what is under it.
        expect(liftAttachmentsOut(nested, "chat", isSpace)).toEqual([]);
        expect(
            text(applySpaceSidebarOperations(nested, [{ type: "remove", id: "todo" }]).document),
        ).not.toContain("todo");
    });

    it("never lets Prioritizing hide sessions the person revealed", () => {
        const before = doc('<happy-space id="release"/>', '<happy-space id="pricing"/>');
        const reveal = [
            {
                type: "insert" as const,
                node: { type: "space" as const, id: "session1" },
                to: { parent: "release" },
            },
            {
                type: "insert" as const,
                node: { type: "space" as const, id: "session2" },
                to: { after: "session1" },
            },
            { type: "set" as const, id: "release", expanded: true },
        ];
        const revealed = applySpaceSidebarOperations(before, reveal).document;
        const authorship = recordSidebarAuthorship({}, before, revealed, reveal, "person");
        const rules: PrioritizingRules = {
            person: (id, aspect) => authorship[id]?.[aspect] === "person",
            rows,
            happyId: undefined,
            untouched: new Set(),
            recent: new Set(),
            manual: new Set(),
            fresh: new Set(),
            moveLimit: undefined,
        };
        const result = applyPrioritizingOperations(
            revealed,
            [
                { type: "remove", id: "session2" },
                { type: "set", id: "release", expanded: false },
                {
                    type: "insert",
                    node: { type: "section", id: "quiet", label: "Quiet", collapsed: true },
                    to: { after: "happy-create" },
                },
                { type: "move", id: "todo-missing", to: { parent: "pricing" } },
            ],
            rules,
            undefined,
        );
        expect(result.operations).toEqual([]);
        expect(result.notes.join("\n")).toMatch(/remove session2: Keep the person's manual/);
        expect(result.notes.join("\n")).toMatch(/section quiet .*revealed in view/);
        expect(result.notes.join("\n")).toMatch(/own folds/);
        // A session the person never placed may still be taken out.
        const shown = applySpaceSidebarOperations(before, reveal).document;
        expect(
            applyPrioritizingOperations(
                shown,
                [{ type: "remove", id: "session2" }],
                { ...rules, person: () => false },
                undefined,
            ).operations,
        ).toEqual([{ type: "remove", id: "session2" }]);
    });
});
