import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("a manual compaction's replacement measurement", () => {
    it("records tokensAfter during the next run without reporting the working agent idle", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "context ready", type: "text" }] },
                {
                    content: [{ text: "answered on the compacted context", type: "text" }],
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 400,
                        output: 20,
                        totalTokens: 420,
                    },
                },
            ],
            compaction: async (request) => ({
                status: "completed",
                preservedMessages: [],
                usage: { cacheRead: 0, cacheWrite: 0, input: 100, output: 10, totalTokens: 110 },
                context: request.context,
            }),
        });
        running.add(gym);
        await gym.send("prepare the context");
        const compacted = await gym.client.compactAgent(gym.defaultSessionId);
        await gym.waitForRun(compacted.run.id);

        const answered = await gym.send("answer on the compacted context");

        const events = await gym.events();
        const started = events.findIndex(
            (event) => event.type === "run.started" && event.payload.run.id === answered.runId,
        );
        const finished = events.findIndex(
            (event) => event.type === "run.finished" && event.payload.run.id === answered.runId,
        );
        expect(started).toBeGreaterThanOrEqual(0);
        expect(finished).toBeGreaterThan(started);
        const duringRun = events.slice(started, finished);
        const measured = duringRun.find(
            (event) =>
                event.type === "message.updated" &&
                event.payload.message.id === compacted.message.id &&
                event.payload.message.content.some(
                    (block) => block.type === "compaction" && block.tokensAfter === 420,
                ),
        );
        expect(measured).toBeDefined();
        const statuses = duringRun.flatMap((event) =>
            event.type === "agent.updated" && event.payload.changes.status !== undefined
                ? [event.payload.changes.status]
                : [],
        );
        expect(statuses).not.toContain("idle");
        await expect(gym.client.getAgent(gym.defaultSessionId)).resolves.toMatchObject({
            agent: { status: "idle" },
        });
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
