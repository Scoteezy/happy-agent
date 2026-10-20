import type { ServiceMessage } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

const overflow = {
    error: {
        kind: "context_overflow" as const,
        message: "The prompt is too long for this model.",
    },
};

async function serviceMessages(gym: AgentGym): Promise<ServiceMessage[]> {
    return (await gym.client.getMessages(gym.defaultSessionId)).runs
        .flatMap((run) => run.messages)
        .filter((message): message is ServiceMessage => message.role === "service");
}

/** Every `retrying` value the agent reported, oldest first. */
async function retryingUpdates(gym: AgentGym): Promise<unknown[]> {
    return (await gym.events())
        .filter((event) => event.type === "agent.updated")
        .map((event) => (event.payload as { changes?: Record<string, unknown> }).changes ?? {})
        .filter((changes) => "retrying" in changes)
        .map((changes) => changes["retrying"]);
}

function messageTexts(message: { readonly content: unknown }): string {
    return JSON.stringify(message.content);
}

it("resets an overflowed context once, says so, and answers the same request", async () => {
    const gym = await createAgentGym({
        inference: [
            overflow,
            { content: [{ type: "text", text: "Answered in a fresh context." }] },
        ],
    });
    running.push(gym);

    await gym.send("Summarize everything we did.");

    // One notice and no failure: the reset is recovery, not an error.
    const service = await serviceMessages(gym);
    const notices = service.filter((message) => message.notice !== undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
        notice: { kind: "context_reset" },
        content: [{ type: "text", text: "Context reset" }],
    });
    expect(service.filter((message) => message.failure !== undefined)).toEqual([]);
    expect(JSON.stringify(await gym.history())).toContain("Answered in a fresh context.");

    // The one retry is reported as context_too_long, then cleared when output starts.
    const updates = await retryingUpdates(gym);
    expect(updates[0]).toMatchObject({ attempt: 1, maxAttempts: 1, kind: "context_too_long" });
    expect(updates.at(-1)).toBeNull();

    // The retry starts from the reset's handoff and still carries the person's request.
    expect(gym.inference.requests).toHaveLength(2);
    const retried = gym.inference.requests[1]!.messages;
    expect(retried[0]).toMatchObject({ role: "system" });
    expect(messageTexts(retried[0]!)).toContain("context-reset-history-context");
    expect(retried.some((message) => messageTexts(message).includes("Summarize everything"))).toBe(
        true,
    );
    expect((await gym.client.getAgent(gym.defaultSessionId)).agent.retrying ?? null).toBeNull();
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);

it("shows context_too_long only when the retry after the reset overflows too", async () => {
    const gym = await createAgentGym({ inference: [overflow, overflow] });
    running.push(gym);

    await gym.send("Summarize everything we did.");

    const service = await serviceMessages(gym);
    expect(service.filter((message) => message.notice !== undefined)).toHaveLength(1);
    const failures = service.filter((message) => message.failure !== undefined);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failure).toMatchObject({
        kind: "context_too_long",
        modelId: gym.selection.modelId,
        message: "This chat no longer fits the model's context window, so start a new chat.",
    });
    // Agent Base retries an overflow once, never twice.
    expect(gym.inference.requests).toHaveLength(2);
    expect(await retryingUpdates(gym)).toContainEqual(
        expect.objectContaining({ kind: "context_too_long" }),
    );
    expect((await retryingUpdates(gym)).at(-1)).toBeNull();
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);

it("reports an unreachable provider as a network failure", async () => {
    const gym = await createAgentGym({
        inference: [
            {
                error: {
                    message: "fetch failed: getaddrinfo ENOTFOUND api.example.test",
                    providerError: { type: "network" },
                },
            },
        ],
    });
    running.push(gym);

    await gym.send("Try to reach the provider.");

    const failures = (await serviceMessages(gym)).filter(
        (message) => message.failure !== undefined,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failure).toMatchObject({
        kind: "network",
        provider: { id: gym.selection.providerId },
    });
    expect(failures[0]?.failure?.message).toMatch(
        /^Couldn't reach .+\. Check your connection, then retry\.$/u,
    );
    expect(JSON.stringify(failures[0])).not.toContain("api.example.test");
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 30_000);
