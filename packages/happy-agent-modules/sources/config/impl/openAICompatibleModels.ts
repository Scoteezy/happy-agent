import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentModel } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { HappyAgentConfigValues, HappyAgentConfiguration } from "../ConfigModule.js";

type OpenAICompatibleProviderConfig = Extract<
    HappyAgentConfigValues["providers"][string],
    { readonly type: "openai_compatible" }
>;
type Effort = AgentModel["defaultEffort"];

/** The context window assumed until the vendor or the configuration says otherwise. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Compaction starts at 85% of the window, leaving room for the reply and the summary. */
const AUTO_COMPACT_RATIO = 0.85;
const METADATA_TIMEOUT_MS = 15_000;
/** OpenRouter's whole catalog, descriptions included, is a few megabytes. */
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const EFFORT_ORDER: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What the vendor's `/models` endpoint said about one configured model, as it is cached. */
const modelMetadataSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 256 }),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        contextWindow: Type.Optional(Type.Integer({ minimum: 1_024, maximum: 100_000_000 })),
        input: Type.Optional(
            Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { maxItems: 2 }),
        ),
        efforts: Type.Optional(
            Type.Array(Type.Union(EFFORT_ORDER.map((effort) => Type.Literal(effort))), {
                minItems: 1,
                maxItems: 7,
            }),
        ),
        defaultEffort: Type.Optional(
            Type.Union(EFFORT_ORDER.map((effort) => Type.Literal(effort))),
        ),
    },
    { additionalProperties: false },
);
type ModelMetadata = Static<typeof modelMetadataSchema>;
const cachedMetadataSchema = Type.Array(modelMetadataSchema, { maxItems: 256 });

/** One entry of an OpenAI-style `/models` list; OpenRouter adds the optional fields. */
const vendorModelSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 256 }),
    name: Type.Optional(Type.String()),
    context_length: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    architecture: Type.Optional(
        Type.Object({ input_modalities: Type.Optional(Type.Array(Type.String())) }),
    ),
    reasoning: Type.Optional(
        Type.Object({
            mandatory: Type.Optional(Type.Boolean()),
            supported_efforts: Type.Optional(Type.Array(Type.String())),
            default_effort: Type.Optional(Type.String()),
        }),
    ),
});
const vendorModelListSchema = Type.Object({ data: Type.Array(Type.Unknown()) });

/** One configured chat model, resolved from configuration over the vendor's own metadata. */
export interface OpenAICompatibleResolvedModel {
    readonly id: string;
    readonly name: string;
    readonly contextWindow: number;
    readonly autoCompactWindow: number;
    readonly input: readonly ("text" | "image")[];
    /** The efforts sent as `reasoning_effort`; absent when nothing says the model takes one. */
    readonly efforts?: readonly Effort[];
    readonly defaultEffort: Effort;
    readonly request?: Readonly<Record<string, unknown>>;
}

/**
 * Every chat model one provider serves, in configured order.
 *
 * The list is exactly `models`: the vendor is never asked which models exist. Configuration wins
 * field by field over the cached `/models` metadata, which wins over conservative defaults: a
 * 128k window, text input, and no effort sent.
 */
export function openAICompatibleModels(
    agentHome: string,
    providerId: string,
    provider: OpenAICompatibleProviderConfig,
): readonly OpenAICompatibleResolvedModel[] {
    const metadata =
        provider.modelMetadata === false ? [] : (cachedMetadata(agentHome, providerId) ?? []);
    return (provider.models ?? []).map((id) => {
        const reported = metadata.find((candidate) => candidate.id === id);
        const override = provider.modelOverrides?.[id];
        const contextWindow =
            override?.contextWindow ?? reported?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const efforts = override?.efforts ?? reported?.efforts;
        const ordered =
            efforts === undefined
                ? undefined
                : EFFORT_ORDER.filter((effort) => efforts.includes(effort));
        const defaultEffort =
            override?.defaultEffort ??
            (reported?.defaultEffort !== undefined && ordered?.includes(reported.defaultEffort)
                ? reported.defaultEffort
                : undefined) ??
            ordered?.find((effort) => effort !== "off") ??
            ordered?.[0] ??
            "medium";
        return {
            id,
            name: override?.name ?? reported?.name ?? id,
            contextWindow,
            autoCompactWindow: Math.min(
                override?.autoCompactWindow ?? Math.floor(contextWindow * AUTO_COMPACT_RATIO),
                contextWindow,
            ),
            input: override?.input ?? reported?.input ?? ["text"],
            ...(ordered === undefined ? {} : { efforts: ordered }),
            defaultEffort,
            ...(override?.request === undefined ? {} : { request: override.request }),
        };
    });
}

/** The key this provider is configured to use, read when it is needed. */
export function openAICompatibleApiKey(
    provider: OpenAICompatibleProviderConfig,
): string | undefined {
    const key =
        provider.apiKey ??
        (provider.apiKeyEnv === undefined ? undefined : process.env[provider.apiKeyEnv]);
    return key?.trim() ? key : undefined;
}

function metadataPath(agentHome: string, providerId: string): string {
    return join(agentHome, "openai-compatible", encodeURIComponent(providerId), "models.json");
}

/** The metadata last fetched for one provider, read again only when the file changes. */
const cached = new Map<
    string,
    { readonly mtimeMs: number; readonly models: readonly ModelMetadata[] }
>();

function cachedMetadata(
    agentHome: string,
    providerId: string,
): readonly ModelMetadata[] | undefined {
    const path = metadataPath(agentHome, providerId);
    let mtimeMs: number;
    try {
        mtimeMs = statSync(path).mtimeMs;
    } catch {
        return undefined;
    }
    const hit = cached.get(path);
    if (hit?.mtimeMs === mtimeMs) return hit.models;
    try {
        const models: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!Value.Check(cachedMetadataSchema, models)) return undefined;
        cached.set(path, { mtimeMs, models });
        return models;
    } catch {
        return undefined;
    }
}

/**
 * Ask the vendor's `/models` endpoint what it knows about the configured models — their context
 * windows, image input, and reasoning efforts — and remember the answer. This never adds or
 * removes a model; it runs after startup, off every session path, and a vendor without the
 * endpoint simply keeps the defaults.
 */
export async function refreshOpenAICompatibleMetadata(
    configuration: HappyAgentConfiguration,
    providerId: string,
    provider: OpenAICompatibleProviderConfig,
    fetcher: typeof fetch = fetch,
): Promise<void> {
    if (provider.modelMetadata === false || (provider.models ?? []).length === 0) return;
    const apiKey = openAICompatibleApiKey(provider);
    const response = await fetcher(`${provider.baseUrl}/models`, {
        headers: {
            ...provider.headers,
            accept: "application/json",
            ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The models endpoint answered HTTP ${response.status}.`);
    }
    const body: unknown = JSON.parse(await readBounded(response));
    if (!Value.Check(vendorModelListSchema, body)) {
        throw new Error("The models endpoint did not return a model list.");
    }
    const wanted = new Set(provider.models);
    const models: ModelMetadata[] = [];
    for (const entry of body.data) {
        if (!Value.Check(vendorModelSchema, entry) || !wanted.has(entry.id)) continue;
        const metadata = toMetadata(entry);
        if (Value.Check(modelMetadataSchema, metadata)) models.push(metadata);
    }
    const path = metadataPath(configuration.paths.agentHome, providerId);
    const next = JSON.stringify(models);
    try {
        if (readFileSync(path, "utf8") === next) return;
    } catch {
        // Written below.
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, path);
}

function toMetadata(entry: Static<typeof vendorModelSchema>): ModelMetadata {
    const input = entry.architecture?.input_modalities?.filter(
        (modality): modality is "text" | "image" => modality === "text" || modality === "image",
    );
    const reasoning = entry.reasoning;
    const supported = reasoning?.supported_efforts
        ?.map((effort) => (effort === "none" ? "off" : effort))
        .filter(
            (effort): effort is Effort =>
                (EFFORT_ORDER as readonly string[]).includes(effort) &&
                !(effort === "off" && reasoning?.mandatory === true),
        );
    const efforts =
        supported === undefined || supported.length === 0
            ? undefined
            : EFFORT_ORDER.filter((effort) => supported.includes(effort));
    const defaultEffort = reasoning?.default_effort === "none" ? "off" : reasoning?.default_effort;
    return {
        id: entry.id,
        ...(entry.name?.trim() ? { name: entry.name.trim().slice(0, 256) } : {}),
        ...(typeof entry.context_length === "number" && entry.context_length >= 1_024
            ? { contextWindow: Math.min(entry.context_length, 100_000_000) }
            : {}),
        ...(input === undefined || input.length === 0 ? {} : { input }),
        ...(efforts === undefined ? {} : { efforts }),
        ...(efforts !== undefined && efforts.includes(defaultEffort as Effort)
            ? { defaultEffort: defaultEffort as Effort }
            : {}),
    };
}

async function readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_METADATA_BYTES) {
            await reader.cancel();
            throw new Error("The models endpoint answered with too much data.");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}
