import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
    OpenAICompatibleProvider,
    assistantMessageFromEvents,
    committedSessionEvents,
    type SessionContext,
    type SessionEvent,
    type SessionStream,
} from "@/index.js";
import { testContext } from "./testContext.js";

/**
 * Runs against OpenRouter with the key in OPENROUTER_API_KEY, which is never stored in the
 * repository. OPENROUTER_LIVE_MODELS selects other models, separated by commas.
 */
const models = (process.env.OPENROUTER_LIVE_MODELS ?? "deepseek/deepseek-v4.1-flash-1017")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
const instructions =
    "Follow the test instructions precisely. Call echo once when asked, then wait for its result before replying.";

describe.skipIf(process.env.RIG_LIVE_TEST !== "1")("OpenRouter Chat Completions live", () => {
    for (const model of models) {
        it(`${model} calls a tool, continues from its result, and compacts`, async () => {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) throw new Error("Set OPENROUTER_API_KEY to run the OpenRouter live test.");
            const session = await new OpenAICompatibleProvider({
                apiKey,
                endpoint: "https://openrouter.ai/api/v1",
                vendor: "OpenRouter",
                models: [{ id: model, efforts: ["low", "high", "max"] }],
                request: { reasoning: { enabled: true } },
                reasoningField: "reasoning",
                inferenceMaxRetries: 0,
            }).session(`live-${crypto.randomUUID()}`, {
                instructions,
                tools: [
                    {
                        name: "echo",
                        description: "Echo the supplied test text.",
                        parameters: Type.Object({ text: Type.String() }),
                    },
                ],
            });
            let context: SessionContext = {
                instructions,
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Calculate 13 multiplied by 17, then call echo with text OPENROUTER_OK. After its result, report the calculation and the echoed text.",
                            },
                        ],
                    },
                ],
            };
            try {
                const first = await collect(session.run(testContext, { context, effort: "low" }));
                expect(first.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
                const assistant = assistantMessageFromEvents(committedSessionEvents(first))!;
                const call = assistant.content.find((block) => block.type === "tool_call");
                expect(call).toMatchObject({ name: "echo" });
                expect(JSON.parse(call!.type === "tool_call" ? call!.arguments : "{}")).toEqual({
                    text: "OPENROUTER_OK",
                });
                context = {
                    ...context,
                    messages: [
                        ...context.messages,
                        assistant,
                        {
                            role: "tool",
                            callId: call!.type === "tool_call" ? call!.callId : "",
                            content: [{ type: "text", text: "OPENROUTER_OK" }],
                        },
                    ],
                };
                const second = await collect(session.run(testContext, { context, effort: "low" }));
                expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
                const reply = assistantMessageFromEvents(committedSessionEvents(second))!;
                const text = reply.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("");
                expect(text).toContain("221");
                expect(text).toContain("OPENROUTER_OK");
                const usage = second.find((event) => event.type === "token_usage");
                expect(usage).toMatchObject({ type: "token_usage" });

                const compaction = await session.compact(testContext, {
                    context: { ...context, messages: [...context.messages, reply] },
                });
                expect(compaction.status).toBe("completed");
                if (compaction.status !== "completed") return;
                const resumed = await collect(
                    session.run(testContext, {
                        context: {
                            ...compaction.context,
                            messages: [
                                ...compaction.context.messages,
                                {
                                    role: "user",
                                    content: [
                                        {
                                            type: "text",
                                            text: "What text did echo return? Answer with that text only.",
                                        },
                                    ],
                                },
                            ],
                        },
                        effort: "low",
                    }),
                );
                // Claude Code's continuation tells the model to pick up the last task, so it may
                // answer or call echo again; either way the summary must have carried the text.
                expect(resumed.at(-1)).toMatchObject({ type: "done" });
                expect(["normal", "tool_call"]).toContain(
                    (resumed.at(-1) as { state: string }).state,
                );
                const answer = assistantMessageFromEvents(committedSessionEvents(resumed))!;
                expect(
                    answer.content
                        .map((block) =>
                            block.type === "text"
                                ? block.text
                                : block.type === "tool_call"
                                  ? block.arguments
                                  : "",
                        )
                        .join(""),
                ).toContain("OPENROUTER_OK");
            } finally {
                session.destroy();
            }
        }, 180_000);
    }
});

async function collect(stream: SessionStream): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) {
        if (event.type === "done" && event.state === "error") console.error(event);
        events.push(event);
    }
    return events;
}
