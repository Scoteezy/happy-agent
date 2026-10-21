import { mkdirSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { readDaemonPid } from "./daemonPid.js";

/**
 * Names the one daemon process whose next exit is intentional, however it ends.
 *
 * A daemon asked to stop exits cleanly, but a stop can still end in a forced kill: a caller that
 * gives up waiting, or `happy-agent kill`. The crash supervisor cannot tell such a kill from a
 * crash by its exit status alone, so whoever begins an intentional stop records the daemon's PID
 * here first. The record is keyed by PID, so a stale one never suppresses a later daemon's restart.
 */
export function daemonStopIntentPath(directory: string): string {
    return join(directory, "stop-intent");
}

/**
 * Record that this daemon process is being stopped on purpose.
 *
 * The write is synchronous so it lands before the caller yields: a stop can be followed by a
 * kill at any moment. A few bytes written in place are never seen half-written in practice, and a
 * record that cannot be read only means the exit is judged by its status.
 */
export function recordDaemonStopIntent(directory: string, pid: number): void {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    writeFileSync(daemonStopIntentPath(directory), `${String(pid)}\n`, { mode: 0o600 });
}

/**
 * Whether a stop was recorded for exactly this process. A matching record is consumed, so it
 * describes only the exit it was written for.
 */
export async function consumeDaemonStopIntent(directory: string, pid: number): Promise<boolean> {
    const path = daemonStopIntentPath(directory);
    let recorded: number | undefined;
    try {
        recorded = await readDaemonPid(path);
    } catch {
        // An unreadable record states no intent; the exit is judged by its status alone.
        return false;
    }
    if (recorded !== pid) return false;
    await unlink(path).catch(() => undefined);
    return true;
}
