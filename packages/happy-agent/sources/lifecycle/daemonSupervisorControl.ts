import { isDaemonProcessRunning, waitForDaemonProcessExit } from "./daemonPid.js";
import { daemonProcessIdentity } from "./daemonProcessIdentity.js";
import {
    daemonSupervisorStatePath,
    describeDaemonExit,
    readDaemonSupervisorState,
    type DaemonSupervisorState,
} from "./daemonSupervisorState.js";

const SUPERVISOR_EXIT_TIMEOUT_MS = 5_000;

/** Whether the process that published this state is still that supervisor. */
export async function isDaemonSupervisorRunning(state: DaemonSupervisorState): Promise<boolean> {
    if (state.phase === "gave-up" || state.supervisorPid === process.pid) return false;
    if (!(await isDaemonProcessRunning(state.supervisorPid))) return false;
    if (state.supervisorIdentity === undefined) return true;
    const identity = await daemonProcessIdentity(state.supervisorPid).catch(() => undefined);
    return identity === state.supervisorIdentity;
}

/**
 * Tells a live crash supervisor to stop watching, so a daemon that is being killed, or that is
 * down between restarts, stays down. The supervisor exits without touching the daemon itself.
 * Returns the supervisor's PID when one was stood down.
 */
export async function standDownDaemonSupervisor(directory: string): Promise<number | undefined> {
    const state = await readDaemonSupervisorState(daemonSupervisorStatePath(directory)).catch(
        () => undefined,
    );
    if (state === undefined || !(await isDaemonSupervisorRunning(state))) return undefined;
    try {
        process.kill(state.supervisorPid, "SIGTERM");
    } catch {
        return undefined;
    }
    await waitForDaemonProcessExit(state.supervisorPid, SUPERVISOR_EXIT_TIMEOUT_MS);
    return state.supervisorPid;
}

/** Human-readable `status` lines about crash recovery; none when nothing is known. */
export async function describeDaemonSupervisor(
    directory: string,
    daemonResponding: boolean,
): Promise<string[]> {
    const state = await readDaemonSupervisorState(daemonSupervisorStatePath(directory)).catch(
        () => undefined,
    );
    if (state === undefined) return [];
    if (state.phase === "gave-up") {
        // A daemon started some other way since then makes this record history, not status.
        if (daemonResponding || state.lastExit === undefined) return [];
        return [
            `The daemon stopped unexpectedly ${String(state.quickFailures)} times in a row soon after starting, so it was not restarted again.`,
            `It last stopped with ${describeDaemonExit(state.lastExit)} at ${formatTime(state.lastExit.at)}.`,
            "Run 'happy-agent start' to start it again.",
        ];
    }
    if (!(await isDaemonSupervisorRunning(state))) return [];
    if (state.phase === "restarting" && state.lastExit !== undefined) {
        const restartAt =
            state.nextRestartAt === undefined ? "shortly" : `at ${formatTime(state.nextRestartAt)}`;
        return [
            `The daemon stopped unexpectedly with ${describeDaemonExit(state.lastExit)} and restarts ${restartAt}.`,
        ];
    }
    const lines = [
        `Crash recovery: the daemon restarts if it stops unexpectedly (supervisor PID ${String(state.supervisorPid)}).`,
    ];
    if (state.restarts > 0 && state.lastExit !== undefined) {
        lines.push(
            `It has restarted ${state.restarts === 1 ? "once" : `${String(state.restarts)} times`}; it last stopped with ${describeDaemonExit(state.lastExit)} at ${formatTime(state.lastExit.at)}.`,
        );
    }
    return lines;
}

function formatTime(iso: string): string {
    const time = new Date(iso);
    return Number.isNaN(time.getTime()) ? iso : time.toLocaleString();
}
