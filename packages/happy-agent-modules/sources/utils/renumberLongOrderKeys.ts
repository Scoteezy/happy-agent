import { agentDatabaseRows, agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { sql, type SQL } from "drizzle-orm";

/** One stored list of fractional order keys, read in `(order_key, id)` order. */
export interface OrderKeyList {
    readonly table: string;
    /** Non-null columns naming one list; no columns means the whole table is one list. */
    readonly listColumns: readonly string[];
    /** The column breaking ties between equal keys, unique within a list. */
    readonly idColumn: string;
    /** The longest key the store accepts. */
    readonly maxLength: number;
    /** Whether each row's `version` advances when its key changes, so clients take the new key. */
    readonly versioned: boolean;
}

/**
 * Gives every list holding a key longer than half the store's bound fresh, evenly spaced keys in
 * its existing order. Keys stepped from one no longer than that can still double once and fit, so
 * the list can keep taking work at either end. Only lists with such a key are read.
 */
export async function renumberLongOrderKeys(
    database: AgentDatabase,
    list: OrderKeyList,
): Promise<void> {
    const table = sql.raw(list.table);
    const id = sql.raw(list.idColumn);
    const columns = list.listColumns.map((column) => sql.raw(column));
    const long = sql`length(order_key) > ${Math.floor(list.maxLength / 2)}`;
    const groups = await agentDatabaseRows<Record<string, unknown>>(
        database,
        columns.length === 0
            ? sql`SELECT 1 AS whole FROM ${table} WHERE ${long} LIMIT 1`
            : sql`SELECT DISTINCT ${sql.join(columns, sql`, `)} FROM ${table} WHERE ${long}`,
    );
    const version: SQL = list.versioned ? sql`, version = version + 1` : sql``;
    for (const group of groups) {
        const inList = list.listColumns.map((column) => sql`${sql.raw(column)} = ${group[column]}`);
        const rows = await agentDatabaseRows<{ readonly id: string }>(
            database,
            sql`SELECT ${id} AS id FROM ${table}
                ${inList.length === 0 ? sql`` : sql`WHERE ${sql.join(inList, sql` AND `)}`}
                ORDER BY order_key, ${id}`,
        );
        const keys = spreadOrderKeys(rows.length);
        for (const [index, row] of rows.entries()) {
            const where = sql.join([...inList, sql`${id} = ${row.id}`], sql` AND `);
            await agentDatabaseRun(
                database,
                sql`UPDATE ${table} SET order_key = ${keys[index]}${version} WHERE ${where}`,
            );
        }
    }
}

/** `count` ascending keys of one width, with at least one free digit between neighbours. */
function spreadOrderKeys(count: number): readonly string[] {
    let width = 1;
    while (10 ** width < (count + 1) * 10) width += 1;
    const step = BigInt(10) ** BigInt(width) / BigInt(count + 1);
    return Array.from({ length: count }, (_, index) =>
        (step * BigInt(index + 1)).toString().padStart(width, "0").replace(/0+$/, ""),
    );
}
