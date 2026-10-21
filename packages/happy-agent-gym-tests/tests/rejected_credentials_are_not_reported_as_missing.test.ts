import { createServer } from "node:http";
import type { ServiceMessage } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("reports a real Codex rejection without claiming the configured credential is absent", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
        request.resume();
        if (request.method === "POST" && request.url === "/v1/responses") {
            // The synthetic key must have survived configuration and provider construction.
            requests.push(request.headers.authorization ?? "");
        }
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
            JSON.stringify({ error: { type: "authentication_error", message: "Rejected." } }),
        );
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
            liveProviders: ["configured_codex"],
            config: [
                "[providers]",
                "default_enable = false",
                "[providers.configured_codex]",
                'type = "codex"',
                'name = "Configured Codex"',
                "enabled = true",
                "credential_isolation = true",
                'api_key = "synthetic-rejected-key"',
                `base_url = "http://127.0.0.1:${address.port}/v1"`,
                'transport = "sse"',
                "[settings]",
                "inference_max_retries = 0",
            ].join("\n"),
        });
        await gym.send("Try the configured account.", {
            providerId: "configured_codex",
            modelId: "openai/gpt-6.1-sol",
        });
        const history = await gym.client.getMessages(gym.defaultSessionId);
        const failure = history.runs
            .flatMap((run) => run.messages)
            .find(
                (message): message is ServiceMessage =>
                    message.role === "service" && message.failure !== undefined,
            );
        expect(requests).toContain("Bearer synthetic-rejected-key");
        expect(failure?.error).toMatchObject({
            code: "authentication_failed",
            mode: { providerId: "configured_codex", modelId: "openai/gpt-6.1-sol" },
        });
        expect(failure?.failure).toMatchObject({
            kind: "signin_missing",
            provider: { id: "configured_codex", label: "Configured Codex" },
            message:
                "Configured Codex couldn't authenticate. Check its sign-in settings, then retry.",
        });
        expect(failure?.content).toEqual([{ type: "text", text: failure?.failure?.message }]);
        expect(JSON.stringify(failure)).not.toContain("synthetic-rejected-key");
        expect(gym.errors).toEqual([]);
    } finally {
        await gym?.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}, 30_000);
