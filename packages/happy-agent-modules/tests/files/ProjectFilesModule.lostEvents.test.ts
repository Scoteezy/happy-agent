import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

// A directory watch that never reports anything, as when macOS's shared FSEvents stream is
// recreated around a change while other directory watches are added or closed.
vi.mock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const watch = (() =>
        Object.assign(new EventEmitter(), {
            close: () => undefined,
            unref: () => undefined,
        })) as unknown as typeof original.watch;
    return { ...original, default: { ...original, watch }, watch };
});

let directory: string;
let events: ProjectFilesEvent[];
let files: ProjectFilesModule;
let root: ProjectFileRoot;
let runners: RunnersModule;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "happy-agent-files-lost-events-"));
    await mkdir(join(directory, "viewed"));
    await mkdir(join(directory, "other"));
    runners = new RunnersModule(await temporaryTestConfig());
    files = new ProjectFilesModule(
        {} as ProjectsModule,
        {} as WorkspacesModule,
        { invalidate: vi.fn(), markChanged: vi.fn() } as unknown as GitModule,
        runners,
    );
    root = { projectId: "project-1", root: await realpath(directory) };
    events = [];
    files.onEvent((_ctx, event) => {
        events.push(event);
    });
});

afterEach(async () => {
    await files.close();
    await runners.close();
    await rm(directory, { force: true, recursive: true });
});

it("reports a create its watch lost once another folder is watched", async () => {
    await files.tree(root, { path: "viewed" });
    await writeFile(join(directory, "viewed", "created.txt"), "created");

    await files.tree(root, { path: "other" });

    await vi.waitFor(() =>
        expect(events.flatMap((event) => event.paths ?? [])).toContain("viewed/created.txt"),
    );
});

it("reports a create and a delete its watch lost when the folder is read again", async () => {
    await writeFile(join(directory, "viewed", "removed.txt"), "removed");
    await files.tree(root, { path: "viewed" });
    await writeFile(join(directory, "viewed", "created.txt"), "created");
    await rm(join(directory, "viewed", "removed.txt"));

    await files.tree(root, { path: "viewed" });

    await vi.waitFor(() =>
        expect(events.flatMap((event) => event.paths ?? []).sort()).toEqual([
            "viewed/created.txt",
            "viewed/removed.txt",
        ]),
    );
});

it("reports nothing for folders that did not change", async () => {
    await files.tree(root, { path: "viewed" });
    await files.tree(root, { path: "other" });
    await files.tree(root, { path: "viewed" });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toEqual([]);
});
