import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import {
    historyAgentIdSchema,
    historyToolPresentationSchema,
    type HistoryToolPresentation,
} from "../HistoryMessage.js";

/** One successful tool result that showed media or an artifact in a conversation. */
export interface HistoryPresentedResult {
    /** The message's position in the conversation, newest highest. */
    readonly position: number;
    readonly callId: string;
    readonly toolName: string;
    /** When the result was recorded, when the record says. */
    readonly at: number | undefined;
    readonly presentation: Extract<HistoryToolPresentation, { type: "media" | "artifact" }>;
}

/**
 * Successful tool results presenting media or an artifact, newest first, from messages before
 * `beforePosition`. The filter runs in SQL over each message's blocks, so a conversation's other
 * messages are never decoded. `artifactId` narrows the read to that artifact's presentations.
 */
export async function queryToolPresentations(
    ctx: Context,
    agentId: string,
    options: {
        readonly beforePosition?: number;
        readonly limit: number;
        readonly artifactId?: string;
    },
): Promise<HistoryPresentedResult[]> {
    if (!Value.Check(historyAgentIdSchema, agentId)) {
        throw new Error("The history module received an invalid presentation lookup.");
    }
    const before =
        options.beforePosition === undefined
            ? sql``
            : sql`AND history.position < ${options.beforePosition}`;
    const artifact =
        options.artifactId === undefined
            ? sql``
            : sql`AND json_extract(block.value, '$.presentation.artifactId') = ${options.artifactId}`;
    const rows = await agentDatabaseRows<{
        position: number | string;
        at: number | string | null;
        block_json: string;
    }>(
        ctx.db,
        sql`SELECT history.position AS position,
                   json_extract(history.message_json, '$.at') AS at,
                   block.value AS block_json
            FROM happy_agent_module_history AS history,
                 json_each(history.message_json, '$.blocks') AS block
            WHERE history.agent_id = ${agentId} ${before}
              AND json_extract(block.value, '$.type') = 'tool_result'
              AND COALESCE(json_extract(block.value, '$.isError'), 0) != 1
              AND json_extract(block.value, '$.presentation.type') IN ('media', 'artifact')
              ${artifact}
            ORDER BY history.position DESC, block.key DESC
            LIMIT ${options.limit}`,
    );
    const results: HistoryPresentedResult[] = [];
    for (const row of rows) {
        const block = JSON.parse(row.block_json) as {
            readonly callId?: unknown;
            readonly toolName?: unknown;
            readonly presentation?: unknown;
        };
        if (
            typeof block.callId !== "string" ||
            typeof block.toolName !== "string" ||
            !Value.Check(historyToolPresentationSchema, block.presentation)
        ) {
            throw new Error("The stored tool presentation is invalid.");
        }
        const presentation = block.presentation;
        if (presentation.type !== "media" && presentation.type !== "artifact") continue;
        results.push({
            position: Number(row.position),
            callId: block.callId,
            toolName: block.toolName,
            at: row.at === null ? undefined : Number(row.at),
            presentation,
        });
    }
    return results;
}
