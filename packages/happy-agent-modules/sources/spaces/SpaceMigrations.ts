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
    [
        "002-trim-to-the-api",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            // The sidebar manager no longer has a row, rows no longer carry their own name, and
            // sections no longer carry a context line. Queued changes, applied batches, and
            // bookkeeping were stored in the earlier shape; they are dropped, and each person's
            // sidebar settles again on its next read.
            await agentDatabaseRun(
                database,
                sql`DELETE FROM ${sql.raw(SPACES_TABLE)} WHERE role = 'manager'`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(SPACES_TABLE)} DROP COLUMN name`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(SPACE_SECTIONS_TABLE)} DROP COLUMN context`,
            );
            for (const table of [SPACE_PENDING_TABLE, SPACE_BATCHES_TABLE, SPACE_OWNERS_TABLE]) {
                await agentDatabaseRun(database, sql`DELETE FROM ${sql.raw(table)}`);
            }
        },
    ],
    [
        "003-prioritizing",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            // The hidden sidebar manager became Prioritizing, a subtask of Happy. Its old agent is
            // forgotten, and the next brief makes the subtask; rows and sections are kept.
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(SPACE_OWNERS_TABLE)}
                    SET state_json = json_remove(state_json, '$.managerAgentId')`,
            );
        },
    ],
    [
        "004-prioritizing-is-an-ordinary-subtask",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            // Prioritizing was a conversation subtask with special metadata. It is now made through
            // the ordinary subtask path with the person's next new work; the old one is forgotten.
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(SPACE_OWNERS_TABLE)}
                    SET state_json = json_remove(state_json, '$.prioritizingAgentId')`,
            );
        },
    ],
    [
        "005-sidebar-artifact-owner",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX happy_agent_module_space_owners_sidebar ON ${sql.raw(SPACE_OWNERS_TABLE)} (json_extract(state_json, '$.sidebarArtifactId')) WHERE json_extract(state_json, '$.sidebarArtifactId') IS NOT NULL`,
            );
        },
    ],
] as const;
