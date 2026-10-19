import type { AgentModel } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";

import type { SpaceManagerModel } from "../Space.js";

/** The model, account, and effort a manager turn runs on. */
export interface SpaceManagerRoute {
    readonly providerId: string;
    readonly model: string;
    readonly effort: SessionReasoningEffort;
}

/** Fast, inexpensive models that sort a sidebar well, in order of preference. */
const ECONOMICAL_MODEL_IDS = [
    "anthropic/haiku-5-5",
    "openai/gpt-6-luna",
    "openai/gpt-5.6-luna",
    "xai/grok-composer-2.5-fast",
    "anthropic/sonnet-5",
];

/** Sorting rows is light work, so the least reasoning the model accepts is enough. */
const CHEAPEST_EFFORTS: readonly SessionReasoningEffort[] = ["off", "minimal", "low", "medium"];

/**
 * Picks what the manager runs on. A configured model wins while the installation still offers
 * it. Otherwise the cheapest model of the account Happy runs on, because only that account is
 * known to be signed in and paid for, and then of the installation's default account.
 */
export function selectSpaceManagerRoute(
    models: readonly AgentModel[],
    configured: SpaceManagerModel | undefined,
    preferredProviderId: string | undefined,
): SpaceManagerRoute | undefined {
    if (configured !== undefined) {
        const model = models.find(
            (candidate) =>
                candidate.providerId === configured.providerId &&
                candidate.id === configured.modelId,
        );
        if (model !== undefined) {
            const effort = model.effortLevels.find((level) => level === configured.effort);
            return {
                providerId: model.providerId,
                model: model.id,
                effort: effort ?? cheapestEffort(model),
            };
        }
    }
    const served =
        servedBy(models, preferredProviderId) ?? servedBy(models, models[0]?.providerId) ?? models;
    const model =
        ECONOMICAL_MODEL_IDS.map((id) => served.find((candidate) => candidate.id === id)).find(
            (candidate) => candidate !== undefined,
        ) ?? served[0];
    if (model === undefined) return undefined;
    return { providerId: model.providerId, model: model.id, effort: cheapestEffort(model) };
}

function servedBy(
    models: readonly AgentModel[],
    providerId: string | undefined,
): readonly AgentModel[] | undefined {
    if (providerId === undefined) return undefined;
    const served = models.filter((model) => model.providerId === providerId);
    return served.length === 0 ? undefined : served;
}

function cheapestEffort(model: AgentModel): SessionReasoningEffort {
    for (const effort of CHEAPEST_EFFORTS) {
        if (model.effortLevels.includes(effort)) return effort;
    }
    return model.defaultEffort;
}
