import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
interface Space {
    id: string;
    target: { id: string };
}
interface Snapshot {
    spaces: Space[];
    cursor: string;
}
interface SpaceEvent {
    type: string;
    payload: { space: Space };
}
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("adds newly created Surfaces after seeding and reconciles leaving and rejoining", async () => {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    running.add(gym);
    const snapshot = () => gym.http.ok<Snapshot>("GET", "/v0/spaces");
    const before = await snapshot();
    const surface = (await gym.client.createSurface({ type: "todo", name: "Shopping" })).surface;
    await gym.client.createTodo(surface.id, { text: "Milk" });
    const row = await gym.waitUntil(
        async () => (await snapshot()).spaces.find((space) => space.target.id === surface.id),
        "the new Surface's row",
    );
    expect(row).toMatchObject({ placement: "pending", visibility: "shown", title: "Shopping" });
    await gym.client.leaveSurface(surface.id);
    await gym.waitUntil(
        async () =>
            (await snapshot()).spaces.some((space) => space.id === row.id) ? undefined : true,
        "the left Surface's row to leave",
    );
    await gym.client.joinSurface(surface.id);
    const rejoined = await gym.waitUntil(
        async () => (await snapshot()).spaces.find((space) => space.target.id === surface.id),
        "the rejoined Surface's row",
    );
    expect(rejoined.id).not.toBe(row.id);
    const events = (await gym.client.getEvents({ after: before.cursor, limit: 1000 }))
        .events as unknown as SpaceEvent[];
    expect(
        events.filter(
            (event) =>
                event.type === "space.created" && event.payload.space.target.id === surface.id,
        ),
    ).toHaveLength(2);
    expect(events).toContainEqual(
        expect.objectContaining({
            type: "space.removed",
            payload: expect.objectContaining({ spaceId: row.id }),
        }),
    );
}, 120_000);

it("keeps Surface rows and events private to each seeded member", async () => {
    const {
        gym,
        alice,
        bob,
        aliceHttp: owner,
        bobHttp: member,
    } = await surfaceTeamClients({ timeoutMs: 15_000 });
    running.add(gym);
    const snapshot = (http: typeof owner) => http.ok<Snapshot>("GET", "/v0/spaces");
    // Exercise explicit membership without the automatic participation policy.
    await bob.saveUserSetting("surfaces.autoJoin", { value: false });
    const [a, b] = await Promise.all([snapshot(owner), snapshot(member)]);
    const surface = (
        await alice.createSurface({ type: "document", name: "Shared notes", text: "Team notes" })
    ).surface;
    const ownerRow = await gym.waitUntil(
        async () => (await snapshot(owner)).spaces.find((space) => space.target.id === surface.id),
        "the creator's row",
    );
    expect((await snapshot(member)).spaces.some((space) => space.target.id === surface.id)).toBe(
        false,
    );
    await bob.joinSurface(surface.id);
    const memberRow = await gym.waitUntil(
        async () => (await snapshot(member)).spaces.find((space) => space.target.id === surface.id),
        "the joined member's row",
    );
    expect(memberRow.id).not.toBe(ownerRow.id);
    await bob.leaveSurface(surface.id);
    await gym.waitUntil(
        async () =>
            (await snapshot(member)).spaces.some((space) => space.id === memberRow.id)
                ? undefined
                : true,
        "only the leaving member's row to leave",
    );
    expect(
        (await snapshot(owner)).spaces.filter((space) => space.target.id === surface.id),
    ).toEqual([expect.objectContaining({ id: ownerRow.id })]);
    const ownerEvents = (await alice.getEvents({ after: a.cursor, limit: 1000 }))
        .events as unknown as SpaceEvent[];
    const memberEvents = (await bob.getEvents({ after: b.cursor, limit: 1000 }))
        .events as unknown as SpaceEvent[];
    expect(
        ownerEvents
            .filter((event) => event.type === "space.created")
            .map((event) => event.payload.space.id),
    ).not.toContain(memberRow.id);
    expect(
        memberEvents
            .filter((event) => event.type === "space.created")
            .map((event) => event.payload.space.id),
    ).not.toContain(ownerRow.id);
}, 120_000);
