import { type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("refuses to remove a joined task without archive authority and keeps every owner's row", async () => {
    const {
        gym,
        alice,
        bob,
        aliceHttp: owner,
        bobHttp: member,
    } = await surfaceTeamClients({ timeoutMs: 30_000 });
    running.add(gym);
    const snapshot = (http: typeof owner) =>
        http.ok<{ spaces: { id: string; target: { id: string } }[]; cursor: string }>(
            "GET",
            "/v0/spaces",
        );
    const { task } = await alice.createTask({});
    await bob.joinTask(task.id);
    const before = await snapshot(member);
    const row = before.spaces.find((space) => space.target.id === task.id)!;
    await snapshot(owner);

    await expect(bob.archiveTask(task.id, { ifMatch: task.version })).rejects.toMatchObject({
        status: 403,
    });
    expect(await member.request("PATCH", `/v0/spaces/${row.id}`, { removed: true })).toMatchObject({
        status: 403,
        body: { code: "forbidden" },
    });
    expect((await alice.getTask(task.id)).task.status).toBe("active");
    expect((await snapshot(member)).spaces).toEqual(before.spaces);
    expect((await snapshot(owner)).spaces.some((space) => space.target.id === task.id)).toBe(true);
    const events = await bob.getEvents({ after: before.cursor, limit: 1000 });
    expect(
        events.events.filter(
            (event) => event.type === "task.updated" || String(event.type) === "space.removed",
        ),
    ).toEqual([]);

    // The team owner can remove an empty task owned by another member.
    const other = (await bob.createTask({})).task;
    await alice.joinTask(other.id);
    const ownRow = (await snapshot(owner)).spaces.find((space) => space.target.id === other.id)!;
    expect(
        (await owner.request("PATCH", `/v0/spaces/${ownRow.id}`, { removed: true })).status,
    ).toBe(204);
    expect((await bob.getTask(other.id)).task.status).toBe("archived");
}, 120_000);
