import type { MessageMode, ServiceMessage } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it, vi } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
    vi.restoreAllMocks();
});

const modelId = "openai/gpt-6.1-sol";
const mode = (providerId: string): MessageMode => ({
    providerId,
    modelId,
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
});

async function failures(gym: AgentGym): Promise<ServiceMessage[]> {
    return (await gym.client.getMessages(gym.defaultSessionId)).runs
        .flatMap((run) => run.messages)
        .filter(
            (message): message is ServiceMessage =>
                message.role === "service" && message.failure !== undefined,
        );
}

it("reports the signed-out account when a pool's other account is spent, whatever order it tried them", async () => {
    // Smart routes choose their initial account randomly; zero starts on the signed-out account,
    // so the spent account is the last one tried.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const gym = await createAgentGym({
        routeConfiguredProviders: true,
        providerIds: ["gym", "other"],
        models: ["gym", "other", "pool"].map((providerId) => ({
            id: modelId,
            providerId,
            name: "Fixture model",
            defaultEffort: "medium",
            effortLevels: ["medium"],
        })),
        config: `[providers]
default_enable = false
[providers.gym]
type = "codex"
enabled = true
[providers.other]
type = "codex"
enabled = true
[providers.pool]
type = "smart"
enabled = true
providers = ["gym", "other"]
`,
        inference: [
            {
                providerId: "gym",
                error: {
                    kind: "unknown",
                    message:
                        "Codex authentication could not be renewed for this account. Try again; if it keeps failing, sign in to Codex again with the same account.",
                    providerError: { type: "authentication" },
                },
            },
            {
                providerId: "other",
                error: {
                    kind: "billing_error",
                    message: "Second account spent its quota.",
                    providerError: {
                        type: "out_of_tokens",
                        resetAt: Date.now() + 5 * 24 * 60 * 60_000,
                    },
                },
            },
        ],
    });
    running.push(gym);

    await gym.client.sendMessage(gym.defaultSessionId, {
        text: "Troubleshoot the server.",
        mode: mode("pool"),
    });
    const failed = await gym.waitUntil(
        async () => (await failures(gym))[0],
        "the pool's failure to be recorded",
    );
    // Both accounts were tried before the turn failed.
    expect(gym.inference.requests).toHaveLength(2);
    // Signing in fixes the pool now; waiting days for the spent account does not.
    expect(failed.failure).toMatchObject({
        kind: "signin_missing",
        provider: { id: "gym" },
        fallbackProviders: [],
    });
    expect(failed.failure?.message).not.toMatch(/No pool account is available/u);
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);
