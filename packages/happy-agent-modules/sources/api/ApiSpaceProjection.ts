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

export const moveSpaceRequestSchema = Type.Object(
    {
        sectionId: Type.Union([cuid2Schema, Type.Null()]),
        afterId: Type.Union([cuid2Schema, Type.Null()]),
        mutationId,
    },
    { additionalProperties: false },
);

export const sectionDisclosureRequestSchema = Type.Object(
    {
        collapsed: Type.Optional(Type.Boolean()),
        tailExpanded: Type.Optional(Type.Boolean()),
        mutationId,
    },
    { additionalProperties: false },
);

export const spaceFocusRequestSchema = Type.Object(
    { spaceId: Type.Union([cuid2Schema, Type.Null()]) },
    { additionalProperties: false },
);

/** The person is mid-interaction (hold batches), or calm (a gesture finished, or idle). */
export const spaceAttentionRequestSchema = Type.Object(
    { state: Type.Union([Type.Literal("interacting"), Type.Literal("calm")]) },
    { additionalProperties: false },
);

export const spaceTidyRequestSchema = Type.Object({ mutationId }, { additionalProperties: false });

export const spaceManagerRequestSchema = Type.Object(
    {
        model: Type.Union([
            Type.Object(
                {
                    providerId: Type.String({ minLength: 1, maxLength: 128 }),
                    modelId: Type.String({ minLength: 1, maxLength: 256 }),
                    effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
    },
    { additionalProperties: false },
);

/** One sidebar row as clients see it: stored placement plus its content resolved live. */
export function spaceResource(
    space: SpaceRecord,
    description: SpaceDescription,
): Record<string, unknown> {
    const target = description.target;
    return {
        id: space.id,
        ownerUserId: space.ownerUserId,
        role: space.role,
        title: description.title,
        name: space.name ?? null,
        icon:
            space.icon === undefined
                ? null
                : space.icon.type === "image"
                  ? description.imageUrl === undefined
                      ? null
                      : { type: "image", url: description.imageUrl }
                  : space.icon,
        contents: space.contents,
        target:
            target === undefined
                ? null
                : {
                      kind: target.kind,
                      id: target.id,
                      agentId: target.agentId ?? null,
                      workspaceId: target.workspaceId ?? null,
                      ...(target.path === undefined ? {} : { path: target.path }),
                  },
        agentId: target?.agentId ?? null,
        sectionId: space.sectionId ?? null,
        orderKey: space.orderKey,
        placement: space.placement,
        visibility: space.visibility,
        working: description.working,
        archived: description.archived,
        lastActivityAt: description.lastActivityAt ?? null,
        manualAt: space.manualAt ?? null,
        version: space.version,
        createdAt: space.createdAt,
        updatedAt: space.updatedAt,
    };
}

export function spaceSectionResource(section: SpaceSectionRecord): Record<string, unknown> {
    return {
        id: section.id,
        ownerUserId: section.ownerUserId,
        name: section.name,
        context: section.context ?? null,
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
    return {
        id: batch.id,
        ownerUserId: batch.ownerUserId,
        reason: batch.reason,
        note: batch.note,
        noteAgentId: batch.noteAgentId ?? null,
        noteMessageId: batch.noteMessageId ?? null,
        changes: batch.changes,
        sections: batch.sections,
        appliedAt: batch.appliedAt,
    };
}
