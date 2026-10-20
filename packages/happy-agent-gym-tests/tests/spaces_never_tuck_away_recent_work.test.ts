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
    it("evacuates running and recently active rows from a removed section while keeping them shown", async () => {
        let phase: "idle" | "place" | "remove" = "idle";
        let completed = "idle";
        let sectionId = "";
        const ids: string[] = [];
        const gym = await createAgentGym({
            timeoutMs: 30_000,
            inference(request) {
                const last = request.messages.at(-1);
                if (!request.instructions.includes("You are Prioritizing")) {
                    return {
                        delayMs: JSON.stringify(last).includes("Keep running") ? 60_000 : 0,
                        content: [{ type: "text", text: "Done." }],
                    };
                }
                if (
                    last?.role === "user" &&
                    JSON.stringify(last).includes("Tidy the sidebar now.")
                ) {
                    if (phase === "place")
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    name: "update_section",
                                    arguments: { name: "Work" },
                                    callId: "make_section",
                                },
                            ],
                        };
                    if (phase === "remove")
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    name: "remove_section",
                                    arguments: { sectionId },
                                    callId: "remove_section",
                                },
                            ],
                        };
                }
                if (phase === "place" && last?.role === "tool") {
                    const created = /Section ([a-z0-9]+) queued for creation/.exec(
                        JSON.stringify(last),
                    )?.[1];
                    if (created !== undefined) {
                        sectionId = created;
                        return {
                            content: ids.map((spaceId, index) => ({
                                type: "tool_call",
                                name: "place_space",
                                arguments: { spaceId, sectionId },
                                callId: `place_${index}`,
                            })),
                        };
                    }
                }
                if (last?.role === "tool") completed = phase;
                return { content: [{ type: "text", text: "Sidebar updated." }] };
            },
        });
        running.add(gym);
        const created = [];
        for (let index = 0; index < 3; index++) {
            const cell = await gym.http.ok<{ space: Space; agent: { id: string } }>(
                "POST",
                "/v0/spaces/stem-cells",
                {},
            );
            created.push(cell);
            ids.push(cell.space.id);
        }
        await gym.send("Recently active work.", { sessionId: created[0]!.agent.id });
        await gym.http.post("/v0/spaces/attention", { state: "interacting" });
        phase = "place";
        await gym.http.post("/v0/spaces/tidy", {});
        await gym.waitUntil(
            () => (completed === "place" ? true : undefined),
            "the queued section placements",
        );
        await gym.http.post("/v0/spaces/attention", { state: "calm" });
        await gym.waitUntil(async () => {
            const snapshot = await gym.http.ok<{ sections: { id: string }[] }>("GET", "/v0/spaces");
            return snapshot.sections.some((section) => section.id === sectionId) ? true : undefined;
        }, "the placed section");
        await gym.send("Keep running while the sidebar is tidied.", {
            sessionId: created[1]!.agent.id,
            wait: false,
        });
        await gym.waitUntil(async () => {
            const snapshot = await gym.http.ok<{ spaces: (Space & { working: boolean })[] }>(
                "GET",
                "/v0/spaces",
            );
            return snapshot.spaces.find((row) => row.id === ids[1])?.working ? true : undefined;
        }, "the running task");
        phase = "remove";
        await gym.http.post("/v0/spaces/tidy", {});
        await gym.waitUntil(
            () => (completed === "remove" ? true : undefined),
            "the queued section removal",
        );
        await gym.http.post("/v0/spaces/attention", { state: "calm" });
        const final = await gym.waitUntil(async () => {
            const snapshot = await gym.http.ok<{
                spaces: (Space & { sectionId: string | null })[];
                sections: { id: string }[];
            }>("GET", "/v0/spaces");
            return snapshot.sections.length === 0 ? snapshot : undefined;
        }, "the removed section");
        await gym.abort(created[1]!.agent.id);
        expect(ids.map((id) => final.spaces.find((row) => row.id === id)?.visibility)).toEqual([
            "shown",
            "shown",
            "folded",
        ]);
        expect(
            final.spaces
                .filter((row) => ids.includes(row.id))
                .every((row) => row.sectionId === null),
        ).toBe(true);
    }, 120_000);

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
