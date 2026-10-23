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

interface HandOff {
    name: string;
    arguments: Record<string, unknown>;
}

const echoOf = (event: GymAgentEvent): unknown =>
    (event.payload as { readonly mutationId?: unknown }).mutationId;

const agentOf = (event: GymAgentEvent): unknown =>
    (event.payload as { readonly agentId?: unknown }).agentId;

/**
 * A gym whose default agent makes the hand-off's one tool call when it invokes the review skill.
 * `later` scripts every other turn; by default each simply answers.
 */
async function handingOff(
    handOff: HandOff,
    later?: (request: GymInferenceRequest) => GymTurn | undefined,
): Promise<AgentGym> {
    const gym: AgentGym = await createAgentGym({
        files: { ".agents/skills/review/SKILL.md": SKILL },
        inference: (request: GymInferenceRequest): GymTurn => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ text: "<title>Hand-off</title>", type: "text" }] };
            }
            const messages = JSON.stringify(request.messages);
            if (
                request.sessionId === gym.defaultSessionId &&
                messages.includes("Use the /review skill.") &&
                !messages.includes("handoffcall")
            ) {
                return {
                    content: [
                        {
                            arguments: handOff.arguments,
                            callId: "handoffcall",
                            name: handOff.name,
                            type: "tool_call",
                        },
                    ],
                };
            }
            return later?.(request) ?? { content: [{ text: "done", type: "text" }] };
        },
    });
    running.add(gym);
    return gym;
}

/** Invokes the review skill under `a-echo` and waits for the run it starts to settle. */
async function reviewTagged(gym: AgentGym): Promise<string> {
    await gym.client.invokeSlashCommand(gym.defaultSessionId, "review", {
        mode: {
            effort: gym.selection.effort,
            modelId: gym.selection.modelId,
            permissionMode: "auto",
            providerId: gym.selection.providerId,
            serviceTier: null,
        },
        mutationId: "a-echo",
    });
    const runId = await gym.waitUntil(async () => {
        const started = (await gym.events()).find(
            (event) => event.type === "run.started" && event.payload.mutationId === "a-echo",
        );
        return started?.type === "run.started" ? started.payload.run.id : undefined;
    }, "the tagged run to start");
    await gym.waitForRun(runId);
    return runId;
}

/** The first run, other than `except`, that `agentId` finished. */
async function finishedRun(gym: AgentGym, agentId: string, except?: string): Promise<string> {
    return await gym.waitUntil(async () => {
        const finished = (await gym.events()).find(
            (event) =>
                event.type === "run.finished" &&
                agentOf(event) === agentId &&
                runIdOf(event) !== except,
        );
        return finished === undefined ? undefined : runIdOf(finished);
    }, "the handed-off run to finish");
}

/** Every event of one run that did not echo `a-echo`, with what it echoed instead. */
async function strayEchoes(gym: AgentGym, runId: string): Promise<readonly unknown[]> {
    const run = (await gym.events()).filter((event) => runIdOf(event) === runId);
    expect(run.map((event) => event.type)).toContain("run.finished");
    return run.flatMap((event) =>
        echoOf(event) === "a-echo" ? [] : [[event.type, echoOf(event) ?? null]],
    );
}

describe("work one agent hands to another", () => {
    it("echoes, in a bot's run, the run that messaged the bot", async () => {
        const handOff: HandOff = { name: "send_bot_message", arguments: {} };
        const gym = await handingOff(handOff);
        const { bot } = await gym.client.createBot({ name: "Researcher" });
        handOff.arguments = { botId: bot.id, text: "Collect the incident reports." };
        await reviewTagged(gym);

        expect(await strayEchoes(gym, await finishedRun(gym, bot.agent.id))).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("echoes, in a task's run, the run that messaged the task", async () => {
        const handOff: HandOff = { name: "send_task_message", arguments: {} };
        const gym = await handingOff(handOff);
        const { task } = await gym.client.createTask({ name: "Audit exports" });
        handOff.arguments = { taskId: task.id, text: "Check the billing exports." };
        await reviewTagged(gym);

        expect(await strayEchoes(gym, await finishedRun(gym, task.agent.id))).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("echoes, in a goal's continuation, the run that set the goal", async () => {
        const gym = await handingOff(
            { name: "create_goal", arguments: { objective: "Finish the review." } },
            (request) =>
                JSON.stringify(request.messages).includes("goalcomplete")
                    ? undefined
                    : request.sessionId === gym.defaultSessionId &&
                        JSON.stringify(request.messages).includes(
                            "Continue working toward the active goal.",
                        )
                      ? {
                            content: [
                                {
                                    arguments: { status: "complete" },
                                    callId: "goalcomplete",
                                    name: "update_goal",
                                    type: "tool_call",
                                },
                            ],
                        }
                      : undefined,
        );
        const reviewRunId = await reviewTagged(gym);

        const continuationRunId = await finishedRun(gym, gym.defaultSessionId, reviewRunId);
        expect(continuationRunId).not.toBe(reviewRunId);
        expect(await strayEchoes(gym, continuationRunId)).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("echoes, in the run a scheduled message starts, the run that scheduled it", async () => {
        const handOff: HandOff = { name: "schedule_message", arguments: {} };
        const gym = await handingOff(handOff);
        handOff.arguments = {
            input: { agent_id: gym.defaultSessionId, message: "Look again.", in: { seconds: 1 } },
        };
        const reviewRunId = await reviewTagged(gym);

        // The message arrives after the scheduling run has settled.
        const scheduledRunId = await finishedRun(gym, gym.defaultSessionId, reviewRunId);
        expect(await strayEchoes(gym, scheduledRunId)).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
