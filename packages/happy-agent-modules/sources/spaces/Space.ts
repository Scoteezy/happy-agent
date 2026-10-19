import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { SPACE_ICON_SLUGS } from "./impl/spaceIconSlugs.js";

/** The one person a standalone installation belongs to, as tasks and Surfaces already name it. */
export const SPACE_STANDALONE_OWNER = "standalone";

export const spaceOwnerIdSchema = Type.Union([cuid2Schema, Type.Literal(SPACE_STANDALONE_OWNER)]);
export const spaceTimestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const spaceVersionSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const spaceOrderKeySchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[0-9]+$",
});
/** A short human label: nonblank, without control characters. */
export const spaceTextSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
/** A short lower-case phrase completing a sentence, without its own full stop. */
export const spaceReasonSchema = Type.String({
    minLength: 1,
    maxLength: 60,
    pattern: "^[^\\x00-\\x1f\\x7f.!?]+$",
});
export const spaceIconSlugSchema = Type.Union(SPACE_ICON_SLUGS.map((slug) => Type.Literal(slug)));

/**
 * Happy is row one, the manager is never shown, and every other row is an item. Exactly one Happy
 * and at most one manager exist per person.
 */
export const spaceRoleSchema = Type.Union([
    Type.Literal("happy"),
    Type.Literal("manager"),
    Type.Literal("item"),
]);

/** Pending means the manager has not placed the row yet; its position is still its section. */
export const spacePlacementSchema = Type.Union([Type.Literal("pending"), Type.Literal("settled")]);

/** Shown in its section, folded into Older at the bottom, or hidden. Hidden is never deletion. */
export const spaceVisibilitySchema = Type.Union([
    Type.Literal("shown"),
    Type.Literal("folded"),
    Type.Literal("hidden"),
]);

/**
 * What the row draws. A stem cell is new work nobody has named yet; a library icon is one slug of
 * the bundled icon set, so only the slug is stored; an image is the content's own picture.
 */
export const spaceIconSchema = Type.Union([
    Type.Object({ type: Type.Literal("stem_cell") }, { additionalProperties: false }),
    Type.Object(
        { type: Type.Literal("library"), slug: spaceIconSlugSchema },
        { additionalProperties: false },
    ),
    Type.Object({ type: Type.Literal("image") }, { additionalProperties: false }),
]);

export const spaceSurfaceTypeSchema = Type.Union([
    Type.Literal("todo"),
    Type.Literal("document"),
    Type.Literal("calendar"),
    Type.Literal("reference"),
]);

/** One thing a space holds. The first entry is the one a click opens. */
export const spaceRefSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("task"), taskId: cuid2Schema, agentId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("bot"), botId: cuid2Schema, agentId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("agent"), agentId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("artifact"), artifactId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("surface"),
            surfaceId: cuid2Schema,
            surfaceType: spaceSurfaceTypeSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("file"),
            workspaceId: cuid2Schema,
            path: Type.String({ minLength: 1, maxLength: 4_096 }),
        },
        { additionalProperties: false },
    ),
]);

export const spaceRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        ownerUserId: spaceOwnerIdSchema,
        role: spaceRoleSchema,
        /** A name chosen for the row; without one the title follows the content. */
        name: Type.Optional(spaceTextSchema),
        /** Absent until the manager chooses one. */
        icon: Type.Optional(spaceIconSchema),
        contents: Type.Array(spaceRefSchema, { maxItems: 32 }),
        /** Absent: directly under Happy, which is where unplaced new work waits. */
        sectionId: Type.Optional(cuid2Schema),
        orderKey: spaceOrderKeySchema,
        placement: spacePlacementSchema,
        visibility: spaceVisibilitySchema,
        /** When the person last moved this row by hand; the manager leaves it there. */
        manualAt: Type.Optional(spaceTimestampSchema),
        /** When the manager was first told about this row's work, so it is told only once. */
        briefedAt: Type.Optional(spaceTimestampSchema),
        version: spaceVersionSchema,
        createdAt: spaceTimestampSchema,
        updatedAt: spaceTimestampSchema,
    },
    { additionalProperties: false },
);

export const spaceSectionRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        ownerUserId: spaceOwnerIdSchema,
        name: spaceTextSchema,
        /** One muted line under the title. */
        context: Type.Optional(spaceTextSchema),
        /** Partial collapse: only the first rows show, the rest wait behind "+k more". */
        visibleCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        collapsed: Type.Boolean(),
        tailExpanded: Type.Boolean(),
        orderKey: spaceOrderKeySchema,
        version: spaceVersionSchema,
        createdAt: spaceTimestampSchema,
        updatedAt: spaceTimestampSchema,
    },
    { additionalProperties: false },
);

/**
 * One reorganisation the manager wants and has not been allowed to make yet. Changes wait until
 * the person is calm, then apply together as one batch.
 */
export const spacePendingChangeSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("place"),
            spaceId: cuid2Schema,
            /** `null` puts the row directly under Happy. */
            sectionId: Type.Union([cuid2Schema, Type.Null()]),
            /** After this row; `null` or absent puts it first. */
            afterId: Type.Optional(Type.Union([cuid2Schema, Type.Null()])),
            /** A few words saying why, for Happy's note, such as "after you finished it". */
            reason: Type.Optional(spaceReasonSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("visibility"),
            spaceId: cuid2Schema,
            visibility: spaceVisibilitySchema,
            /** A few words saying why, for Happy's note, such as "after you finished it". */
            reason: Type.Optional(spaceReasonSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("section"),
            sectionId: cuid2Schema,
            create: Type.Boolean(),
            name: Type.Optional(spaceTextSchema),
            context: Type.Optional(Type.Union([spaceTextSchema, Type.Null()])),
            visibleCount: Type.Optional(
                Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()]),
            ),
            /** After this section; `null` puts it first; absent keeps its place (last if new). */
            afterSectionId: Type.Optional(Type.Union([cuid2Schema, Type.Null()])),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("remove_section"), sectionId: cuid2Schema },
        { additionalProperties: false },
    ),
]);

const spacePositionSchema = Type.Object(
    {
        sectionId: Type.Union([cuid2Schema, Type.Null()]),
        sectionName: Type.Union([Type.String(), Type.Null()]),
        /** The row's position in its section, under Happy, or in Older. */
        index: Type.Integer({ minimum: 0 }),
        visibility: spaceVisibilitySchema,
        placement: spacePlacementSchema,
    },
    { additionalProperties: false },
);

export const spaceBatchChangeSchema = Type.Object(
    {
        spaceId: cuid2Schema,
        title: Type.String(),
        reason: Type.Optional(spaceReasonSchema),
        from: spacePositionSchema,
        to: spacePositionSchema,
    },
    { additionalProperties: false },
);

export const spaceBatchSectionChangeSchema = Type.Object(
    {
        sectionId: cuid2Schema,
        name: Type.String(),
        change: Type.Union([
            Type.Literal("created"),
            Type.Literal("updated"),
            Type.Literal("removed"),
        ]),
    },
    { additionalProperties: false },
);

/** One applied reorganisation: the note shown in Happy's chat and every row that moved. */
export const spaceBatchSchema = Type.Object(
    {
        id: cuid2Schema,
        ownerUserId: spaceOwnerIdSchema,
        reason: Type.Union([Type.Literal("calm"), Type.Literal("tidy")]),
        note: Type.String({ minLength: 1, maxLength: 1_000 }),
        noteAgentId: Type.Optional(cuid2Schema),
        noteMessageId: Type.Optional(cuid2Schema),
        changes: Type.Array(spaceBatchChangeSchema),
        sections: Type.Array(spaceBatchSectionChangeSchema),
        appliedAt: spaceTimestampSchema,
    },
    { additionalProperties: false },
);

/** A model the manager runs on. Without one it runs on the cheapest model of Happy's account. */
export const spaceManagerModelSchema = Type.Object(
    {
        providerId: Type.String({ minLength: 1, maxLength: 128 }),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    },
    { additionalProperties: false },
);

/** Each person's sidebar bookkeeping. */
export const spaceOwnerStateSchema = Type.Object(
    {
        ownerUserId: spaceOwnerIdSchema,
        /** Advances with every change to this person's sidebar. */
        revision: Type.Integer({ minimum: 0 }),
        managerAgentId: Type.Optional(cuid2Schema),
        /**
         * The person asked for something to happen now — a tidy, or a move in their own words —
         * so the queued changes apply as soon as the manager finishes, without waiting for calm.
         */
        applyRequestedAt: Type.Optional(spaceTimestampSchema),
        managerModel: Type.Optional(spaceManagerModelSchema),
    },
    { additionalProperties: false },
);

export type SpaceOwnerId = Static<typeof spaceOwnerIdSchema>;
export type SpaceRole = Static<typeof spaceRoleSchema>;
export type SpacePlacement = Static<typeof spacePlacementSchema>;
export type SpaceVisibility = Static<typeof spaceVisibilitySchema>;
export type SpaceIcon = Static<typeof spaceIconSchema>;
export type SpaceIconSlug = Static<typeof spaceIconSlugSchema>;
export type SpaceRef = Static<typeof spaceRefSchema>;
export type SpaceRecord = Static<typeof spaceRecordSchema>;
export type SpaceSectionRecord = Static<typeof spaceSectionRecordSchema>;
export type SpacePendingChange = Static<typeof spacePendingChangeSchema>;
export type SpaceBatch = Static<typeof spaceBatchSchema>;
export type SpaceBatchChange = Static<typeof spaceBatchChangeSchema>;
export type SpaceBatchSectionChange = Static<typeof spaceBatchSectionChangeSchema>;
export type SpaceManagerModel = Static<typeof spaceManagerModelSchema>;
export type SpaceOwnerState = Static<typeof spaceOwnerStateSchema>;

/** What a person's sidebar holds right now. */
export interface SpaceSnapshot {
    readonly spaces: readonly SpaceRecord[];
    readonly sections: readonly SpaceSectionRecord[];
    readonly pendingChanges: number;
    readonly revision: number;
}

/** What a click on a row opens. */
export interface SpaceTarget {
    readonly kind: "task" | "bot" | "agent" | "artifact" | "surface" | "file";
    readonly id: string;
    readonly agentId?: string;
    readonly workspaceId?: string;
    readonly path?: string;
}

/** A row's content resolved for display and for the manager's judgement. */
export interface SpaceDescription {
    readonly title: string;
    readonly target: SpaceTarget | undefined;
    readonly archived: boolean;
    readonly working: boolean;
    readonly lastActivityAt: number | undefined;
    /** A daemon-relative URL of the content's own picture, when it has one. */
    readonly imageUrl: string | undefined;
}

export class SpaceNotFoundError extends Error {
    constructor(message = "The space was not found.") {
        super(message);
        this.name = "SpaceNotFoundError";
    }
}

export class SpaceInputError extends Error {
    constructor(message = "The space request is invalid.") {
        super(message);
        this.name = "SpaceInputError";
    }
}

export class SpaceConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SpaceConflictError";
    }
}
