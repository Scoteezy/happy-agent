import { createServer } from "node:http";
import type { MessageMode, ServiceMessage } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("keeps the switched account through a child report, the next composer send, and restart", async () => {
    const modelId = "openai/gpt-6.1-sol";
    const healthyModelId = "anthropic/opus-5-5";
    const before: MessageMode = {
        providerId: "gym",
        modelId,
        effort: "high",
        serviceTier: "priority",
        permissionMode: "read_only",
    };
    const after: MessageMode = {
        ...before,
        providerId: "healthy",
        modelId: healthyModelId,
        serviceTier: null,
    };
    let primaryId = "";
    let releaseChild = () => {};
    const childGate = new Promise<void>((resolve) => {
        releaseChild = resolve;
    });
    // Account usage is real: the configured setup token's local probe gives "healthy" a fresh
    // reading, which the failure still must not snapshot.
    const server = createServer((request, response) => {
        request.resume();
        response.writeHead(200, {
            "content-type": "application/json",
            "anthropic-ratelimit-unified-status": "allowed",
            "anthropic-ratelimit-unified-5h-utilization": "0.1",
        });
        response.end("{}");
    });
    let gym: AgentGym | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing fixture port.");
        gym = await createAgentGym({
            providerIds: ["gym", "healthy"],
            models: [
                {
                    id: modelId,
                    providerId: "gym",
                    name: "Original model",
                    defaultEffort: "high",
                    effortLevels: ["high"],
                    serviceTiers: ["priority"],
                },
                {
                    id: healthyModelId,
                    providerId: "healthy",
                    name: "Healthy model",
                    defaultEffort: "high",
                    effortLevels: ["high"],
                },
            ],
            config: [
                "[providers]",
                "default_enable = false",
                "[providers.gym]",
                'type = "codex"',
                "enabled = true",
                "credential_isolation = true",
                "[providers.healthy]",
                'type = "claude"',
                "enabled = true",
                "credential_isolation = true",
                'oauth_token = "synthetic-usage-token"',
            ].join("\n"),
            environment: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}` },
            inference: async (request) => {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "Switch mode" }] };
                if (request.providerId === "healthy")
                    return { content: [{ type: "text", text: "Healthy account answered." }] };
                if (request.sessionId === primaryId)
                    return {
                        error: {
                            message: "The original account could not authenticate.",
                            providerError: { type: "authentication" },
                        },
                    };
                await childGate;
                return { content: [{ type: "text", text: "The delayed child report is ready." }] };
            },
        });
        primaryId = gym.defaultSessionId;
        await gym.waitUntil(async () => {
            const entry = (await gym!.client.getUsage()).providers?.find(
                (entry) => entry.providerId === "healthy",
            );
            return entry?.usage?.windows.fiveHour?.usedPercent === 10 ? true : undefined;
        }, "the healthy account's usage reading");
        await gym.client.sendMessage(primaryId, {
            text: "Create a child, then continue the task.",
            mode: before,
            content: [
                {
                    type: "tool_call_request",
                    name: "create_agent",
                    arguments: {
                        title: "Delayed child",
                        model: modelId,
                        provider: "gym",
                        effort: "high",
                        text: "Report when ready.",
                    },
                },
            ],
        });
        const failed = await gym.waitUntil(async () => {
            const page = await gym!.client.getMessages(primaryId);
            return page.runs
                .filter((run) => run.status === "failed")
                .flatMap((run) => run.messages)
                .find(
                    (message): message is ServiceMessage =>
                        message.role === "service" && message.failure !== undefined,
                );
        }, "the original account to fail");
        // Switch targets come from the live catalog the model picker reads, never the failure.
        expect(failed.failure?.fallbackProviders).toEqual([]);
        const switched = await gym.client.switchAndContinue(primaryId, failed.id, {
            providerId: "healthy",
            modelId: healthyModelId,
        });
        const completed = async () =>
            (await gym!.client.getMessages(primaryId)).runs.filter(
                (run) => run.status === "completed",
            ).length;
        await gym.waitUntil(
            async () => ((await completed()) === 1 ? true : undefined),
            "the switched continuation to complete",
        );
        expect(switched.message.failure?.resolution).toMatchObject({
            action: "switched",
            providerId: "healthy",
        });
        releaseChild();
        await gym.waitUntil(
            async () => ((await completed()) === 2 ? true : undefined),
            "the automatic child report to complete on the switched account",
        );
        const current = await gym.client.getAgentMode(primaryId);
        expect(current.mode).toEqual(after);

        // A composer opened after switching submits the canonical mode it just read.
        await gym.client.sendMessage(primaryId, {
            text: "Continue after switching.",
            mode: current.mode!,
        });
        await gym.waitUntil(
            async () => ((await completed()) === 3 ? true : undefined),
            "the next human turn to stay on the healthy account",
        );
        expect(
            gym.inference.requests.filter(
                (request) => request.sessionId === primaryId && request.providerId === "gym",
            ),
        ).toHaveLength(1);
        expect(
            gym.inference.requests.filter(
                (request) => request.sessionId === primaryId && request.providerId === "healthy",
            ),
        ).toHaveLength(3);
        await gym.restart();
        expect((await gym.client.getAgentMode(primaryId)).mode).toEqual(after);
        expect(gym.errors).toEqual([]);
    } finally {
        releaseChild();
        await gym?.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}, 30_000);
