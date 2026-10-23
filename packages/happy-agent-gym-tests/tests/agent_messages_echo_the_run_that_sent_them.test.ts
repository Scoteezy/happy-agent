import {
    createAgentGym,
    runIdOf,
    type AgentGym,
    type GymAgentEvent,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const SKILL = "---\nname: review\ndescription: Review the changes.\n---\n\nReview carefully.";

const echoOf = (event: GymAgentEvent): unknown =>
    (event.payload as { readonly mutationId?: unknown }).mutationId;

function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

/** Invokes the review skill under `mutationId` and returns the run it starts. */
async function invokeReview(gym: AgentGym, agentId: string, mutationId: string): Promise<string> {
    const before = (await gym.events()).length;
    await gym.client.invokeSlashCommand(agentId, "review", {
        mode: {
            effort: gym.selection.effort,
            modelId: gym.selection.modelId,
            permissionMode: "auto",
            providerId: gym.selection.providerId,
            serviceTier: null,
        },
        mutationId,
    });
    return await gym.waitUntil(async () => {
        const started = (await gym.events())
            .slice(before)
            .find(
                (event) =>
                    event.type === "run.started" &&
                    event.payload.agentId === agentId &&
                    event.payload.mutationId === mutationId,
            );
        return started?.type === "run.started" ? started.payload.run.id : undefined;
    }, `the ${mutationId} run to start`);
}

/** The run that accepted one message, whether it started on its own or after a boundary. */
async function runOf(gym: AgentGym, messageId: string): Promise<string> {
    return await gym.waitUntil(async () => {
        for (const event of await gym.events()) {
            if (
                event.type === "run.started" &&
                event.payload.acceptedMessageIds.includes(messageId)
            ) {
                return event.payload.run.id;
            }
            if (
                event.type === "run.boundary" &&
                event.payload.acceptedMessageIds.includes(messageId)
            ) {
                return event.payload.startedRun.id;
            }
        }
        return undefined;
    }, "the delivered message to start a run");
}

/** The ID of the message an agent received from another agent, once it is in its history. */
async function receivedMessageId(gym: AgentGym, agentId: string, text: string): Promise<string> {
    return await gym.waitUntil(async () => {
        const messages = (await gym.client.getMessages(agentId)).runs.flatMap(
            (run) => run.messages,
        );
        return messages.find(
            (message) => message.role === "agent" && JSON.stringify(message).includes(text),
        )?.id;
    }, "the delivered message to be accepted");
}

/** Every event of one run that did not echo `expected`, with what it echoed instead. */
function strayEchoes(
    events: readonly GymAgentEvent[],
    runId: string,
    expected: string,
): readonly (readonly [string, unknown])[] {
    return events
        .filter((event) => runIdOf(event) === runId)
        .flatMap((event) =>
            echoOf(event) === expected ? [] : [[event.type, echoOf(event) ?? null] as const],
        );
}

async function messageAcceptedAfterTheSendingRunSettled(senderMovesOn: boolean): Promise<void> {
    const target = gate();
    const targetStarted = gate();
    const secondRun = gate();
    const secondRunStarted = gate();
    let senderAgentId = "";
    let targetAgentId = "";
    let senderCalls = 0;
    let targetCalls = 0;
    const gym = await createAgentGym({
        files: { ".agents/skills/review/SKILL.md": SKILL },
        inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ text: "<title>Messages</title>", type: "text" }] };
            }
            if (request.sessionId === targetAgentId) {
                targetCalls += 1;
                if (targetCalls > 1) {
                    return { content: [{ text: "target answered", type: "text" }] };
                }
                // The target is answering something else, so the message waits for this answer.
                targetStarted.open();
                await target.opened;
                return { content: [{ text: "target busy", type: "text" }] };
            }
            if (request.sessionId !== senderAgentId) {
                return { content: [{ text: "unexpected agent", type: "text" }] };
            }
            senderCalls += 1;
            if (senderCalls === 1) {
                return {
                    content: [
                        {
                            arguments: {
                                text: "Sent from the first run.",
                                toAgentId: targetAgentId,
                            },
                            callId: "firstrunmessage",
                            name: "send_agent_message",
                            type: "tool_call",
                        },
                    ],
                };
            }
            if (senderCalls === 2) return { content: [{ text: "message sent", type: "text" }] };
            // The sender's next run stays open until the target has answered the message.
            secondRunStarted.open();
            await secondRun.opened;
            return { content: [{ text: "second run finished", type: "text" }] };
        },
    });
    running.add(gym);
    senderAgentId = gym.defaultSessionId;
    targetAgentId = (await gym.createSession({ title: "Target" })).id;
    await gym.send("answer something else", { sessionId: targetAgentId, wait: false });
    await targetStarted.opened;

    const firstRunId = await invokeReview(gym, senderAgentId, "a-echo");
    await gym.waitForRun(firstRunId);
    let secondRunId: string | undefined;
    if (senderMovesOn) {
        secondRunId = await invokeReview(gym, senderAgentId, "b-echo");
        await secondRunStarted.opened;
    }

    target.open();
    const messageId = await receivedMessageId(gym, targetAgentId, "Sent from the first run.");
    const targetRunId = await runOf(gym, messageId);
    await gym.waitForRun(targetRunId);
    secondRun.open();
    if (secondRunId !== undefined) await gym.waitForRun(secondRunId);

    const events = await gym.events();
    expect(
        events.filter((event) => runIdOf(event) === targetRunId).map((event) => event.type),
    ).toContain("run.finished");
    expect(strayEchoes(events, targetRunId, "a-echo")).toEqual([]);
    if (secondRunId !== undefined) expect(strayEchoes(events, secondRunId, "b-echo")).toEqual([]);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
}

describe("a message one agent sends another", () => {
    it("echoes the run that sent it after the sender moved on to a differently tagged run", async () => {
        await messageAcceptedAfterTheSendingRunSettled(true);
    }, 60_000);

    it("echoes the run that sent it after that run settled", async () => {
        await messageAcceptedAfterTheSendingRunSettled(false);
    }, 60_000);

    it("echoes, in a helper's report, the run that started the helper", async () => {
        const parent = gate();
        const parentBusy = gate();
        const helper = gate();
        const helperStarted = gate();
        let parentAgentId = "";
        let parentCalls = 0;
        const gym = await createAgentGym({
            files: { ".agents/skills/review/SKILL.md": SKILL },
            inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Helper</title>", type: "text" }] };
                }
                if (request.sessionId !== parentAgentId) {
                    // The helper outlives the run that started it and reports once it finishes.
                    helperStarted.open();
                    await helper.opened;
                    return { content: [{ text: "helper result", type: "text" }] };
                }
                parentCalls += 1;
                if (parentCalls === 1) {
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    provider: "gym",
                                    text: "Report later.",
                                    title: "Helper",
                                },
                                callId: "taggedrunspawnshelper",
                                name: "create_agent",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                if (parentCalls === 2) {
                    return { content: [{ text: "helper started", type: "text" }] };
                }
                if (parentCalls === 3) {
                    // The parent is answering something else, so the report waits for this answer.
                    parentBusy.open();
                    await parent.opened;
                    return { content: [{ text: "parent busy", type: "text" }] };
                }
                return { content: [{ text: "report read", type: "text" }] };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;

        const spawningRunId = await invokeReview(gym, parentAgentId, "a-echo");
        await gym.waitForRun(spawningRunId);
        await helperStarted.opened;
        await gym.send("answer something else", { wait: false });
        await parentBusy.opened;
        helper.open();
        await gym.waitForEvent(
            (event) =>
                event.type === "run.finished" &&
                event.payload.agentId !== parentAgentId &&
                event.payload.run.status === "completed",
            "the helper to finish",
        );

        parent.open();
        const reportId = await receivedMessageId(gym, parentAgentId, "helper result");
        const reportRunId = await runOf(gym, reportId);
        await gym.waitForRun(reportRunId);

        const events = await gym.events();
        expect(
            events.filter((event) => runIdOf(event) === reportRunId).map((event) => event.type),
        ).toContain("run.finished");
        expect(strayEchoes(events, reportRunId, "a-echo")).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);
});
