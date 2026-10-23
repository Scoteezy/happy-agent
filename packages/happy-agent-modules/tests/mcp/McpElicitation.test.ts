import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withLifetime } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import { McpModule } from "../../sources/mcp/index.js";
import { PresenceModule } from "../../sources/presence/index.js";
import { presenceMigrations } from "../../sources/presence/PresenceDatabase.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import {
    UserInputModule,
    userInputMigrations,
    type UserInputRequest,
} from "../../sources/userInput/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const fixture = fileURLToPath(new URL("./fixtures/stdioServer.mjs", import.meta.url));
const AGENT = "agent-a";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const confirmPrint = {
    message: "Start printing benchy.3mf on the X1C?",
    requestedSchema: {
        type: "object",
        properties: { confirm: { type: "boolean", title: "Start print" } },
        required: ["confirm"],
    },
};
const approvePrint = {
    message: "Start printing benchy.3mf on the X1C?",
    requestedSchema: { type: "object", properties: {} },
};

describe("MCP elicitation from a real server", () => {
    it("asks the person, naming the server, and returns their answer to the server", async () => {
        const world = await elicitationWorld();
        const call = world.elicit(confirmPrint);
        const question = await world.pendingQuestion();

        // The API's answer route only takes identifiers of this shape.
        expect(question.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
        expect(question.context).toContain("**Bambu Printer** is an MCP server");
        expect(question.permissionRequest).toEqual({
            source: "mcp_elicitation",
            server: "bambu_printer",
            serverTitle: "Bambu Printer",
        });
        expect(question.questions).toEqual([
            {
                id: "confirm",
                header: "Start print",
                question:
                    "Bambu Printer asks: Start printing benchy.3mf on the X1C?\n\nStart print",
                options: {
                    multiSelect: false,
                    choices: [
                        { label: "Yes", description: "Answer yes." },
                        { label: "No", description: "Answer no." },
                    ],
                },
            },
        ]);
        await world.answer(question, { confirm: "Yes" });

        await expect(call).resolves.toEqual({ action: "accept", content: { confirm: true } });
    });

    it("returns free text and numbers the person typed", async () => {
        const world = await elicitationWorld();
        const call = world.elicit({
            message: "Name the print job.",
            requestedSchema: {
                type: "object",
                properties: { name: { type: "string" }, copies: { type: "integer" } },
                required: ["name", "copies"],
            },
        });
        await world.answer(await world.pendingQuestion(), { name: "Benchy", copies: "2" });

        await expect(call).resolves.toEqual({
            action: "accept",
            content: { name: "Benchy", copies: 2 },
        });
    });

    it("declines when the person chooses Decline", async () => {
        const world = await elicitationWorld();
        const call = world.elicit(approvePrint);
        const question = await world.pendingQuestion();
        expect(question.questions?.[0]?.question).toBe(
            "Bambu Printer asks: Start printing benchy.3mf on the X1C?",
        );
        await world.answer(question, { approval: "Decline" });

        await expect(call).resolves.toEqual({ action: "decline" });
    });

    it("cancels when the person dismisses the question", async () => {
        const world = await elicitationWorld();
        const call = world.elicit(approvePrint);
        const question = await world.pendingQuestion();
        await world.userInput.cancel(world.ctx, AGENT, {
            requestId: question.id,
            reason: "Dismissed from the phone.",
        });

        await expect(call).resolves.toEqual({ action: "cancel" });
    });

    it("cancels without waiting when the person is away", async () => {
        const world = await elicitationWorld();
        await world.presence.setPresence(world.ctx, { status: "away" });

        await expect(world.elicit(approvePrint)).resolves.toEqual({ action: "cancel" });
        await expect(
            world.userInput.list(world.ctx, AGENT, { status: "terminal" }),
        ).resolves.toMatchObject([{ status: "away" }]);
    });

    it("withdraws the question when the server stops waiting for it", async () => {
        const world = await elicitationWorld();
        const call = world.elicit({ ...approvePrint, timeoutMs: 200 });

        await expect(call).resolves.toMatch(/^error: .*timed out/u);
        await expect
            .poll(async () => await world.userInput.list(world.ctx, AGENT, { status: "terminal" }))
            .toMatchObject([
                { status: "cancelled", reason: "Bambu Printer no longer needs an answer." },
            ]);
        await expect(
            world.userInput.list(world.ctx, AGENT, { status: "pending" }),
        ).resolves.toEqual([]);
    });

    it("withdraws the question when the turn that called the tool stops", async () => {
        const world = await elicitationWorld();
        const turn = new AbortController();
        const call = world.mcp.callTool(withLifetime(world.ctx, turn.signal), AGENT, {
            server: "bambu_printer",
            name: "elicit",
            arguments: approvePrint,
        });
        await world.pendingQuestion();
        turn.abort(new Error("The run was stopped."));

        await expect(call).rejects.toThrow("The run was stopped.");
        await expect
            .poll(async () => await world.userInput.list(world.ctx, AGENT, { status: "pending" }))
            .toEqual([]);
        await expect(
            world.userInput.list(world.ctx, AGENT, { status: "terminal" }),
        ).resolves.toMatchObject([{ status: "cancelled" }]);
    });

    it("declines a request that arrives outside a tool call without asking anyone", async () => {
        const world = await elicitationWorld();
        const result = await world.mcp.readResource(
            world.ctx,
            AGENT,
            "bambu_printer",
            "fixture://elicitation/outside-a-tool-call",
        );

        expect(result.contents).toMatchObject([{ text: JSON.stringify({ action: "decline" }) }]);
        await expect(world.userInput.list(world.ctx, AGENT)).resolves.toEqual([]);
    });

    /*
     * Time is the subject here, so these wait on the clock: a 400 ms tool budget, a person who takes
     * longer than that to answer, and a server whose work after the answer takes longer again.
     */
    it("stops the tool timeout while the person decides, and resumes it afterwards", async () => {
        const world = await elicitationWorld({ toolTimeoutMs: 400 });
        const call = world.elicit(confirmPrint);
        const question = await world.pendingQuestion();
        await delay(800);
        await world.answer(question, { confirm: "Yes" });
        await expect(call).resolves.toEqual({ action: "accept", content: { confirm: true } });

        const slow = world.elicit({ ...confirmPrint, afterMs: 1_200 });
        await world.answer(await world.pendingQuestion(), { confirm: "Yes" });
        await expect(slow).rejects.toThrow(/timed out/u);
    });
});

async function elicitationWorld(options: { readonly toolTimeoutMs?: number } = {}) {
    const root = await mkdtemp(join(tmpdir(), "happy-mcp-elicitation-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const configPath = join(
        root,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
        "mcp.toml",
    );
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
        configPath,
        [
            "[mcp_servers.bambu_printer]",
            `command = ${JSON.stringify(process.execPath)}`,
            `args = ${JSON.stringify([fixture, "elicitation"])}`,
            "startup_timeout_sec = 10",
            `tool_timeout_sec = ${String((options.toolTimeoutMs ?? 10_000) / 1_000)}`,
            "",
        ].join("\n"),
        "utf8",
    );
    const config = await ConfigModule.load(join(root, ".happy"));
    const db = moduleDatabase([...presenceMigrations, ...userInputMigrations], "mcp-elicitation");
    cleanups.push(() => db.close());
    await db.ready;
    const ctx = db.context;
    const presence = new PresenceModule(config);
    const userInput = new UserInputModule(presence);
    const runners = new RunnersModule(config);
    const mcp = new McpModule(
        config,
        userInput,
        { onEvent: () => () => undefined } as never,
        runners,
        new ComputeModule(config, new SecretsModule(), runners),
    );
    cleanups.push(async () => await mcp.close());
    await mcp.reload(ctx);

    return {
        ctx,
        mcp,
        presence,
        userInput,
        /** Calls the fixture's `elicit` tool and parses what the server got back. */
        async elicit(args: Record<string, unknown>): Promise<unknown> {
            const result = await mcp.callTool(ctx, AGENT, {
                server: "bambu_printer",
                name: "elicit",
                arguments: args,
            });
            const first = result.content?.[0];
            if (first?.type !== "text") throw new Error("The fixture returned no text.");
            return first.text.startsWith("error: ") ? first.text : JSON.parse(first.text);
        },
        /** The question a client would render, once it is waiting. */
        async pendingQuestion(): Promise<UserInputRequest> {
            let found: UserInputRequest | undefined;
            await expect
                .poll(async () => {
                    found = (await userInput.list(ctx, AGENT, { status: "pending" }))[0];
                    return found !== undefined;
                })
                .toBe(true);
            return found!;
        },
        /**
         * Answers exactly as `POST /v0/agents/:agentId/question/:questionId/answer` does: one value
         * is sent as it is, and the API leaves telling a label from free text to the module.
         */
        async answer(question: UserInputRequest, answers: Record<string, string>): Promise<void> {
            await userInput.answer(ctx, AGENT, { requestId: question.id, answers });
        },
    };
}
