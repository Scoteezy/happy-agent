import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";
import type {
    UsageInferenceRecord,
    UsageRecord,
    UsageRunBreakdown,
    UsageTurnRecord,
} from "../../sources/usage/Usage.js";
import { UsageModule } from "../../sources/usage/UsageModule.js";
import { UsageDatabase } from "../../sources/usage/impl/usageDatabase.js";
import {
    USAGE_BUCKET_MS,
    USAGE_INDEXED_STARTED_AT,
} from "../../sources/usage/impl/usageHourlyTotalsMigration.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

type Handle = ModuleDatabase & {
    readonly database: import("@slopus/happy-agent-base").AgentDatabase;
};

const HOUR = USAGE_BUCKET_MS;
const DAY = 24 * HOUR;
/** An hour boundary, so fixtures can sit exactly on, just before, and just after one. */
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % HOUR) + 17 * 60 * 1_000 + 123;

/** A database migrated up to, but not including, the usage migration at `stopBefore`. */
async function withDatabase<T>(
    name: string,
    callback: (database: Handle, module: UsageModule) => Promise<T>,
    stopBefore?: string,
): Promise<T> {
    const events = new EventsModule();
    const database = moduleDatabase(events.migrations, name) as Handle;
    await database.ready;
    const module = new UsageModule(events);
    try {
        for (const [key, migration] of module.migrations) {
            if (key === stopBefore) break;
            await migration(database.context, database.database);
        }
        return await callback(database, module);
    } finally {
        database.close();
    }
}

/** The installation-wide window query as it stood before hourly totals: a scan of every record. */
async function scannedWindows(
    ctx: Context,
    cutoffs: readonly number[],
): Promise<UsageRunBreakdown[]> {
    const STARTED_AT = sql`json_extract(record_json, '$.startedAt')`;
    const sums = cutoffs.flatMap((cutoff, index) =>
        ["input", "output", "cacheRead", "cacheWrite"].map(
            (name) =>
                sql`COALESCE(SUM(COALESCE(json_extract(record_json, ${`$.tokens.${name}`}), 0))
                        FILTER (WHERE ${STARTED_AT} >= ${cutoff}), 0) AS ${sql.raw(`${name}_${index}`)}`,
        ),
    );
    const rows = await agentDatabaseRows<Record<string, number | string | null>>(
        ctx.db,
        sql`SELECT json_extract(record_json, '$.provider') AS provider,
                   json_extract(record_json, '$.model') AS model,
                   ${sql.join(sums, sql`, `)},
                   COUNT(*) FILTER (WHERE json_extract(record_json, '$.durationMs')
                        != json_extract(record_json, '$.finishedAt') - ${STARTED_AT}) AS inconsistent
            FROM happy_agent_usage_records
            WHERE ${STARTED_AT} >= ${Math.min(...cutoffs)} AND kind = 'inference'
              AND json_extract(record_json, '$.model') IS NOT NULL
            GROUP BY provider, model
            ORDER BY provider, model`,
    );
    const windows = cutoffs.map<UsageRunBreakdown>(() => ({}));
    for (const row of rows) {
        if (Number(row["inconsistent"]) > 0) throw new Error("duration contradicts its span");
        cutoffs.forEach((_cutoff, index) => {
            const tokens = {
                input: Number(row[`input_${index}`]),
                output: Number(row[`output_${index}`]),
                cacheRead: Number(row[`cacheRead_${index}`]),
                cacheWrite: Number(row[`cacheWrite_${index}`]),
            };
            if (Object.values(tokens).every((count) => count === 0)) return;
            const window = windows[index] as UsageRunBreakdown;
            window[String(row["provider"])] = {
                ...window[String(row["provider"])],
                [String(row["model"])]: tokens,
            };
        });
    }
    return windows;
}

/** Mulberry32: small, seeded, and the same on every run. */
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

/** A start time that lands on, beside, or between hour boundaries in the last 40 days. */
function startTime(next: () => number): number {
    const hour = NOW - (NOW % HOUR) - Math.floor(next() * 40 * 24) * HOUR;
    const roll = next();
    if (roll < 0.15) return hour;
    if (roll < 0.25) return hour - 1;
    if (roll < 0.35) return hour + 1;
    return hour + Math.floor(next() * HOUR);
}

function randomRecord(next: () => number, index: number): UsageRecord {
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
    const provider = pick(["claude", "codex", "grok", "claude-work"]);
    const model = pick([
        undefined,
        `${provider}/alpha`,
        `${provider}/beta`,
        "shared/model",
        `${provider}/gamma-${index % 3}`,
    ]);
    const startedAt = startTime(next);
    const durationMs = Math.floor(next() * 90_000);
    const common = {
        id: `record-${index}`,
        agentId: `agent-${1 + Math.floor(next() * 8)}`,
        runId: `run-${index % 40}`,
        provider,
        ...(model === undefined ? {} : { model }),
        startedAt,
        finishedAt: startedAt + durationMs,
        durationMs,
    };
    if (next() < 0.15) {
        return { ...common, kind: "turn", aborted: false } satisfies UsageTurnRecord;
    }
    const count = (): number => (next() < 0.1 ? 0 : Math.floor(next() * 50_000));
    return {
        ...common,
        kind: "inference",
        state: "normal",
        tokens: {
            input: count(),
            output: count(),
            ...(next() < 0.7 ? { cacheRead: count() } : {}),
            ...(next() < 0.5 ? { cacheWrite: count() } : {}),
        },
    } satisfies UsageInferenceRecord;
}

/** Cutoff sets the API and other hosts may ask for, including boundary-exact and wide ones. */
function cutoffSets(next: () => number): number[][] {
    const boundary = NOW - (NOW % HOUR) - 5 * HOUR;
    const sets = [
        [NOW - HOUR, NOW - DAY, NOW - 7 * DAY, NOW - 30 * DAY],
        [0],
        [boundary, boundary - 1, boundary + 1, NOW - 45 * DAY],
        [NOW, NOW + HOUR],
        [NOW - 30 * DAY, NOW - HOUR],
    ];
    for (let index = 0; index < 20; index++) {
        const length = 1 + Math.floor(next() * 8);
        sets.push(Array.from({ length }, () => startTime(next) + (next() < 0.3 ? 0 : 1)));
    }
    return sets;
}

async function expectWindowsMatchScan(ctx: Context, next: () => number): Promise<void> {
    const store = new UsageDatabase();
    for (const cutoffs of cutoffSets(next)) {
        const expected = await scannedWindows(ctx, cutoffs);
        const actual = await store.windowUsage(ctx, cutoffs);
        // Serialized, so provider and model order must match too.
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    }
}

async function hourlyRows(handle: Handle): Promise<number> {
    const rows = await agentDatabaseRows<{ count: number }>(
        handle.database,
        sql`SELECT COUNT(*) AS count FROM happy_agent_usage_hourly_totals`,
    );
    return Number(rows[0]?.count);
}

async function insertRaw(
    handle: Handle,
    record: UsageRecord | Record<string, unknown>,
): Promise<void> {
    const value = record as UsageRecord;
    await agentDatabaseRun(
        handle.database,
        sql`INSERT INTO happy_agent_usage_records
                (record_id, agent_id, run_id, finished_at, kind, record_json)
            VALUES (${value.id}, ${value.agentId}, ${value.runId ?? null}, ${value.finishedAt},
                    ${value.kind}, ${JSON.stringify(record)})`,
    );
}

describe("installation-wide usage windows", () => {
    it("match the full record scan on randomized history through writes, rewrites, and resets", async () => {
        await withDatabase("usage-window-randomized", async (handle, module) => {
            const ctx = handle.context;
            const next = random(0x5eed);
            const store = new UsageDatabase();
            for (let index = 0; index < 2_500; index++) {
                await store.record(ctx, randomRecord(next, index));
            }
            await expectWindowsMatchScan(ctx, next);

            // A rewrite moves a record between buckets and models; the totals follow it.
            for (let index = 0; index < 200; index += 7) {
                const moved = randomRecord(next, 10_000 + index);
                await agentDatabaseRun(
                    handle.database,
                    sql`UPDATE happy_agent_usage_records
                        SET record_json = ${JSON.stringify({ ...moved, id: `record-${index}` })},
                            kind = ${moved.kind}
                        WHERE record_id = ${`record-${index}`}`,
                );
            }
            await expectWindowsMatchScan(ctx, next);

            // Deleting records by any route takes them out of their buckets.
            await agentDatabaseRun(
                handle.database,
                sql`DELETE FROM happy_agent_usage_records WHERE record_id LIKE 'record-1%'`,
            );
            await expectWindowsMatchScan(ctx, next);

            for (let agent = 1; agent <= 8; agent++) {
                expect(await module.reset(ctx, `agent-${agent}`)).toBeGreaterThan(0);
                await expectWindowsMatchScan(ctx, next);
            }
            expect(await hourlyRows(handle)).toBe(0);

            await store.record(ctx, randomRecord(next, 20_000));
            await module.resetAll(ctx);
            expect(await hourlyRows(handle)).toBe(0);
            const empty = await store.windowUsage(ctx, [0, NOW - HOUR]);
            expect(empty).toEqual([{}, {}]);
        });
    });

    it("backfills hourly totals from history recorded before the migration", async () => {
        await withDatabase(
            "usage-window-backfill",
            async (handle, module) => {
                const ctx = handle.context;
                const next = random(0xbacf111);
                const store = new UsageDatabase();
                for (let index = 0; index < 1_500; index++) {
                    await store.record(ctx, randomRecord(next, index));
                }
                // A record that is no longer valid JSON must not stop the migration.
                await insertRaw(handle, {
                    id: "corrupt",
                    agentId: "agent-1",
                    finishedAt: NOW,
                    kind: "inference",
                });
                await agentDatabaseRun(
                    handle.database,
                    sql`UPDATE happy_agent_usage_records SET record_json = '{corrupt'
                        WHERE record_id = 'corrupt'`,
                );
                const [, migrate] = module.migrations.find(
                    ([key]) => key === "006-usage-hourly-totals",
                )!;
                await migrate(ctx, handle.database);
                expect(await hourlyRows(handle)).toBeGreaterThan(0);

                await agentDatabaseRun(
                    handle.database,
                    sql`DELETE FROM happy_agent_usage_records WHERE record_id = 'corrupt'`,
                );
                await expectWindowsMatchScan(ctx, next);

                // Records written after the migration land in the same buckets.
                for (let index = 1_500; index < 2_000; index++) {
                    await store.record(ctx, randomRecord(next, index));
                }
                await expectWindowsMatchScan(ctx, next);
            },
            "006-usage-hourly-totals",
        );
    });

    it("refuses a window over a record whose duration contradicts its span, and only then", async () => {
        await withDatabase("usage-window-integrity", async (handle) => {
            const ctx = handle.context;
            const store = new UsageDatabase();
            const hour = NOW - (NOW % HOUR) - 3 * HOUR;
            const startedAt = hour + 20 * 60 * 1_000;
            await insertRaw(handle, {
                id: "contradiction",
                agentId: "agent-1",
                provider: "claude",
                model: "claude/alpha",
                kind: "inference",
                tokens: { input: 1, output: 1 },
                startedAt,
                finishedAt: startedAt + 10,
                durationMs: 999,
            });
            // Inside a window's whole hours, from the buckets.
            await expect(store.windowUsage(ctx, [NOW - DAY])).rejects.toThrow("duration");
            // Inside the partial hour a window starts with, from the records.
            await expect(store.windowUsage(ctx, [hour + 1])).rejects.toThrow("duration");
            await expect(store.windowUsage(ctx, [NOW - HOUR, startedAt - 1])).rejects.toThrow(
                "duration",
            );
            // A window that starts after it never sees it.
            await expect(store.windowUsage(ctx, [startedAt + 1, NOW - HOUR])).resolves.toEqual([
                {},
                {},
            ]);
            await expect(store.windowUsage(ctx, [hour + HOUR])).resolves.toEqual([{}]);
        });
    });

    it("reads the partial hour through the start-time index", async () => {
        await withDatabase("usage-window-index", async (handle) => {
            const plan = await agentDatabaseRows<{ detail: string }>(
                handle.database,
                sql`EXPLAIN QUERY PLAN
                    SELECT record_json FROM happy_agent_usage_records
                    WHERE kind = 'inference'
                      AND ${sql.raw(USAGE_INDEXED_STARTED_AT)} >= ${NOW - HOUR}
                      AND ${sql.raw(USAGE_INDEXED_STARTED_AT)} < ${NOW}`,
            );
            expect(plan.map((row) => row.detail).join("\n")).toContain(
                "happy_agent_usage_records_inference_start",
            );
        });
    });
});
