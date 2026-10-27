import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * How wide one bucket is, in milliseconds.
 *
 * The triggers below bucket every inference by this width, so the reader must use the same one.
 * Changing it means a new migration that rebuilds the buckets, never an edit to this one.
 * Buckets start at multiples of the width since the epoch.
 */
export const USAGE_BUCKET_MS = 3_600_000;

/**
 * A record's start time exactly as the start-time index stores it.
 *
 * A query reaches the index only by naming this very expression, so the reader uses this constant
 * rather than spelling it again. A record that is not valid JSON has no start time here instead
 * of failing the write that stores it, so the record reads stay the place that refuses it.
 */
export const USAGE_INDEXED_STARTED_AT =
    "CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.startedAt') END";

/**
 * Which records the buckets hold: valid inference attributed to a model, with a start time that
 * can be bucketed. This is exactly the set the installation-wide windows have always summed.
 */
function counted(row: string): string {
    return `json_valid(${row}.record_json)
        AND ${row}.kind = 'inference'
        AND json_type(${row}.record_json, '$.startedAt') = 'integer'
        AND json_extract(${row}.record_json, '$.startedAt') >= 0
        AND json_extract(${row}.record_json, '$.model') IS NOT NULL`;
}

/** One record's fields as a bucket sees them. */
function fields(
    row: string,
): Record<
    | "bucket"
    | "provider"
    | "model"
    | "input"
    | "output"
    | "cacheRead"
    | "cacheWrite"
    | "inconsistent",
    string
> {
    const field = (path: string): string => `json_extract(${row}.record_json, '${path}')`;
    return {
        bucket: `(${field("$.startedAt")} / ${USAGE_BUCKET_MS}) * ${USAGE_BUCKET_MS}`,
        provider: field("$.provider"),
        model: field("$.model"),
        input: `COALESCE(${field("$.tokens.input")}, 0)`,
        output: `COALESCE(${field("$.tokens.output")}, 0)`,
        cacheRead: `COALESCE(${field("$.tokens.cacheRead")}, 0)`,
        cacheWrite: `COALESCE(${field("$.tokens.cacheWrite")}, 0)`,
        // The same contradiction every record read refuses, measured once as the record lands.
        inconsistent: `CASE WHEN ${field("$.durationMs")} IS NULL OR ${field("$.finishedAt")} IS NULL
                                 OR ${field("$.durationMs")} != ${field("$.finishedAt")} - ${field("$.startedAt")}
                            THEN 1 ELSE 0 END`,
    };
}

/** Add one record to its bucket. */
function addRecord(row: string): string {
    const record = fields(row);
    return `INSERT INTO happy_agent_usage_hourly_totals
            (bucket_start, provider, model, records, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, inconsistent_records)
        VALUES (${record.bucket}, ${record.provider}, ${record.model}, 1, ${record.input},
                ${record.output}, ${record.cacheRead}, ${record.cacheWrite}, ${record.inconsistent})
        ON CONFLICT(bucket_start, provider, model) DO UPDATE SET
            records = records + excluded.records,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens,
            cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
            cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
            inconsistent_records = inconsistent_records + excluded.inconsistent_records;`;
}

/** Take one record back out of its bucket, dropping the bucket once nothing is left in it. */
function removeRecord(row: string): string {
    const record = fields(row);
    const bucket = `bucket_start = ${record.bucket}
        AND provider = ${record.provider} AND model = ${record.model}`;
    return `UPDATE happy_agent_usage_hourly_totals SET
            records = records - 1,
            input_tokens = input_tokens - ${record.input},
            output_tokens = output_tokens - ${record.output},
            cache_read_tokens = cache_read_tokens - ${record.cacheRead},
            cache_write_tokens = cache_write_tokens - ${record.cacheWrite},
            inconsistent_records = inconsistent_records - ${record.inconsistent}
        WHERE ${bucket};
        DELETE FROM happy_agent_usage_hourly_totals WHERE ${bucket} AND records = 0;`;
}

/**
 * Hourly provider/model inference totals, kept by triggers on the record table.
 *
 * The installation-wide windows used to scan and parse every record started inside the widest
 * window, and that scan held the daemon's only thread for over half a second on a long-lived
 * installation. Buckets answer every whole hour of a window instead; the reader adds the one
 * partial hour at each window's start from the records themselves, through the start-time index
 * created here, so the answer stays exact to the millisecond.
 *
 * Triggers rather than the recording code keep the buckets, so every insert, delete, and rewrite
 * of a record — a recorded inference, a reset, anything else — moves its bucket inside the very
 * statement that changed the record, and the two cannot drift apart. Each bucket also counts the
 * records in it whose duration contradicts their own span, measured once as the record is
 * written, so a window still refuses to be built out of one without reparsing history to find it.
 *
 * The reader takes the bucket width and the indexed start-time expression from this file because
 * it must match them exactly. Like the rest of a released migration, neither may change.
 */
export async function migrateUsageHourlyTotals(
    _ctx: Context,
    database: AgentDatabaseFacade<AgentDatabase>,
): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`CREATE TABLE happy_agent_usage_hourly_totals (
            bucket_start INTEGER NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            records INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            cache_write_tokens INTEGER NOT NULL,
            inconsistent_records INTEGER NOT NULL,
            PRIMARY KEY (bucket_start, provider, model)
        ) WITHOUT ROWID`,
    );
    const record = fields("record");
    await agentDatabaseRun(
        database,
        sql.raw(`INSERT INTO happy_agent_usage_hourly_totals
                (bucket_start, provider, model, records, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, inconsistent_records)
            SELECT ${record.bucket} AS bucket, ${record.provider} AS provider,
                   ${record.model} AS model, COUNT(*),
                   SUM(${record.input}), SUM(${record.output}),
                   SUM(${record.cacheRead}), SUM(${record.cacheWrite}),
                   SUM(${record.inconsistent})
            FROM happy_agent_usage_records AS record
            WHERE ${counted("record")}
            GROUP BY bucket, provider, model`),
    );
    await agentDatabaseRun(
        database,
        sql.raw(`CREATE INDEX happy_agent_usage_records_inference_start
            ON happy_agent_usage_records (${USAGE_INDEXED_STARTED_AT})
            WHERE kind = 'inference'`),
    );
    await agentDatabaseRun(
        database,
        sql.raw(`CREATE TRIGGER happy_agent_usage_hourly_totals_insert
            AFTER INSERT ON happy_agent_usage_records
            WHEN ${counted("new")}
            BEGIN
                ${addRecord("new")}
            END`),
    );
    await agentDatabaseRun(
        database,
        sql.raw(`CREATE TRIGGER happy_agent_usage_hourly_totals_delete
            AFTER DELETE ON happy_agent_usage_records
            WHEN ${counted("old")}
            BEGIN
                ${removeRecord("old")}
            END`),
    );
    // A rewrite moves the record out of its old bucket and into its new one. Removing and adding
    // commute, so the order the two triggers fire in does not matter.
    await agentDatabaseRun(
        database,
        sql.raw(`CREATE TRIGGER happy_agent_usage_hourly_totals_update_old
            AFTER UPDATE ON happy_agent_usage_records
            WHEN ${counted("old")}
            BEGIN
                ${removeRecord("old")}
            END`),
    );
    await agentDatabaseRun(
        database,
        sql.raw(`CREATE TRIGGER happy_agent_usage_hourly_totals_update_new
            AFTER UPDATE ON happy_agent_usage_records
            WHEN ${counted("new")}
            BEGIN
                ${addRecord("new")}
            END`),
    );
}
