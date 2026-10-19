import { describe, expect, it } from "vitest";

import type { SpaceRecord, SpaceSectionRecord } from "../../../sources/spaces/index.js";
import { applySpaceChanges } from "../../../sources/spaces/impl/applySpaceChanges.js";

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
