import { describe, expect, it } from "vitest";

import { spaceMigrations, type SpaceRecord } from "../../sources/spaces/index.js";
import {
    deletePendingChanges,
    insertSpace,
    queryOwnersWithPendingChanges,
    queryPendingChanges,
    querySpace,
    querySpaceByRef,
    querySpacesByAgent,
    updateSpace,
    upsertPendingChange,
} from "../../sources/spaces/persistence/SpacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const AGENT = "agentaaaaaaaaaaaaaaaaaaa";

function stemCell(id: string, ownerUserId = "standalone"): SpaceRecord {
    return {
        id,
        ownerUserId,
        role: "item",
        icon: { type: "stem_cell" },
        contents: [{ kind: "task", taskId: "taskaaaaaaaaaaaaaaaaaaaa", agentId: AGENT }],
        orderKey: "5",
        placement: "pending",
        visibility: "shown",
        version: 1,
        createdAt: 1,
        updatedAt: 1,
    };
}

describe("spaces persistence", () => {
    it("stores rows, finds them by content and conversation, and refuses stale versions", async () => {
        const database = moduleDatabase(spaceMigrations, "spaces-rows");
        await database.ready;
        const ctx = database.context;
        await insertSpace(ctx, stemCell("rowaaaaaaaaaaaaaaaaaaaaa"));
        await expect(insertSpace(ctx, stemCell("rowbbbbbbbbbbbbbbbbbbbbb"))).rejects.toThrow();
        await insertSpace(ctx, stemCell("rowccccccccccccccccccccc", "ownerbbbbbbbbbbbbbbbbbbb"));

        expect(
            (await querySpaceByRef(ctx, "standalone", "task:taskaaaaaaaaaaaaaaaaaaaa"))?.id,
        ).toBe("rowaaaaaaaaaaaaaaaaaaaaa");
        expect((await querySpacesByAgent(ctx, AGENT)).map(({ id }) => id)).toEqual([
            "rowaaaaaaaaaaaaaaaaaaaaa",
            "rowccccccccccccccccccccc",
        ]);

        const stored = (await querySpace(ctx, "rowaaaaaaaaaaaaaaaaaaaaa"))!;
        const { icon: _icon, ...withoutIcon } = stored;
        await updateSpace(ctx, { ...withoutIcon, version: 2 }, 1);
        expect((await querySpace(ctx, stored.id))?.icon).toBeUndefined();
        await expect(updateSpace(ctx, { ...stored, version: 3 }, 1)).rejects.toThrow(
            "The space changed before it could be stored.",
        );
        database.close();
    });

    it("keeps the manager's last word per target, in the order it was given", async () => {
        const database = moduleDatabase(spaceMigrations, "spaces-pending");
        await database.ready;
        const ctx = database.context;
        const place = (sectionId: string | null) =>
            ({ type: "place", spaceId: "rowaaaaaaaaaaaaaaaaaaaaa", sectionId }) as const;
        await upsertPendingChange(ctx, "standalone", "space:a", place(null), 1);
        await upsertPendingChange(
            ctx,
            "standalone",
            "section:s",
            { type: "remove_section", sectionId: "secaaaaaaaaaaaaaaaaaaaaa" },
            2,
        );
        await upsertPendingChange(
            ctx,
            "standalone",
            "space:a",
            place("secaaaaaaaaaaaaaaaaaaaaa"),
            3,
        );

        expect(await queryPendingChanges(ctx, "standalone")).toEqual([
            { type: "remove_section", sectionId: "secaaaaaaaaaaaaaaaaaaaaa" },
            place("secaaaaaaaaaaaaaaaaaaaaa"),
        ]);
        expect(await queryOwnersWithPendingChanges(ctx)).toEqual(["standalone"]);
        await deletePendingChanges(ctx, "standalone", ["space:a"]);
        expect(await queryPendingChanges(ctx, "standalone")).toHaveLength(1);
        await deletePendingChanges(ctx, "standalone");
        expect(await queryOwnersWithPendingChanges(ctx)).toEqual([]);
        database.close();
    });
});
