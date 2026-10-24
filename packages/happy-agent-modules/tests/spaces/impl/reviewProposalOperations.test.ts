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
        '<happy-section id="bots" label="Bots"/>',
        '<happy-space id="helper"/>',
        '<happy-space id="quiet"/>',
    );
    const rules = {
        person: (id: string, aspect: string) => id === "mine" && aspect === "place",
        mayNotArchive: (id: string) =>
            id === "busy" ? "busy is active in the last two hours; it is not finished." : undefined,
        mayNotMove: (id: string) =>
            id === "happy" ? "Prioritizing cannot move or hide Happy." : undefined,
        mayNotHide: (id: string) =>
            id === "busy" ? "busy was active in the last two hours; keep it shown." : undefined,
        mayNotStale: (id: string) => (id === "helper" ? "helper is a bot." : undefined),
    };

    it("offers finished work under Archive and quiet work under Stale, and keeps what may not move", () => {
        const result = reviewProposalOperations(
            sidebar,
            [
                {
                    type: "insert",
                    node: { type: "section", id: "archive", label: "Archive" },
                    to: { after: "quiet" },
                },
                { type: "move", id: "done", to: { after: "archive" } },
                { type: "move", id: "busy", to: { after: "done" } },
                { type: "move", id: "mine", to: { after: "happy" } },
                {
                    type: "insert",
                    node: { type: "section", id: "stale", label: "Stale", collapsed: true },
                    to: { after: "done" },
                },
                { type: "move", id: "quiet", to: { after: "stale" } },
                { type: "move", id: "helper", to: { after: "stale" } },
                // Recent work may be grouped in a proposal, but never folded away.
                {
                    type: "insert",
                    node: { type: "section", id: "launch", label: "Launch" },
                    to: { after: "desktop" },
                },
                { type: "set", id: "launch", collapsed: true },
                {
                    type: "insert",
                    node: { type: "section", id: "older", label: "Older" },
                    to: { after: "happy" },
                },
                {
                    type: "insert",
                    node: { type: "section", id: "now", label: "Active" },
                    to: { after: "happy" },
                },
            ],
            rules,
        );
        expect(result.operations.map((operation) => operation.type)).toEqual([
            "insert",
            "move",
            "insert",
            "move",
            "insert",
        ]);
        expect(result.notes).toEqual([
            "Dropped move busy after done: busy is active in the last two hours; it is not finished.",
            "Dropped move mine after happy: Keep the person's edit of this proposal.",
            "Dropped move helper after stale: helper is a bot.",
            expect.stringMatching(
                /^Dropped .*launch.*: busy was active in the last two hours; keep it shown\.$/,
            ),
            expect.stringMatching(
                /Section "Older" sorts by age, status, or whether work is finished/,
            ),
            expect.stringMatching(
                /Section "Active" sorts by age, status, or whether work is finished/,
            ),
        ]);
        expect(archiveOffers(result.document)).toEqual(["done"]);
        // The sidebar never takes the Archive heading or what accepting archives.
        expect(formatSpaceSidebar(withoutArchive(result.document, new Set(["done"])))).toBe(
            formatSpaceSidebar(
                doc(
                    '<happy-space id="happy"/>',
                    '<happy-section id="desktop" label="Desktop"/>',
                    '<happy-section id="launch" label="Launch"/>',
                    '<happy-space id="mine"/>',
                    '<happy-space id="busy"/>',
                    '<happy-section id="bots" label="Bots"/>',
                    '<happy-space id="helper"/>',
                    '<happy-section id="stale" label="Stale" collapsed="true"/>',
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
});
