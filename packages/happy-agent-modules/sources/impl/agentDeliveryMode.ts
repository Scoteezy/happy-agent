import {
    agentEffort,
    agentModel,
    agentProvider,
    agentServiceTier,
    DEFAULT_AGENT_PERMISSION_MODE,
    type AgentBaseMessageOptions,
    type AgentModel,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";
import { messageModeSchema, type MessageMode } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

/**
 * The mode one agent's message gives a conversation that has never been given one.
 *
 * Agent Base holds no model for a new agent: the first message names it, and a person's message
 * always does. When an agent speaks first instead — a task's opening text, or the first word to an
 * unstarted task seeded with an idle draft, or the first word to a bot nobody has talked to yet — the
 * conversation runs on the seeded selection or sender's own selection while this installation still
 * offers it. If a seeded model is no longer offered by the installation (e.g. removed from the catalog
 * or deprecated), it falls back to the sender's own selection if offered, or the installation's
 * default model. A conversation that already has a mode and is not unstarted keeps it, so a later
 * message never overrides a person's choice. The permission mode is the one Agent Base gives a new
 * agent, sent explicitly so the recorded mode is what the conversation actually runs with.
 *
 * `ctx` is the sender's: its agent context carries the selection the sender is running on.
 */
export async function agentDeliveryMode(
    ctx: Context,
    agents: AgentSystemRef,
    models: readonly AgentModel[],
    toAgentId: string,
): Promise<AgentDeliveryMode | undefined> {
    const config = await agents.config(ctx, toAgentId);
    if (
        config?.metadata?.["unstarted"] !== true &&
        Value.Check(messageModeSchema, config?.metadata?.["lastMode"])
    ) {
        return undefined;
    }
    const lastMode = config?.metadata?.["lastMode"];
    const draft = config?.metadata?.["draft"];
    const seededMode =
        (Value.Check(messageModeSchema, lastMode) ? (lastMode as MessageMode) : undefined) ??
        (Value.Check(messageModeSchema, draft) ? (draft as MessageMode) : undefined);
    const seeded =
        seededMode !== undefined
            ? models.find(
                  (model) =>
                      model.providerId === seededMode.providerId && model.id === seededMode.modelId,
              )
            : undefined;
    const providerId = agentProvider(ctx);
    const modelId = agentModel(ctx);
    const inherited =
        seeded ?? models.find((model) => model.providerId === providerId && model.id === modelId);
    const model = inherited ?? models[0];
    if (model === undefined) return undefined;
    const requestedEffort: SessionReasoningEffort | undefined =
        seededMode !== undefined
            ? (seededMode.effort as SessionReasoningEffort)
            : inherited === undefined
              ? undefined
              : agentEffort(ctx);
    const effort: SessionReasoningEffort =
        requestedEffort !== undefined && model.effortLevels.includes(requestedEffort)
            ? requestedEffort
            : model.defaultEffort;
    const requestedTier =
        seededMode !== undefined
            ? seededMode.serviceTier
            : inherited === undefined
              ? undefined
              : agentServiceTier(ctx);
    const serviceTier =
        requestedTier !== undefined &&
        requestedTier !== null &&
        model.serviceTiers?.includes(requestedTier) === true
            ? requestedTier
            : null;
    const permissionMode =
        (seededMode !== undefined ? seededMode.permissionMode : undefined) ??
        DEFAULT_AGENT_PERMISSION_MODE;
    return {
        mode: {
            providerId: model.providerId,
            modelId: model.id,
            effort,
            serviceTier,
            permissionMode,
        },
        options: {
            provider: model.providerId,
            model: model.id,
            effort,
            serviceTier,
            permissionMode,
        },
    };
}

/** A conversation's first mode: the one to record, and the send options that run with it. */
export interface AgentDeliveryMode {
    readonly mode: MessageMode;
    readonly options: Pick<
        AgentBaseMessageOptions,
        "effort" | "model" | "permissionMode" | "provider" | "serviceTier"
    >;
}
