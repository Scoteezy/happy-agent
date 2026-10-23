import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMontyPool } from "../../sources/monty/index.js";
import { createCpuLimitedExecutable } from "../../sources/utils/createCpuLimitedExecutable.js";

function killTestWorker(pid: number): void {
    try {
        process.kill(pid, "SIGKILL");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
}

describe.skipIf(process.platform === "win32")("native interpreter CPU ownership", () => {
    it("keeps exec PID, quoted executable paths and arguments intact", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy monty ' quoting-"));
        const binary = join(directory, "node ' executable");
        await symlink(process.execPath, binary);
        const launcher = await createCpuLimitedExecutable(binary, 2);
        try {
            const child = spawn(launcher.path, [
                "-e",
                "console.log(JSON.stringify([process.pid, process.argv[1], require('node:child_process').execFileSync('/bin/sh', ['-c', 'ulimit -S -t; ulimit -H -t'], {encoding: 'utf8'})]))",
                "a ' quoted argument",
            ]);
            let output = "";
            child.stdout.on("data", (chunk) => {
                output += chunk;
            });
            const [code] = await once(child, "exit");
            expect(code).toBe(0);
            expect(JSON.parse(output)).toEqual([child.pid, "a ' quoted argument", "2\n2\n"]);
        } finally {
            await launcher.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("gives every checkout a fresh worker and retains the request watchdog", async () => {
        const pool = await createMontyPool({ minProcesses: 0, maxProcesses: 1, requestTimeout: 1 });
        let session = await pool.checkout();
        try {
            const firstPid = session.workerPid;
            expect(firstPid).toBeTypeOf("number");
            expect(await session.feedRun("1 + 1")).toBe(2);
            await session.close();
            session = await pool.checkout();
            expect(session.workerPid).not.toBe(firstPid);
            await expect(session.feedRun("while True:\n    pass")).rejects.toMatchObject({
                timedOut: true,
            });
        } finally {
            await session.close();
            await pool.close();
        }
    });

    it("kernel-kills in-flight Python even after its harness is SIGKILLed", async () => {
        const ownerTemp = await mkdtemp(join(tmpdir(), "happy-monty-owner-"));
        const moduleUrl = new URL("../../sources/monty/index.ts", import.meta.url).href;
        const owner = spawn(
            process.execPath,
            [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                `
            import { createMontyPool } from ${JSON.stringify(moduleUrl)};
            const pool = await createMontyPool({minProcesses:0,maxProcesses:1,requestTimeout:30}, 1);
            const session = await pool.checkout();
            const pid = session.workerPid;
            let reported = false;
            await session.feedRun("print('running')\\nwhile True:\\n    pass", {
                printCallback: () => {
                    if (!reported) { reported = true; console.log(pid); }
                },
            });
        `,
            ],
            { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: ownerTemp } },
        );
        let workerPid: number | undefined;
        let workerExited = false;
        let stderr = "";
        owner.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        try {
            const [chunk] = await once(owner.stdout, "data", {
                signal: AbortSignal.timeout(5_000),
            });
            workerPid = Number(String(chunk).trim());
            expect(workerPid, stderr).toBeGreaterThan(0);
            const exited = once(owner, "exit");
            owner.kill("SIGKILL");
            await exited;
            await expect
                .poll(
                    () => {
                        try {
                            process.kill(workerPid!, 0);
                            return false;
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
                            throw error;
                        }
                    },
                    { timeout: 5_000, interval: 25 },
                )
                .toBe(true);
            workerExited = true;
        } finally {
            owner.kill("SIGKILL");
            if (workerPid !== undefined && !workerExited) {
                killTestWorker(workerPid);
            }
            await rm(ownerTemp, { recursive: true, force: true });
        }
    }, 10_000);
});
