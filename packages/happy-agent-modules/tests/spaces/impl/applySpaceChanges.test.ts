import { describe, expect, it } from "vitest";

import type { SpaceRecord, SpaceSectionRecord } from "../../../sources/spaces/index.js";
import { applySpaceChanges, compareRows } from "../../../sources/spaces/impl/applySpaceChanges.js";

const OWNER = "standalone";
const NOW = 1_000;

function row(id: string, orderKey: string, extra: Partial<SpaceRecord> = {}): SpaceRecord {
    return {
        id,
        ownerUserId: OWNER,
        role: "item",
        contents: [{ kind: "task", taskId: `${id}task`, agentId: `${id}agent` }],
        orderKey,
        placement: "settled",
        visibility: "shown",
        version: 1,
        createdAt: 0,
        updatedAt: 0,
        ...extra,
    };
}

function section(id: string, name: string, orderKey: string): SpaceSectionRecord {
    return {
        id,
        ownerUserId: OWNER,
        name,
        collapsed: false,
        tailExpanded: false,
        orderKey,
        version: 1,
        createdAt: 0,
        updatedAt: 0,
    };
}

const titles = new Map([
    ["rowa", "Release notes"],
    ["rowb", "Viewer release"],
    ["rowc", "Status probe"],
]);

describe("applySpaceChanges", () => {
    it("gives evacuated protected rows fresh keys after Happy while preserving their section order", () => {
        const spaces = [
            row("happy", "1", { role: "happy" }),
            row("existing", "2"),
            row("rowb", "1", { sectionId: "secold" }),
            row("quiet", "2", { sectionId: "secold" }),
            row("rowa", "05", { sectionId: "secold" }),
        ];
        const outcome = applySpaceChanges(
            OWNER,
            spaces,
            [section("secold", "Work", "1")],
            [{ type: "remove_section", sectionId: "secold" }],
            titles,
            NOW,
            new Set(["rowa", "rowb"]),
        );
        const updated = new Map(outcome.spaces.map(({ space }) => [space.id, space]));
        const shown = spaces
            .map((space) => updated.get(space.id) ?? space)
            .filter((space) => space.visibility === "shown" && space.sectionId === undefined)
            .sort(compareRows);
        expect(shown.map((space) => space.id)).toEqual(["happy", "rowa", "rowb", "existing"]);
        expect(updated.get("rowa")?.orderKey).not.toBe("05");
        expect(updated.get("rowb")?.orderKey).not.toBe("1");
        expect(updated.get("quiet")?.visibility).toBe("folded");
        expect(outcome.changes.find((change) => change.spaceId === "rowa")?.to.index).toBe(0);
        expect(outcome.changes.find((change) => change.spaceId === "rowb")?.to.index).toBe(1);
    });

    it("keeps protected work shown after section removal and checks the final batch outcome", () => {
        const outcome = applySpaceChanges(
            OWNER,
            [row("rowa", "1", { sectionId: "secold" }), row("rowb", "2", { sectionId: "secold" })],
            [section("secold", "Work", "1")],
            [
                { type: "visibility", spaceId: "rowa", visibility: "hidden" },
                { type: "place", spaceId: "rowa", sectionId: "secold" },
                { type: "remove_section", sectionId: "secold" },
            ],
            titles,
            NOW,
            new Set(["rowa"]),
        );
        expect(outcome.removedSectionIds).toEqual(["secold"]);
        expect(
            outcome.spaces.map(({ space }) => ({
                id: space.id,
                visibility: space.visibility,
                sectionId: space.sectionId,
            })),
        ).toEqual([
            { id: "rowa", visibility: "shown", sectionId: undefined },
            { id: "rowb", visibility: "folded", sectionId: undefined },
        ]);
        expect(outcome.changes.find((change) => change.spaceId === "rowa")?.to.visibility).toBe(
            "shown",
        );
    });

    it("places a pending row at the top of a new section and records where it came from", () => {
        const outcome = applySpaceChanges(
            OWNER,
            [row("rowa", "5", { placement: "pending" })],
            [],
            [
                { type: "section", sectionId: "secnew", create: true, name: "Releases" },
                { type: "place", spaceId: "rowa", sectionId: "secnew" },
            ],
            titles,
            NOW,
        );
        expect(outcome.createdSections.map(({ name }) => name)).toEqual(["Releases"]);
        expect(outcome.spaces).toHaveLength(1);
        expect(outcome.spaces[0]).toMatchObject({
            previousVersion: 1,
            space: { sectionId: "secnew", placement: "settled", visibility: "shown", version: 2 },
        });
        expect(outcome.changes).toEqual([
            {
                spaceId: "rowa",
                title: "Release notes",
                from: {
                    sectionId: null,
                    sectionName: null,
                    index: 0,
                    visibility: "shown",
                    placement: "pending",
                },
                to: {
                    sectionId: "secnew",
                    sectionName: "Releases",
                    index: 0,
                    visibility: "shown",
                    placement: "settled",
                },
            },
        ]);
        expect(outcome.sectionChanges).toEqual([
            { sectionId: "secnew", name: "Releases", change: "created" },
        ]);
    });

    it("folds a row into Older and reports its new index there", () => {
        const outcome = applySpaceChanges(
            OWNER,
            [row("rowa", "1", { sectionId: "secrel" }), row("rowb", "2", { sectionId: "secrel" })],
            [section("secrel", "Release", "1")],
            [{ type: "visibility", spaceId: "rowa", visibility: "folded" }],
            titles,
            NOW,
        );
        expect(outcome.changes).toHaveLength(1);
        expect(outcome.changes[0]).toMatchObject({
            from: { sectionName: "Release", index: 0, visibility: "shown" },
            to: { visibility: "folded", index: 0 },
        });
        // Its neighbour now sits first, but it did not move by itself, so it is not in the diff.
        expect(outcome.spaces.map(({ space }) => space.id)).toEqual(["rowa"]);
    });

    it("does not create a section the batch leaves empty", () => {
        const outcome = applySpaceChanges(
            OWNER,
            [row("rowc", "1", { placement: "pending" })],
            [],
            [
                { type: "section", sectionId: "secchk", create: true, name: "Checks" },
                { type: "place", spaceId: "rowc", sectionId: "secchk" },
                { type: "visibility", spaceId: "rowc", visibility: "hidden" },
            ],
            titles,
            NOW,
        );
        expect(outcome.createdSections).toEqual([]);
        expect(outcome.sectionChanges).toEqual([]);
        expect(outcome.changes[0]?.to).toMatchObject({ visibility: "hidden", sectionId: null });
    });

    it("folds the rows of a removed section instead of losing them", () => {
        const outcome = applySpaceChanges(
            OWNER,
            [row("rowa", "1", { sectionId: "secold" })],
            [section("secold", "Old", "1")],
            [{ type: "remove_section", sectionId: "secold" }],
            titles,
            NOW,
        );
        expect(outcome.removedSectionIds).toEqual(["secold"]);
        expect(outcome.spaces[0]?.space).toMatchObject({ visibility: "folded" });
        expect(outcome.spaces[0]?.space.sectionId).toBeUndefined();
    });

    it("drops changes to rows and sections that no longer exist, and never moves Happy", () => {
        const happy = row("happyrow", "1", { role: "happy" });
        const outcome = applySpaceChanges(
            OWNER,
            [happy],
            [],
            [
                { type: "place", spaceId: "gone", sectionId: null },
                { type: "visibility", spaceId: "happyrow", visibility: "hidden" },
                { type: "section", sectionId: "secgone", create: false, name: "Renamed" },
            ],
            titles,
            NOW,
        );
        expect(outcome.spaces).toEqual([]);
        expect(outcome.changes).toEqual([]);
        expect(outcome.sectionChanges).toEqual([]);
    });

    it("places a row after another row of the same section", () => {
        const outcome = applySpaceChanges(
            OWNER,
            [
                row("rowa", "1", { sectionId: "secrel" }),
                row("rowb", "2", { sectionId: "secrel" }),
                row("rowc", "3", { sectionId: "secrel" }),
            ],
            [section("secrel", "Release", "1")],
            [{ type: "place", spaceId: "rowc", sectionId: "secrel", afterId: "rowa" }],
            titles,
            NOW,
        );
        expect(outcome.changes[0]).toMatchObject({ from: { index: 2 }, to: { index: 1 } });
        const key = outcome.spaces[0]!.space.orderKey;
        expect(key > "1" && key < "2").toBe(true);
    });
});
