import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenAICompatibleProvider } from "@slopus/happy-providers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { computeToolVendor } from "../../sources/compute/ComputeToolVendor.js";
import { refreshOpenAICompatibleMetadata } from "../../sources/config/impl/openAICompatibleModels.js";
import { systemPromptForModel } from "../../sources/systemPrompt/impl/systemPromptForModel.js";
import { glm_5_3_system_prompt } from "../../sources/systemPrompt/prompts/glm/glm_5_3_system_prompt.js";

const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configuration(lines: readonly string[]) {
    const root = await mkdtemp(join(tmpdir(), "happy-openai-compatible-"));
    roots.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    await writeFile(
        join(folder, "happy.toml"),
        ["[providers]", "default_enable = false", ...lines].join("\n"),
    );
    return await ConfigModule.load(join(root, ".happy"));
}

const base = (...extra: string[]) => [
    "[providers.openrouter]",
    'type = "openai_compatible"',
    'name = "OpenRouter"',
    "enabled = true",
    'base_url = "https://openrouter.example/api/v1/"',
    'api_key_env = "TEST_OPENROUTER_KEY"',
    `models = ["${DEEPSEEK}", "example/plain"]`,
    ...extra,
];

/** The relevant part of OpenRouter's real `/models` entry for DeepSeek V4.1 Flash 1017. */
const openRouterModels = {
    data: [
        {
            id: DEEPSEEK,
            name: "DeepSeek: DeepSeek V4.1 Flash 1017",
            context_length: 1_048_576,
            architecture: {
                modality: "text+image->text",
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
            },
            pricing: { prompt: "0.0000003", completion: "0.0000012" },
            reasoning: {
                mandatory: false,
                default_enabled: true,
                supported_efforts: ["max", "high", "low", "none"],
                default_effort: "high",
            },
        },
        { id: "unrelated/model", context_length: 8_192 },
    ],
};

describe("OpenAI-compatible providers", () => {
    it("lists exactly the configured models with conservative defaults until the vendor answers", async () => {
        const config = await configuration(base());
        expect(config.catalog.filter((entry) => entry.providerId === "openrouter")).toEqual([
            expect.objectContaining({
                id: DEEPSEEK,
                name: DEEPSEEK,
                enabled: true,
                effortLevels: ["medium"],
                defaultEffort: "medium",
                contextWindow: 128_000,
                autoCompactWindow: 108_800,
            }),
            expect.objectContaining({ id: "example/plain", contextWindow: 128_000 }),
        ]);
        expect(config.providerType("openrouter")).toBe("openai_compatible");
        expect(config.providers.typeOf("openrouter")).toBe("openai_compatible");
        expect(config.modelContext("openrouter", DEEPSEEK)).toEqual({
            contextWindow: 128_000,
            autoCompactWindow: 108_800,
        });
    });

    it("refines context, image input, and efforts from the vendor's /models, with configuration winning", async () => {
        const config = await configuration(
            base(
                `[providers.openrouter.model_overrides."example/plain"]`,
                'name = "Plain"',
                "context_window = 32768",
                'efforts = ["low", "high"]',
                'default_effort = "low"',
            ),
        );
        const provider = config.configuration.values.providers["openrouter"]!;
        if (provider.type !== "openai_compatible") throw new Error("Wrong provider type.");
        const request = vi.fn(async () => Response.json(openRouterModels));
        vi.stubEnv("TEST_OPENROUTER_KEY", "test-key");
        await refreshOpenAICompatibleMetadata(
            config.configuration,
            "openrouter",
            provider,
            request as unknown as typeof fetch,
        );
        const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://openrouter.example/api/v1/models");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
        const routes = config.catalog.filter((entry) => entry.providerId === "openrouter");
        expect(routes).toEqual([
            expect.objectContaining({
                id: DEEPSEEK,
                name: "DeepSeek: DeepSeek V4.1 Flash 1017",
                effortLevels: ["off", "low", "high", "max"],
                defaultEffort: "high",
                contextWindow: 1_048_576,
                autoCompactWindow: 891_289,
            }),
            expect.objectContaining({
                id: "example/plain",
                name: "Plain",
                effortLevels: ["low", "high"],
                defaultEffort: "low",
                contextWindow: 32_768,
            }),
        ]);
        const deepseek = await config.providers.resolve("openrouter", DEEPSEEK);
        expect(deepseek).toBeInstanceOf(OpenAICompatibleProvider);
        expect(deepseek!.inputTypes).toEqual(["text", "image"]);
        expect((await config.providers.resolve("openrouter", "example/plain"))!.inputTypes).toEqual(
            ["text"],
        );
    });

    it("ignores the vendor's metadata when model_metadata is off", async () => {
        const config = await configuration(base("model_metadata = false"));
        const provider = config.configuration.values.providers["openrouter"]!;
        if (provider.type !== "openai_compatible") throw new Error("Wrong provider type.");
        const request = vi.fn(async () => Response.json(openRouterModels));
        await refreshOpenAICompatibleMetadata(
            config.configuration,
            "openrouter",
            provider,
            request as unknown as typeof fetch,
        );
        expect(request).not.toHaveBeenCalled();
        expect(config.modelContext("openrouter", DEEPSEEK)?.contextWindow).toBe(128_000);
    });

    it("reads the key from the named variable when a session needs it", async () => {
        const config = await configuration(base());
        await expect(config.providers.resolve("openrouter", DEEPSEEK)).rejects.toThrow(
            "openrouter has no credentials. Check its settings, then retry.",
        );
        vi.stubEnv("TEST_OPENROUTER_KEY", "test-key");
        expect(await config.providers.resolve("openrouter", DEEPSEEK)).toBeInstanceOf(
            OpenAICompatibleProvider,
        );
    });

    it.each([
        [["base_url"], 'Provider "openrouter" must set base_url.'],
        [["api_key_env"], 'Provider "openrouter" must set api_key or api_key_env.'],
        [[], 'Provider "openrouter" must set api_key or api_key_env, not both.', ['api_key = "k"']],
        [["models"], 'Provider "openrouter" must list models.'],
        [
            [],
            'providers.openrouter.model_overrides names "other/model", which is not in models.',
            ['[providers.openrouter.model_overrides."other/model"]', "context_window = 4096"],
        ],
    ] as const)(
        "rejects incomplete configuration: %j",
        async (omitted, message, extra?: readonly string[]) => {
            const lines = base(...(extra ?? [])).filter(
                (line) => !omitted.some((key) => line.startsWith(`${key} =`)),
            );
            await expect(configuration(lines)).rejects.toThrow(message);
        },
    );

    it("refuses a request field the protocol owns before any session starts", async () => {
        vi.stubEnv("TEST_OPENROUTER_KEY", "test-key");
        const config = await configuration(
            base("[providers.openrouter.request]", "stream = false"),
        );
        await expect(config.providers.resolve("openrouter", DEEPSEEK)).rejects.toThrow(
            'The request field "stream" cannot be configured.',
        );
    });

    it("gives these models Claude Code's function tools and lean prompt, whatever their IDs resemble", () => {
        for (const model of [DEEPSEEK, "openai/gpt-6-luna", "anthropic/opus-5"]) {
            expect(computeToolVendor({ model, providerKind: "openai_compatible" })).toBe("glm");
            expect(systemPromptForModel({ model, providerKind: "openai_compatible" })).toBe(
                glm_5_3_system_prompt,
            );
        }
        expect(computeToolVendor({ model: "openai/gpt-6-luna", providerKind: "codex" })).toBe(
            "codex",
        );
    });
});
