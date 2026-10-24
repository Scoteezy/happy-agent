import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

interface StemCell {
    readonly space: {
        readonly id: string;
        readonly target: {
            readonly kind: string;
            readonly id: string;
            readonly workspaceId: string;
            readonly agentId: string;
        };
    };
    readonly agent: { readonly id: string };
}

it("creates new work under the IDs the client chose and replays it for the same IDs", async () => {
    const gym = await createAgentGym({ timeoutMs: 30_000 });
    running.add(gym);
    const health = await gym.client.getHealth();
    expect(health.capabilities?.stemCellIdentities).toBe(true);
    const before = (await gym.client.listTasks()).tasks.length;
    const ids = {
        id: "clientspaceaaaaaaaaaaaaa",
        taskId: "clienttaskaaaaaaaaaaaaaa",
        workspaceId: "clientworkspaceaaaaaaaaa",
        agentId: "clientagentaaaaaaaaaaaaa",
    };

    // The client already shows the conversation; it exists only once creation answers.
    await expect(
        gym.send("Too early.", { sessionId: ids.agentId, wait: false }),
    ).rejects.toMatchObject({ status: 404 });

    // A client that timed out resends at once; only one conversation is made.
    const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
            gym.http.post<StemCell>("/v0/spaces/stem-cells", {
                ...ids,
                mutationId: `client-ids-${index}`,
            }),
        ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
        200, 200, 200, 200, 200, 201,
    ]);
    for (const response of responses) {
        expect(response.body.space).toMatchObject({
            id: ids.id,
            target: {
                kind: "task",
                id: ids.taskId,
                workspaceId: ids.workspaceId,
                agentId: ids.agentId,
            },
        });
        expect(response.body.agent.id).toBe(ids.agentId);
    }
    expect((await gym.client.listTasks()).tasks).toHaveLength(before + 1);
    const { task } = await gym.client.getTask(ids.taskId);
    expect(task).toMatchObject({ workspaceId: ids.workspaceId, agent: { id: ids.agentId } });

    // The published client sends the same request, and a replay may omit the child IDs.
    const typed = await gym.client.createStemCell(ids);
    expect(typed.agent.id).toBe(ids.agentId);
    const bare = await gym.http.post<StemCell>("/v0/spaces/stem-cells", { id: ids.id });
    expect(bare.status).toBe(200);
    expect(bare.body.agent.id).toBe(ids.agentId);

    // The conversation is addressable by the chosen agent ID.
    await gym.send("Plan the Android 2.4 release.", { sessionId: ids.agentId });

    await gym.restart();
    const replay = await gym.http.post<StemCell>("/v0/spaces/stem-cells", ids);
    expect(replay.status).toBe(200);
    expect(replay.body.space.target.agentId).toBe(ids.agentId);
    expect((await gym.client.listTasks()).tasks).toHaveLength(before + 1);
}, 120_000);

it("refuses IDs that are taken, repeated, mismatched, or malformed, and creates nothing", async () => {
    const gym = await createAgentGym({ timeoutMs: 30_000 });
    running.add(gym);
    const existing = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {
        id: "takenspaceaaaaaaaaaaaaaa",
        taskId: "takentaskaaaaaaaaaaaaaaa",
        workspaceId: "takenworkspaceaaaaaaaaaa",
        agentId: "takenagentaaaaaaaaaaaaaa",
    });
    const before = (await gym.client.listTasks()).tasks.length;
    const fresh = {
        id: "freshspaceaaaaaaaaaaaaaa",
        taskId: "freshtaskaaaaaaaaaaaaaaa",
        workspaceId: "freshworkspaceaaaaaaaaaa",
        agentId: "freshagentaaaaaaaaaaaaaa",
    };

    // A replay of the space ID that names another conversation is a conflict.
    const mismatched = await gym.http.post("/v0/spaces/stem-cells", {
        id: existing.space.id,
        agentId: fresh.agentId,
    });
    expect(mismatched.status).toBe(409);

    // A child ID without its space ID is not a retry; it is already in use.
    for (const taken of [
        { taskId: existing.space.target.id },
        { workspaceId: existing.space.target.workspaceId },
        { agentId: existing.space.target.agentId },
        { agentId: gym.defaultSessionId },
    ]) {
        const response = await gym.http.post("/v0/spaces/stem-cells", { ...fresh, ...taken });
        expect(response.status).toBe(409);
    }
    const repeated = await gym.http.post("/v0/spaces/stem-cells", {
        ...fresh,
        agentId: fresh.taskId,
    });
    expect(repeated.status).toBe(409);
    const malformed = await gym.http.post("/v0/spaces/stem-cells", {
        ...fresh,
        taskId: "Not-An-Id",
    });
    expect(malformed.status).toBe(400);

    expect((await gym.client.listTasks()).tasks).toHaveLength(before);
    const { spaces } = await gym.http.ok<{ spaces: { id: string }[] }>("GET", "/v0/spaces");
    expect(spaces.some((space) => space.id === fresh.id)).toBe(false);

    // Nothing was reserved by the refusals: the same IDs still make new work.
    const created = await gym.http.post<StemCell>("/v0/spaces/stem-cells", fresh);
    expect(created.status).toBe(201);
    expect(created.body.agent.id).toBe(fresh.agentId);
}, 120_000);

it("keeps generating every ID for a client that sends none", async () => {
    const gym = await createAgentGym({ timeoutMs: 30_000 });
    running.add(gym);
    const first = await gym.http.post<StemCell>("/v0/spaces/stem-cells", {});
    const second = await gym.http.post<StemCell>("/v0/spaces/stem-cells", {});
    expect([first.status, second.status]).toEqual([201, 201]);
    const targets = [first.body.space.target, second.body.space.target];
    const all = targets.flatMap((target) => [target.id, target.workspaceId, target.agentId]);
    expect(new Set(all).size).toBe(6);
    expect(first.body.agent.id).toBe(first.body.space.target.agentId);
    const retry = await gym.http.post<StemCell>("/v0/spaces/stem-cells", {
        id: first.body.space.id,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.agent.id).toBe(first.body.agent.id);
}, 120_000);

it("answers another person's space ID as not found even when its child IDs differ", async () => {
    const {
        gym,
        aliceHttp: owner,
        bobHttp: member,
    } = await surfaceTeamClients({
        timeoutMs: 30_000,
    });
    running.add(gym);
    await Promise.all([owner.ok("GET", "/v0/spaces"), member.ok("GET", "/v0/spaces")]);
    const id = "teamspaceaaaaaaaaaaaaaaa";
    const created = await owner.request("POST", "/v0/spaces/stem-cells", {
        id,
        taskId: "teamtaskaaaaaaaaaaaaaaaa",
        workspaceId: "teamworkspaceaaaaaaaaaaa",
        agentId: "teamagentaaaaaaaaaaaaaaa",
    });
    expect(created.status).toBe(201);
    const foreign = await member.request("POST", "/v0/spaces/stem-cells", {
        id,
        agentId: "bobagentaaaaaaaaaaaaaaaa",
    });
    expect(foreign.status).toBe(404);
}, 120_000);
