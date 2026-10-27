import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    spaceMigrations,
    SpaceStorageError,
    type SpaceRecord,
} from "../../sources/spaces/index.js";
import { SPACE_OWNERS_TABLE } from "../../sources/spaces/SpaceMigrations.js";
import {
    deletePendingChanges,
    SIDEBAR_MUTATIONS_KEPT,
    insertSection,
    insertSidebarMutation,
    insertSpace,
    insertSpaceIfAbsent,
    queryOwnersWithPendingChanges,
    queryOwnerState,
    queryOwnerStates,
    queryPendingChanges,
    querySections,
    querySidebarMutation,
    querySpace,
    querySpaceByRef,
    querySpaces,
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

    it("frees a row's content key when the row hands its content over", async () => {
        const database = moduleDatabase(spaceMigrations, "spaces-handover");
        await database.ready;
        const ctx = database.context;
        const seeded = stemCell("rowaaaaaaaaaaaaaaaaaaaaa");
        await insertSpace(ctx, seeded);
        await updateSpace(ctx, { ...seeded, contents: [], visibility: "hidden", version: 2 }, 1);
        await insertSpace(ctx, stemCell("rowbbbbbbbbbbbbbbbbbbbbb"));
        expect(
            (await querySpaceByRef(ctx, "standalone", "task:taskaaaaaaaaaaaaaaaaaaaa"))?.id,
        ).toBe("rowbbbbbbbbbbbbbbbbbbbbb");
        database.close();
    });

    it("seeds one row per piece of work however often seeding runs", async () => {
        const database = moduleDatabase(spaceMigrations, "spaces-seed");
        await database.ready;
        const ctx = database.context;
        expect(await insertSpaceIfAbsent(ctx, stemCell("rowaaaaaaaaaaaaaaaaaaaaa"))).toBe(true);
        expect(await insertSpaceIfAbsent(ctx, stemCell("rowbbbbbbbbbbbbbbbbbbbbb"))).toBe(false);
        expect((await querySpacesByAgent(ctx, AGENT)).map(({ id }) => id)).toEqual([
            "rowaaaaaaaaaaaaaaaaaaaaa",
        ]);
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

    it("reads state a newer build added fields to, and skips only a person whose state is unreadable", async () => {
        const database = moduleDatabase(spaceMigrations, "spaces-owner-tolerance");
        await database.ready;
        const ctx = database.context;
        const store = async (ownerUserId: string, state: unknown) =>
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(SPACE_OWNERS_TABLE)} (owner_user_id, state_json)
                    VALUES (${ownerUserId}, ${JSON.stringify(state)})`,
            );
        await store("standalone", {
            ownerUserId: "standalone",
            sidebarPlacedIds: ["desktop"],
            fieldFromANewerBuild: { anything: true },
        });
        await store("ownerbbbbbbbbbbbbbbbbbbb", {
            ownerUserId: "ownerbbbbbbbbbbbbbbbbbbb",
            sidebarPlacedIds: "not a list",
        });

        expect(await queryOwnerState(ctx, "standalone")).toEqual({
            ownerUserId: "standalone",
            sidebarPlacedIds: ["desktop"],
        });
        await expect(queryOwnerState(ctx, "ownerbbbbbbbbbbbbbbbbbbb")).rejects.toBeInstanceOf(
            SpaceStorageError,
        );
        expect((await queryOwnerStates(ctx)).map((state) => state.ownerUserId)).toEqual([
            "standalone",
        ]);
        database.close();
    });

    it("turns the manual lists into authorship and drops queued whole documents with a note", async () => {
        const index = spaceMigrations.findIndex(([key]) => key === "007-sidebar-operations");
        const migration = spaceMigrations[index]!;
        const database = moduleDatabase(
            spaceMigrations.slice(0, index),
            "spaces-sidebar-operations",
        );
        await database.ready;
        const ctx = database.context;
        const store = async (ownerUserId: string, state: unknown) =>
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(SPACE_OWNERS_TABLE)} (owner_user_id, state_json)
                    VALUES (${ownerUserId}, ${JSON.stringify(state)})`,
            );
        await store("standalone", {
            ownerUserId: "standalone",
            sidebarManualIds: ["desktop", "rowaaaaaaaaaaaaaaaaaaaaa"],
            sidebarManualFolds: ["desktop", "happy-row"],
            sidebarPending: [{ html: "<nav/>", baseVersion: 3, operationId: "edit" }],
            sidebarBrief: ["Earlier."],
        });
        await store("ownerbbbbbbbbbbbbbbbbbbb", {
            ownerUserId: "ownerbbbbbbbbbbbbbbbbbbb",
            sidebarPlacedIds: ["untouched"],
        });

        await migration[1](ctx, database.database);

        expect(await queryOwnerState(ctx, "standalone")).toEqual({
            ownerUserId: "standalone",
            sidebarAuthorship: {
                desktop: { place: "person", label: "person", fold: "person" },
                rowaaaaaaaaaaaaaaaaaaaaa: { place: "person", label: "person" },
                "happy-row": { fold: "person" },
            },
            sidebarPending: [],
            sidebarBrief: [
                "Earlier.",
                "Your queued sidebar edits were discarded when the sidebar moved to operations. Read it again and redo what is still needed.",
            ],
        });
        expect(await queryOwnerState(ctx, "ownerbbbbbbbbbbbbbbbbbbb")).toEqual({
            ownerUserId: "ownerbbbbbbbbbbbbbbbbbbb",
            sidebarPlacedIds: ["untouched"],
        });
        database.close();
    });

    it("answers a retried sidebar batch and keeps only each person's latest batches", async () => {
        const database = moduleDatabase(spaceMigrations, "spaces-sidebar-mutations");
        await database.ready;
        const ctx = database.context;
        const mutation = (mutationId: string, appliedAt: number) => ({
            ownerUserId: "standalone",
            mutationId,
            version: 2,
            author: "person" as const,
            digest: "a".repeat(64),
            operations: [{ type: "remove" as const, id: "rowaaaaaaaaaaaaaaaaaaaaa" }],
            appliedAt,
        });
        await insertSidebarMutation(ctx, mutation("first", 1));
        await expect(insertSidebarMutation(ctx, mutation("first", 2))).rejects.toThrow();
        expect(await querySidebarMutation(ctx, "standalone", "first")).toEqual(
            mutation("first", 1),
        );
        expect(
            await querySidebarMutation(ctx, "ownerbbbbbbbbbbbbbbbbbbb", "first"),
        ).toBeUndefined();
        for (let index = 0; index < SIDEBAR_MUTATIONS_KEPT; index++)
            await insertSidebarMutation(ctx, mutation(`later-${String(index)}`, 10 + index));
        expect(await querySidebarMutation(ctx, "standalone", "first")).toBeUndefined();
        expect(await querySidebarMutation(ctx, "standalone", "later-0")).toBeDefined();
        database.close();
    });

    it("renumbers a sidebar whose keys grew long after Happy, keeping its order", async () => {
        const database = moduleDatabase(spaceMigrations.slice(0, 10), "spaces-order-keys");
        await database.ready;
        const ctx = database.context;
        const row = (index: number, orderKey: string, ownerUserId = "standalone") => ({
            ...stemCell(`row${String(index).padStart(21, "a")}`, ownerUserId),
            contents: [
                {
                    kind: "task" as const,
                    taskId: `task${String(index).padStart(20, "a")}`,
                    agentId: `agent${String(index).padStart(19, "a")}`,
                },
            ],
            orderKey,
        });
        await insertSpace(ctx, { ...row(0, "1"), role: "happy" });
        // Released builds put each arrival between Happy and the top row, one digit at a time.
        for (let index = 1; index <= 40; index++)
            await insertSpace(ctx, row(index, `1${"0".repeat(200 - index)}5`));
        await insertSpace(ctx, row(41, `1${"0".repeat(100)}5`, "ownerbbbbbbbbbbbbbbbbbbb"));
        await insertSection(ctx, {
            id: "secaaaaaaaaaaaaaaaaaaaaa",
            ownerUserId: "standalone",
            name: "Work",
            collapsed: false,
            tailExpanded: false,
            orderKey: "5",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
        });
        const before = (await querySpaces(ctx, "standalone")).map(({ id }) => id);

        const [key, migrate] = spaceMigrations[10];
        expect(key).toBe("011-space-order-keys-renumbered");
        await migrate(ctx, database.database);

        const after = await querySpaces(ctx, "standalone");
        expect(after.map(({ id }) => id)).toEqual(before);
        expect(Math.max(...after.map(({ orderKey }) => orderKey.length))).toBeLessThanOrEqual(3);
        expect(after.every(({ version, updatedAt }) => version === 2 && updatedAt === 1)).toBe(
            true,
        );
        // Another person's sidebar and short section keys are left as they were.
        const theirs = await querySpaces(ctx, "ownerbbbbbbbbbbbbbbbbbbb");
        expect(theirs.map(({ orderKey, version }) => [orderKey.length, version])).toEqual([
            [102, 1],
        ]);
        expect((await querySections(ctx, "standalone")).map(({ version }) => version)).toEqual([1]);
        database.close();
    });
});
