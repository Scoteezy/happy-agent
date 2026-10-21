import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { isDaemonProcessRunning } from "../sources/lifecycle/daemonPid.js";
import { superviseSpawnedDaemon } from "../sources/lifecycle/ensureAgentDaemon.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

it.skipIf(process.platform === "win32")(
    "a start that times out stops the crash supervisor and the stalled daemon under it",
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-agent-start-timeout-"));
        temporaryDirectories.push(directory);
        const daemonPidPath = join(directory, "daemon.pid");
        // The supervisor ignores SIGTERM aimed at it alone and runs a stalled daemon child.
        const supervisor = spawn(
            "/bin/sh",
            ["-c", `trap '' TERM; sleep 60 & echo $! > ${JSON.stringify(daemonPidPath)}; wait`],
            { detached: true, stdio: "ignore" },
        );
        let daemonPid: number | undefined;
        await expect
            .poll(async () => {
                daemonPid = Number(await readFile(daemonPidPath, "utf8").catch(() => "0"));
                return daemonPid > 0;
            })
            .toBe(true);

        await expect(
            superviseSpawnedDaemon(supervisor, new Promise<never>(() => undefined), 100),
        ).rejects.toThrow("Timed out while starting the local daemon.");

        await expect.poll(async () => await isDaemonProcessRunning(daemonPid!)).toBe(false);
        expect(supervisor.exitCode !== null || supervisor.signalCode !== null).toBe(true);
    },
);
