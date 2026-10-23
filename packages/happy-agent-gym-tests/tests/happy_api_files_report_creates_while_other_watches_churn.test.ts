import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const active = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...active].map(async (gym) => await gym.dispose()));
    active.clear();
});

// On macOS every directory watch in the daemon shares one FSEvents stream, which the runtime stops
// and recreates whenever any directory watch is added or closed; Bun drops a change landing a few
// milliseconds either side of that. Each trial lands a create right before other folders are
// opened, the way a client expanding a tree does, and must still be reported without the client
// looking at the folder again.
const TRIALS = 40;
const CHURN = 6;

describe("files.updated while other directory watches churn", () => {
    it("reports a create in a viewed folder that lands while other folders are opened", async () => {
        const gym = await createAgentGym({ timeoutMs: 20_000 });
        active.add(gym);
        const workspaceId = await root(gym);
        const missed: string[] = [];
        for (let trial = 0; trial < TRIALS; trial += 1) {
            const folder = `viewed-${String(trial)}`;
            const others = [...Array(CHURN).keys()].map(
                (index) => `${folder}-other-${String(index)}`,
            );
            for (const path of [folder, ...others]) await mkdir(join(gym.workspacePath, path));
            await gym.client.getFileTree(workspaceId, { limit: 1, path: folder });
            const before = new Set((await gym.events()).map((event) => event.cursor));
            const created = `${folder}/created.txt`;
            await writeFile(join(gym.workspacePath, created), "created\n");
            await Promise.all(
                others.map(
                    async (path) => await gym.client.getFileTree(workspaceId, { limit: 1, path }),
                ),
            );
            const reported = await gym
                .waitForEvent(
                    (event) =>
                        !before.has(event.cursor) &&
                        event.type === "files.updated" &&
                        event.payload.workspaceId === workspaceId &&
                        (event.payload.paths === null || event.payload.paths.includes(created)),
                    `files.updated for ${created}`,
                    3_000,
                )
                .then(
                    () => true,
                    () => false,
                );
            if (!reported) missed.push(created);
        }
        expect(missed).toEqual([]);
    }, 180_000);
});

async function root(gym: AgentGym): Promise<string> {
    const projects = await gym.client.listProjects();
    const project = projects.projects.find(
        (candidate) =>
            candidate.compute.type === "host" && candidate.compute.path === gym.workspacePath,
    );
    if (project === undefined) throw new Error("The gym root project was not registered.");
    return project.id;
}
