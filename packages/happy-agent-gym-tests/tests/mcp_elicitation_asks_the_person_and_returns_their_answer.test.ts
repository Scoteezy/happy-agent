import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    await Promise.all(closers.splice(0).map(async (close) => await close()));
});

describe("MCP elicitation", () => {
    it("asks the person through the question API and returns only their answer to the server", async () => {
        const printer = await startPrinterServer();
        const gym = await createAgentGym({
            files: {
                "mcp.toml": `[mcp_servers.bambu_printer]\nurl = "${printer.url}"\n`,
            },
            inference: [
                { content: [printCall("approved")] },
                { content: [{ type: "text", text: "The print started." }] },
                { content: [printCall("declined")] },
                { content: [{ type: "text", text: "The print did not start." }] },
            ],
        });
        running.add(gym);
        const agentId = gym.defaultSessionId;

        const approving = await gym.send("Print the benchy.", {
            permissionMode: "full_access",
            wait: false,
        });
        const approval = await gym.waitUntil(async () => {
            const { question } = await gym.client.getPendingQuestion(agentId);
            return question?.status === "pending" ? question : undefined;
        }, "the printer's question");
        expect(approval.context).toContain("**Bambu Printer** is an MCP server");
        expect(approval.permissionRequest).toEqual({
            source: "mcp_elicitation",
            server: "bambu_printer",
            serverTitle: "Bambu Printer",
        });
        const created = await gym.waitForEvent(
            (event) =>
                event.type === "question.created" && event.payload.question.id === approval.id,
            "the printer's question.created event",
        );
        expect(
            created.type === "question.created" && created.payload.question.permissionRequest,
        ).toEqual(approval.permissionRequest);
        expect(approval.questions).toEqual([
            {
                id: "approval",
                header: "Approval",
                question: "Bambu Printer asks: Start printing benchy.3mf on the X1C?",
                multiSelect: false,
                options: [
                    { label: "Approve", description: "Let Bambu Printer go ahead." },
                    { label: "Decline", description: "Tell Bambu Printer no." },
                ],
            },
        ]);
        expect(printer.answers).toEqual([]);

        await gym.client.answerQuestion(agentId, approval.id, {
            answers: { approval: ["Approve"] },
            mutationId: "approve-print",
        });
        await gym.waitForRun(approving.runId);
        expect(printer.answers).toEqual([{ action: "accept", content: {} }]);
        expect(toolResult(gym, "approved")).toContain('{"action":"accept","content":{}}');

        const declining = await gym.send("Print another one.", {
            permissionMode: "full_access",
            wait: false,
        });
        const second = await gym.waitUntil(async () => {
            const { question } = await gym.client.getPendingQuestion(agentId);
            return question?.status === "pending" && question.id !== approval.id
                ? question
                : undefined;
        }, "the printer's second question");
        await gym.client.answerQuestion(agentId, second.id, {
            answers: { approval: ["Decline"] },
            mutationId: "decline-print",
        });
        await gym.waitForRun(declining.runId);
        expect(printer.answers).toEqual([{ action: "accept", content: {} }, { action: "decline" }]);
        expect(toolResult(gym, "declined")).toContain('{"action":"decline"}');

        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 30_000);
});

function printCall(callId: string) {
    return {
        type: "tool_call" as const,
        callId,
        name: "mcp__bambu_printer__start_print",
        arguments: {},
    };
}

function toolResult(gym: AgentGym, callId: string): string | undefined {
    return gym.inference.toolResults().find((result) => result.callId === callId)?.text;
}

/** A printer server that will not print until a person approves it through elicitation. */
async function startPrinterServer(): Promise<{
    readonly url: string;
    readonly answers: unknown[];
}> {
    const answers: unknown[] = [];
    const server = new McpServer({ name: "bambu-printer", version: "1.0.0" });
    server.registerTool(
        "start_print",
        { description: "Start the loaded print once a person approves it." },
        async (extra) => {
            const result = await server.server.elicitInput(
                {
                    message: "Start printing benchy.3mf on the X1C?",
                    requestedSchema: { type: "object", properties: {} },
                },
                { relatedRequestId: extra.requestId },
            );
            answers.push(result);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    // The SDK's own transport types disagree with exactOptionalPropertyTypes.
    await server.connect(transport as unknown as Transport);
    const http: HttpServer = createServer((request, response) => {
        void transport.handleRequest(request, response);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    closers.push(async () => {
        await server.close();
        await new Promise<void>((resolve) => http.close(() => resolve()));
    });
    const { port } = http.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}/mcp`, answers };
}
