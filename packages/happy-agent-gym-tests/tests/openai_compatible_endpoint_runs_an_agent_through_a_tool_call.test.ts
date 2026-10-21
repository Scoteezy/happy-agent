import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAgentGym, type AgentGym, type GymAgentHistory } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A configured OpenAI-compatible account runs the real provider against a local Chat Completions
 * endpoint: configuration, catalog, harness, wire format, tool execution, and reasoning replay are
 * all the product. Only the vendor is a fixture.
 */
// A gateway ID that looks like OpenAI's, which must still get the Chat Completions harness.
const MODEL = "openai/gpt-oss-gym";
const KEY_VARIABLE = "GYM_ACME_API_KEY";
const KEY = "gym-acme-key";

interface RecordedRequest {
    readonly url: string;
    readonly headers: IncomingHttpHeaders;
    readonly body: ChatRequest;
}

interface ChatRequest {
    readonly model: string;
    readonly stream: boolean;
    readonly messages: readonly Record<string, unknown>[];
    readonly tools?: readonly { readonly function: { readonly name: string } }[];
    readonly [field: string]: unknown;
}

const servers = new Set<Server>();
const gyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
    await Promise.all(
        [...servers].map(
            async (server) => await new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
    servers.clear();
    vi.unstubAllEnvs();
});

describe("an OpenAI-compatible endpoint", () => {
    it("runs an agent through a tool call and replays its reasoning", async () => {
        const vendor = await startVendor();
        vi.stubEnv(KEY_VARIABLE, KEY);
        const gym = await createAgentGym({
            config: [
                "[providers.acme]",
                'type = "openai_compatible"',
                'name = "Acme Gateway"',
                "enabled = true",
                `base_url = "${vendor.url}/v1/"`,
                `api_key_env = "${KEY_VARIABLE}"`,
                `models = ["${MODEL}"]`,
                'reasoning_field = "reasoning"',
                "[providers.acme.headers]",
                '"X-Title" = "Happy Agent"',
                "[providers.acme.request]",
                "reasoning = { enabled = true }",
                `[providers.acme.model_overrides."${MODEL}"]`,
                'name = "GPT OSS Gym"',
                "context_window = 200000",
                'efforts = ["low", "high"]',
                'default_effort = "high"',
                "",
            ].join("\n"),
            files: { "README.md": "The launch code is HERON-17.\n" },
            liveProviders: ["acme"],
            permissionMode: "workspace_write",
        });
        gyms.add(gym);

        expect((await gym.client.getConfig()).config.models[MODEL]).toMatchObject({
            name: "GPT OSS Gym",
            contextWindow: 200_000,
            autoCompactWindow: 170_000,
            efforts: ["low", "high"],
            defaultEffort: "high",
        });

        const acme = { providerId: "acme", modelId: MODEL, effort: "high" };
        await gym.send("What is the launch code in the readme?", acme);

        // The tool really ran on the agent's machine, and the answer came back from the vendor.
        expect(lastText(await gym.history())).toBe("The launch code is HERON-17.");
        const turns = vendor.requests.filter((request) => request.body.tools !== undefined);
        expect(turns).toHaveLength(2);
        const [first, second] = turns as [RecordedRequest, RecordedRequest];

        expect(first.url).toBe("/v1/chat/completions");
        expect(first.headers.authorization).toBe(`Bearer ${KEY}`);
        expect(first.headers["x-title"]).toBe("Happy Agent");
        expect(first.body).toMatchObject({
            model: MODEL,
            stream: true,
            reasoning: { enabled: true },
            reasoning_effort: "high",
        });
        // Claude Code's function tools, never Codex's grammar tools, whatever the ID looks like.
        const offered = first.body.tools!.map((tool) => tool.function.name);
        expect(offered).toEqual(expect.arrayContaining(["Bash", "Read", "Edit", "Write"]));
        expect(offered).not.toContain("exec_command");
        expect(offered).not.toContain("apply_patch");

        // The continuation carries the call, its reasoning under the configured field, and the
        // command's real output.
        const assistant = second.body.messages.find((message) => message["role"] === "assistant");
        expect(assistant).toMatchObject({
            reasoning: "The readme has it.",
            tool_calls: [{ id: "call_readme", function: { name: "Bash" } }],
        });
        const result = second.body.messages.find((message) => message["role"] === "tool");
        expect(result).toMatchObject({ tool_call_id: "call_readme" });
        expect(JSON.stringify(result)).toContain("The launch code is HERON-17.");

        // A second turn on the same account still works.
        await gym.send("Thanks, that is all.", acme);
        expect(lastText(await gym.history())).toBe("Glad to help.");
        expect(gym.errors).toEqual([]);
    });
});

/** A Chat Completions vendor that reads the readme with Bash, then answers from its output. */
async function startVendor(): Promise<{ url: string; requests: RecordedRequest[] }> {
    const requests: RecordedRequest[] = [];
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
                response.writeHead(404).end();
                return;
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
            requests.push({ url: request.url, headers: request.headers, body });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(stream(reply(body)));
        });
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function reply(body: ChatRequest): readonly object[] {
    const last = body.messages.at(-1)!;
    if (body.tools === undefined) return answer("Launch code");
    if (last["role"] === "tool") return answer("The launch code is HERON-17.");
    if (!JSON.stringify(last).includes("launch code")) return answer("Glad to help.");
    return [
        chunk({ role: "assistant", content: "", reasoning: "The readme " }),
        chunk({ reasoning: "has it." }),
        chunk({
            tool_calls: [
                {
                    index: 0,
                    id: "call_readme",
                    type: "function",
                    function: { name: "Bash", arguments: '{"command":' },
                },
            ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"cat README.md"}' } }] }),
        chunk({}, "tool_calls"),
        usage(),
    ];
}

function answer(text: string): readonly object[] {
    return [chunk({ role: "assistant", content: text }), chunk({}, "stop"), usage()];
}

function chunk(delta: object, finish_reason: string | null = null): object {
    return { choices: [{ index: 0, delta, finish_reason }] };
}

function usage(): object {
    return { choices: [], usage: { prompt_tokens: 120, completion_tokens: 12 } };
}

function stream(chunks: readonly object[]): string {
    return (
        chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n"
    );
}

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
