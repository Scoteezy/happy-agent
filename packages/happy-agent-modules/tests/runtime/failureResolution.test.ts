import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HappyAgentApiError, type ServiceMessage } from "@slopus/happy-agent-client";
import { ClaudeCodeCredential } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

const model = "anthropic/sonnet-5-5";

// A failed turn is resolved on its own message: Retry and Switch record what the person did and
// start the continued run without adding a user message, once.
it("records a retry on the failed message, runs again, and stays idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "failure-resolution-"));
    let fixture: Awaited<ReturnType<typeof credentialWriterRuntime>> | undefined;
    try {
        vi.stubEnv("HOME", root);
        for (const key of [
            "CLAUDE_CONFIG_DIR",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ])
            vi.stubEnv(key, undefined);
        vi.spyOn(ClaudeCodeCredential, "tryLoad").mockResolvedValue(null);
        fixture = await credentialWriterRuntime("owner", {
            defaultModel: model,
            providerConfiguration: `[providers]\ndefault_enable = false\n[providers.private_account]\ntype = "claude"\nenabled = true\n`,
        });
        const { owner, agent } = fixture;
        await owner.sendMessage(agent.id, {
            text: "Fail without a sign-in.",
            mode: { ...writerMode, modelId: model },
        });
        const failures = async () =>
            (await owner.getMessages(agent.id)).runs
                .flatMap((run) => run.messages)
                .filter(
                    (row): row is ServiceMessage =>
                        row.role === "service" && row.failure !== undefined,
                );
        await vi.waitFor(async () => expect(await failures()).toHaveLength(1), {
            timeout: 10_000,
            interval: 10,
        });
        const [failed] = await failures();
        const userMessages = async () =>
            (await owner.getMessages(agent.id)).runs
                .flatMap((run) => run.messages)
                .filter((row) => row.role === "user");
        expect(await userMessages()).toHaveLength(1);

        // The failure carries no switch targets; Switch accepts only what the live catalog offers.
        expect(failed!.failure?.fallbackProviders).toEqual([]);
        const modeBeforeRejectedSwitch = await owner.getAgentMode(agent.id);
        await expect(
            owner.switchAndContinue(agent.id, failed!.id, {
                providerId: "missing_account",
                modelId: model,
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect(await owner.getAgentMode(agent.id)).toEqual(modeBeforeRejectedSwitch);
        expect((await failures())[0]?.failure?.resolution).toBeUndefined();
        // A message that is not a failure cannot be retried.
        const [user] = await userMessages();
        await expect(owner.retryFailedTurn(agent.id, user!.id)).rejects.toBeInstanceOf(
            HappyAgentApiError,
        );

        const retried = await owner.retryFailedTurn(agent.id, failed!.id);
        expect(retried.message).toMatchObject({
            id: failed!.id,
            failure: { kind: "signin_missing", resolution: { action: "retried" } },
        });
        // The continued run fails the same way and leaves a second, unresolved failure.
        await vi.waitFor(async () => expect(await failures()).toHaveLength(2), {
            timeout: 10_000,
            interval: 10,
        });
        const [first, second] = await failures();
        expect(first?.failure?.resolution).toMatchObject({ action: "retried" });
        expect(second?.failure?.resolution).toBeUndefined();
        expect(await userMessages()).toHaveLength(1);

        // Retrying the resolved failure again answers with its state and starts nothing.
        const again = await owner.retryFailedTurn(agent.id, failed!.id);
        expect(again.message).toEqual(retried.message);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await failures()).toHaveLength(2);

        // With the chat's own provider turned off, the retried turn says so instead.
        await owner.patchConfig({ providers: { private_account: { enabled: false } } });
        await owner.retryFailedTurn(agent.id, second!.id);
        await vi.waitFor(async () => expect(await failures()).toHaveLength(3), {
            timeout: 10_000,
            interval: 10,
        });
        expect((await failures())[2]?.failure).toMatchObject({
            kind: "provider_disabled",
            message: "private_account is turned off. Turn it on in settings, then retry.",
            provider: { id: "private_account", vendorName: "Claude" },
        });
        // The live catalog no longer offers the turned-off account, so neither does Switch. The
        // failed run may still be settling, which answers 409 until the agent is idle.
        const third = (await failures())[2]!;
        await vi.waitFor(
            () =>
                expect(
                    owner.switchAndContinue(agent.id, third.id, {
                        providerId: "private_account",
                        modelId: model,
                    }),
                ).rejects.toMatchObject({ status: 400 }),
            { timeout: 10_000, interval: 10 },
        );
    } finally {
        await fixture?.close();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

it("rolls back a switch's resolution, continuation and mode together, then preserves a supported tier", async () => {
    let fixture: Awaited<ReturnType<typeof credentialWriterRuntime>> | undefined;
    const provider = createServer((request, response) => {
        request.resume();
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
            JSON.stringify({ error: { type: "authentication_error", message: "Rejected." } }),
        );
    });
    try {
        await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
        const address = provider.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing fixture port.");
        fixture = await credentialWriterRuntime("owner", {
            providerConfiguration: `[providers]
default_enable = false
${["private_account", "codex"]
    .map(
        (id) => `[providers.${id}]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-${id}-key"
base_url = "http://127.0.0.1:${address.port}/v1"
transport = "sse"`,
    )
    .join("\n")}`,
        });
        const { owner, agent, runtime } = fixture;
        const mode = {
            ...writerMode,
            serviceTier: "priority",
            permissionMode: "read_only" as const,
        };
        await owner.sendMessage(agent.id, { text: "Fail before switching.", mode });
        const failures = async () =>
            (await owner.getMessages(agent.id)).runs
                .flatMap((run) => run.messages)
                .filter(
                    (row): row is ServiceMessage =>
                        row.role === "service" && row.failure !== undefined,
                );
        await vi.waitFor(async () => expect(await failures()).toHaveLength(1), {
            timeout: 10_000,
            interval: 10,
        });
        const [failed] = await failures();
        // No usage reading vouches for "codex", yet the live catalog offers it, so it is a target.
        expect(failed!.failure?.fallbackProviders).toEqual([]);
        const before = await owner.getMessages(agent.id);
        const modeBefore = (await owner.getAgentMode(agent.id)).mode;
        expect(modeBefore).toEqual(mode);
        const updateMetadata = runtime.system.updateMetadata.bind(runtime.system);
        const fault = vi
            .spyOn(runtime.system, "updateMetadata")
            .mockImplementation(async (...args) => {
                await updateMetadata(...args);
                throw new Error("Synthetic commit failure after metadata write.");
            });
        await expect(
            owner.switchAndContinue(agent.id, failed!.id, {
                providerId: "codex",
                modelId: writerMode.modelId,
            }),
        ).rejects.toMatchObject({ status: 500 });
        fault.mockRestore();
        expect((await owner.getAgentMode(agent.id)).mode).toEqual(modeBefore);
        expect((await failures())[0]?.failure?.resolution).toBeUndefined();
        expect((await owner.getMessages(agent.id)).runs).toEqual(before.runs);

        const switched = await owner.switchAndContinue(agent.id, failed!.id, {
            providerId: "codex",
            modelId: writerMode.modelId,
        });
        expect(switched.message.failure?.resolution).toMatchObject({
            action: "switched",
            providerId: "codex",
        });
        expect((await owner.getAgentMode(agent.id)).mode).toEqual({ ...mode, providerId: "codex" });
        // Both accounts use the same local rejection fixture, so exactly one new run fails.
        await vi.waitFor(async () => expect(await failures()).toHaveLength(2), {
            timeout: 10_000,
            interval: 10,
        });
        expect((await owner.getMessages(agent.id)).runs).toHaveLength(before.runs.length + 1);
        const again = await owner.switchAndContinue(agent.id, failed!.id, {
            providerId: "codex",
            modelId: writerMode.modelId,
        });
        expect(again.message).toEqual(switched.message);
        expect((await owner.getAgentMode(agent.id)).mode).toEqual({ ...mode, providerId: "codex" });
        expect((await owner.getMessages(agent.id)).runs).toHaveLength(before.runs.length + 1);
    } finally {
        vi.restoreAllMocks();
        await fixture?.close();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
}, 30_000);
