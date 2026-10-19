import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

interface Space {
    readonly id: string;
    readonly title: string | null;
    readonly target: { readonly kind: string; readonly id: string };
}
interface StemCell {
    readonly space: Space;
    readonly agent: { readonly id: string };
}

describe("a stem cell", () => {
    it("has no title until named, and can be removed only while nobody wrote in it", async () => {
        const gym = await createAgentGym({ timeoutMs: 30_000 });
        running.add(gym);
        const rows = async () =>
            (await gym.http.ok<{ spaces: Space[] }>("GET", "/v0/spaces")).spaces;
        const cursor = (await gym.http.ok<{ cursor: string }>("GET", "/v0/spaces")).cursor;

        // New work has no title of its own yet; the client labels it.
        const untouched = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {});
        expect(untouched.space.title).toBeNull();

        // Leaving it untouched removes it: the row goes and its task is archived.
        const removedRow = await gym.http.patch(`/v0/spaces/${untouched.space.id}`, {
            removed: true,
            mutationId: "remove-1",
        });
        expect(removedRow.status).toBe(204);
        expect((await rows()).some((row) => row.id === untouched.space.id)).toBe(false);
        expect(
            (await gym.http.patch(`/v0/spaces/${untouched.space.id}`, { removed: true })).status,
        ).toBe(204);
        expect((await gym.client.getTask(untouched.space.target.id)).task.status).toBe("archived");
        // Space events are not in the published client's event union yet.
        const events = (await gym.client.getEvents({ after: cursor, limit: 1_000 }))
            .events as readonly { readonly type: string; readonly payload: unknown }[];
        const removed = events.find((event) => event.type === "space.removed");
        expect(removed?.payload).toMatchObject({
            spaceId: untouched.space.id,
            mutationId: "remove-1",
        });

        // Once a message exists it is real work and is kept.
        const used = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {});
        await gym.send("Plan the Android 2.4 release.", { sessionId: used.agent.id });
        expect(
            (await gym.http.patch(`/v0/spaces/${used.space.id}`, { removed: true })).status,
        ).toBe(409);
        expect(
            (
                await gym.http.patch(`/v0/spaces/${used.space.id}`, {
                    removed: true,
                    visibility: "hidden",
                })
            ).status,
        ).toBe(400);
        expect((await rows()).some((row) => row.id === used.space.id)).toBe(true);

        // A name brings its title back.
        const { task } = await gym.client.getTask(used.space.target.id);
        await gym.client.renameTask(
            task.id,
            { name: "Android 2.4 release" },
            { ifMatch: task.version },
        );
        const renamed = await gym.waitUntil(async () => {
            const row = (await rows()).find((candidate) => candidate.id === used.space.id);
            return row?.title === null ? undefined : row;
        }, "the named row");
        expect(renamed.title).toBe("Android 2.4 release");
    });
});
