import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("agent replies while a workspace folder is not made yet", () => {
    it("answers committed agent mutations and discovers skills once the folder exists", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Done.", type: "text" }] }],
        });
        running.add(gym);
        const projectId = (await gym.client.getAgent(gym.defaultSessionId)).agent.workspaceId;
        await gym.waitUntil(async () => {
            const project = (await gym.client.getProject(projectId)).project;
            return project.initialization.status === "ready" ? project : undefined;
        }, "the root project to become ready");
        const created = await gym.client.createWorkspace({ name: "Later", parentId: projectId });
        const workspace = await gym.waitUntil(async () => {
            const current = (await gym.client.getWorkspace(created.workspace.id)).workspace;
            if (current.initialization.status === "failed")
                throw new Error(current.initialization.error ?? "Workspace setup failed.");
            return current.initialization.status === "ready" ? current : undefined;
        }, "the workspace to become ready");
        if (workspace.compute.type !== "host") throw new Error("Expected a host workspace.");
        // The gate: the folder is absent, as while provisioning has not made it yet, so the
        // agent's machine cannot be built when a reply asks for its slash commands.
        const folder = workspace.compute.path;
        await rm(folder, { force: true, recursive: true });

        const agent = (await gym.client.createAgent({ workspaceId: workspace.id, title: "Early" }))
            .agent;
        const reordered = await gym.client.reorderAgent(agent.id, { afterId: null });
        expect(reordered.agent.id).toBe(agent.id);
        expect(reordered.slashCommands.map((command) => command.name)).not.toContain("greet");
        expect((await gym.client.getAgent(agent.id)).agent.id).toBe(agent.id);

        await mkdir(join(folder, ".agents", "skills", "greet"), { recursive: true });
        await writeFile(
            join(folder, ".agents", "skills", "greet", "SKILL.md"),
            "---\nname: greet\ndescription: Greets the person.\n---\n\nSay hello.\n",
        );
        await gym.send("Hello.", { sessionId: agent.id });
        const after = await gym.client.getAgent(agent.id);
        expect(after.slashCommands.map((command) => command.name)).toContain("greet");
        expect(gym.inference.unscripted).toEqual([]);
    });
});
