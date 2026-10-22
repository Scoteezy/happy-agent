import { describe, expect, it } from "vitest";

import {
    SurfacesPersistence,
    surfacesMigrations,
} from "../../sources/surfaces/persistence/SurfacesPersistence.js";
import {
    queryAutomaticSurfaceIds,
    queryLastSurfaceOrderKey,
    saveSurfaceLeave,
    clearSurfaceLeave,
} from "../../sources/surfaces/persistence/surfaceAutomaticMembership.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("Surface membership storage upgrades", () => {
    it("preserves old heads and history while selecting only eligible missing memberships", async () => {
        const database = moduleDatabase(surfacesMigrations.slice(0, -1), "surface-upgrade");
        await database.ready;
        try {
            const ctx = database.context;
            const store = new SurfacesPersistence(database.database);
            const rows = [
                { key: "surface.a12345678901234567890123", value: { type: "todo", members: [] } },
                {
                    key: "surface.b12345678901234567890123",
                    value: {
                        type: "document",
                        members: [
                            { userId: "alice", orderKey: "58" },
                            { userId: null, orderKey: "55" },
                        ],
                    },
                },
                { key: "surface.c12345678901234567890123", value: { type: "task", members: [] } },
                {
                    key: "surface.s12345678901234567890123",
                    value: {
                        type: "separator",
                        members: [
                            { userId: "alice", orderKey: "99" },
                            { userId: null, orderKey: "98" },
                        ],
                    },
                },
                // History is deliberately not a head; membership scans must not interpret it.
                { key: "revision.large-history", value: { invalid: "historical data" } },
            ];
            for (const row of rows) await store.writeValue(ctx, row.key, row.value);
            const [, migrate] = surfacesMigrations.at(-1)!;
            await migrate(ctx, database.database);
            for (const row of rows) expect(await store.kv().read(ctx, row.key)).toEqual(row.value);
            expect(await queryAutomaticSurfaceIds(ctx, "alice")).toEqual([
                "a12345678901234567890123",
                "c12345678901234567890123",
            ]);
            expect(
                await queryAutomaticSurfaceIds(ctx, "alice", "s12345678901234567890123"),
            ).toEqual([]);
            expect(await queryLastSurfaceOrderKey(ctx, "alice")).toBe("58");
            expect(await queryLastSurfaceOrderKey(ctx, null)).toBe("55");
            await saveSurfaceLeave(ctx, "alice", "a12345678901234567890123");
            await saveSurfaceLeave(ctx, "alice", "a12345678901234567890123");
            expect(await queryAutomaticSurfaceIds(ctx, "alice")).toEqual([
                "c12345678901234567890123",
            ]);
            expect(await queryAutomaticSurfaceIds(ctx, "bob")).toHaveLength(3);
            await clearSurfaceLeave(ctx, "alice", "a12345678901234567890123");
            expect(
                await queryAutomaticSurfaceIds(ctx, "alice", "a12345678901234567890123"),
            ).toEqual(["a12345678901234567890123"]);
        } finally {
            database.close();
        }
    });
});
