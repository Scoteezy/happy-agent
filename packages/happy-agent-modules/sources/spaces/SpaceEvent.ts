import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    spaceBatchSchema,
    spaceOwnerIdSchema,
    spaceRecordSchema,
    spaceSectionRecordSchema,
    spaceTimestampSchema,
    spaceVersionSchema,
} from "./Space.js";

const envelope = {
    at: spaceTimestampSchema,
    ownerUserId: spaceOwnerIdSchema,
    /** The person's sidebar revision after this change. */
    revision: Type.Integer({ minimum: 0 }),
    mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
} as const;

/** Changes to one person's sidebar, published after the transaction that made them commits. */
export const spaceEventSchema = Type.Union([
    Type.Object(
        { ...envelope, type: Type.Literal("space_created"), space: spaceRecordSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("space_updated"),
            space: spaceRecordSchema,
            previousVersion: spaceVersionSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...envelope, type: Type.Literal("space_removed"), spaceId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...envelope, type: Type.Literal("section_created"), section: spaceSectionRecordSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("section_updated"),
            section: spaceSectionRecordSchema,
            previousVersion: spaceVersionSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...envelope, type: Type.Literal("section_removed"), sectionId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...envelope, type: Type.Literal("batch_applied"), batch: spaceBatchSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("batch_queued"),
            pendingChanges: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
    ),
]);

export type SpaceEvent = Static<typeof spaceEventSchema>;
export type SpaceEventListener = (ctx: Context, event: SpaceEvent) => Promise<void> | void;
export type SpaceUnsubscribe = () => void;
