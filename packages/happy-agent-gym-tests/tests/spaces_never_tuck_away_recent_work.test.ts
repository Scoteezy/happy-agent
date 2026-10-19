import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

interface Space {
    readonly id: string;
    readonly visibility: string;
}

/** A Prioritizing script that hides and folds every row it knows of when asked to tidy, as a cheap model did. */
function tuckEverythingAway(rows: readonly string[]) {
    let call = 0;
    return (request: GymInferenceRequest): GymTurn => {
        if (!request.instructions.includes("You are Prioritizing")) {
            return { content: [{ type: "text", text: "Done." }] };
        }
        const last = request.messages.at(-1);
        if (last?.role === "user" && JSON.stringify(last).includes("Tidy the sidebar now.")) {
            return {
                content: rows.map((spaceId, index) => ({
                    type: "tool_call" as const,
                    name: "set_space_visibility",
                    arguments: { spaceId, visibility: index === 0 ? "hidden" : "folded" },
                    callId: `tuck_${String(++call)}`,
                })),
            };
        }
        return { content: [{ type: "text", text: "Sidebar updated." }] };
    };
}

describe("a tidy", () => {
    it("never hides or folds work that is running or was active in the last two hours", async () => {
        const rows: string[] = [];
        const gym = await createAgentGym({
            timeoutMs: 30_000,
            inference: tuckEverythingAway(rows),
        });
        running.add(gym);
        const isPrioritizing = (request: GymInferenceRequest) =>
            request.instructions.includes("You are Prioritizing");

        for (const text of ["Plan the Android 2.4 release.", "Draft the weekly usage report."]) {
            const created = await gym.http.ok<{ space: Space; agent: { id: string } }>(
                "POST",
                "/v0/spaces/stem-cells",
                {},
            );
            rows.push(created.space.id);
            await gym.send(text, { sessionId: created.agent.id });
        }

        expect((await gym.http.post("/v0/spaces/tidy", {})).status).toBe(202);
        const replies = await gym.waitUntil(() => {
            const answered = gym.inference.requests.find(
                (request) =>
                    isPrioritizing(request) &&
                    request.messages.at(-1)?.role === "tool" &&
                    JSON.stringify(request.messages).includes("tuck_"),
            );
            return answered === undefined ? undefined : JSON.stringify(answered.messages);
        }, "Prioritizing's tidy");
        expect(replies).toContain("stays shown");
        expect(replies).not.toContain("Change queued");

        // Nothing was queued, so the calm moment moves nothing.
        const calm = await gym.http.ok<{ batch: unknown }>("POST", "/v0/spaces/attention", {
            state: "calm",
        });
        expect(calm.batch).toBeNull();
        const { spaces } = await gym.http.ok<{ spaces: Space[] }>("GET", "/v0/spaces");
        expect(spaces.filter((row) => rows.includes(row.id)).map((row) => row.visibility)).toEqual([
            "shown",
            "shown",
        ]);
    }, 120_000);
});
