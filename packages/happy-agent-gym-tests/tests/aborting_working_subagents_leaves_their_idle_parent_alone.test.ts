import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("stopping a conversation's subagents after its own turn ended", () => {
    it("aborts each working child's subtree without touching the idle parent", async () => {
        let parentAgentId = "";
        let childAgentId: string | undefined;
        let parentRequests = 0;
        const delegatedRequests = new Map<string, number>();
        const unexpected: string[] = [];
        const gym = await createAgentGym({
            timeoutMs: 20_000,
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Stop subagents</title><slug>stop-subagents</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                if (request.sessionId === parentAgentId) {
                    parentRequests += 1;
                    if (parentRequests === 1) {
                        return {
                            content: [
                                createAgent("childcreate", "Delegate further, then keep working."),
                                {
                                    arguments: {
                                        cmd: "sleep 30",
                                        max_output_tokens: 1_000,
                                        yield_time_ms: 250,
                                    },
                                    callId: "parentprocess",
                                    name: "exec_command",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    if (parentRequests === 2) {
                        return { content: [{ text: "PARENT_HANDED_OFF", type: "text" }] };
                    }
                    unexpected.push(`parent:${JSON.stringify(request.messages.at(-1))}`);
                    return { content: [{ text: "UNEXPECTED_PARENT_CONTINUATION", type: "text" }] };
                }
                childAgentId ??= request.sessionId;
                const requests = (delegatedRequests.get(request.sessionId) ?? 0) + 1;
                delegatedRequests.set(request.sessionId, requests);
                if (requests > 1) {
                    unexpected.push(`${request.sessionId}:continued`);
                    return { content: [{ text: "UNEXPECTED_CHILD_CONTINUATION", type: "text" }] };
                }
                const holdActive = {
                    arguments: { duration: "30 seconds" },
                    callId: `hold${request.sessionId}`,
                    name: "wait",
                    type: "tool_call",
                } as const;
                return request.sessionId === childAgentId
                    ? { content: [createAgent("grandchildcreate", "Keep working."), holdActive] }
                    : { content: [holdActive] };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;

        await gym.send("Hand the work to a subagent and keep a server running.", {
            permissionMode: "full_access",
        });

        // The parent's own turn is over, and only the work it handed off is still going.
        const { child, grandchild } = await gym.waitUntil(async () => {
            const parent = (await gym.client.getAgent(parentAgentId)).agent;
            const children = (await gym.client.getAgentActivity(parentAgentId)).subagents;
            const working = children.find((candidate) => candidate.id === childAgentId);
            if (parent.status !== "idle" || working === undefined) return undefined;
            if (working.status === "idle" || parent.subagents.running !== 1) return undefined;
            const below = (await gym.client.getAgentActivity(working.id)).subagents[0];
            return below !== undefined && below.status !== "idle"
                ? { child: working, grandchild: below }
                : undefined;
        }, "only the delegated subtree to be working");
        const parentProcess = (await gym.client.getAgentActivity(parentAgentId)).processes.find(
            (process) => process.status === "running",
        );
        expect(parentProcess).toBeDefined();

        await gym.client.abortAgent(child.id, {});

        for (const agentId of [child.id, grandchild.id]) {
            const run = await gym.waitUntil(async () => {
                const latest = (await gym.client.getMessages(agentId)).runs.at(-1);
                return latest?.status === "aborted" ? latest : undefined;
            }, `the run of ${agentId} to be aborted`);
            expect(run).toMatchObject({ reason: "abort", status: "aborted" });
        }
        const parent = await gym.waitUntil(async () => {
            const agent = (await gym.client.getAgent(parentAgentId)).agent;
            return agent.subagents.running === 0 ? agent : undefined;
        }, "the parent to see no running subagents");
        expect(parent.status).toBe("idle");

        // An aborted collaborator owes its creator no report, so the parent is not woken, and
        // the parent's own background work survives a stop aimed only at its subagents.
        const history = await gym.client.getMessages(parentAgentId);
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0]).toMatchObject({ status: "completed" });
        const processes = (await gym.client.getAgentActivity(parentAgentId)).processes;
        expect(processes.find((process) => process.id === parentProcess?.id)).toMatchObject({
            status: "running",
        });
        expect(parentRequests).toBe(2);
        expect(unexpected).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
        if (parentProcess !== undefined)
            await gym.client.stopProcess(parentAgentId, parentProcess.id);
    }, 60_000);
});

function createAgent(callId: string, text: string) {
    return {
        arguments: {
            effort: "medium",
            model: "gym/model",
            provider: "gym",
            text,
            title: callId,
        },
        callId,
        name: "create_agent",
        type: "tool_call",
    } as const;
}
