/** Spaces: each person's sidebar, one ordered list of their work in flat sections. */

import { type Static, Type } from "@sinclair/typebox";

import { agentSchema } from "./agents.js";
import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    timestampSchema,
} from "./common.js";

/** What a row shows before its title. */
export const spaceIconSchema = Type.Union([
    Type.Object({ type: Type.Literal("stem_cell") }),
    /** An icon from the desktop's icon library. */
    Type.Object({ slug: Type.String(), type: Type.Literal("library") }),
    /** The content's own picture: a daemon-relative path read with the same bearer token. */
    Type.Object({ type: Type.Literal("image"), url: Type.String() }),
]);
export type SpaceIcon = Static<typeof spaceIconSchema>;

/**
 * What selecting a row opens: nearly always a task; a bot for Happy and other bots; a Surface.
 * Clients skip a row whose `kind` they do not know.
 */
export const spaceTargetSchema = Type.Object({
    /** The conversation to show; `null` for a Surface. */
    agentId: Nullable(cuid2Schema),
    /** The task, bot, or Surface. */
    id: cuid2Schema,
    kind: Type.Union([Type.Literal("task"), Type.Literal("bot"), Type.Literal("surface")]),
    /** The conversation's workspace; `null` for a Surface. */
    workspaceId: Nullable(cuid2Schema),
});
export type SpaceTarget = Static<typeof spaceTargetSchema>;

export const spaceVisibilitySchema = Type.Union([
    Type.Literal("shown"),
    /** In the Older part of the list. */
    Type.Literal("folded"),
    Type.Literal("hidden"),
]);
export type SpaceVisibility = Static<typeof spaceVisibilitySchema>;

/**
 * One row of the sidebar. Happy is an ordinary row whose target is its bot. A task row's tree comes
 * from the task's agent and workspaces, not from here. Events carry whole rows; keep the copy with
 * the greater `version`.
 */
export const spaceSchema = Type.Object({
    createdAt: timestampSchema,
    /** `null` until one is chosen. */
    icon: Nullable(spaceIconSchema),
    id: cuid2Schema,
    /** Opaque position within its section. */
    orderKey: Type.String(),
    /** `pending` while Prioritizing has not placed new work yet. */
    placement: Type.Union([Type.Literal("pending"), Type.Literal("settled")]),
    sectionId: Nullable(cuid2Schema),
    target: spaceTargetSchema,
    /** `null` while new work has not named itself; clients label it themselves. */
    title: Nullable(Type.String()),
    updatedAt: timestampSchema,
    /** An integer that grows with every change to the row. */
    version: Type.Integer({ minimum: 1 }),
    visibility: spaceVisibilitySchema,
    /** Whether the target's conversation is running now. */
    working: Type.Boolean(),
});
export type Space = Static<typeof spaceSchema>;

/** A flat section of the sidebar. */
export const spaceSectionSchema = Type.Object({
    /** The person closed the whole section. */
    collapsed: Type.Boolean(),
    createdAt: timestampSchema,
    id: cuid2Schema,
    /** Unique within the person's sidebar, ignoring case. */
    name: Type.String(),
    orderKey: Type.String(),
    /** The person opened the "+k more" tail. */
    tailExpanded: Type.Boolean(),
    updatedAt: timestampSchema,
    version: Type.Integer({ minimum: 1 }),
    /** Show only this many rows before "+k more", or all of them when `null`. */
    visibleCount: Nullable(Type.Integer({ minimum: 1 })),
});
export type SpaceSection = Static<typeof spaceSectionSchema>;

/** Where a row was, or went, in a batch. */
export const spaceBatchPositionSchema = Type.Object({
    /** Zero-based, among the rows it was listed with. */
    index: Type.Integer({ minimum: 0 }),
    sectionId: Nullable(Type.String({ minLength: 1, maxLength: 128 })),
    sectionName: Nullable(Type.String()),
    visibility: spaceVisibilitySchema,
});
export type SpaceBatchPosition = Static<typeof spaceBatchPositionSchema>;

export const spaceBatchChangeSchema = Type.Object({
    from: spaceBatchPositionSchema,
    spaceId: cuid2Schema,
    /** The row's title when the batch applied. */
    title: Type.String(),
    to: spaceBatchPositionSchema,
});
export type SpaceBatchChange = Static<typeof spaceBatchChangeSchema>;

/** Prioritizing's changes, applied together at a calm moment. */
export const spaceBatchSchema = Type.Object({
    appliedAt: timestampSchema,
    changes: Type.Array(spaceBatchChangeSchema),
    id: cuid2Schema,
    /** The one line added to Happy's conversation. */
    note: Type.String(),
    /** That line's message ID in Happy's conversation, or `null` when Happy was unavailable. */
    noteMessageId: Nullable(cuid2Schema),
});
export type SpaceBatch = Static<typeof spaceBatchSchema>;

/** `GET /v0/spaces` */
export const spaceListResponseSchema = Type.Object({
    /** Follow `space.*` events from here. */
    cursor: eventCursorSchema,
    sections: Type.Array(spaceSectionSchema),
    spaces: Type.Array(spaceSchema),
});
export type SpaceListResponse = Static<typeof spaceListResponseSchema>;

/** `GET /v0/spaces/batches` — newest first. */
export const spaceBatchListResponseSchema = Type.Object({
    batches: Type.Array(spaceBatchSchema),
});
export type SpaceBatchListResponse = Static<typeof spaceBatchListResponseSchema>;

/** `POST /v0/spaces/stem-cells` — new work, pending under Happy or at the top of a section. */
export const createStemCellRequestSchema = Type.Object({
    /** The retry key: repeating it answers `200` with the existing row and conversation. */
    id: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    sectionId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 128 }))),
});
export type CreateStemCellRequest = Static<typeof createStemCellRequestSchema>;

export const createStemCellResponseSchema = Type.Object({
    agent: agentSchema,
    space: spaceSchema,
});
export type CreateStemCellResponse = Static<typeof createStemCellResponseSchema>;

/** The person's authoritative HTML sidebar and live space identities. */
export const spaceSidebarResponseSchema = Type.Object({
    artifactId: cuid2Schema,
    version: Type.Integer({ minimum: 1 }),
    html: Type.String(),
    spaces: Type.Array(spaceSchema),
    /**
     * Prioritizing's icon for each session by agent ID, whether or not the session is shown.
     * Older daemons omit it; treat a missing map as empty.
     */
    agentIcons: Type.Optional(
        Type.Record(
            Type.String(),
            Type.Object({ slug: Type.String(), type: Type.Literal("library") }),
        ),
    ),
    /**
     * Present while the document still mirrors the classic sidebar, until the person's first
     * write or Prioritizing's next notice. Older daemons omit it; treat a missing flag as false.
     */
    seed: Type.Optional(Type.Literal(true)),
});
export type SpaceSidebarResponse = Static<typeof spaceSidebarResponseSchema>;

export const updateSpaceSidebarRequestSchema = Type.Object({
    html: Type.String({ maxLength: 131072 }),
    baseVersion: Type.Integer({ minimum: 1 }),
    mutationId: mutationIdSchema,
});
export type UpdateSpaceSidebarRequest = Static<typeof updateSpaceSidebarRequestSchema>;

export const sidebarDiagnosticSchema = Type.Object({
    message: Type.String(),
    offset: Type.Integer({ minimum: 0 }),
});
export type SidebarDiagnostic = Static<typeof sidebarDiagnosticSchema>;

/**
 * `PATCH /v0/spaces/:spaceId` — the person's own change to a row, applied at once. At least one
 * field. Giving `sectionId` moves the row (first in the section unless `afterId` says otherwise);
 * a moved row becomes `shown` unless `visibility` says otherwise.
 */
export const updateSpaceRequestSchema = Type.Object({
    /** The row to follow within the section, or `null` to move first. */
    afterId: Type.Optional(Nullable(cuid2Schema)),
    mutationId: Type.Optional(mutationIdSchema),
    sectionId: Type.Optional(Nullable(cuid2Schema)),
    visibility: Type.Optional(spaceVisibilitySchema),
});
export type UpdateSpaceRequest = Static<typeof updateSpaceRequestSchema>;

/**
 * `PATCH /v0/spaces/:spaceId` with `removed` — takes new work nobody wrote in out of the
 * sidebar and archives its task. Answers `204`, and `409` once its conversation holds a message.
 */
export const removeSpaceRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    removed: Type.Literal(true),
});
export type RemoveSpaceRequest = Static<typeof removeSpaceRequestSchema>;

export const spaceResponseSchema = Type.Object({ space: spaceSchema });
export type SpaceResponse = Static<typeof spaceResponseSchema>;

/** `PATCH /v0/spaces/sections/:sectionId` — the person's own disclosure; at least one flag. */
export const updateSpaceSectionRequestSchema = Type.Object({
    collapsed: Type.Optional(Type.Boolean()),
    mutationId: Type.Optional(mutationIdSchema),
    tailExpanded: Type.Optional(Type.Boolean()),
});
export type UpdateSpaceSectionRequest = Static<typeof updateSpaceSectionRequestSchema>;

export const spaceSectionResponseSchema = Type.Object({ section: spaceSectionSchema });
export type SpaceSectionResponse = Static<typeof spaceSectionResponseSchema>;

/** `POST /v0/spaces/attention` — whether a batch may apply now. */
export const spaceAttentionRequestSchema = Type.Object({
    state: Type.Union([Type.Literal("interacting"), Type.Literal("calm")]),
});
export type SpaceAttentionRequest = Static<typeof spaceAttentionRequestSchema>;

export const spaceAttentionResponseSchema = Type.Object({
    /** The batch this report applied. */
    batch: Nullable(spaceBatchSchema),
});
export type SpaceAttentionResponse = Static<typeof spaceAttentionResponseSchema>;
