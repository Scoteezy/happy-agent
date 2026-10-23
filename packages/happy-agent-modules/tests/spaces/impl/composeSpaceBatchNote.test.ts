import { describe, expect, it } from "vitest";

import type { SpaceBatch } from "../../../sources/spaces/index.js";
import { composeSpaceBatchNote } from "../../../sources/spaces/impl/composeSpaceBatchNote.js";

type Change = SpaceBatch["changes"][number];

const shown = (sectionId: string | null, sectionName: string | null, placement = "settled") =>
    ({ sectionId, sectionName, index: 0, visibility: "shown", placement }) as Change["from"];

function change(title: string, to: Change["to"], extra: Partial<Change> = {}): Change {
    return { spaceId: "rowa", title, from: shown("secrel", "Release"), to, ...extra };
}

describe("composeSpaceBatchNote", () => {
    it("writes one line for a lone move", () => {
        expect(
            composeSpaceBatchNote(
                [change("Preview viewer release", { ...shown(null, null), visibility: "folded" })],
                [],
            ),
        ).toBe("Tucked away Preview viewer release.");
    });

    it("never calls folded work older or done", () => {
        const note = composeSpaceBatchNote(
            [change("Lightbox", { ...shown("quiet", "Later"), visibility: "folded" })],
            [],
        );
        expect(note).toBe("Tucked Lightbox into Later.");
        expect(note).not.toMatch(/older|done/i);
    });

    it("names only the row when the sidebar's separators have no title", () => {
        const untitled = (placement: string) =>
            ({ ...shown("sep", null), placement }) as Change["from"];
        expect(
            composeSpaceBatchNote(
                [change("Android release", untitled("settled"), { from: untitled("pending") })],
                [{ sectionId: "sep", name: "a separator", change: "created" }],
            ),
        ).toBe("Placed Android release.");
        expect(composeSpaceBatchNote([change("Lightbox", untitled("settled"))], [])).toBe(
            "Moved Lightbox.",
        );
        expect(
            composeSpaceBatchNote(
                [],
                [{ sectionId: "sep", name: "a separator", change: "created" }],
            ),
        ).toBe("Added a separator.");
    });

    it("says new work was put in its section", () => {
        expect(
            composeSpaceBatchNote(
                [
                    change("Android release", shown("secrel", "Releases"), {
                        from: shown(null, null, "pending"),
                    }),
                ],
                [{ sectionId: "secrel", name: "Releases", change: "created" }],
            ),
        ).toBe("Put Android release in Releases.");
    });

    it("names two moves and counts the rest", () => {
        const folded = { ...shown(null, null), visibility: "folded" } as Change["to"];
        const hidden = { ...shown(null, null), visibility: "hidden" } as Change["to"];
        expect(
            composeSpaceBatchNote(
                [change("A", folded), change("B", hidden), change("C", hidden)],
                [],
            ),
        ).toBe("Tucked away A, hid B, and 1 more.");
        expect(composeSpaceBatchNote([change("A", folded), change("B", hidden)], [])).toBe(
            "Tucked away A and hid B.",
        );
    });

    it("names every row folded out of view, by the section it went into", () => {
        const into = (sectionId: string, name: string) =>
            ({ ...shown(sectionId, name), visibility: "folded" }) as Change["to"];
        expect(
            composeSpaceBatchNote(
                [
                    change("Pricing page copy", shown("secrel", "Release")),
                    change("Flaky gym chaos seed", into("rel", "Reliability")),
                    change("Daemon memory leak", into("rel", "Reliability")),
                    change("Telegram bridge reconnects", into("rel", "Reliability")),
                    change("Docs site search", into("growth", "Growth")),
                    change("Team invite emails", into("growth", "Growth")),
                ],
                [],
            ),
        ).toBe(
            "Tucked Flaky gym chaos seed, Daemon memory leak and Telegram bridge reconnects into " +
                "Reliability, tucked Docs site search and Team invite emails into Growth, and 1 more.",
        );
        const many = ["A", "B", "C", "D", "E", "F", "G", "H"].map((title) =>
            change(title, into("rel", "Reliability")),
        );
        expect(composeSpaceBatchNote(many, [])).toBe(
            "Tucked A, B, C, D, E, F and 2 others into Reliability.",
        );
    });

    it("names a moved section once, whatever rows travelled with it", () => {
        expect(composeSpaceBatchNote([], [], ["Releases"])).toBe("Moved Releases.");
        const hidden = { ...shown(null, null), visibility: "hidden" } as Change["to"];
        expect(composeSpaceBatchNote([change("Probe", hidden)], [], ["Releases"])).toBe(
            "Moved Releases and hid Probe.",
        );
    });

    it("describes a batch that only changed sections", () => {
        expect(
            composeSpaceBatchNote([], [{ sectionId: "secold", name: "Old", change: "removed" }]),
        ).toBe("Removed Old.");
        expect(
            composeSpaceBatchNote(
                [],
                [
                    { sectionId: "rel", name: "Releases", change: "created" },
                    { sectionId: "sep", name: "a separator", change: "created" },
                ],
            ),
        ).toBe("Added Releases and a separator.");
    });
});
