import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    assistantMessageFromEvents,
    committedSessionEvents,
    type SessionContext,
    type SessionEvent,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { afterAll, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { refreshOpenAICompatibleMetadata } from "../../sources/config/impl/openAICompatibleModels.js";

/** Runs against OpenRouter with the key in OPENROUTER_API_KEY, which never enters the repository. */
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const ctx = createRootContext().named("happy-agent-modules-openrouter-live");
const roots: string[] = [];

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function openRouter() {
    const root = await mkdtemp(join(tmpdir(), "happy-openrouter-live-"));
    roots.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    await writeFile(
        join(folder, "happy.toml"),
        [
            "[providers]",
            "default_enable = false",
            "[providers.openrouter]",
            'type = "openai_compatible"',
            'name = "OpenRouter"',
            "enabled = true",
            'base_url = "https://openrouter.ai/api/v1"',
            'api_key_env = "OPENROUTER_API_KEY"',
            `models = ["${DEEPSEEK}"]`,
            'reasoning_field = "reasoning"',
            "[providers.openrouter.request]",
            "reasoning = { enabled = true }",
        ].join("\n"),
    );
    return await ConfigModule.load(join(root, ".happy"));
}

describe.skipIf(process.env.RIG_LIVE_TEST !== "1")("OpenRouter through configuration, live", () => {
    it("reads model details, then runs DeepSeek through a tool call to an answer", async () => {
        const config = await openRouter();
        const provider = config.configuration.values.providers["openrouter"]!;
        if (provider.type !== "openai_compatible") throw new Error("Wrong provider type.");
        await refreshOpenAICompatibleMetadata(config.configuration, "openrouter", provider);
        const route = config.catalog.find((entry) => entry.providerId === "openrouter")!;
        console.log("catalog route", JSON.stringify(route));
        expect(route).toMatchObject({ id: DEEPSEEK, enabled: true });
        expect(route.contextWindow).toBeGreaterThan(128_000);

        const resolved = (await config.providers.resolve("openrouter", DEEPSEEK))!;
        console.log("input types", resolved.inputTypes);
        expect(resolved.inputTypes).toContain("image");
        const instructions = "Use the read_note tool when asked about the note.";
        const session = await resolved.session("live", {
            instructions,
            tools: [
                {
                    name: "read_note",
                    description: "Read the shared note.",
                    parameters: Type.Object({}),
                },
            ],
        });
        let context: SessionContext = {
            instructions,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "What does the note say? Quote it exactly." }],
                },
            ],
        };
        try {
            const first = await collect(session.run(ctx, { context, effort: route.defaultEffort }));
            expect(first.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
            const assistant = assistantMessageFromEvents(committedSessionEvents(first))!;
            const call = assistant.content.find((block) => block.type === "tool_call");
            if (call?.type !== "tool_call") throw new Error("DeepSeek did not call the tool.");
            console.log("tool call", call.name, call.arguments);
            context = {
                ...context,
                messages: [
                    ...context.messages,
                    assistant,
                    {
                        role: "tool",
                        callId: call.callId,
                        content: [{ type: "text", text: "PURPLE-HERON-42" }],
                    },
                ],
            };
            const second = await collect(
                session.run(ctx, { context, effort: route.defaultEffort }),
            );
            expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
            const reply = assistantMessageFromEvents(committedSessionEvents(second))!
                .content.filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("");
            console.log("reply", reply);
            console.log(
                "usage",
                JSON.stringify(second.find((event) => event.type === "token_usage")),
            );
            expect(reply).toContain("PURPLE-HERON-42");
        } finally {
            session.destroy();
        }
    }, 180_000);
});

async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) {
        if (event.type === "done" && event.state === "error") console.error(event);
        events.push(event);
    }
    return events;
}
