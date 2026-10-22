import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/** Select missing catalog memberships before decoding heads, never historical content. */
export async function queryAutomaticSurfaceIds(
    ctx: Context,
    userId: string,
    surfaceId?: string,
): Promise<readonly string[]> {
    const rows = await agentDatabaseRows<{ id: string }>(
        ctx.db,
        sql`SELECT substr(head.key, 9) AS id FROM happy_agent_surfaces AS head
            WHERE head.key >= 'surface.' AND head.key < 'surface.\uffff'
                AND json_extract(head.value_json, '$.type') != 'separator'
                ${surfaceId === undefined ? sql`` : sql`AND head.key = ${`surface.${surfaceId}`}`}
                AND NOT EXISTS (
                    SELECT 1 FROM json_each(head.value_json, '$.members') AS member
                    WHERE json_extract(member.value, '$.userId') = ${userId}
                )
                AND NOT EXISTS (
                    SELECT 1 FROM happy_agent_surface_leaves AS departure
                    WHERE departure.user_id = ${userId} AND departure.surface_id = substr(head.key, 9)
                )
            ORDER BY head.key LIMIT 100`,
    );
    return rows.map((row) => row.id);
}

/** Record deliberate removal even when there is no current membership. */
export async function saveSurfaceLeave(
    ctx: Context,
    userId: string,
    surfaceId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_agent_surface_leaves (user_id, surface_id)
            VALUES (${userId}, ${surfaceId}) ON CONFLICT DO NOTHING`,
    );
}

/** Only an explicit join clears the person's exclusion. */
export async function clearSurfaceLeave(
    ctx: Context,
    userId: string,
    surfaceId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_agent_surface_leaves WHERE user_id = ${userId} AND surface_id = ${surfaceId}`,
    );
}

/** Appending needs one order key, not every decoded Surface in the catalog. */
export async function queryLastSurfaceOrderKey(
    ctx: Context,
    userId: string | null,
): Promise<string | undefined> {
    const rows = await agentDatabaseRows<{ order_key: string }>(
        ctx.db,
        sql`SELECT json_extract(member.value, '$.orderKey') AS order_key
            FROM happy_agent_surfaces AS head, json_each(head.value_json, '$.members') AS member
            WHERE head.key >= 'surface.' AND head.key < 'surface.\uffff'
                AND json_extract(head.value_json, '$.type') != 'separator'
                AND json_extract(member.value, '$.userId') IS ${userId}
            ORDER BY order_key DESC LIMIT 1`,
    );
    return rows[0]?.order_key;
}
