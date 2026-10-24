import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const STICKER_RECENTS_TABLE = "happy_agent_sticker_recents";

/** Each person's recently used stickers, most recent by `used_at`, at most 20 kept. */
export const stickerMigrations: readonly AgentModuleMigration[] = [
    [
        "001-sticker-recents",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(STICKER_RECENTS_TABLE)} (
                    person_key TEXT NOT NULL,
                    pack_id TEXT NOT NULL,
                    sticker_id TEXT NOT NULL,
                    used_at INTEGER NOT NULL,
                    PRIMARY KEY (person_key, pack_id, sticker_id)
                )`,
            );
        },
    ],
];
