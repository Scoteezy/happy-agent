import { describe, expect, it } from "vitest";
import { formatSpaceSidebar, parseSpaceSidebar } from "@slopus/happy-agent-client";

import {
    archiveOffers,
    reviewProposalOperations,
    withoutArchive,
} from "../../../sources/spaces/impl/reviewProposalOperations.js";
import {
    formatConversationAge,
    formatConversationTurns,
} from "../../../sources/spaces/impl/formatConversationTurns.js";

const doc = (...items: string[]) =>
    parseSpaceSidebar(`<nav><happy-search/><happy-create/>${items.join("")}</nav>`);

describe("sidebar proposals", () => {
    const sidebar = doc(
        '<happy-space id="happy"/>',
        '<happy-section id="desktop" label="Desktop"/>',
        '<happy-space id="done"/>',
        '<happy-space id="mine"/>',
        '<happy-space id="busy"/>',
        '<happy-section id="bots" label="Bots"/>',
        '<happy-space id="helper"/>',
        '<happy-separator id="top"/>',
        '<happy-space id="quiet"/>',
    );
    const rules = {
        person: (id: string, aspect: string) => id === "mine" && aspect === "place",
        mayNotArchive: (id: string) =>
            id === "helper" ? "helper is not a task's row." : undefined,
    };

    it("keeps only the person's edits and what accepting can archive, and leaves the rest to Prioritizing", () => {
        const result = reviewProposalOperations(
            sidebar,
            [
                {
                    type: "insert",
                    node: { type: "section", id: "archive", label: "Archive" },
                    to: { after: "quiet" },
                },
                { type: "move", id: "done", to: { after: "archive" } },
                { type: "move", id: "helper", to: { after: "done" } },
                { type: "move", id: "mine", to: { after: "happy" } },
                { type: "set", id: "archive", label: "Finished" },
                // Where things go is Prioritizing's decision: Happy, separators, status names.
                { type: "move", id: "happy", to: { after: "busy" } },
                { type: "remove", id: "top" },
                {
                    type: "insert",
                    node: { type: "section", id: "now", label: "Active", collapsed: true },
                    to: { after: "busy" },
                },
            ],
            rules,
        );
        expect(result.notes).toEqual([
            "Dropped move helper after done: helper is not a task's row.",
            "Dropped move mine after happy: Keep the person's edit of this proposal.",
            expect.stringMatching(/: The archive section is labelled "Archive"\.$/),
        ]);
        expect(archiveOffers(result.document)).toEqual(["done"]);
        // The sidebar never takes the Archive heading or what accepting archives.
        expect(formatSpaceSidebar(withoutArchive(result.document, new Set(["done"])))).toBe(
            formatSpaceSidebar(
                doc(
                    '<happy-section id="desktop" label="Desktop"/>',
                    '<happy-space id="mine"/>',
                    '<happy-space id="busy"/>',
                    '<happy-section id="now" label="Active" collapsed="true"/>',
                    '<happy-space id="happy"/>',
                    '<happy-section id="bots" label="Bots"/>',
                    '<happy-space id="helper"/>',
                    '<happy-space id="quiet"/>',
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

    it("gives ages in minutes up to three hours, so recent work never reads as two hours", () => {
        const hours = (count: number) => count * 60 * 60_000;
        expect(formatConversationAge(5 * 60_000)).toBe("5 min");
        expect(formatConversationAge(hours(1.7))).toBe("102 min");
        expect(formatConversationAge(hours(2.9))).toBe("174 min");
        expect(formatConversationAge(hours(3))).toBe("3 h");
        expect(formatConversationAge(hours(72))).toBe("3 days");
    });
});
