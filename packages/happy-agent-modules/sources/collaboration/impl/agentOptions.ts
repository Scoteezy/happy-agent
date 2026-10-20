import { createHash } from "node:crypto";

import type { AgentModel } from "@slopus/happy-agent-base";

/** One model a new agent can run, with the choices its creation takes. */
export interface AgentOptionsModel {
    readonly id: string;
    readonly name: string;
    readonly efforts: readonly string[];
    readonly defaultEffort: string;
    readonly serviceTiers?: readonly string[];
}

/** One account a harness runs on. */
export interface AgentOptionsProvider {
    readonly id: string;
    readonly name: string;
    readonly models: readonly AgentOptionsModel[];
    /** Quota windows the account's agent reports, when it reports any. */
    readonly usage?: readonly AgentOptionsUsageWindow[];
}

/** Share of one quota window left, as the agent itself reports it. */
export interface AgentOptionsUsageWindow {
    /** Which models the window covers, in the agent's words, such as "Gemini Models". */
    readonly scope: string;
    /** The window, in the agent's words, such as "Weekly Limit Remaining". */
    readonly window: string;
    readonly remainingPercent: number;
    /** ISO time the window resets, or null when unreported. */
    readonly resetsAt: string | null;
}

/** One harness and the accounts it runs on. */
export interface AgentOptionsHarness {
    readonly id: string;
    readonly name: string;
    readonly providers: readonly AgentOptionsProvider[];
}

/**
 * The harnesses, accounts, and models one agent can create sub-agents with. `version` changes
 * exactly when one of those choices does, and never for usage, which moves on every request.
 */
export interface AgentOptions {
    readonly version: string;
    readonly current: { readonly harness: string; readonly provider: string };
    readonly harnesses: readonly AgentOptionsHarness[];
}

export interface AgentOptionsSources {
    readonly harnessOf: (providerId: string, modelId: string) => string;
    readonly harnessName: (harnessId: string) => string;
    readonly providerName: (providerId: string) => string;
}

/** Group `models` by harness and account, in catalog order. */
export function buildAgentOptions(
    models: readonly AgentModel[],
    current: AgentOptions["current"],
    sources: AgentOptionsSources,
): AgentOptions {
    const harnesses = new Map<string, Map<string, AgentOptionsModel[]>>();
    for (const model of models) {
        const harnessId = sources.harnessOf(model.providerId, model.id);
        let providers = harnesses.get(harnessId);
        if (providers === undefined) harnesses.set(harnessId, (providers = new Map()));
        let entries = providers.get(model.providerId);
        if (entries === undefined) providers.set(model.providerId, (entries = []));
        entries.push({
            id: model.id,
            name: model.name,
            efforts: [...model.effortLevels],
            defaultEffort: model.defaultEffort,
            ...(model.serviceTiers === undefined || model.serviceTiers.length === 0
                ? {}
                : { serviceTiers: [...model.serviceTiers] }),
        });
    }
    const listed: AgentOptionsHarness[] = [...harnesses].map(([id, providers]) => ({
        id,
        name: sources.harnessName(id),
        providers: [...providers].map(([providerId, entries]) => ({
            id: providerId,
            name: sources.providerName(providerId),
            models: entries,
        })),
    }));
    const version = createHash("sha256")
        .update(JSON.stringify({ current, harnesses: listed }))
        .digest("hex")
        .slice(0, 12);
    return { version: `o_${version}`, current, harnesses: listed };
}

/** The options as the text a model reads. */
export function formatAgentOptions(options: AgentOptions): string {
    const lines = [
        `Version ${options.version}. You are on harness ${options.current.harness}, provider ${options.current.provider}; omitted harness and provider default to these when they serve the model.`,
    ];
    if (options.harnesses.length === 0) lines.push("No harness offers sub-agents to you now.");
    for (const harness of options.harnesses) {
        lines.push("", `Harness ${harness.id} (${harness.name}):`);
        for (const provider of harness.providers) {
            lines.push(`- provider ${provider.id} (${provider.name}):`);
            for (const model of provider.models) {
                lines.push(
                    `  - ${model.id} (${model.name}; effort: ${model.efforts.join(", ")}, default ${model.defaultEffort}${
                        model.serviceTiers === undefined
                            ? ""
                            : `; tiers: ${model.serviceTiers.join(", ")}`
                    })`,
                );
            }
            for (const window of provider.usage ?? []) {
                lines.push(
                    `  - usage: ${window.scope}, ${window.window}: ${String(window.remainingPercent)}% left${
                        window.resetsAt === null ? "" : `, resets ${window.resetsAt}`
                    }`,
                );
            }
        }
    }
    return lines.join("\n");
}
