import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { GitModule } from "../../sources/git/index.js";
import {
    ProjectFilesModule,
    type ProjectFileRoot,
    type ProjectFilesEvent,
} from "../../sources/files/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";

// A file the platform refuses to watch, as an exhausted FSEvents or inotify budget does.
vi.mock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const watch = ((path: unknown, ...rest: unknown[]) => {
        if (String(path).endsWith("unwatchable.txt")) {
            throw Object.assign(new Error("EMFILE: too many open files, watch"), {
                code: "EMFILE",
            });
        }
        return (original.watch as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof original.watch;
    return { ...original, default: { ...original, watch }, watch };
});

let directory: string;
let files: ProjectFilesModule;
let root: ProjectFileRoot;
let runners: RunnersModule;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "happy-agent-files-unwatchable-"));
    runners = new RunnersModule(await temporaryTestConfig());
    files = new ProjectFilesModule(
        {} as ProjectsModule,
        {} as WorkspacesModule,
        { invalidate: vi.fn(), markChanged: vi.fn() } as unknown as GitModule,
        runners,
    );
    root = { projectId: "project-1", root: await realpath(directory) };
});

afterEach(async () => {
    await files.close();
    await runners.close();
    await rm(directory, { force: true, recursive: true });
});

it("reports a rendered file it cannot watch as a change of unknown paths, once until it can", async () => {
    await writeFile(join(directory, "unwatchable.txt"), "content", "utf8");
    const events: ProjectFilesEvent[] = [];
    files.onEvent((_ctx, event) => {
        events.push(event);
    });

    await files.read(root, { path: "unwatchable.txt" });
    await vi.waitFor(() => expect(events.some((event) => event.paths === null)).toBe(true));

    // The client's re-read fails to watch it again, and is not reported again.
    const reported = events.length;
    await files.read(root, { path: "unwatchable.txt" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events.filter((event) => event.paths === null)).toHaveLength(1);
    expect(events).toHaveLength(reported);
});
