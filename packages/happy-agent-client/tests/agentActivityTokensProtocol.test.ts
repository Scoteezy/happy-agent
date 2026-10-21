import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import { HappyAgentClient, agentSchema, type Agent } from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const agent: Agent = {
    id: "child1",
    workspaceId: "workspace1",
    parentAgentId: "parent1",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    version,
    lastCursor: version,
    orderKey: null,
    pendingQuestionId: null,
    processes: { running: 0 },
    subagents: { running: 0, total: 0 },
    status: "idle",
    title: "Finished helper",
    titleStatus: "ready",
    unread: null,
};

describe("activity token totals", () => {
    it("accepts omitted, unknown, zero, and recorded totals without breaking older agents", () => {
        expectTypeOf<Agent["totalTokens"]>().toEqualTypeOf<number | null | undefined>();
        expect(Value.Check(agentSchema, agent)).toBe(true);
        for (const totalTokens of [null, 0, 12_200, Number.MAX_SAFE_INTEGER]) {
            expect(Value.Check(agentSchema, { ...agent, totalTokens })).toBe(true);
        }
    });

    it.each([-1, 1.5, "12200", true, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
        "rejects malformed token totals %j",
        (totalTokens) => {
            expect(Value.Check(agentSchema, { ...agent, totalTokens })).toBe(false);
        },
    );

    it("preserves totals through the existing activity client method", async () => {
        const subagents = [
            { ...agent, id: "measured", totalTokens: 12_200 },
            { ...agent, id: "zero", totalTokens: 0 },
            { ...agent, id: "unknown", totalTokens: null },
            { ...agent, id: "older" },
        ];
        const client = new HappyAgentClient({
            endpoint: "http://agent.test",
            token: "test",
            fetch: async () => Response.json({ subagents, processes: [] }),
        });
        expect((await client.getAgentActivity("parent1")).subagents).toEqual(subagents);
    });
});
