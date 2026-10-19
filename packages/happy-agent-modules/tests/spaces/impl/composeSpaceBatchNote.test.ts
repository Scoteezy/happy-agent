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
        ).toBe("Moved Preview viewer release to Older.");
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
        ).toBe("Moved A to Older, hid B, and 1 more.");
        expect(composeSpaceBatchNote([change("A", folded), change("B", hidden)], [])).toBe(
            "Moved A to Older and hid B.",
        );
    });

    it("describes a batch that only changed sections", () => {
        expect(
            composeSpaceBatchNote([], [{ sectionId: "secold", name: "Old", change: "removed" }]),
        ).toBe("Removed Old.");
    });
});
