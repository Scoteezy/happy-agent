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
 * The only sidebar write other agents have: they ask Prioritizing, which decides. Keyed by
 * the tool call, so a retried call asks once.
 */
export function requestSpacePlacementTool(spaces: SpacesModule, actingAgentId: string) {
    return defineAgentTool({
        name: "request_space_placement",
        defer: true,
        capabilities: [
            "Ask Prioritizing to place, fold, or hide a conversation's row in the sidebar.",
        ],
        searchKeywords: ["sidebar", "move to section", "organize sidebar", "put this in"],
        description:
            "Ask Prioritizing, the helper that organises the person's sidebar, to move a conversation's row: into a section, under a collapsed section, or out of sight. Prioritizing decides and applies it at a calm moment, or at once when the person explicitly asked.",
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
