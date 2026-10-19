import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    spaceBatchSchema,
    spaceOwnerStateSchema,
    spacePendingChangeSchema,
    spaceRecordSchema,
    spaceSectionRecordSchema,
    type SpaceBatch,
    type SpaceOwnerState,
    type SpacePendingChange,
    type SpaceRecord,
    type SpaceSectionRecord,
} from "../Space.js";
import {
    SPACE_BATCHES_TABLE,
    SPACE_OWNERS_TABLE,
    SPACE_PENDING_TABLE,
    SPACE_SECTIONS_TABLE,
    SPACES_TABLE,
} from "../SpaceMigrations.js";
import { spaceRefKey } from "../impl/spaceRefKey.js";

interface SpaceRow {
    readonly id: string;
    readonly owner_user_id: string;
    readonly role: string;
    readonly name: string | null;
    readonly icon_json: string | null;
    readonly contents_json: string;
    readonly section_id: string | null;
    readonly order_key: string;
    readonly placement: string;
    readonly visibility: string;
    readonly manual_at: number | string | null;
    readonly briefed_at: number | string | null;
    readonly version: number | string;
    readonly created_at: number | string;
    readonly updated_at: number | string;
}

/** Every row of one person's sidebar, sections first by their own order, then rows by key. */
export async function querySpaces(ctx: Context, ownerUserId: string): Promise<SpaceRecord[]> {
    const rows = await agentDatabaseRows<SpaceRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(SPACES_TABLE)}
            WHERE owner_user_id = ${ownerUserId} ORDER BY order_key, id`,
    );
    return rows.map(spaceFromRow);
}

export async function querySpace(ctx: Context, spaceId: string): Promise<SpaceRecord | undefined> {
    const rows = await agentDatabaseRows<SpaceRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(SPACES_TABLE)} WHERE id = ${spaceId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : spaceFromRow(rows[0]);
}

export async function querySpaceByRef(
    ctx: Context,
    ownerUserId: string,
    refKey: string,
): Promise<SpaceRecord | undefined> {
    const rows = await agentDatabaseRows<SpaceRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(SPACES_TABLE)}
            WHERE owner_user_id = ${ownerUserId} AND ref_key = ${refKey} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : spaceFromRow(rows[0]);
}

/** Every person's row holding this conversation, whatever kind of content names it. */
export async function querySpacesByAgent(ctx: Context, agentId: string): Promise<SpaceRecord[]> {
    const rows = await agentDatabaseRows<SpaceRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(SPACES_TABLE)} AS space
            WHERE EXISTS (
                SELECT 1 FROM json_each(space.contents_json) AS ref
                WHERE json_extract(ref.value, '$.agentId') = ${agentId}
            )
            ORDER BY id`,
    );
    return rows.map(spaceFromRow);
}

/** Every person's row whose primary content is this reference. */
export async function querySpacesByRef(ctx: Context, refKey: string): Promise<SpaceRecord[]> {
    const rows = await agentDatabaseRows<SpaceRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(SPACES_TABLE)} WHERE ref_key = ${refKey} ORDER BY id`,
    );
    return rows.map(spaceFromRow);
}

export async function insertSpace(ctx: Context, space: SpaceRecord): Promise<void> {
    assertValue(spaceRecordSchema, space, "space");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(SPACES_TABLE)} (
            id, owner_user_id, role, ref_key, name, icon_json, contents_json, section_id,
            order_key, placement, visibility, manual_at, briefed_at, version, created_at,
            updated_at
        ) VALUES (
            ${space.id}, ${space.ownerUserId}, ${space.role}, ${spaceRefKey(space)},
            ${space.name ?? null}, ${space.icon === undefined ? null : JSON.stringify(space.icon)},
            ${JSON.stringify(space.contents)}, ${space.sectionId ?? null}, ${space.orderKey},
            ${space.placement}, ${space.visibility}, ${space.manualAt ?? null},
            ${space.briefedAt ?? null}, ${space.version}, ${space.createdAt}, ${space.updatedAt}
        )`,
    );
}

/**
 * Seed a row unless the person already has one for that content. Keyed on the content at the
 * storage boundary, so two seeds racing for the same work leave one row and the loser learns it.
 */
export async function insertSpaceIfAbsent(ctx: Context, space: SpaceRecord): Promise<boolean> {
    assertValue(spaceRecordSchema, space, "space");
    const inserted = await agentDatabaseRows<{ readonly id: string }>(
        ctx.db,
        sql`INSERT INTO ${sql.raw(SPACES_TABLE)} (
            id, owner_user_id, role, ref_key, name, icon_json, contents_json, section_id,
            order_key, placement, visibility, manual_at, briefed_at, version, created_at,
            updated_at
        ) VALUES (
            ${space.id}, ${space.ownerUserId}, ${space.role}, ${spaceRefKey(space)},
            ${space.name ?? null}, ${space.icon === undefined ? null : JSON.stringify(space.icon)},
            ${JSON.stringify(space.contents)}, ${space.sectionId ?? null}, ${space.orderKey},
            ${space.placement}, ${space.visibility}, ${space.manualAt ?? null},
            ${space.briefedAt ?? null}, ${space.version}, ${space.createdAt}, ${space.updatedAt}
        ) ON CONFLICT (owner_user_id, ref_key) DO NOTHING RETURNING id`,
    );
    return inserted.length === 1;
}

/** Store a decided change; the version compare-and-swap refuses a row that moved meanwhile. */
export async function updateSpace(
    ctx: Context,
    space: SpaceRecord,
    expectedVersion: number,
): Promise<void> {
    assertValue(spaceRecordSchema, space, "space");
    const changed = await agentDatabaseRows<{ readonly id: string }>(
        ctx.db,
        sql`UPDATE ${sql.raw(SPACES_TABLE)} SET
            ref_key = ${spaceRefKey(space)}, name = ${space.name ?? null},
            icon_json = ${space.icon === undefined ? null : JSON.stringify(space.icon)},
            contents_json = ${JSON.stringify(space.contents)},
            section_id = ${space.sectionId ?? null}, order_key = ${space.orderKey},
            placement = ${space.placement}, visibility = ${space.visibility},
            manual_at = ${space.manualAt ?? null}, briefed_at = ${space.briefedAt ?? null},
            version = ${space.version}, updated_at = ${space.updatedAt}
            WHERE id = ${space.id} AND version = ${expectedVersion}
            RETURNING id`,
    );
    if (changed.length !== 1) throw new Error("The space changed before it could be stored.");
}

/** Record that the manager was told about this row. Bookkeeping only; the row does not move. */
export async function updateSpaceBriefedAt(
    ctx: Context,
    spaceId: string,
    briefedAt: number,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`UPDATE ${sql.raw(SPACES_TABLE)} SET briefed_at = ${briefedAt} WHERE id = ${spaceId}`,
    );
}

interface SectionRow {
    readonly id: string;
    readonly owner_user_id: string;
    readonly name: string;
    readonly context: string | null;
    readonly visible_count: number | string | null;
    readonly collapsed: number | string | boolean;
    readonly tail_expanded: number | string | boolean;
    readonly order_key: string;
    readonly version: number | string;
    readonly created_at: number | string;
    readonly updated_at: number | string;
}

export async function querySections(
    ctx: Context,
    ownerUserId: string,
): Promise<SpaceSectionRecord[]> {
    const rows = await agentDatabaseRows<SectionRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(SPACE_SECTIONS_TABLE)}
            WHERE owner_user_id = ${ownerUserId} ORDER BY order_key, id`,
    );
    return rows.map(sectionFromRow);
}

export async function querySection(
    ctx: Context,
    sectionId: string,
): Promise<SpaceSectionRecord | undefined> {
    const rows = await agentDatabaseRows<SectionRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(SPACE_SECTIONS_TABLE)} WHERE id = ${sectionId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : sectionFromRow(rows[0]);
}

export async function insertSection(ctx: Context, section: SpaceSectionRecord): Promise<void> {
    assertValue(spaceSectionRecordSchema, section, "section");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(SPACE_SECTIONS_TABLE)} (
            id, owner_user_id, name, context, visible_count, collapsed, tail_expanded,
            order_key, version, created_at, updated_at
        ) VALUES (
            ${section.id}, ${section.ownerUserId}, ${section.name}, ${section.context ?? null},
            ${section.visibleCount ?? null}, ${section.collapsed ? 1 : 0},
            ${section.tailExpanded ? 1 : 0}, ${section.orderKey}, ${section.version},
            ${section.createdAt}, ${section.updatedAt}
        )`,
    );
}

export async function updateSection(
    ctx: Context,
    section: SpaceSectionRecord,
    expectedVersion: number,
): Promise<void> {
    assertValue(spaceSectionRecordSchema, section, "section");
    const changed = await agentDatabaseRows<{ readonly id: string }>(
        ctx.db,
        sql`UPDATE ${sql.raw(SPACE_SECTIONS_TABLE)} SET
            name = ${section.name}, context = ${section.context ?? null},
            visible_count = ${section.visibleCount ?? null},
            collapsed = ${section.collapsed ? 1 : 0},
            tail_expanded = ${section.tailExpanded ? 1 : 0}, order_key = ${section.orderKey},
            version = ${section.version}, updated_at = ${section.updatedAt}
            WHERE id = ${section.id} AND version = ${expectedVersion}
            RETURNING id`,
    );
    if (changed.length !== 1) throw new Error("The section changed before it could be stored.");
}

/** Remove an empty section. Rows still in it are a caller error, never silently orphaned. */
export async function deleteSection(ctx: Context, sectionId: string): Promise<void> {
    const remaining = await agentDatabaseRows<{ readonly id: string }>(
        ctx.db,
        sql`SELECT id FROM ${sql.raw(SPACES_TABLE)} WHERE section_id = ${sectionId} LIMIT 1`,
    );
    if (remaining.length > 0) throw new Error("A section with rows in it cannot be removed.");
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(SPACE_SECTIONS_TABLE)} WHERE id = ${sectionId}`,
    );
}

interface PendingRow {
    readonly target_key: string;
    readonly change_json: string;
}

/** The changes waiting for a calm moment, in the order the manager asked for them. */
export async function queryPendingChanges(
    ctx: Context,
    ownerUserId: string,
): Promise<SpacePendingChange[]> {
    const rows = await agentDatabaseRows<PendingRow>(
        ctx.db,
        sql`SELECT target_key, change_json FROM ${sql.raw(SPACE_PENDING_TABLE)}
            WHERE owner_user_id = ${ownerUserId} ORDER BY sequence, target_key`,
    );
    return rows.map((row) => parseValue(spacePendingChangeSchema, row.change_json, "change"));
}

/** The people with changes waiting for a calm moment. */
export async function queryOwnersWithPendingChanges(ctx: Context): Promise<string[]> {
    const rows = await agentDatabaseRows<{ readonly owner_user_id: string }>(
        ctx.db,
        sql`SELECT DISTINCT owner_user_id FROM ${sql.raw(SPACE_PENDING_TABLE)}
            ORDER BY owner_user_id`,
    );
    return rows.map((row) => row.owner_user_id);
}

/**
 * Queue one change. A later change to the same target replaces the earlier one and moves to the
 * end, so the batch reflects the manager's last word in the order it decided.
 */
export async function upsertPendingChange(
    ctx: Context,
    ownerUserId: string,
    targetKey: string,
    change: SpacePendingChange,
    at: number,
): Promise<void> {
    assertValue(spacePendingChangeSchema, change, "change");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(SPACE_PENDING_TABLE)}
                (owner_user_id, target_key, change_json, created_at, sequence)
            VALUES (
                ${ownerUserId}, ${targetKey}, ${JSON.stringify(change)}, ${at},
                (SELECT COALESCE(MAX(sequence), 0) + 1 FROM ${sql.raw(SPACE_PENDING_TABLE)}
                    WHERE owner_user_id = ${ownerUserId})
            )
            ON CONFLICT (owner_user_id, target_key) DO UPDATE SET
                change_json = excluded.change_json,
                created_at = excluded.created_at,
                sequence = excluded.sequence`,
    );
}

export async function deletePendingChanges(
    ctx: Context,
    ownerUserId: string,
    targetKeys?: readonly string[],
): Promise<void> {
    if (targetKeys === undefined) {
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM ${sql.raw(SPACE_PENDING_TABLE)} WHERE owner_user_id = ${ownerUserId}`,
        );
        return;
    }
    for (const targetKey of targetKeys) {
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM ${sql.raw(SPACE_PENDING_TABLE)}
                WHERE owner_user_id = ${ownerUserId} AND target_key = ${targetKey}`,
        );
    }
}

export async function insertBatch(ctx: Context, batch: SpaceBatch): Promise<void> {
    assertValue(spaceBatchSchema, batch, "batch");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(SPACE_BATCHES_TABLE)} (id, owner_user_id, batch_json, applied_at)
            VALUES (${batch.id}, ${batch.ownerUserId}, ${JSON.stringify(batch)},
                ${batch.appliedAt})`,
    );
}

/** The most recent batches, newest first. */
export async function queryBatches(
    ctx: Context,
    ownerUserId: string,
    limit: number,
): Promise<SpaceBatch[]> {
    const rows = await agentDatabaseRows<{ readonly batch_json: string }>(
        ctx.db,
        sql`SELECT batch_json FROM ${sql.raw(SPACE_BATCHES_TABLE)}
            WHERE owner_user_id = ${ownerUserId}
            ORDER BY applied_at DESC, id DESC LIMIT ${limit}`,
    );
    return rows.map((row) => parseValue(spaceBatchSchema, row.batch_json, "batch"));
}

export async function queryOwnerState(
    ctx: Context,
    ownerUserId: string,
): Promise<SpaceOwnerState | undefined> {
    const rows = await agentDatabaseRows<{ readonly state_json: string }>(
        ctx.db,
        sql`SELECT state_json FROM ${sql.raw(SPACE_OWNERS_TABLE)}
            WHERE owner_user_id = ${ownerUserId} LIMIT 1`,
    );
    return rows[0] === undefined
        ? undefined
        : parseValue(spaceOwnerStateSchema, rows[0].state_json, "owner state");
}

/** Every person who has a sidebar. */
export async function queryOwnerStates(ctx: Context): Promise<SpaceOwnerState[]> {
    const rows = await agentDatabaseRows<{ readonly state_json: string }>(
        ctx.db,
        sql`SELECT state_json FROM ${sql.raw(SPACE_OWNERS_TABLE)} ORDER BY owner_user_id`,
    );
    return rows.map((row) => parseValue(spaceOwnerStateSchema, row.state_json, "owner state"));
}

export async function writeOwnerState(ctx: Context, state: SpaceOwnerState): Promise<void> {
    assertValue(spaceOwnerStateSchema, state, "owner state");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(SPACE_OWNERS_TABLE)} (owner_user_id, state_json)
            VALUES (${state.ownerUserId}, ${JSON.stringify(state)})
            ON CONFLICT (owner_user_id) DO UPDATE SET state_json = excluded.state_json`,
    );
}

function spaceFromRow(row: SpaceRow): SpaceRecord {
    const space = {
        id: row.id,
        ownerUserId: row.owner_user_id,
        role: row.role,
        ...(row.name === null ? {} : { name: row.name }),
        ...(row.icon_json === null ? {} : { icon: JSON.parse(row.icon_json) as unknown }),
        contents: JSON.parse(row.contents_json) as unknown,
        ...(row.section_id === null ? {} : { sectionId: row.section_id }),
        orderKey: row.order_key,
        placement: row.placement,
        visibility: row.visibility,
        ...(row.manual_at === null ? {} : { manualAt: Number(row.manual_at) }),
        ...(row.briefed_at === null ? {} : { briefedAt: Number(row.briefed_at) }),
        version: Number(row.version),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
    assertValue(spaceRecordSchema, space, "space");
    return space as SpaceRecord;
}

function sectionFromRow(row: SectionRow): SpaceSectionRecord {
    const section = {
        id: row.id,
        ownerUserId: row.owner_user_id,
        name: row.name,
        ...(row.context === null ? {} : { context: row.context }),
        ...(row.visible_count === null ? {} : { visibleCount: Number(row.visible_count) }),
        collapsed: Number(row.collapsed) === 1 || row.collapsed === true,
        tailExpanded: Number(row.tail_expanded) === 1 || row.tail_expanded === true,
        orderKey: row.order_key,
        version: Number(row.version),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
    assertValue(spaceSectionRecordSchema, section, "section");
    return section as SpaceSectionRecord;
}

function parseValue<Schema extends TSchema>(
    schema: Schema,
    encoded: string,
    label: string,
): Static<Schema> {
    const value = JSON.parse(encoded) as unknown;
    assertValue(schema, value, label);
    return value as Static<Schema>;
}

function assertValue(schema: TSchema, value: unknown, label: string): void {
    if (!Value.Check(schema, value)) {
        throw new Error(`Space storage contains an invalid ${label}.`);
    }
}
