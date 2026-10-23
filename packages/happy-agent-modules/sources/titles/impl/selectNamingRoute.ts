import type { AgentModel } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";

/** One account and model a name can be written on. */
export interface NamingRoute {
    readonly providerId: string;
    readonly model: string;
    readonly effort: SessionReasoningEffort;
}

/**
 * Picks what writes a name: the model the chat itself runs on, at that model's own default
 * effort.
 *
 * A new chat starts on the default model from Settings, so this is the person's chosen model, not
 * a cheaper one: short names still need judgement about what the work is. When that model is no
 * longer served, the chat's own account is preferred, because only it is known to be signed in;
 * the configured default answers when the chat has named no account.
 */
export function selectNamingRoute(
    models: readonly AgentModel[],
    chat: { readonly providerId?: string; readonly modelId?: string },
    defaultProviderId?: string,
): NamingRoute | undefined {
    const model =
        models.find(
            (candidate) =>
                candidate.providerId === chat.providerId && candidate.id === chat.modelId,
        ) ??
        models.find((candidate) => candidate.providerId === chat.providerId) ??
        models.find((candidate) => candidate.providerId === defaultProviderId) ??
        models[0];
    if (model === undefined) return undefined;
    return { providerId: model.providerId, model: model.id, effort: model.defaultEffort };
}
