import { describe, expect, it } from "vitest";
import { formatSpaceSidebar, parseSpaceSidebar } from "@slopus/happy-agent-client";

import {
    archiveOffers,
    reviewProposalOperations,
    withoutArchive,
} from "../../../sources/spaces/impl/reviewProposalOperations.js";
import { formatConversationTurns } from "../../../sources/spaces/impl/formatConversationTurns.js";

const doc = (...items: string[]) =>
    parseSpaceSidebar(`<nav><happy-search/><happy-create/>${items.join("")}</nav>`);

describe("sidebar proposals", () => {
    const sidebar = doc(
        '<happy-space id="happy"/>',
        '<happy-section id="desktop" label="Desktop"/>',
        '<happy-space id="done"/>',
        '<happy-space id="mine"/>',
        '<happy-space id="busy"/>',
    );
    const rules = {
        person: (id: string, aspect: string) => id === "mine" && aspect === "place",
        mayNotArchive: (id: string) =>
            id === "busy" ? "busy is active in the last two hours; it is not finished." : undefined,
    };

    it("offers finished work under Archive and keeps what the person edited", () => {
        const result = reviewProposalOperations(
            sidebar,
            [
                {
                    type: "insert",
                    node: { type: "section", id: "archive", label: "Archive" },
                    to: { after: "busy" },
                },
                { type: "move", id: "done", to: { after: "archive" } },
                { type: "move", id: "busy", to: { after: "done" } },
                { type: "move", id: "mine", to: { after: "happy" } },
                {
                    type: "insert",
                    node: { type: "section", id: "stale", label: "Stale", collapsed: true },
                    to: { after: "desktop" },
                },
                {
                    type: "insert",
                    node: { type: "section", id: "older", label: "Older" },
                    to: { after: "happy" },
                },
            ],
            rules,
        );
        expect(result.operations.map((operation) => operation.type)).toEqual([
            "insert",
            "move",
            "insert",
        ]);
        expect(result.notes).toEqual([
            "Dropped move busy after done: busy is active in the last two hours; it is not finished.",
            "Dropped move mine after happy: Keep the person's edit of this proposal.",
            'Dropped insert section older after happy: Section "Older" sorts by age or whether work is finished; name a subject, or use Stale for quiet unfinished work.',
        ]);
        expect(archiveOffers(result.document)).toEqual(["done"]);
        // The sidebar never takes the Archive heading or what accepting archives.
        expect(formatSpaceSidebar(withoutArchive(result.document, new Set(["done"])))).toBe(
            formatSpaceSidebar(
                doc(
                    '<happy-space id="happy"/>',
                    '<happy-section id="desktop" label="Desktop"/>',
                    '<happy-section id="stale" label="Stale" collapsed="true"/>',
                    '<happy-space id="mine"/>',
                    '<happy-space id="busy"/>',
                ),
            ),
        );
    });

    it("reads a conversation as its latest turns, the last replies of each, oldest first", () => {
        const now = 10 * 60 * 60_000;
        const text = formatConversationTurns(
            [
                { role: "user", text: "Fix the build", at: 0 },
                { role: "assistant", text: "Looking.", at: 1 },
                { role: "assistant", text: "Fixed and pushed.", at: 2 },
                { role: "agent", text: "Report: tests pass.", at: 3 },
                { role: "assistant", text: "Done.", at: 4 },
                { role: "user", text: "x".repeat(50), at: now - 5 * 60_000 },
            ],
            { turns: 2, replies: 1, now, messageLimit: 20, limit: 4_000 },
        );
        expect(text).toBe(
            [
                "(1 earlier turn left out)",
                "Another agent, 10 h ago: Report: tests pass.",
                "Agent, 10 h ago: Done.",
                "",
                `Person, 5 min ago: ${"x".repeat(20)}…`,
            ].join("\n"),
        );
        expect(
            formatConversationTurns([], { turns: 4, replies: 1, now, messageLimit: 20, limit: 99 }),
        ).toBe("Nothing has been said here yet.");
    });
});
