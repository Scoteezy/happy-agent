import { defineAgentTool, type AgentModel } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import {
    collaborationCreateInputSchema,
    collaborationCreateResultSchema,
    type CollaborationCreateInput,
    type CollaborationCreator,
} from "../CollaborationAgent.js";

/** Create a collaborator and hand it its opening task. */
export function createAgentTool(
    collaboration: CollaborationModule,
    thisAgentId: string,
    creator: CollaborationCreator,
    maxCollaborators: number,
    maxCollaborationDepth: number,
) {
    return defineAgentTool({
        name: "create_agent",
        defer: true,
        capabilities: ["Create, message, and coordinate coding subagents."],
        searchKeywords: ["spawn subagent", "delegate work", "parallel collaborator"],
        description: createAgentDescription(maxCollaborators, maxCollaborationDepth),
        parameters: collaborationCreateInputSchema,
        returnType: collaborationCreateResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: CollaborationCreateInput, call) =>
            await collaboration.createToolAgent(
                ctx,
                thisAgentId,
                withCurrentProvider(input, creator.provider, collaboration.availableModels()),
                call.id,
                creator,
            ),
        toLLM: ({ agentId }) => [
            {
                type: "text",
                text: `Created collaborator ${agentId} and sent it the task. Anything it has to say will arrive as a message; nothing is waiting on it.`,
            },
        ],
    });
}

/** Omitted provider means the creator's route when that route serves the requested model. */
function withCurrentProvider(
    input: CollaborationCreateInput,
    currentProviderId: string,
    models: readonly AgentModel[],
): CollaborationCreateInput {
    if (input.provider !== undefined) return input;
    const currentProviderServesModel = models.some(
        (model) => model.id === input.model && model.providerId === currentProviderId,
    );
    return currentProviderServesModel ? { ...input, provider: currentProviderId } : input;
}

/**
 * The description never lists models: it stays the same while accounts and models come and go,
 * so provider prompt caching holds and no provider session is replaced. `agent_options` lists
 * them, and a change reaches an agent that has seen them as a notice.
 */
function createAgentDescription(maxCollaborators: number, maxCollaborationDepth: number): string {
    return [
        "Create a hidden collaborator for internal work, such as research. Bots, tasks, and subtasks use create_subtask only for substantial, distinct workstreams (e.g. changes across projects) or explicit subtask requests, within eligibility and depth limits. Handle small steps inline. Usually create second-level subtasks only on explicit user request.",
        "",
        "The collaborator works on its own. This call returns as soon as the task is delivered, and anything the collaborator has to say arrives later as a message — nothing here waits for it.",
        `One root agent tree may contain at most ${maxCollaborators} ordinary collaborators. Reuse one with send_agent_message after reaching the limit, or archive one that can no longer work (for example, its provider fails) with archive_agent to free its place. The maximum depth is ${maxCollaborationDepth} agents including the root. Subtasks belong to the tree but count toward neither limit; collaborators they create do count.`,
        "Call agent_options for the harnesses, providers, and models you can use, then choose an exact model and effort. A harness is who runs the collaborator's loop: happy is Happy's own; others are foreign agents such as Antigravity or Claude Code. Omitting harness or provider uses your own when it serves that model; otherwise each is optional only when the model settles it. This is the only chance to choose: a collaborator's model, effort, and permissions cannot be changed afterwards.",
    ].join("\n");
}
