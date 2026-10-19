import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

export const SPACES_TABLE = "happy_agent_module_spaces";
export const SPACE_SECTIONS_TABLE = "happy_agent_module_space_sections";
export const SPACE_PENDING_TABLE = "happy_agent_module_space_pending";
export const SPACE_BATCHES_TABLE = "happy_agent_module_space_batches";
export const SPACE_OWNERS_TABLE = "happy_agent_module_space_owners";

/**
 * The `spaces` module's migrations: rows and sections per person, the reorganisations waiting for
 * a calm moment, the batches already applied, and each person's bookkeeping.
 */
export const spaceMigrations = [
    [
        "001-spaces",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(SPACES_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_user_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    ref_key TEXT NOT NULL,
                    name TEXT,
                    icon_json TEXT,
                    contents_json TEXT NOT NULL,
                    section_id TEXT,
                    order_key TEXT NOT NULL,
                    placement TEXT NOT NULL,
                    visibility TEXT NOT NULL,
                    manual_at BIGINT,
                    briefed_at BIGINT,
                    version INTEGER NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    UNIQUE (owner_user_id, ref_key)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${SPACES_TABLE}_order`)}
                    ON ${sql.raw(SPACES_TABLE)} (owner_user_id, section_id, order_key, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(SPACE_SECTIONS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_user_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    context TEXT,
                    visible_count INTEGER,
                    collapsed INTEGER NOT NULL,
                    tail_expanded INTEGER NOT NULL,
                    order_key TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${SPACE_SECTIONS_TABLE}_order`)}
                    ON ${sql.raw(SPACE_SECTIONS_TABLE)} (owner_user_id, order_key, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(SPACE_PENDING_TABLE)} (
                    owner_user_id TEXT NOT NULL,
                    target_key TEXT NOT NULL,
                    change_json TEXT NOT NULL,
                    created_at BIGINT NOT NULL,
                    sequence INTEGER NOT NULL,
                    PRIMARY KEY (owner_user_id, target_key)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(SPACE_BATCHES_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_user_id TEXT NOT NULL,
                    batch_json TEXT NOT NULL,
                    applied_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${SPACE_BATCHES_TABLE}_owner`)}
                    ON ${sql.raw(SPACE_BATCHES_TABLE)} (owner_user_id, applied_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(SPACE_OWNERS_TABLE)} (
                    owner_user_id TEXT PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
] as const;
