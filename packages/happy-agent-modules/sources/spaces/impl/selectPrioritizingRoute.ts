import type { AgentModel } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The model, account, and effort a Prioritizing turn runs on. */
export interface PrioritizingRoute {
    readonly providerId: string;
    readonly model: string;
    readonly effort: SessionReasoningEffort;
}

/** The installation's default model, as Settings in the desktop app saves it. */
export const PRIORITIZING_DEFAULT_MODEL_SETTING = "happy-desktop.model.default";

const defaultModelSchema = Type.Object({
    providerId: Type.String({ minLength: 1 }),
    modelId: Type.String({ minLength: 1 }),
});

/**
 * Picks what Prioritizing runs on: the default model from Settings, the one Happy suggests for
 * every new chat, at that model's own default effort. Grouping and choosing what to show need the
 * strongest model, never a cheaper one. Without a chosen model still served, the installation's
 * default model.
 */
export function selectPrioritizingRoute(
    models: readonly AgentModel[],
    defaultModel: unknown,
): PrioritizingRoute | undefined {
    const chosen = Value.Check(defaultModelSchema, defaultModel) ? defaultModel : undefined;
    const model =
        models.find(
            (candidate) =>
                candidate.providerId === chosen?.providerId && candidate.id === chosen.modelId,
        ) ?? models[0];
    if (model === undefined) return undefined;
    return { providerId: model.providerId, model: model.id, effort: model.defaultEffort };
}
