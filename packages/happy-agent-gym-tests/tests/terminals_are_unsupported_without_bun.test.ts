import { HappyAgentApiError } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

// Happy Agent opens terminals only on Bun, the runtime it ships on. A daemon running from sources
// under Node must say so plainly instead of failing with an internal error. This scenario belongs
// to the gym's Node lane.
if (process.versions.bun !== undefined) {
    throw new Error("This scenario proves Node behavior; it runs in the gym's Node lane.");
}

it("answers 501 unsupported with a readable reason and leaves no terminal behind", async () => {
    const gym = await createAgentGym();
    try {
        const workspaceId = await readyRoot(gym);
        const failure = await gym.client
            .openTerminal(workspaceId, { command: "exit 0" })
            .then(() => undefined)
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(HappyAgentApiError);
        const apiError = failure as HappyAgentApiError;
        expect(apiError.status).toBe(501);
        expect(apiError.code).toBe("unsupported");
        expect(apiError.body?.error).toMatch(/Bun/u);
        expect((await gym.client.listTerminals(workspaceId)).terminals).toEqual([]);
        // The same client keeps working after the refusal.
        expect((await gym.client.listProjects()).projects.map((project) => project.id)).toContain(
            workspaceId,
        );
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
    }
});

async function readyRoot(gym: AgentGym): Promise<string> {
    return await gym.waitUntil(async () => {
        const { projects } = await gym.client.listProjects();
        return projects.find(
            (item) => item.status === "active" && item.initialization.status === "ready",
        )?.id;
    }, "the root project to become ready");
}
