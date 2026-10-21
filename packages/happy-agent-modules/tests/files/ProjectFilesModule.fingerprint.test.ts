import { mkdir, mkdtemp, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
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

/** A whole second, so putting a file's modification time back restores it exactly. */
const WRITTEN_AT = 1_700_000_000;

/** Same size as "before", written with the modification time put back, as cp -p leaves a file. */
function rewriteKeepingTime(fs: typeof import("node:fs"), path: string): void {
    fs.writeFileSync(path, "BEFORE", "utf8");
    fs.utimesSync(path, WRITTEN_AT, WRITTEN_AT);
}

async function writeBefore(path: string): Promise<void> {
    await writeFile(path, "before", "utf8");
    await utimes(path, WRITTEN_AT, WRITTEN_AT);
}

/** Watches made of files whose name says to fail them, and whether each file's watch was made. */
const platform = vi.hoisted(() => ({
    failing: [] as import("node:fs").FSWatcher[],
    watched: new Set<string>(),
}));

// Every directory watch is inert, as the shared macOS stream is while other watches restart it,
// so only a rendered file's own watch and fingerprint can report its change.
vi.mock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const { EventEmitter } = await import("node:events");
    let comparedAt: string | undefined;
    const lstatSync = ((path: unknown, ...rest: unknown[]) => {
        const stat = (original.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
        const target = String(path);
        // Changed just after the fingerprint taken once the watch was made: only a watch the
        // kernel already holds can see it.
        if (
            target.endsWith("compared.txt") &&
            platform.watched.has(target) &&
            comparedAt !== target
        ) {
            comparedAt = target;
            queueMicrotask(() => rewriteKeepingTime(original, target));
        }
        return stat;
    }) as typeof original.lstatSync;
    const watch = ((path: unknown, ...rest: unknown[]) => {
        const target = String(path);
        if (original.statSync(target).isDirectory()) {
            return Object.assign(new EventEmitter(), {
                close: () => undefined,
                ref: () => undefined,
                unref: () => undefined,
            });
        }
        // Changed after its bytes were read and before its watch exists.
        if (target.endsWith("raced.txt")) rewriteKeepingTime(original, target);
        const watcher = (original.watch as (...args: unknown[]) => unknown)(target, ...rest);
        platform.watched.add(target);
        if (target.endsWith("failing.txt") && platform.failing.length === 0) {
            platform.failing.push(watcher as import("node:fs").FSWatcher);
        }
        // Changed after its watch exists, before the kernel holds it.
        if (target.endsWith("armed.txt"))
            queueMicrotask(() => rewriteKeepingTime(original, target));
        return watcher;
    }) as typeof original.watch;
    return {
        ...original,
        default: { ...original, lstatSync, watch },
        lstatSync,
        watch,
    };
});

let directory: string;
let events: ProjectFilesEvent[];
let files: ProjectFilesModule;
let root: ProjectFileRoot;
let runners: RunnersModule;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "happy-agent-files-fingerprint-"));
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

function reported(): string[] {
    return [...new Set(events.flatMap((event) => event.paths ?? []))];
}

it("reports a rendered file changed between its read and its watch, even with its time put back", async () => {
    await writeBefore(join(directory, "raced.txt"));

    await files.read(root, { path: "raced.txt" });

    await vi.waitFor(() => expect(reported()).toEqual(["raced.txt"]));
});

it("reports a rendered file changed after its watch is made, before the kernel holds it", async () => {
    await writeBefore(join(directory, "armed.txt"));

    await files.read(root, { path: "armed.txt" });

    await vi.waitFor(() => expect(reported()).toEqual(["armed.txt"]));
});

it("watches the new file a re-read finds once its folder was moved and made again", async () => {
    await mkdir(join(directory, "docs"));
    await writeFile(join(directory, "docs", "note.txt"), "before", "utf8");
    await files.read(root, { path: "docs/note.txt" });

    await rename(join(directory, "docs"), join(directory, "docs-moved"));
    await mkdir(join(directory, "docs"));
    await writeFile(join(directory, "docs", "note.txt"), "again", "utf8");
    await files.read(root, { path: "docs/note.txt" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    events.length = 0;

    await writeFile(join(directory, "docs", "note.txt"), "edited", "utf8");

    await vi.waitFor(() => expect(reported()).toEqual(["docs/note.txt"]));
});

it("reports a rendered file changed just after its watch's own comparison", async () => {
    await writeBefore(join(directory, "compared.txt"));

    await files.read(root, { path: "compared.txt" });

    await vi.waitFor(() => expect(reported()).toEqual(["compared.txt"]));
});

it("reports a rendered file whose watch fails once, then watches it again on its re-read", async () => {
    await writeFile(join(directory, "failing.txt"), "before", "utf8");
    await files.read(root, { path: "failing.txt" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    platform.failing[0]?.emit("error", Object.assign(new Error("EMFILE"), { code: "EMFILE" }));
    await vi.waitFor(() => expect(events.filter((event) => event.paths === null)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(1);

    events.length = 0;
    await files.read(root, { path: "failing.txt" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(join(directory, "failing.txt"), "edited", "utf8");
    await vi.waitFor(() => expect(reported()).toEqual(["failing.txt"]));
    expect(events.every((event) => event.paths !== null)).toBe(true);
});
