import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type {
    SpaceBatch,
    SpaceDescription,
    SpaceRecord,
    SpaceSectionRecord,
} from "../spaces/index.js";

const mutationId = Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 }));

export const createStemCellRequestSchema = Type.Object(
    {
        id: Type.Optional(cuid2Schema),
        sectionId: Type.Optional(Type.Union([cuid2Schema, Type.Null()])),
        mutationId,
    },
    { additionalProperties: false },
);

/** The person's own change to a row: a move, a visibility, or removal of untouched new work. */
export const updateSpaceRequestSchema = Type.Object(
    {
        sectionId: Type.Optional(Type.Union([cuid2Schema, Type.Null()])),
        afterId: Type.Optional(Type.Union([cuid2Schema, Type.Null()])),
        visibility: Type.Optional(
            Type.Union([Type.Literal("shown"), Type.Literal("folded"), Type.Literal("hidden")]),
        ),
        removed: Type.Optional(Type.Literal(true)),
        mutationId,
    },
    { additionalProperties: false },
);

export const updateSpaceSectionRequestSchema = Type.Object(
    {
        collapsed: Type.Optional(Type.Boolean()),
        tailExpanded: Type.Optional(Type.Boolean()),
        mutationId,
    },
    { additionalProperties: false },
);

/** The person is mid-interaction (hold batches), or calm (a gesture finished, or idle). */
export const spaceAttentionRequestSchema = Type.Object(
    { state: Type.Union([Type.Literal("interacting"), Type.Literal("calm")]) },
    { additionalProperties: false },
);

/** A body carrying nothing but an optional mutation ID. */
export const spaceTidyRequestSchema = Type.Object({ mutationId }, { additionalProperties: false });

/**
 * One sidebar row as clients see it: stored placement plus its content resolved live. A row whose
 * content cannot be opened is not shown at all.
 */
export function spaceResource(
    space: SpaceRecord,
    description: SpaceDescription,
): Record<string, unknown> | undefined {
    const target = description.target;
    if (target === undefined) return undefined;
    return {
        id: space.id,
        // Work that has not named itself yet has no title; clients label it themselves.
        title: description.named ? description.title : null,
        icon:
            space.icon === undefined
                ? null
                : space.icon.type === "image"
                  ? description.imageUrl === undefined
                      ? null
                      : { type: "image", url: description.imageUrl }
                  : space.icon,
        target: {
            kind: target.kind,
            id: target.id,
            agentId: target.agentId ?? null,
            workspaceId: target.workspaceId ?? null,
        },
        sectionId: space.sectionId ?? null,
        orderKey: space.orderKey,
        placement: space.placement,
        visibility: space.visibility,
        working: description.working,
        version: space.version,
        createdAt: space.createdAt,
        updatedAt: space.updatedAt,
    };
}

export function spaceSectionResource(section: SpaceSectionRecord): Record<string, unknown> {
    return {
        id: section.id,
        name: section.name,
        visibleCount: section.visibleCount ?? null,
        collapsed: section.collapsed,
        tailExpanded: section.tailExpanded,
        orderKey: section.orderKey,
        version: section.version,
        createdAt: section.createdAt,
        updatedAt: section.updatedAt,
    };
}

export function spaceBatchResource(batch: SpaceBatch): Record<string, unknown> {
    const position = (at: SpaceBatch["changes"][number]["from"]) => ({
        sectionId: at.sectionId,
        sectionName: at.sectionName,
        index: at.index,
        visibility: at.visibility,
    });
    return {
        id: batch.id,
        note: batch.note,
        noteMessageId: batch.noteMessageId ?? null,
        changes: batch.changes.map((change) => ({
            spaceId: change.spaceId,
            title: change.title,
            from: position(change.from),
            to: position(change.to),
        })),
        appliedAt: batch.appliedAt,
    };
}
