import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { CollaborationCreator } from "../CollaborationAgent.js";
import type { CollaborationModule } from "../CollaborationModule.js";
import { formatAgentOptions } from "../impl/agentOptions.js";

const agentOptionsInputSchema = Type.Object(
    {
        harness: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
type AgentOptionsInput = Static<typeof agentOptionsInputSchema>;

const agentOptionsResultSchema = Type.Object(
    { text: Type.String() },
    { additionalProperties: false },
);

/**
 * List what this agent can create sub-agents and subtasks with. Reading the options marks them
 * seen, so later changes arrive as a notice instead of in any tool definition.
 */
export function agentOptionsTool(
    collaboration: CollaborationModule,
    creator: CollaborationCreator,
    markSeen: (ctx: Context, version: string) => Promise<void>,
) {
    return defineAgentTool({
        name: "agent_options",
        defer: true,
        capabilities: ["Create, message, and coordinate coding subagents."],
        searchKeywords: ["list models", "subagent models", "harnesses", "providers", "quota"],
        description:
            "List the harnesses, providers, and models you can create collaborators and subtasks with, each model's efforts, and the quota an account's agent reports. A harness is who runs the agent's loop: happy is Happy's own; others are foreign agents such as Antigravity or Claude Code. Filter by harness or provider. When these options change later, you are told.",
        parameters: agentOptionsInputSchema,
        returnType: agentOptionsResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: AgentOptionsInput) => {
            const options = await collaboration.agentOptions(creator, input);
            // Only the whole set is a version the agent has seen; a filtered view is not.
            if (input.harness === undefined && input.provider === undefined) {
                await markSeen(ctx, options.version);
            }
            return { text: formatAgentOptions(options) };
        },
        toLLM: ({ text }) => [{ type: "text", text }],
    });
}
