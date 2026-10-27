import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    openAgentSQLiteDatabase,
    withAgentDatabase,
} from "@slopus/happy-agent-base";
import { createRootContext, type Context, type RootContext } from "@steve.kite/stdlib";
import { sql, type SQL } from "drizzle-orm";
import { expect, it } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";
import type { UsageRecord, UsageRunBreakdown } from "../../sources/usage/Usage.js";
import { UsageModule } from "../../sources/usage/UsageModule.js";
import { UsageDatabase } from "../../sources/usage/impl/usageDatabase.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000 + 37 * 60 * 1_000 + 451;
/** Roughly the installation this was measured on: 205k records, 130k of them in the last month. */
const OLDER_RECORDS = 75_000;
const RECENT_RECORDS = 130_000;
const INSERT_BATCH = 500;

/** The pre-totals window query, kept as the "before" measurement and the exactness oracle. */
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
                   COUNT(*) FILTER (WHERE ${STARTED_AT} IS NULL
                        OR json_extract(record_json, '$.durationMs') IS NULL
                        OR json_extract(record_json, '$.finishedAt') IS NULL
                        OR json_extract(record_json, '$.durationMs')
                            != json_extract(record_json, '$.finishedAt') - ${STARTED_AT})
                        AS inconsistent
            FROM happy_agent_usage_records
            WHERE ${STARTED_AT} >= ${Math.min(...cutoffs)} AND kind = 'inference'
              AND json_extract(record_json, '$.model') IS NOT NULL
            GROUP BY provider, model
            ORDER BY provider, model`,
    );
    const windows = cutoffs.map<UsageRunBreakdown>(() => ({}));
    for (const row of rows) {
        expect(Number(row["inconsistent"])).toBe(0);
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

/** One stored record, shaped and sized like the ones the daemon writes. */
function storedRecord(index: number, startedAt: number): UsageRecord {
    const provider = ["claude", "codex", "grok", "claude-work"][index % 4] as string;
    const model = `${provider}/model-${index % 5}`;
    const agentId = `agent-${String(index % 2_000).padStart(24, "0")}`;
    const runId = `run-${String(Math.floor(index / 7)).padStart(32, "0")}`;
    const durationMs = 1_000 + (index % 60_000);
    const finishedAt = startedAt + durationMs;
    const inference = index % 14 !== 0;
    const record = {
        id: `record-${String(index).padStart(32, "0")}`,
        agentId,
        provider,
        model,
        effort: "high",
        kind: inference ? "inference" : "turn",
        runId,
        startedAt,
        finishedAt,
        durationMs,
        ...(inference
            ? {
                  state: "normal",
                  tokens: {
                      input: 1 + (index % 9_000),
                      output: index % 700,
                      cacheRead: (index * 13) % 80_000,
                      cacheWrite: (index * 7) % 5_000,
                  },
              }
            : { aborted: false, contextTokens: 40_000 + (index % 100_000) }),
    };
    return record as UsageRecord;
}

/**
 * The longest the event loop went without running a timer while `work` ran.
 *
 * A 1 ms interval records every gap between its ticks, so a synchronous stretch of database work
 * shows up as one long gap: exactly what a concurrent request would have waited behind.
 */
async function longestStall(work: () => Promise<void>): Promise<number> {
    let last = performance.now();
    let longest = 0;
    const probe = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
    }, 1);
    try {
        await sleep(5);
        last = performance.now();
        longest = 0;
        await work();
        await sleep(5);
    } finally {
        clearInterval(probe);
    }
    return longest;
}

async function seed(ctx: Context): Promise<void> {
    const total = OLDER_RECORDS + RECENT_RECORDS;
    for (let start = 0; start < total; start += INSERT_BATCH) {
        const rows: SQL[] = [];
        for (let index = start; index < Math.min(total, start + INSERT_BATCH); index++) {
            const startedAt =
                index < OLDER_RECORDS
                    ? NOW - 90 * DAY + Math.floor((index / OLDER_RECORDS) * 60 * DAY)
                    : NOW -
                      30 * DAY +
                      Math.floor(((index - OLDER_RECORDS) / RECENT_RECORDS) * 30 * DAY);
            const record = storedRecord(index, startedAt);
            const values = [
                record.id,
                record.agentId,
                record.runId,
                record.finishedAt,
                record.kind,
                JSON.stringify(record),
            ];
            rows.push(
                sql`(${sql.join(
                    values.map((value) => sql`${value}`),
                    sql`, `,
                )})`,
            );
        }
        await ctx.inTx(async (txCtx) => {
            await agentDatabaseRun(
                txCtx.db,
                sql`INSERT INTO happy_agent_usage_records
                        (record_id, agent_id, run_id, finished_at, kind, record_json)
                    VALUES ${sql.join(rows, sql`, `)}`,
            );
        });
    }
}

it(
    "answers the API windows over 200k records in a few milliseconds without stalling",
    { timeout: 300_000 },
    async () => {
        const root = await mkdtemp(join(tmpdir(), "usage-window-performance-"));
        const owner = await openAgentSQLiteDatabase(join(root, "agent.sqlite"));
        try {
            const ctx = (
                withAgentDatabase(createRootContext(), owner.database) as RootContext
            ).named("usage-window-performance");
            const module = new UsageModule(new EventsModule());
            const migrations = module.migrations.filter(
                ([key]) => key !== "006-usage-hourly-totals",
            );
            for (const [, migrate] of migrations) await migrate(ctx, owner.database);
            await seed(ctx);

            // The windows `GET /v0/usage` asks for.
            const cutoffs = [NOW - HOUR, NOW - DAY, NOW - 7 * DAY, NOW - 30 * DAY];
            let scanned: UsageRunBreakdown[] = [];
            const scanStallMs = await longestStall(async () => {
                scanned = await scannedWindows(ctx, cutoffs);
            });

            const [, migrate] = module.migrations.find(
                ([key]) => key === "006-usage-hourly-totals",
            )!;
            let started = performance.now();
            await ctx.inTx(
                async (txCtx) => await migrate(txCtx, txCtx.db as typeof owner.database),
            );
            const migrationMs = performance.now() - started;

            const store = new UsageDatabase();
            expect(JSON.stringify(await store.windowUsage(ctx, cutoffs))).toBe(
                JSON.stringify(scanned),
            );

            const durations: number[] = [];
            const stallMs = await longestStall(async () => {
                for (let call = 0; call < 50; call++) {
                    started = performance.now();
                    await store.windowUsage(ctx, cutoffs);
                    durations.push(performance.now() - started);
                    await sleep(2);
                }
            });
            durations.sort((a, b) => a - b);
            const median = durations[Math.floor(durations.length / 2)] as number;
            const slowest = durations[durations.length - 1] as number;

            // Recording an inference now also moves its hourly bucket; it must stay cheap.
            started = performance.now();
            for (let index = 0; index < 500; index++) {
                await store.record(
                    ctx,
                    storedRecord(1_000_000 + index, NOW - 10 * 60 * 1_000 + index),
                );
            }
            const recordMs = (performance.now() - started) / 500;

            console.info(
                `usage windows over ${OLDER_RECORDS + RECENT_RECORDS} records: ` +
                    `record scan stalled the loop ${scanStallMs.toFixed(1)} ms; ` +
                    `migration ${migrationMs.toFixed(0)} ms; ` +
                    `windows median ${median.toFixed(2)} ms, slowest ${slowest.toFixed(2)} ms, ` +
                    `longest stall ${stallMs.toFixed(1)} ms; record ${recordMs.toFixed(3)} ms`,
            );
            // The scan this replaces held the loop for hundreds of milliseconds on the same data.
            expect(slowest).toBeLessThan(50);
            expect(stallMs).toBeLessThan(50);
            expect(JSON.stringify(await store.windowUsage(ctx, cutoffs))).toBe(
                JSON.stringify(await scannedWindows(ctx, cutoffs)),
            );
        } finally {
            await owner.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
