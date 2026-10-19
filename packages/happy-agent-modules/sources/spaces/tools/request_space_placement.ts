import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { SpacesModule } from "../SpacesModule.js";

const requestSpacePlacementSchema = Type.Object(
    {
        request: Type.String({
            minLength: 1,
            maxLength: 2_000,
            description:
                'What should change, in plain words, for example "put this in Desktop" or "the release is done".',
        }),
        agentId: Type.Optional(
            Type.Union([cuid2Schema], {
                description: "The conversation whose row should move. Omit for your own.",
            }),
        ),
        personAsked: Type.Optional(
            Type.Boolean({
                description:
                    "True when the person explicitly asked for this change, so it applies at once instead of waiting for a calm moment.",
            }),
        ),
    },
    { additionalProperties: false },
);
type RequestSpacePlacementInput = Static<typeof requestSpacePlacementSchema>;

const resultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });

/**
 * The only sidebar write other agents have: they ask the sidebar manager, which decides. Keyed by
 * the tool call, so a retried call asks once.
 */
export function requestSpacePlacementTool(spaces: SpacesModule, actingAgentId: string) {
    return defineAgentTool({
        name: "request_space_placement",
        defer: true,
        capabilities: ["Ask the sidebar manager to place, fold, or hide a conversation's row."],
        searchKeywords: ["sidebar", "move to section", "organize sidebar", "put this in"],
        description:
            "Ask the person's sidebar manager to move a conversation's row in their sidebar: into a section, to Older, or out of sight. The manager decides and applies it at a calm moment, or at once when the person explicitly asked.",
        parameters: requestSpacePlacementSchema,
        returnType: resultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: RequestSpacePlacementInput, call) => ({
            text: await spaces.requestPlacement(ctx, actingAgentId, {
                request: input.request,
                agentId: input.agentId ?? actingAgentId,
                personAsked: input.personAsked === true,
                requestId: call.id,
            }),
        }),
        toLLM: (result) => [{ type: "text", text: result.text }],
    });
}
