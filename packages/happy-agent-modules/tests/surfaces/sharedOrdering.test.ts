import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { orderKeyBetween, orderKeyJustBefore } from "../../sources/utils/orderKeyBetween.js";
import { renumberLongOrderKeys } from "../../sources/utils/renumberLongOrderKeys.js";
import { orderKeyBetween as workspaceKey } from "../../sources/workspaces/store/workspaceOrdering.js";
import { taskOrderKeyBetween } from "../../sources/tasks/impl/taskOrderKeyBetween.js";
import { connectionOrderKeyBetween } from "../../sources/connections/impl/connectionOrderKey.js";
import { subtaskOrderKeyBetween } from "../../sources/subtasks/subtaskOrderKeyBetween.js";
import { surfaceOrderKey } from "../../sources/surfaces/impl/surfaceOrderKey.js";
import { projectOrderKeyBetween } from "../../sources/projects/store/projectRootAgentOrdering.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("one decimal fractional ordering implementation", () => {
    it("keeps existing domain entry points on the same function", () => {
        for (const key of [
            workspaceKey,
            taskOrderKeyBetween,
            connectionOrderKeyBetween,
            subtaskOrderKeyBetween,
            surfaceOrderKey,
        ])
            expect(key).toBe(orderKeyBetween);
    });
    it.each([
        [null, null, "5"],
        ["5", null, "6"],
        ["8", null, "9"],
        ["9", null, "91"],
        ["99", null, "9901"],
        ["9909", null, "991"],
        ["991", null, "9911"],
        ["00000000000000000001", null, "1"],
        ["0000000000000000000000000000000000000000000000000000000000000001", null, "1"],
        ["5", "7", "6"],
        ["5", "6", "55"],
        ["55", "6", "57"],
        [null, "5", "4"],
        [null, "1", "09"],
        [null, "01", "0099"],
        [null, "0091", "009"],
        [null, "009", "0089"],
        [null, "00000000000000000001", "00000000000000000000999999999999"],
        ["00000000000000000010", "00000000000000000011", "000000000000000000105"],
    ])("uses existing keys between %s and %s", (before, after, expected) => {
        expect(orderKeyBetween(before, after)).toBe(expected);
        expect(projectOrderKeyBetween(before, after)).toBe(expected);
    });
    it("inserts among mixed padded integer and fractional keys without rewriting neighbours", () => {
        const keys = ["00000000000000000001", "00000000000000000002", "5", "7"];
        const originals = [...keys];
        for (let step = 0; step < 500; step++) {
            const index = (step * 31) % (keys.length + 1);
            const before = keys[index - 1] ?? null;
            const after = keys[index] ?? null;
            const key = orderKeyBetween(before, after);
            expect(key).toMatch(/^[0-9]*[1-9]$/);
            if (before !== null) expect(key > before).toBe(true);
            if (after !== null) expect(key < after).toBe(true);
            keys.splice(index, 0, key);
        }
        expect(keys).toEqual([...keys].sort());
        for (const key of originals) expect(keys).toContain(key);
    });
    it.each([
        ["first", (keys: string[]) => orderKeyBetween(null, keys[0] ?? null), 0],
        ["last", (keys: string[]) => orderKeyBetween(keys.at(-1) ?? null, null), -1],
    ] as const)("keeps keys short when work is placed %s again and again", (_, next, at) => {
        const keys: string[] = [];
        for (let step = 0; step < 1_000; step++) {
            const key = next(keys);
            expect(key).toMatch(/^[0-9]*[1-9]$/);
            if (at === 0) keys.unshift(key);
            else keys.push(key);
        }
        expect(keys).toEqual([...keys].sort());
        expect(new Set(keys).size).toBe(keys.length);
        expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(8);
    });
});

describe("order keys at a fixed row", () => {
    it("steps just below the next row and refuses bounds with nothing between them", () => {
        expect(orderKeyJustBefore("1", "5")).toBe("4");
        expect(orderKeyJustBefore("1", "2")).toBe("19");
        expect(orderKeyJustBefore("1", "11")).toBe("1099");
        expect(orderKeyJustBefore(null, "00000000000000000010")).toBe(
            "00000000000000000009999999999999",
        );
        expect(() => orderKeyJustBefore("1", "10")).toThrow("Order keys are out of order.");
        expect(() => orderKeyBetween(null, "0")).toThrow("Order keys are out of order.");
        // Nothing sorts between a key and the same key with zeros after it.
        expect(() => orderKeyBetween("1", "10")).toThrow("Order keys are out of order.");
        expect(() => orderKeyBetween("0000000000000000001", "00000000000000000010")).toThrow(
            "Order keys are out of order.",
        );
        expect(orderKeyBetween("00000000000000000010", null)).toBe("1");
    });
});

describe("renumbering long order keys", () => {
    async function table() {
        const database = moduleDatabase([], "renumber-order-keys");
        await database.ready;
        await agentDatabaseRun(
            database.database,
            sql`CREATE TABLE rows (owner TEXT NOT NULL, id TEXT NOT NULL, order_key TEXT NOT NULL,
                version INTEGER NOT NULL, PRIMARY KEY (owner, id))`,
        );
        const insert = async (owner: string, id: string, key: string) =>
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO rows VALUES (${owner}, ${id}, ${key}, 1)`,
            );
        const read = async (owner: string) =>
            await agentDatabaseRows<{ id: string; order_key: string; version: number }>(
                database.database,
                sql`SELECT id, order_key, version FROM rows WHERE owner = ${owner}
                    ORDER BY order_key, id`,
            );
        return { database, insert, read };
    }

    it("renumbers only lists holding a key past half the bound, in order, ties by ID", async () => {
        const { database, insert, read } = await table();
        try {
            await insert("long", "c", "1");
            await insert("long", "b", "0001");
            await insert("long", "a", "0001");
            await insert("long", "d", "000000001");
            await insert("short", "e", "00000001");
            const list = {
                table: "rows",
                listColumns: ["owner"],
                idColumn: "id",
                maxLength: 16,
                versioned: true,
            };
            await renumberLongOrderKeys(database.database, list);
            expect(await read("long")).toEqual([
                { id: "d", order_key: "2", version: 2 },
                { id: "a", order_key: "4", version: 2 },
                { id: "b", order_key: "6", version: 2 },
                { id: "c", order_key: "8", version: 2 },
            ]);
            expect(await read("short")).toEqual([{ id: "e", order_key: "00000001", version: 1 }]);
            await renumberLongOrderKeys(database.database, list);
            expect((await read("long")).map((row) => row.version)).toEqual([2, 2, 2, 2]);
        } finally {
            database.close();
        }
    });

    it("renumbers a whole table as one list, leaving room between neighbours", async () => {
        const { database, insert, read } = await table();
        try {
            for (let index = 0; index < 12; index++)
                await insert(
                    index % 2 === 0 ? "x" : "y",
                    `r${String(index).padStart(2, "0")}`,
                    `${"0".repeat(40 - index)}1`,
                );
            await renumberLongOrderKeys(database.database, {
                table: "rows",
                listColumns: [],
                idColumn: "id",
                maxLength: 64,
                versioned: false,
            });
            const keys = [...(await read("x")), ...(await read("y"))]
                .sort((left, right) => (left.order_key < right.order_key ? -1 : 1))
                .map((row) => [row.id, row.order_key]);
            expect(keys.map(([id]) => id)).toEqual(
                Array.from({ length: 12 }, (_, index) => `r${String(index).padStart(2, "0")}`),
            );
            expect(keys.map(([, key]) => key)).toEqual([
                "076",
                "152",
                "228",
                "304",
                "38",
                "456",
                "532",
                "608",
                "684",
                "76",
                "836",
                "912",
            ]);
            expect((await read("x"))[0]?.version).toBe(1);
        } finally {
            database.close();
        }
    });
});
