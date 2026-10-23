import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

// A project folder nested below its repository's top level is searched through Git's own
// listing, whose index still holds tracked files removed from disk. Its 20,000-file cap is covered
// by the files module's unit tests: writing that many files here floods the shared FSEvents
// stream and slows every other scenario's watches.
describe("file search in a folder nested inside a repository", () => {
    it("does not suggest a tracked file removed from disk", async () => {
        const gym = await fresh();
        await execFile("git", ["init", "--quiet", gym.workspacePath]);
        const directory = join(gym.workspacePath, "deleted-package");
        await mkdir(directory);
        await writeFile(join(directory, "deleted-search-target.ts"), "removed");
        await writeFile(join(directory, "present.ts"), "present");
        await execFile("git", [
            "-C",
            gym.workspacePath,
            "add",
            "deleted-package/deleted-search-target.ts",
        ]);
        await rm(join(directory, "deleted-search-target.ts"));
        const projectId = await register(gym, directory);

        const removed = await gym.client.searchFiles(projectId, {
            limit: 10,
            query: "deleted-search-target",
        });
        const present = await gym.client.searchFiles(projectId, { limit: 10, query: "present" });

        expect(removed.files).toEqual([]);
        expect(present.files).toContainEqual({ fileName: "present.ts", path: "present.ts" });
    });
});

async function fresh(): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 30_000 });
    running.add(gym);
    return gym;
}

async function register(gym: AgentGym, path: string): Promise<string> {
    const { project } = await gym.client.registerProject({ path });
    await gym.waitUntil(async () => {
        const current = (await gym.client.getProject(project.id)).project;
        return current.initialization.status === "ready" ? true : undefined;
    }, "the nested project to become ready");
    return project.id;
}
