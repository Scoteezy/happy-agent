import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("reserves a stem-cell ID before creating work and replays its real conversation", async () => {
    const gym = await createAgentGym({ timeoutMs: 30_000 });
    running.add(gym);
    const before = (await gym.client.listTasks()).tasks.length;
    const id = "stemcellretryaaaaaaaaaaa";
    const responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
            gym.http.post<{
                space: { id: string; target: { id: string; agentId: string } };
                agent: { id: string };
            }>("/v0/spaces/stem-cells", { id, mutationId: `retry-${index}` }),
        ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const first = responses[0]!.body;
    for (const response of responses) {
        expect(response.body.space.id).toBe(id);
        expect(response.body.space.target.agentId).toBe(response.body.agent.id);
        expect(response.body.agent.id).toBe(first.agent.id);
    }
    expect((await gym.client.listTasks()).tasks).toHaveLength(before + 1);
    const { spaces } = await gym.http.ok<{ spaces: { target: { kind: string } }[] }>(
        "GET",
        "/v0/spaces",
    );
    expect(spaces.filter((space) => space.target.kind === "task")).toHaveLength(before + 1);
    await gym.restart();
    const replay = await gym.http.post<typeof first>("/v0/spaces/stem-cells", { id });
    expect(replay.status).toBe(200);
    expect(replay.body.agent.id).toBe(first.agent.id);
}, 120_000);

it("never returns a competing owner's row or creates work for the losing owner", async () => {
    const {
        gym,
        alice,
        bob,
        aliceHttp: owner,
        bobHttp: member,
    } = await surfaceTeamClients({ timeoutMs: 30_000 });
    running.add(gym);
    await Promise.all([owner.ok("GET", "/v0/spaces"), member.ok("GET", "/v0/spaces")]);
    const before = (await alice.listTasks()).tasks.length;
    const id = "stemcellowneraaaaaaaaaaa";
    const results = await Promise.all([
        owner.request("POST", "/v0/spaces/stem-cells", { id }),
        member.request("POST", "/v0/spaces/stem-cells", { id }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 404]);
    expect((await alice.listTasks()).tasks).toHaveLength(before + 1);
    expect((await bob.listTasks()).tasks).toHaveLength(before + 1);
}, 120_000);
