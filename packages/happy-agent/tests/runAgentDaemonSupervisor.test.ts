import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isDaemonProcessRunning } from "../sources/lifecycle/daemonPid.js";
import { readDaemonSupervisorState } from "../sources/lifecycle/daemonSupervisorState.js";
import { runAgentDaemonCommand } from "../sources/lifecycle/runAgentDaemonCommand.js";
import { runAgentDaemonSupervisor } from "../sources/lifecycle/runAgentDaemonSupervisor.js";
import {
    AGENT_DAEMON_SUPERVISE_ENVIRONMENT,
    type DaemonSupervisorPolicy,
} from "../sources/lifecycle/superviseAgentDaemon.js";

/**
 * A stand-in daemon: it counts its runs, records its PID where the real daemon does, and then
 * behaves as the run's mode says: `crash-once` kills itself with SIGKILL on the first run and
 * stays up afterwards, `crash` always exits with status 3, and `clean` exits with status 0.
 */
const FAKE_DAEMON = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HAPPY_HOME_DIR;
const runs = join(home, "runs");
const run = (existsSync(runs) ? Number(readFileSync(runs, "utf8")) : 0) + 1;
writeFileSync(runs, String(run));
writeFileSync(join(home, "agent", "daemon.pid"), process.pid + "\\n", { mode: 0o600 });
if (process.env.${AGENT_DAEMON_SUPERVISE_ENVIRONMENT} !== undefined) {
    writeFileSync(join(home, "inherited-supervise"), "1");
}
const mode = process.env.FAKE_DAEMON_MODE;
if (mode === "clean") process.exit(0);
if (mode === "crash") process.exit(3);
if (run === 1) process.kill(process.pid, "SIGKILL");
setInterval(() => undefined, 1_000);
`;

const POLICY = {
    initialBackoffMs: 20,
    maxBackoffMs: 50,
    stableUptimeMs: 60_000,
    maxQuickFailures: 3,
};

let happyHome: string;
let script: string;
const stops: AbortController[] = [];

beforeEach(async () => {
    happyHome = await mkdtemp(join(tmpdir(), "happy-agent-supervisor-"));
    await mkdir(join(happyHome, "agent"), { mode: 0o700 });
    script = join(happyHome, "fake-daemon.mjs");
    await writeFile(script, FAKE_DAEMON);
    vi.stubEnv("HAPPY_HOME_DIR", happyHome);
    vi.stubEnv(AGENT_DAEMON_SUPERVISE_ENVIRONMENT, "1");
});

afterEach(async () => {
    for (const stop of stops.splice(0)) stop.abort();
    const pid = await readFile(join(happyHome, "agent", "daemon.pid"), "utf8").catch(() => "");
    if (/^\d+/.test(pid)) {
        try {
            process.kill(Number(pid), "SIGKILL");
        } catch {
            // Already gone.
        }
    }
    vi.unstubAllEnvs();
    await rm(happyHome, { force: true, recursive: true });
});

function supervise(mode: "clean" | "crash" | "crash-once"): Promise<number> {
    vi.stubEnv("FAKE_DAEMON_MODE", mode);
    const stop = new AbortController();
    stops.push(stop);
    return runAgentDaemonSupervisor({
        command: { executable: process.execPath, arguments: [script] },
        policy: POLICY,
        stopSignal: stop.signal,
    });
}

async function superviseProcess(mode: "crash" | "crash-once", policy: DaemonSupervisorPolicy) {
    const supervisorScript = join(happyHome, "supervisor.mts");
    const source = fileURLToPath(
        new URL("../sources/lifecycle/runAgentDaemonSupervisor.ts", import.meta.url),
    );
    await writeFile(
        supervisorScript,
        `import { runAgentDaemonSupervisor } from ${JSON.stringify(source)};
process.exit(await runAgentDaemonSupervisor({
    command: { executable: process.execPath, arguments: [${JSON.stringify(script)}] },
    policy: ${JSON.stringify(policy)},
}));
`,
    );
    const supervisor = spawn(process.execPath, ["--import", "tsx", supervisorScript], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, FAKE_DAEMON_MODE: mode },
        stdio: "ignore",
    });
    return { supervisor, exited: once(supervisor, "exit") };
}

async function runs(): Promise<number> {
    return Number(await readFile(join(happyHome, "runs"), "utf8").catch(() => "0"));
}

function supervisorState() {
    return readDaemonSupervisorState(join(happyHome, "agent", "supervisor.json"));
}

describe.skipIf(process.platform === "win32")("runAgentDaemonSupervisor", () => {
    it("restarts a crashed daemon, and happy-agent kill then stops it for good", async () => {
        const { supervisor, exited } = await superviseProcess("crash-once", POLICY);

        try {
            await expect.poll(runs, { timeout: 10_000 }).toBe(2);
            await expect
                .poll(async () => (await supervisorState())?.phase, { timeout: 10_000 })
                .toBe("running");
            const state = await supervisorState();
            expect(state).toMatchObject({
                supervisorPid: supervisor.pid,
                restarts: 1,
                lastExit: { code: null, signal: "SIGKILL" },
            });
            expect((await stat(join(happyHome, "agent", "supervisor.json"))).mode & 0o777).toBe(
                0o600,
            );
            // The daemon never sees the variable that made its parent a supervisor.
            await expect(stat(join(happyHome, "inherited-supervise"))).rejects.toMatchObject({
                code: "ENOENT",
            });

            const lines: string[] = [];
            await runAgentDaemonCommand("kill", { log: (line) => lines.push(line) });

            expect(lines).toEqual([`Daemon process ${String(state?.daemonPid)} was killed.`]);
            await expect(exited).resolves.toEqual([0, null]);
            expect(await runs()).toBe(2);
            expect(await isDaemonProcessRunning(state!.daemonPid!)).toBe(false);
            expect(await isDaemonProcessRunning(supervisor.pid!)).toBe(false);
            await expect(stat(join(happyHome, "agent", "stop-intent"))).rejects.toMatchObject({
                code: "ENOENT",
            });
            // Supervision ended on purpose, so nothing claims to be watching any more.
            expect(await supervisorState()).toBeUndefined();
        } finally {
            supervisor.kill("SIGKILL");
            await exited;
        }
    }, 30_000);

    it("lets a daemon that exits cleanly stay stopped", async () => {
        await expect(supervise("clean")).resolves.toBe(0);

        expect(await runs()).toBe(1);
        expect(await supervisorState()).toBeUndefined();
    });

    it("gives up on a crash loop and reports it through status", async () => {
        await expect(supervise("crash")).resolves.toBe(1);

        expect(await runs()).toBe(3);
        expect(await supervisorState()).toMatchObject({
            phase: "gave-up",
            quickFailures: 3,
            lastExit: { code: 3, signal: null },
        });
        const log = await readFile(join(happyHome, "agent", "daemon.log"), "utf8");
        expect(log).toContain("it will not be restarted");

        const lines: string[] = [];
        await runAgentDaemonCommand("status", { log: (line) => lines.push(line) });
        expect(lines).toContain(
            "The daemon stopped unexpectedly 3 times in a row soon after starting, so it was not restarted again.",
        );
        expect(lines).toContain("Run 'happy-agent start' to start it again.");
    });

    it("stop stands down a supervisor that is waiting to restart a crashed daemon", async () => {
        const { supervisor, exited } = await superviseProcess("crash", {
            initialBackoffMs: 60_000,
            maxBackoffMs: 60_000,
            stableUptimeMs: 60_000,
            maxQuickFailures: 5,
        });
        try {
            await expect
                .poll(async () => (await supervisorState())?.phase, { timeout: 20_000 })
                .toBe("restarting");
            expect(await supervisorState()).toMatchObject({ supervisorPid: supervisor.pid });

            const status: string[] = [];
            await runAgentDaemonCommand("status", { log: (line) => status.push(line) });
            expect(status[0]).toBe("Daemon is not running.");
            expect(status[1]).toMatch(
                /^The daemon stopped unexpectedly with exit code 3 and restarts at /,
            );

            const lines: string[] = [];
            await runAgentDaemonCommand("stop", { log: (line) => lines.push(line) });

            expect(lines).toEqual(["Daemon is not running."]);
            expect(await exited).toEqual([0, null]);
            expect(await runs()).toBe(1);
            expect(await supervisorState()).toBeUndefined();
        } finally {
            supervisor.kill("SIGKILL");
            await exited;
        }
    }, 30_000);
});
