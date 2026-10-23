import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

const rootSchema = Type.Object({
    root: Type.String({ minLength: 1 }),
    workspacePath: Type.String({ minLength: 1 }),
});
type OwnerRoot = Static<typeof rootSchema>;

function readWorkerIdentity(pid: number): string | undefined {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm=,lstart="], {
        encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status === 1) return undefined;
    if (result.status !== 0)
        throw new Error(`Could not identify the test worker: ${result.stderr}`);
    return result.stdout.trim() || undefined;
}

function workerCpuSeconds(pid: number): number {
    const time = execFileSync("/bin/ps", ["-p", String(pid), "-o", "time="], {
        encoding: "utf8",
    });
    return time
        .trim()
        .split(":")
        .reduce((total, part) => total * 60 + Number(part), 0);
}

describe.skipIf(process.platform === "win32")("Monty worker ownership", () => {
    it("ends busy Python when its real Code Mode daemon is killed", async () => {
        const fixture = resolve(import.meta.dirname, "fixtures/montyOwnerGym.ts");
        const scratch = resolve(
            process.env.HAPPY_AGENT_GYM_SCRATCH_DIRECTORY ??
                resolve(import.meta.dirname, "../../../.local"),
        );
        const owner = spawn(
            process.execPath,
            [
                ...(process.versions.bun === undefined
                    ? ["--import", createRequire(import.meta.url).resolve("tsx")]
                    : []),
                fixture,
            ],
            { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
        );
        let installation: OwnerRoot | undefined;
        let workerPid: number | undefined;
        let workerIdentity: string | undefined;
        let stdout = "";
        let stderr = "";
        let admitted = false;
        let startupError: unknown;
        owner.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-32_768);
        });
        owner.stdout.on("data", (chunk) => {
            stdout = (stdout + chunk).slice(-32_768);
            const root = /^gym-root:(.+)$/m.exec(stdout);
            if (root !== null && !admitted) {
                try {
                    const parsed: unknown = JSON.parse(root[1]!);
                    installation = Value.Decode(rootSchema, parsed);
                    admitted = true;
                    owner.stdin.write("run\n");
                } catch (error) {
                    startupError = error;
                }
            }
        });
        try {
            await expect
                .poll(
                    async () => {
                        if (startupError !== undefined) throw startupError;
                        if (owner.exitCode !== null || owner.signalCode !== null) {
                            throw new Error(
                                `Throwaway daemon exited before Python started: ${stderr}`,
                            );
                        }
                        if (installation === undefined) return false;
                        return await readFile(
                            join(installation.workspacePath, "native-ready"),
                            "utf8",
                        ).then(
                            (value) => value === "ready",
                            () => false,
                        );
                    },
                    { timeout: 20_000, interval: 10 },
                )
                .toBe(true);
            // Observe only host process effects: the worker must be a direct child of this
            // fixture's daemon. No module, native pool or database state is inspected.
            const children = execFileSync(
                "/usr/bin/pgrep",
                ["-P", String(owner.pid), "-x", "monty"],
                {
                    encoding: "utf8",
                },
            );
            const workers = children.trim().split("\n").map(Number);
            expect(workers, `Native children of fixture ${owner.pid}: ${stderr}`).toHaveLength(1);
            workerPid = workers[0];
            expect(Number.isSafeInteger(workerPid)).toBe(true);
            workerIdentity = readWorkerIdentity(workerPid!);
            expect(workerIdentity).toBeDefined();
            // The worker is now known and owned even if a later startup assertion fails.
            await writeFile(join(installation!.workspacePath, "native-ack"), "continue");
            await expect
                .poll(() => /^gym-running:(.+)$/m.test(stdout), {
                    timeout: 2_000,
                    interval: 10,
                })
                .toBe(true);
            const initialCpu = workerCpuSeconds(workerPid!);
            await expect
                .poll(() => workerCpuSeconds(workerPid!) - initialCpu, {
                    timeout: 2_000,
                    interval: 10,
                })
                .toBeGreaterThan(0.2);

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
                    {
                        timeout: 2_000,
                        interval: 10,
                        message: "Busy native Python survived daemon death.",
                    },
                )
                .toBe(true);
            workerPid = undefined;
        } finally {
            if (owner.exitCode === null && owner.signalCode === null) {
                const exited = once(owner, "exit");
                owner.kill("SIGKILL");
                await exited;
            }
            if (
                workerPid !== undefined &&
                workerIdentity !== undefined &&
                readWorkerIdentity(workerPid) === workerIdentity
            ) {
                try {
                    process.kill(workerPid, "SIGKILL");
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
                }
            }
            if (installation !== undefined) {
                const runRoot = dirname(installation.root);
                const path = relative(scratch, runRoot);
                expect(path && !path.startsWith("..") && !isAbsolute(path)).toBeTruthy();
                await rm(runRoot, { force: true, recursive: true });
            }
        }
    }, 30_000);
});
