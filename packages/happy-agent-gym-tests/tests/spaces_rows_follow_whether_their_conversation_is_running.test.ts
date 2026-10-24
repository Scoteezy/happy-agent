import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

interface Space {
    readonly id: string;
    readonly working: boolean;
    readonly version: number;
}

it("publishes a row again when its conversation starts running and when the run stops, even aborted", async () => {
    let slow = true;
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference: (request) => {
            if (request.instructions.includes("You name a piece of work"))
                return { content: [{ type: "text", text: "<title>Movie night</title>" }] };
            // The first turn runs until it is stopped; later ones answer at once.
            if (slow) {
                slow = false;
                return { delayMs: 120_000, content: [{ type: "text", text: "Thinking." }] };
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    try {
        const { cursor } = await gym.http.ok<{ cursor: string }>("GET", "/v0/spaces");
        // Space events are not in the published client's event union yet.
        const updates = async (spaceId: string) =>
            (
                (await gym.client.getEvents({ after: cursor, limit: 1_000 })).events as readonly {
                    readonly type: string;
                    readonly payload: { readonly space?: Space };
                }[]
            )
                .filter((event) => event.type === "space.updated")
                .flatMap((event) =>
                    event.payload.space?.id === spaceId ? [event.payload.space] : [],
                );
        const stem = await gym.http.ok<{ space: Space; agent: { id: string } }>(
            "POST",
            "/v0/spaces/stem-cells",
            {},
        );
        expect(stem.space.working).toBe(false);

        await gym.send("Plan movie night.", { sessionId: stem.agent.id, wait: false });
        // Naming the work publishes the row once; the run starting publishes it again.
        const started = await gym.waitUntil(async () => {
            const seen = await updates(stem.space.id);
            return seen.length >= 2 && seen.every((space) => space.working)
                ? seen.at(-1)
                : undefined;
        }, "the row to show its conversation running");
        expect(started.version).toBeGreaterThan(stem.space.version);

        // Stopping the turn is published too: the row no longer shows it running.
        await gym.abort(stem.agent.id);
        const stopped = await gym.waitUntil(async () => {
            const seen = await updates(stem.space.id);
            const last = seen.at(-1);
            return last !== undefined && !last.working && last.version > started.version
                ? last
                : undefined;
        }, "the row to show its conversation stopped");
        const listed = (await gym.http.ok<{ spaces: Space[] }>("GET", "/v0/spaces")).spaces;
        expect(listed.find((space) => space.id === stem.space.id)).toMatchObject({
            working: false,
            version: stopped.version,
        });
        // One publication each way, not one per event of the run.
        expect((await updates(stem.space.id)).map((space) => space.working)).toEqual([
            true,
            true,
            false,
        ]);
    } finally {
        await gym.dispose();
    }
}, 120_000);
