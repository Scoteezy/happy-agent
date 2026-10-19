import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

interface Space {
    readonly id: string;
    readonly role: string;
    readonly visibility: string;
    readonly target: { readonly kind: string; readonly id: string } | null;
}

describe("the sidebar seed", () => {
    it("keeps one row per piece of work, even when new work is the first thing made", async () => {
        const gym = await createAgentGym({ timeoutMs: 30_000 });
        running.add(gym);
        const visibleRows = async () =>
            (await gym.http.ok<{ spaces: Space[] }>("GET", "/v0/spaces")).spaces.filter(
                (row) => row.visibility !== "hidden",
            );

        // ⌘N before the sidebar was ever read: the seed sees the new task too, and the stem cell
        // takes that row over instead of colliding with it.
        const first = await gym.http.post("/v0/spaces/stem-cells", {});
        expect(first.status).toBe(201);
        const created = (first.body as { space: Space }).space;

        // Reading, restarting, and reading again seeds nothing twice.
        const before = await visibleRows();
        await gym.restart();
        const after = await visibleRows();
        expect(after.map(({ id }) => id).sort()).toEqual(before.map(({ id }) => id).sort());
        const targets = after.flatMap((row) => (row.target === null ? [] : [row.target.id]));
        expect(new Set(targets).size).toBe(targets.length);
        expect(after.filter((row) => row.target?.id === created.target!.id)).toEqual([
            expect.objectContaining({ id: created.id }),
        ]);
    });
});
