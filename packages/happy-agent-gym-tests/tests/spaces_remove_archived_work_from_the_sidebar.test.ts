import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

interface Space {
    readonly id: string;
    readonly target: { readonly kind: string; readonly id: string };
}
interface StemCell {
    readonly space: Space;
    readonly agent: { readonly id: string };
}

describe("archived work", () => {
    it("leaves the sidebar with space.removed, and comes back when unarchived", async () => {
        const gym = await createAgentGym({ timeoutMs: 15_000 });
        running.add(gym);
        const rows = async () =>
            (await gym.http.ok<{ spaces: Space[] }>("GET", "/v0/spaces")).spaces;
        const { cursor } = await gym.http.ok<{ cursor: string }>("GET", "/v0/spaces");
        // Space events are not in the published client's event union yet.
        const removedIds = async () =>
            (
                (await gym.client.getEvents({ after: cursor, limit: 1_000 })).events as readonly {
                    readonly type: string;
                    readonly payload: { readonly spaceId?: string };
                }[]
            )
                .filter((event) => event.type === "space.removed")
                .map((event) => event.payload.spaceId);

        // A chat is archived through its task; the agent API refuses task agents.
        const viaTask = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {});
        await gym.send("Plan movie night.", { sessionId: viaTask.agent.id });
        const taskId = viaTask.space.target.id;
        const task = (await gym.client.getTask(taskId)).task;
        await gym.client.archiveTask(taskId, { ifMatch: task.version });
        await gym.waitUntil(
            async () =>
                (await rows()).some((row) => row.id === viaTask.space.id) ? undefined : true,
            "the archived task's row to leave",
        );
        expect(await removedIds()).toContain(viaTask.space.id);

        // Unarchiving brings the work back as a new row for Prioritizing to place.
        const archived = (await gym.client.getTask(taskId)).task;
        await gym.client.unarchiveTask(taskId, { ifMatch: archived.version });
        const back = await gym.waitUntil(async () => {
            const row = (await rows()).find((candidate) => candidate.target.id === taskId);
            return row;
        }, "the unarchived task's row");
        expect(back).toMatchObject({ placement: "pending", visibility: "shown" });
    }, 120_000);
});
