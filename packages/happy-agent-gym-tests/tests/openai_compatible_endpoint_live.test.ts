import { createAgentGym, type AgentGym, type GymAgentHistory } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * DeepSeek through OpenRouter on the real daemon: it reads a file with a tool and answers from it.
 * Opt in with RIG_LIVE_TEST=1 and the key in OPENROUTER_API_KEY, which never enters the repository.
 */
const TURN_MS = 180_000;
const MODEL = "deepseek/deepseek-v4.1-flash-1017";

describe.skipIf(process.env.RIG_LIVE_TEST !== "1" || !process.env.OPENROUTER_API_KEY)(
    "an OpenAI-compatible endpoint, live",
    () => {
        let gym: AgentGym | undefined;
        afterEach(async () => {
            await gym?.dispose();
            gym = undefined;
        }, 60_000);

        it(
            "runs DeepSeek on OpenRouter through a tool call to an answer",
            async () => {
                gym = await createAgentGym({
                    config: [
                        "[providers.openrouter]",
                        'type = "openai_compatible"',
                        'name = "OpenRouter"',
                        "enabled = true",
                        'base_url = "https://openrouter.ai/api/v1"',
                        'api_key_env = "OPENROUTER_API_KEY"',
                        `models = ["${MODEL}"]`,
                        'reasoning_field = "reasoning"',
                        "[providers.openrouter.request]",
                        "reasoning = { enabled = true }",
                        "",
                    ].join("\n"),
                    files: { "NOTE.md": "The shared note says PURPLE-HERON-42.\n" },
                    liveProviders: ["openrouter"],
                    permissionMode: "workspace_write",
                    timeoutMs: TURN_MS,
                });
                const route = { providerId: "openrouter", modelId: MODEL, effort: "medium" };

                await gym.send(
                    "Run `cat NOTE.md` with the Bash tool, then reply with only the code it contains.",
                    route,
                );
                const history = await gym.history();
                const blocks = history.runs.flatMap((run) =>
                    run.messages.flatMap((message) =>
                        message.role === "agent"
                            ? (message.content as readonly {
                                  type: string;
                                  name?: string;
                                  text?: string;
                              }[])
                            : [],
                    ),
                );
                expect(blocks.some((block) => block.type === "tool_call")).toBe(true);
                expect(lastText(history)).toContain("PURPLE-HERON-42");
                expect(gym.errors).toEqual([]);
            },
            TURN_MS * 2,
        );
    },
);

function lastText(history: GymAgentHistory): string {
    const texts = history.runs.flatMap((run) =>
        run.messages.flatMap((message) =>
            message.role === "agent"
                ? (message.content as readonly { type: string; text?: string }[])
                      .filter((block) => block.type === "text")
                      .map((block) => block.text ?? "")
                : [],
        ),
    );
    return texts.at(-1) ?? "";
}
