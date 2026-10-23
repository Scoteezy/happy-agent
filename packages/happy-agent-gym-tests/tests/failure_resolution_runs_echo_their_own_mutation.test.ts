import type { MessageMode, ServiceMessage } from "@slopus/happy-agent-client";
import {
    createAgentGym,
    runIdOf,
    type AgentGym,
    type GymAgentEvent,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

const modelId = "openai/gpt-5.6-sol";
const mode = (providerId: string): MessageMode => ({
    providerId,
    modelId,
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
});

const echoOf = (event: GymAgentEvent): unknown =>
    (event.payload as { readonly mutationId?: unknown }).mutationId;

it("echoes a retry's and a switch's mutation on the runs they start, and on no later run", async () => {
    const gym = await createAgentGym({
        providerIds: ["gym", "other"],
        models: ["gym", "other"].map((providerId) => ({
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
`,
        inference: [
            { providerId: "gym", error: { message: "The first attempt failed." } },
            { providerId: "gym", error: { message: "The retry failed too." } },
            {
                providerId: "other",
                content: [{ type: "text", text: "Answered after the switch." }],
            },
            { providerId: "other", content: [{ type: "text", text: "Answered the next turn." }] },
        ],
    });
    running.push(gym);

    await gym.client.sendMessage(gym.defaultSessionId, {
        text: "Summarize the readme.",
        mode: mode("gym"),
    });
    const first = await unresolvedFailure(gym);

    const retryRunId = await runStartedBy(gym, async () => {
        await gym.client.retryFailedTurn(gym.defaultSessionId, first.id, {
            mutationId: "retry-echo",
        });
    });
    await gym.waitForRun(retryRunId);
    const second = await unresolvedFailure(gym);

    const switchRunId = await runStartedBy(gym, async () => {
        await gym.client.switchAndContinue(gym.defaultSessionId, second.id, {
            providerId: "other",
            modelId,
            mutationId: "switch-echo",
        });
    });
    await gym.waitForRun(switchRunId);

    const laterRunId = await runStartedBy(gym, async () => {
        await gym.client.sendMessage(gym.defaultSessionId, {
            text: "And the next thing.",
            mode: mode("other"),
        });
    });
    await gym.waitForRun(laterRunId);

    const events = await gym.events();
    const runEvents = (runId: string, type: string) =>
        events.filter((event) => runIdOf(event) === runId && event.type === type);
    expect(runEvents(retryRunId, "run.started").map(echoOf)).toEqual(["retry-echo"]);
    expect(runEvents(retryRunId, "run.finished").map(echoOf)).toEqual(["retry-echo"]);
    expect(runEvents(switchRunId, "run.started").map(echoOf)).toEqual(["switch-echo"]);
    expect(runEvents(switchRunId, "run.finished").map(echoOf)).toEqual(["switch-echo"]);
    expect(
        events
            .filter((event) => runIdOf(event) === laterRunId)
            .flatMap((event) => (echoOf(event) === undefined ? [] : [event.type])),
    ).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 60_000);

it("keeps a retry's echo on its run while a helper it spawned starts on its own message", async () => {
    let parentAgentId = "";
    let parentCalls = 0;
    let helperStarted!: () => void;
    const helperAccepted = new Promise<void>((resolve) => {
        helperStarted = resolve;
    });
    const gym = await createAgentGym({
        inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "<title>Helper</title>" }] };
            }
            if (request.sessionId !== parentAgentId) {
                helperStarted();
                return { content: [{ type: "text", text: "Helper finished." }] };
            }
            parentCalls += 1;
            if (parentCalls === 1) return { error: { message: "The first attempt failed." } };
            if (parentCalls === 2) {
                return {
                    content: [
                        {
                            type: "tool_call",
                            callId: "retryspawnshelper",
                            name: "create_agent",
                            arguments: {
                                effort: "medium",
                                model: "gym/model",
                                provider: "gym",
                                text: "Finish at once.",
                                title: "Helper",
                            },
                        },
                    ],
                };
            }
            // The retried run finishes only after the helper has accepted its own message.
            await helperAccepted;
            return { content: [{ type: "text", text: "Parent finished." }] };
        },
    });
    running.push(gym);
    parentAgentId = gym.defaultSessionId;

    await gym.send("Summarize the readme.", { wait: false });
    const failed = await unresolvedFailure(gym);
    const retryRunId = await runStartedBy(gym, async () => {
        await gym.client.retryFailedTurn(gym.defaultSessionId, failed.id, {
            mutationId: "retry-echo",
        });
    });
    await gym.waitForRun(retryRunId);

    const finished = (await gym.events()).filter(
        (event) => event.type === "run.finished" && runIdOf(event) === retryRunId,
    );
    expect(finished.map(echoOf)).toEqual(["retry-echo"]);
    expect(gym.errors).toEqual([]);
}, 60_000);

it("drops a retry's echo from the run a plain steer starts after it", async () => {
    let parentCalls = 0;
    let toolTurnReturned!: () => void;
    const toolTurn = new Promise<void>((resolve) => {
        toolTurnReturned = resolve;
    });
    const gym = await createAgentGym({
        inference: (request: GymInferenceRequest): GymTurn => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "<title>Steer</title>" }] };
            }
            parentCalls += 1;
            if (parentCalls === 1) return { error: { message: "The first attempt failed." } };
            if (parentCalls === 2) {
                toolTurnReturned();
                return {
                    content: [
                        {
                            type: "tool_call",
                            callId: "retryholdsthetool",
                            name: "exec_command",
                            arguments: {
                                cmd: "sleep 2",
                                max_output_tokens: 1_000,
                                yield_time_ms: 3_000,
                            },
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Answered the steer." }] };
        },
    });
    running.push(gym);

    await gym.send("Summarize the readme.", { wait: false });
    const failed = await unresolvedFailure(gym);
    const retryRunId = await runStartedBy(gym, async () => {
        await gym.client.retryFailedTurn(gym.defaultSessionId, failed.id, {
            mutationId: "retry-echo",
        });
    });
    await toolTurn;
    // After the retried run has provider output, a steer starts a successor run of its own.
    const steered = await gym.steer("Also check the license.");
    await gym.waitForRun(steered.runId);

    expect(steered.runId).not.toBe(retryRunId);
    const successor = (await gym.events()).filter(
        (event) => runIdOf(event) === steered.runId && event.type !== "run.boundary",
    );
    expect(successor.map((event) => event.type)).toContain("run.finished");
    expect(successor.flatMap((event) => (echoOf(event) === undefined ? [] : [event.type]))).toEqual(
        [],
    );
    expect(gym.errors).toEqual([]);
}, 60_000);

it("keeps a helper on its parent's mutation after the parent moves on to an untagged run", async () => {
    let parentAgentId = "";
    let parentCalls = 0;
    let releaseHelper!: () => void;
    const helperGate = new Promise<void>((resolve) => {
        releaseHelper = resolve;
    });
    let helperStarted!: () => void;
    const helperRunning = new Promise<void>((resolve) => {
        helperStarted = resolve;
    });
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
    });
    const gym = await createAgentGym({
        inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "<title>Helper</title>" }] };
            }
            if (request.sessionId !== parentAgentId) {
                if (!JSON.stringify(request.messages).includes("Finish slowly.")) {
                    return { content: [{ type: "text", text: "Not the helper." }] };
                }
                // The helper outlives its parent's retried run.
                helperStarted();
                await helperGate;
                return { content: [{ type: "text", text: "Helper finished." }] };
            }
            parentCalls += 1;
            if (parentCalls === 1) return { error: { message: "The first attempt failed." } };
            if (parentCalls === 2) {
                return {
                    content: [
                        {
                            type: "tool_call",
                            callId: "retryspawnsslowhelper",
                            name: "create_agent",
                            arguments: {
                                effort: "medium",
                                model: "gym/model",
                                provider: "gym",
                                text: "Finish slowly.",
                                title: "Helper",
                            },
                        },
                        {
                            type: "tool_call",
                            callId: "retryholdsitsbatch",
                            name: "exec_command",
                            arguments: {
                                cmd: "sleep 1",
                                max_output_tokens: 1_000,
                                yield_time_ms: 2_000,
                            },
                        },
                    ],
                };
            }
            await spawnGate;
            return { content: [{ type: "text", text: "Parent answered." }] };
        },
    });
    running.push(gym);
    parentAgentId = gym.defaultSessionId;

    await gym.send("Summarize the readme.", { wait: false });
    const failed = await unresolvedFailure(gym);
    const retryRunId = await runStartedBy(gym, async () => {
        await gym.client.retryFailedTurn(parentAgentId, failed.id, { mutationId: "retry-echo" });
    });
    await helperRunning;
    // The retried run has provider output, so this steer opens the parent's next run in the same
    // loop while the helper is still working.
    const steered = await gym.steer("Also check the license.");
    expect(steered.runId).not.toBe(retryRunId);
    releaseSpawn();
    await gym.waitForRun(steered.runId);
    releaseHelper();
    const helperId = await gym.waitUntil(async () => {
        const events = await gym.events();
        const retryStart = events.findIndex(
            (event) => event.type === "run.started" && runIdOf(event) === retryRunId,
        );
        const created = events.slice(retryStart).find((event) => event.type === "agent.created");
        return created?.type === "agent.created" ? created.payload.agent.id : undefined;
    }, "the helper to be created");
    await gym.waitForEvent(
        (event) =>
            event.type === "run.finished" &&
            (event.payload as { readonly agentId?: unknown }).agentId === helperId,
        "the helper to finish",
    );

    const events = await gym.events();
    const steeredRun = events.filter((event) => runIdOf(event) === steered.runId);
    expect(
        steeredRun.flatMap((event) => (echoOf(event) === undefined ? [] : [event.type])),
    ).toEqual([]);
    // The helper's own run was started by the retried run, before and after its parent moved on.
    const helperRun = events.filter(
        (event) =>
            runIdOf(event) !== undefined &&
            (event.payload as { readonly agentId?: unknown }).agentId === helperId,
    );
    expect(helperRun.map((event) => event.type)).toContain("run.finished");
    expect(
        helperRun.flatMap((event) =>
            echoOf(event) === "retry-echo" ? [] : [[event.type, echoOf(event) ?? null]],
        ),
    ).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 60_000);

it("echoes a helper's question with the helper's run after its parent moved on", async () => {
    let parentAgentId = "";
    let parentCalls = 0;
    let helperCalls = 0;
    let releaseHelper!: () => void;
    const helperGate = new Promise<void>((resolve) => {
        releaseHelper = resolve;
    });
    let helperStarted!: () => void;
    const helperRunning = new Promise<void>((resolve) => {
        helperStarted = resolve;
    });
    const gym = await createAgentGym({
        inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "<title>Helper</title>" }] };
            }
            if (request.sessionId !== parentAgentId) {
                if (!JSON.stringify(request.messages).includes("Ask the person.")) {
                    return { content: [{ type: "text", text: "Not the helper." }] };
                }
                helperCalls += 1;
                if (helperCalls > 1) return { content: [{ type: "text", text: "Helper done." }] };
                // The helper asks only after its parent has moved on to an untagged run.
                helperStarted();
                await helperGate;
                return {
                    content: [
                        {
                            type: "tool_call",
                            callId: "helperasksquestion",
                            name: "request_user_input",
                            arguments: {
                                context: "The helper needs one choice.",
                                questions: [
                                    {
                                        id: "choice",
                                        header: "Choice",
                                        question: "Which one?",
                                        options: [
                                            { description: "The first.", label: "First" },
                                            { description: "The second.", label: "Second" },
                                        ],
                                        multiSelect: false,
                                    },
                                ],
                            },
                        },
                    ],
                };
            }
            parentCalls += 1;
            if (parentCalls === 1) return { error: { message: "The first attempt failed." } };
            if (parentCalls === 2) {
                return {
                    content: [
                        {
                            type: "tool_call",
                            callId: "retryspawnsaskinghelper",
                            name: "create_agent",
                            arguments: {
                                effort: "medium",
                                model: "gym/model",
                                provider: "gym",
                                text: "Ask the person.",
                                title: "Helper",
                            },
                        },
                        {
                            type: "tool_call",
                            callId: "retryholdsforsteer",
                            name: "exec_command",
                            arguments: {
                                cmd: "sleep 1",
                                max_output_tokens: 1_000,
                                yield_time_ms: 2_000,
                            },
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Parent answered." }] };
        },
    });
    running.push(gym);
    parentAgentId = gym.defaultSessionId;

    await gym.send("Summarize the readme.", { wait: false });
    const failed = await unresolvedFailure(gym);
    await runStartedBy(gym, async () => {
        await gym.client.retryFailedTurn(parentAgentId, failed.id, { mutationId: "retry-echo" });
    });
    await helperRunning;
    const steered = await gym.steer("Also check the license.");
    await gym.waitForRun(steered.runId);
    releaseHelper();
    const created = await gym.waitForEvent(
        (event) => event.type === "question.created",
        "the helper's question",
    );
    if (created.type !== "question.created") throw new Error("No question was created.");
    const question = created.payload.question;
    expect(question.agentId).not.toBe(parentAgentId);
    expect(echoOf(created)).toBe("retry-echo");
    // The parent's untagged run, meanwhile, echoes nothing.
    expect(
        (await gym.events())
            .filter((event) => runIdOf(event) === steered.runId)
            .flatMap((event) => (echoOf(event) === undefined ? [] : [event.type])),
    ).toEqual([]);

    await gym.client.answerQuestion(question.agentId, question.id, {
        answers: { choice: ["First"] },
        mutationId: "answer-echo",
    });
    const updated = await gym.waitForEvent(
        (event) => event.type === "question.updated",
        "the answered question",
    );
    expect(echoOf(updated)).toBe("answer-echo");
    expect(gym.errors).toEqual([]);
}, 60_000);

async function unresolvedFailure(gym: AgentGym): Promise<ServiceMessage> {
    const failure = await gym.waitUntil(async () => {
        const messages = (await gym.client.getMessages(gym.defaultSessionId)).runs.flatMap(
            (run) => run.messages,
        );
        return messages.find(
            (message): message is ServiceMessage =>
                message.role === "service" &&
                message.failure !== undefined &&
                message.failure.resolution === undefined,
        );
    }, "an unresolved failure");
    await gym.waitUntil(
        async () =>
            (await gym.client.getAgent(gym.defaultSessionId)).agent.status === "idle"
                ? true
                : undefined,
        "the failed run to settle",
    );
    return failure;
}

async function runStartedBy(gym: AgentGym, action: () => Promise<void>): Promise<string> {
    const before = (await gym.events()).length;
    await action();
    const started = await gym.waitUntil(async () => {
        const event = (await gym.events())
            .slice(before)
            .find((candidate) => candidate.type === "run.started");
        return event?.type === "run.started" ? event.payload.run.id : undefined;
    }, "a run to start");
    return started;
}
