import { createId } from "@paralleldrive/cuid2";
import { cuid2Schema, defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import {
    spaceIconSlugSchema,
    spaceReasonSchema,
    spaceTextSchema,
    spaceVisibilitySchema,
} from "../Space.js";
import type { SpacesModule } from "../SpacesModule.js";

const textResultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
type TextResult = Static<typeof textResultSchema>;
const toLLM = (result: TextResult) => [{ type: "text" as const, text: result.text }];

const emptySchema = Type.Object({}, { additionalProperties: false });

const placeSpaceSchema = Type.Object(
    {
        spaceId: cuid2Schema,
        sectionId: Type.Union([cuid2Schema, Type.Null()], {
            description: "The section to put the row in, or null for directly under Happy.",
        }),
        afterId: Type.Optional(
            Type.Union([cuid2Schema, Type.Null()], {
                description: "Put the row after this row of the same section. Omit for the top.",
            }),
        ),
        reason: Type.Optional(
            Type.Union([spaceReasonSchema], {
                description:
                    'A few lower-case words on why, such as "finished". Kept with the change; not shown in the note.',
            }),
        ),
    },
    { additionalProperties: false },
);

const setVisibilitySchema = Type.Object(
    {
        spaceId: cuid2Schema,
        visibility: spaceVisibilitySchema,
        reason: Type.Optional(
            Type.Union([spaceReasonSchema], {
                description:
                    'A few lower-case words on why, such as "finished". Kept with the change; not shown in the note.',
            }),
        ),
    },
    { additionalProperties: false },
);

const setIconSchema = Type.Object(
    { spaceId: cuid2Schema, slug: spaceIconSlugSchema },
    { additionalProperties: false },
);

const updateSectionSchema = Type.Object(
    {
        sectionId: Type.Optional(
            Type.Union([cuid2Schema], { description: "Omit to create a new section." }),
        ),
        name: Type.Optional(spaceTextSchema),
        context: Type.Optional(
            Type.Union([spaceTextSchema, Type.Null()], {
                description: "One muted line under the title; null removes it.",
            }),
        ),
        visibleCount: Type.Optional(
            Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()], {
                description: "Show only the first rows; null shows them all.",
            }),
        ),
        afterSectionId: Type.Optional(
            Type.Union([cuid2Schema, Type.Null()], {
                description: "Put the section after this one; null for first. Omit to keep it.",
            }),
        ),
    },
    { additionalProperties: false },
);

const removeSectionSchema = Type.Object(
    { sectionId: cuid2Schema },
    { additionalProperties: false },
);

/**
 * The manager's whole tool array. Everything that moves a row or a section is queued for the next
 * calm moment; only icons apply at once. Each tool restates its outcome so the
 * manager never has to guess whether a change already happened.
 */
export function spaceManagerTools(spaces: SpacesModule, ownerUserId: string): AnyAgentTool[] {
    return [
        defineAgentTool({
            name: "list_sidebar",
            description:
                "Show the person's sidebar: sections in order, the rows in each with their IDs, icons, state, and last activity, rows under Happy, Older, hidden rows, and changes already queued.",
            parameters: emptySchema,
            returnType: textResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx) => ({ text: await spaces.managerOverview(ctx, ownerUserId) }),
            toLLM,
        }),
        defineAgentTool({
            name: "place_space",
            description:
                "Queue moving a row into a section (or directly under Happy with sectionId null), at the top or after another row. Placing a row shows it and settles its placement. Applies at the next calm moment.",
            parameters: placeSpaceSchema,
            returnType: textResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof placeSpaceSchema>) => ({
                text: await spaces.queueChange(ctx, ownerUserId, {
                    type: "place",
                    spaceId: input.spaceId,
                    sectionId: input.sectionId,
                    ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
                    ...(input.reason === undefined ? {} : { reason: input.reason }),
                }),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "set_space_visibility",
            description:
                'Queue showing a row, folding it into Older ("folded"), or hiding it ("hidden"). Hidden rows stay in History; nothing is deleted. Applies at the next calm moment.',
            parameters: setVisibilitySchema,
            returnType: textResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof setVisibilitySchema>) => ({
                text: await spaces.queueChange(ctx, ownerUserId, {
                    type: "visibility",
                    spaceId: input.spaceId,
                    visibility: input.visibility,
                    ...(input.reason === undefined ? {} : { reason: input.reason }),
                }),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "set_space_icon",
            description:
                "Set a row's icon to one slug of the icon library. Applies at once, because it moves nothing.",
            parameters: setIconSchema,
            returnType: textResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof setIconSchema>) => ({
                text: await spaces.setIcon(ctx, ownerUserId, input.spaceId, input.slug),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "update_section",
            description:
                "Create a section (omit sectionId and give a name) or change one: its name, one-line context, visible count, or position. Returns the section ID, which place_space can use right away. Names are unique: creating a name that exists returns the existing section. Applies at the next calm moment.",
            parameters: updateSectionSchema,
            returnType: textResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof updateSectionSchema>, call) => {
                const create = input.sectionId === undefined;
                if (create && input.name === undefined) {
                    throw new Error("A new section needs a name.");
                }
                // A retried call creates the same section rather than a second one.
                const sectionId =
                    input.sectionId ??
                    (await call.kv.getOrCreate(ctx, "sectionId", () => createId()));
                return {
                    text: await spaces.queueChange(ctx, ownerUserId, {
                        type: "section",
                        sectionId,
                        create,
                        ...(input.name === undefined ? {} : { name: input.name }),
                        ...(input.context === undefined ? {} : { context: input.context }),
                        ...(input.visibleCount === undefined
                            ? {}
                            : { visibleCount: input.visibleCount }),
                        ...(input.afterSectionId === undefined
                            ? {}
                            : { afterSectionId: input.afterSectionId }),
                    }),
                };
            },
            toLLM,
        }),
        defineAgentTool({
            name: "remove_section",
            description:
                "Queue removing a section. Rows still in it when the batch applies fold into Older. Applies at the next calm moment.",
            parameters: removeSectionSchema,
            returnType: textResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof removeSectionSchema>) => ({
                text: await spaces.queueChange(ctx, ownerUserId, {
                    type: "remove_section",
                    sectionId: input.sectionId,
                }),
            }),
            toLLM,
        }),
    ];
}
