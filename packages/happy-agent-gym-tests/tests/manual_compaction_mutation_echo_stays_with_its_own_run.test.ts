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

const usage = (input: number) => ({
    cacheRead: 0,
    cacheWrite: 0,
    input,
    output: 10,
    totalTokens: input + 10,
});

describe("a manual compaction's mutation echo", () => {
    it("stays with the compaction and never reaches the queued turn the same loop runs next", async () => {
        let releaseCompaction!: () => void;
        let compactionStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            compactionStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            releaseCompaction = resolve;
        });
        let parentAgentId = "";
        let parentRequests = 0;
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Helper</title>", type: "text" }] };
                }
                if (request.sessionId !== parentAgentId) {
                    return { content: [{ text: "helper finished", type: "text" }] };
                }
                parentRequests += 1;
                if (parentRequests === 1) {
                    return {
                        content: [{ text: "context ready", type: "text" }],
                        usage: usage(100),
                    };
                }
                if (parentRequests === 2) {
                    // The queued turn spawns a helper and measures its context, so its run
                    // carries a spawn update and context updates of its own.
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    provider: "gym",
                                    text: "Finish at once.",
                                    title: "Helper",
                                },
                                callId: "queuedturnspawn",
                                name: "create_agent",
                                type: "tool_call",
                            },
                        ],
                        usage: usage(300),
                    };
                }
                return {
                    content: [{ text: "queued turn answered", type: "text" }],
                    usage: usage(400),
                };
            },
            compaction: async (request) => {
                compactionStarted();
                await gate;
                return {
                    status: "completed",
                    preservedMessages: [],
                    usage: usage(100),
                    context: request.context,
                };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;
        await gym.send("prepare the context");

        const compacted = await gym.client.compactAgent(gym.defaultSessionId, {
            mutationId: "compaction-echo",
        });
        await started;
        // Queued while the compaction runs, so the loop the compaction woke answers it next.
        const queued = await gym.client.sendMessage(gym.defaultSessionId, {
            delivery: "queue",
            mode: {
                effort: gym.selection.effort,
                modelId: gym.selection.modelId,
                permissionMode: "auto",
                providerId: gym.selection.providerId,
                serviceTier: null,
            },
            text: "answer after the compaction",
        });
        releaseCompaction();
        const accepted = await gym.waitForEvent(
            (event) =>
                event.type === "run.started" &&
                event.payload.acceptedMessageIds.includes(queued.message.id),
            "the queued message to start its run",
        );
        if (accepted.type !== "run.started") throw new Error("The queued run did not start.");
        const queuedRunId = accepted.payload.run.id;
        await gym.waitForRun(queuedRunId);

        const events = await gym.events();
        const echoed = (event: GymAgentEvent): boolean =>
            (event.payload as { readonly mutationId?: unknown }).mutationId === "compaction-echo";
        // The compaction's lifecycle, through its finish. The next run's inference later measures
        // its tokensAfter; that update belongs to the run that measured it.
        const compactionFinished = events.findIndex(
            (event) => event.type === "run.finished" && event.payload.run.id === compacted.run.id,
        );
        const compactionLifecycle = events
            .slice(0, compactionFinished + 1)
            .filter(
                (event) =>
                    ((event.type === "run.started" || event.type === "run.finished") &&
                        event.payload.run.id === compacted.run.id) ||
                    ((event.type === "message.created" || event.type === "message.updated") &&
                        event.payload.message.id === compacted.message.id),
            );
        expect(compactionLifecycle.length).toBeGreaterThanOrEqual(4);
        expect(compactionLifecycle.filter((event) => !echoed(event))).toEqual([]);

        // Everything from the queued run's start to its finish, for any agent and whether or not
        // the event names a run.
        const start = events.findIndex(
            (event) => event.type === "run.started" && event.payload.run.id === queuedRunId,
        );
        const finish = events.findIndex(
            (event) => event.type === "run.finished" && runIdOf(event) === queuedRunId,
        );
        expect(finish).toBeGreaterThan(start);
        const queuedTurn = events.slice(start, finish + 1);
        const types = new Set(queuedTurn.map((event) => event.type));
        expect(types).toContain("agent.context.updated");
        expect(
            queuedTurn.some(
                (event) =>
                    event.type === "message.updated" &&
                    event.payload.message.content.some(
                        (block) => block.type === "tool_call" && block.name === "create_agent",
                    ),
            ),
        ).toBe(true);
        expect(queuedTurn.filter(echoed).map((event) => event.type)).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
    it("hands the loop to a differently tagged skill invocation queued behind the compaction", async () => {
        let releaseCompaction!: () => void;
        let compactionStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            compactionStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            releaseCompaction = resolve;
        });
        const gym = await createAgentGym({
            files: {
                ".agents/skills/review/SKILL.md":
                    "---\nname: review\ndescription: Review the changes.\n---\n\nReview carefully.",
            },
            inference: [
                { content: [{ text: "context ready", type: "text" }], usage: usage(100) },
                { content: [{ text: "review finished", type: "text" }], usage: usage(300) },
            ],
            compaction: async (request) => {
                compactionStarted();
                await gate;
                return {
                    status: "completed",
                    preservedMessages: [],
                    usage: usage(100),
                    context: request.context,
                };
            },
        });
        running.add(gym);
        const agentId = gym.defaultSessionId;
        await gym.send("prepare the context");

        await gym.client.compactAgent(agentId, { mutationId: "compaction-echo" });
        await started;
        await gym.client.invokeSlashCommand(agentId, "review", {
            mode: {
                effort: gym.selection.effort,
                modelId: gym.selection.modelId,
                permissionMode: "auto",
                providerId: gym.selection.providerId,
                serviceTier: null,
            },
            mutationId: "skill-echo",
        });
        releaseCompaction();
        const accepted = await gym.waitForEvent(
            (event) => event.type === "run.started" && event.payload.mutationId === "skill-echo",
            "the skill invocation to start its run",
        );
        if (accepted.type !== "run.started") throw new Error("The skill run did not start.");
        const skillRunId = accepted.payload.run.id;
        await gym.waitForRun(skillRunId);

        const events = await gym.events();
        const start = events.findIndex(
            (event) => event.type === "run.started" && event.payload.run.id === skillRunId,
        );
        const finish = events.findIndex(
            (event) => event.type === "run.finished" && runIdOf(event) === skillRunId,
        );
        expect(finish).toBeGreaterThan(start);
        const skillTurn = events
            .slice(start, finish + 1)
            .filter(
                (event) => (event.payload as { readonly agentId?: unknown }).agentId === agentId,
            );
        expect(new Set(skillTurn.map((event) => event.type))).toContain("agent.context.updated");
        expect(
            skillTurn.flatMap((event) => {
                const echo = (event.payload as { readonly mutationId?: unknown }).mutationId;
                return echo === "skill-echo" ? [] : [[event.type, echo ?? null]];
            }),
        ).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
    it("hands an ordinary untagged loop to a skill invocation queued behind its run", async () => {
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let firstStarted!: () => void;
        const firstRunning = new Promise<void>((resolve) => {
            firstStarted = resolve;
        });
        let calls = 0;
        const gym = await createAgentGym({
            files: {
                ".agents/skills/review/SKILL.md":
                    "---\nname: review\ndescription: Review the changes.\n---\n\nReview carefully.",
            },
            inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Review</title>", type: "text" }] };
                }
                calls += 1;
                if (calls === 1) {
                    firstStarted();
                    await firstGate;
                    return { content: [{ text: "first answer", type: "text" }], usage: usage(100) };
                }
                return { content: [{ text: "review finished", type: "text" }], usage: usage(300) };
            },
        });
        running.add(gym);
        const agentId = gym.defaultSessionId;
        await gym.send("an ordinary request", { wait: false });
        await firstRunning;
        await gym.client.invokeSlashCommand(agentId, "review", {
            mode: {
                effort: gym.selection.effort,
                modelId: gym.selection.modelId,
                permissionMode: "auto",
                providerId: gym.selection.providerId,
                serviceTier: null,
            },
            mutationId: "skill-echo",
        });
        releaseFirst();
        const accepted = await gym.waitForEvent(
            (event) => event.type === "run.started" && event.payload.mutationId === "skill-echo",
            "the skill invocation to start its run",
        );
        if (accepted.type !== "run.started") throw new Error("The skill run did not start.");
        const skillRunId = accepted.payload.run.id;
        await gym.waitForRun(skillRunId);

        const events = await gym.events();
        const start = events.findIndex(
            (event) => event.type === "run.started" && event.payload.run.id === skillRunId,
        );
        const finish = events.findIndex(
            (event) => event.type === "run.finished" && runIdOf(event) === skillRunId,
        );
        expect(finish).toBeGreaterThan(start);
        // Every event of the skill's run, and any context it measured. The agent's title, named
        // in the background after the first request, belongs to neither.
        const skillTurn = events
            .slice(start, finish + 1)
            .filter(
                (event) =>
                    runIdOf(event) === skillRunId ||
                    (event.type === "agent.context.updated" && event.payload.agentId === agentId),
            );
        expect(skillTurn.length).toBeGreaterThan(4);
        expect(
            skillTurn.flatMap((event) => {
                const echo = (event.payload as { readonly mutationId?: unknown }).mutationId;
                return echo === "skill-echo" ? [] : [[event.type, echo ?? null]];
            }),
        ).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
