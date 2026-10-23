import { describe, expect, it, vi } from "vitest";

import {
    handleMcpElicitation,
    type McpElicitationRequest,
    type McpUserInputRequest,
    type McpUserInputResponse,
    type McpUserInputService,
} from "../../sources/mcp/index.js";

const SERVER = "bambu_printer";

function request(
    properties: Record<string, Record<string, unknown>>,
    required?: string[],
    message = "Please configure the server.",
): McpElicitationRequest {
    return {
        method: "elicitation/create",
        params: {
            message,
            requestedSchema: {
                type: "object",
                properties,
                ...(required === undefined ? {} : { required }),
            },
        },
    } as McpElicitationRequest;
}

function answering(response: McpUserInputResponse): McpUserInputService & {
    readonly asked: McpUserInputRequest[];
} {
    const asked: McpUserInputRequest[] = [];
    return {
        asked,
        request: async (input) => {
            asked.push(input);
            return response;
        },
    };
}

describe("MCP elicitation adapter", () => {
    it("declines without asking when there is nobody to ask or the request is malformed", async () => {
        await expect(
            handleMcpElicitation(SERVER, request({ name: { type: "string" } }), undefined),
        ).resolves.toEqual({ action: "decline" });

        const callback = vi.fn();
        await expect(
            handleMcpElicitation(SERVER, { nope: true }, { request: callback } as never),
        ).resolves.toEqual({ action: "decline" });
        expect(callback).not.toHaveBeenCalled();
    });

    it("accepts the 2025-11-25 form mode and declines URL mode", async () => {
        const formMode = request({ name: { type: "string" } });
        await expect(
            handleMcpElicitation(
                SERVER,
                { ...formMode, params: { ...formMode.params, mode: "form" } },
                answering({ status: "answered", answers: { name: ["Ada"] } }),
            ),
        ).resolves.toEqual({ action: "accept", content: { name: "Ada" } });

        const callback = vi.fn();
        await expect(
            handleMcpElicitation(
                SERVER,
                {
                    method: "elicitation/create",
                    params: {
                        mode: "url",
                        message: "Sign in.",
                        elicitationId: "e1",
                        url: "https://example.com",
                    },
                },
                { request: callback } as never,
            ),
        ).resolves.toEqual({ action: "decline" });
        expect(callback).not.toHaveBeenCalled();
    });

    it("names the server in the context and in the first question", async () => {
        const service = answering({ status: "cancelled" });
        await handleMcpElicitation(
            SERVER,
            request(
                {
                    nozzle: { type: "number", title: "Nozzle", description: "Nozzle temperature." },
                    bed: { type: "number" },
                },
                undefined,
                "Set print temperatures.",
            ),
            service,
        );
        const asked = service.asked[0]!;
        expect(asked.context).toContain("**Bambu Printer** is an MCP server");
        expect(asked.context).toContain("the agent cannot answer for you");
        expect(asked.questions.map((question) => question.question)).toEqual([
            "Bambu Printer asks: Set print temperatures.\n\nNozzle temperature.",
            "Bed",
        ]);
        expect(asked.questions.map((question) => question.header)).toEqual(["Nozzle", "Bed"]);
    });

    it("maps a dismissed, timed-out, or unreadable answer to cancel, never accept", async () => {
        const input = request({ confirm: { type: "boolean" } }, ["confirm"]);
        await expect(
            handleMcpElicitation(SERVER, input, answering({ status: "cancelled" })),
        ).resolves.toEqual({ action: "cancel" });
        await expect(
            handleMcpElicitation(SERVER, input, {
                request: async () => ({
                    status: "answered",
                    answers: { confirm: ["Yes"] },
                    extra: 1,
                }),
            } as never),
        ).resolves.toEqual({ action: "cancel" });
        await expect(
            handleMcpElicitation(SERVER, request({}), answering({ status: "cancelled" })),
        ).resolves.toEqual({ action: "cancel" });
    });

    it("asks for approval when the requested object has no properties", async () => {
        const approve = answering({ status: "answered", answers: { approval: ["Approve"] } });
        await expect(
            handleMcpElicitation(SERVER, request({}, [], "Start printing benchy.3mf?"), approve),
        ).resolves.toEqual({ action: "accept", content: {} });
        expect(approve.asked[0]?.questions).toEqual([
            {
                header: "Approval",
                id: "approval",
                multiSelect: false,
                options: [
                    { label: "Approve", description: "Let Bambu Printer go ahead." },
                    { label: "Decline", description: "Tell Bambu Printer no." },
                ],
                question: "Bambu Printer asks: Start printing benchy.3mf?",
            },
        ]);

        await expect(
            handleMcpElicitation(
                SERVER,
                request({}),
                answering({ status: "answered", answers: { approval: ["Decline"] } }),
            ),
        ).resolves.toEqual({ action: "decline" });
        // Anything a person writes instead of choosing is not an approval.
        await expect(
            handleMcpElicitation(
                SERVER,
                request({}),
                answering({ status: "answered", answers: { approval: ["sure, go ahead"] } }),
            ),
        ).resolves.toEqual({ action: "decline" });
    });

    it("converts optional and required scalar values and declines missing required values", async () => {
        const input = request(
            {
                environment: { type: "string", description: "Where to deploy." },
                replicas: { type: "number" },
                enabled: { type: "boolean" },
                optional: { type: "string" },
            },
            ["environment", "replicas", "enabled"],
        );
        const service = answering({
            status: "answered",
            answers: { environment: ["staging"], replicas: ["3.5"], enabled: ["Yes"] },
        });
        await expect(handleMcpElicitation(SERVER, input, service)).resolves.toEqual({
            action: "accept",
            content: { environment: "staging", replicas: 3.5, enabled: true },
        });
        expect(service.asked[0]?.questions).toMatchObject([
            { id: "environment", required: true, options: [] },
            { id: "replicas", required: true, options: [] },
            {
                id: "enabled",
                required: true,
                options: [
                    { label: "Yes", description: "Answer yes." },
                    { label: "No", description: "Answer no." },
                ],
            },
            { id: "optional", options: [] },
        ]);
        expect(service.asked[0]?.questions[3]).not.toHaveProperty("required");

        await expect(
            handleMcpElicitation(
                SERVER,
                input,
                answering({
                    status: "answered",
                    answers: { environment: ["staging"], replicas: ["3.5"] },
                }),
            ),
        ).resolves.toEqual({ action: "decline" });
    });

    it("maps enum labels, oneOf titles, and array anyOf titles into their underlying values", async () => {
        const input = request({
            environment: {
                type: "string",
                oneOf: [
                    { const: "staging", title: "Staging" },
                    { const: "production", title: "Production" },
                ],
            },
            regions: {
                type: "array",
                items: {
                    anyOf: [
                        { const: "us-east", title: "US East" },
                        { const: "eu-west", title: "EU West" },
                    ],
                },
            },
            plate: { type: "string", enum: ["textured", "smooth"], enumNames: ["Textured"] },
        });
        const service = answering({
            status: "answered",
            answers: {
                environment: ["Production"],
                regions: ["US East", "EU West"],
                plate: ["smooth"],
            },
        });
        await expect(handleMcpElicitation(SERVER, input, service)).resolves.toEqual({
            action: "accept",
            content: {
                environment: "production",
                regions: ["us-east", "eu-west"],
                plate: "smooth",
            },
        });
        expect(service.asked[0]?.questions).toMatchObject([
            { id: "environment", options: [{ label: "Staging" }, { label: "Production" }] },
            {
                id: "regions",
                multiSelect: true,
                options: [{ label: "US East" }, { label: "EU West" }],
            },
            { id: "plate", options: [{ label: "Textured" }, { label: "smooth" }] },
        ]);
    });

    it("preserves numeric enum values selected in multi-select arrays", async () => {
        await expect(
            handleMcpElicitation(
                SERVER,
                request({ ports: { type: "array", items: { enum: [80, 443] } } }),
                answering({ status: "answered", answers: { ports: ["80", "443"] } }),
            ),
        ).resolves.toEqual({ action: "accept", content: { ports: [80, 443] } });
    });

    it("does not accept answers outside a declared enum", async () => {
        await expect(
            handleMcpElicitation(
                SERVER,
                request({ environment: { type: "string", enum: ["staging", "production"] } }),
                answering({ status: "answered", answers: { environment: ["delete everything"] } }),
            ),
        ).resolves.toEqual({ action: "decline" });
    });

    it("declines invalid booleans, blank or non-finite numbers, and fractional integers", async () => {
        for (const [property, answer] of [
            [{ type: "boolean" }, "maybe"],
            [{ type: "number" }, "Infinity"],
            [{ type: "number" }, "NaN"],
            [{ type: "number" }, " "],
            [{ type: "integer" }, "1.5"],
        ] as const) {
            await expect(
                handleMcpElicitation(
                    SERVER,
                    request({ value: { ...property } }),
                    answering({ status: "answered", answers: { value: [answer] } }),
                ),
            ).resolves.toEqual({ action: "decline" });
        }
    });

    it("declines without asking when the form cannot be shown faithfully", async () => {
        const callback = vi.fn();
        const service = { request: callback } as never;
        // More fields than one question may hold.
        await expect(
            handleMcpElicitation(
                SERVER,
                request(
                    Object.fromEntries(
                        ["a", "b", "c", "d", "e"].map((id) => [id, { type: "string" }]),
                    ),
                ),
                service,
            ),
        ).resolves.toEqual({ action: "decline" });
        // Two choices the person could not tell apart.
        await expect(
            handleMcpElicitation(
                SERVER,
                request({
                    plate: { type: "string", enum: ["a", "b"], enumNames: ["Same", "Same"] },
                }),
                service,
            ),
        ).resolves.toEqual({ action: "decline" });
        // More choices than a question may offer.
        await expect(
            handleMcpElicitation(
                SERVER,
                request({
                    filament: {
                        type: "string",
                        enum: Array.from({ length: 33 }, (_, index) => `slot-${String(index)}`),
                    },
                }),
                service,
            ),
        ).resolves.toEqual({ action: "decline" });
        expect(callback).not.toHaveBeenCalled();
    });

    it("bounds long titles and falls back to the property name when a title is blank", async () => {
        const service = answering({ status: "cancelled" });
        await handleMcpElicitation(
            SERVER,
            request({
                long: { type: "string", title: "A".repeat(80) },
                print_speed: { type: "string", title: "   " },
            }),
            service,
        );
        expect(service.asked[0]?.questions.map((question) => question.header)).toEqual([
            `${"A".repeat(63)}…`,
            "Print Speed",
        ]);
    });
});
