import { cuid2Schema } from "@slopus/happy-agent-base";
import { spaceSidebarAuthorSchema, spaceSidebarOperationSchema } from "@slopus/happy-agent-client";
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
    mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
} as const;

/** Changes to one person's sidebar, published after the transaction that made them commits. */
export const spaceEventSchema = Type.Union([
    Type.Object(
        { ...envelope, type: Type.Literal("space_created"), space: spaceRecordSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...envelope, type: Type.Literal("space_updated"), space: spaceRecordSchema },
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
        { ...envelope, type: Type.Literal("section_updated"), section: spaceSectionRecordSchema },
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
    /** A new sidebar version; its operations turn `previousVersion` into `version`. */
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("sidebar_changed"),
            artifactId: cuid2Schema,
            previousVersion: spaceVersionSchema,
            version: spaceVersionSchema,
            author: spaceSidebarAuthorSchema,
            operations: Type.Array(spaceSidebarOperationSchema),
        },
        { additionalProperties: false },
    ),
]);

export type SpaceEvent = Static<typeof spaceEventSchema>;
export type SpaceEventListener = (ctx: Context, event: SpaceEvent) => Promise<void> | void;
export type SpaceUnsubscribe = () => void;
