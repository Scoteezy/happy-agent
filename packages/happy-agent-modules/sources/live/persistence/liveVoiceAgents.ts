import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/** Each person's Voice agent, and the outline Voice was last given, by its hash. */
export interface LiveVoiceAgent {
    ownerId: string;
    agentId: string;
    outlineSent: string | undefined;
}

interface Row {
    owner_id: string;
    agent_id: string;
    outline_sent: string | null;
}

const decode = (row: Row): LiveVoiceAgent => ({
    ownerId: row.owner_id,
    agentId: row.agent_id,
    outlineSent: row.outline_sent ?? undefined,
});

export async function readVoiceAgent(
    ctx: Context,
    ownerId: string,
): Promise<LiveVoiceAgent | undefined> {
    const rows = await agentDatabaseRows<Row>(
        ctx.db,
        sql`SELECT owner_id, agent_id, outline_sent FROM happy_live_voice_agents WHERE owner_id = ${ownerId}`,
    );
    return rows[0] === undefined ? undefined : decode(rows[0]);
}

export async function voiceAgents(ctx: Context): Promise<LiveVoiceAgent[]> {
    const rows = await agentDatabaseRows<Row>(
        ctx.db,
        sql`SELECT owner_id, agent_id, outline_sent FROM happy_live_voice_agents`,
    );
    return rows.map(decode);
}

/** A new Voice replaces the person's archived one, and starts without an outline. */
export async function saveVoiceAgent(
    ctx: Context,
    ownerId: string,
    agentId: string,
    now: number,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_live_voice_agents(owner_id, agent_id, outline_sent, created_at)
        VALUES (${ownerId}, ${agentId}, NULL, ${now})
        ON CONFLICT(owner_id) DO UPDATE SET agent_id = excluded.agent_id, outline_sent = NULL,
        created_at = excluded.created_at`,
    );
}

export async function saveOutlineSent(
    ctx: Context,
    ownerId: string,
    agentId: string,
    hash: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`UPDATE happy_live_voice_agents SET outline_sent = ${hash}
        WHERE owner_id = ${ownerId} AND agent_id = ${agentId}`,
    );
}
