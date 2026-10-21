import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const MAX_STATE_BYTES = 64 * 1024;

const daemonExitSchema = Type.Object(
    {
        /** When the daemon process exited, as an ISO 8601 timestamp. */
        at: Type.String({ minLength: 1, maxLength: 64 }),
        code: Type.Union([Type.Integer(), Type.Null()]),
        signal: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
        /** How long the process had run before it exited. */
        uptimeMs: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type DaemonExit = Static<typeof daemonExitSchema>;

const daemonSupervisorStateSchema = Type.Object(
    {
        version: Type.Literal(1),
        instance: Type.String({ minLength: 1, maxLength: 128 }),
        supervisorPid: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
        /** The supervisor's own process identity, so a reused PID is never mistaken for it. */
        supervisorIdentity: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
        /**
         * `running`: a daemon process is up. `restarting`: the daemon exited unexpectedly and a
         * replacement starts at `nextRestartAt`. `gave-up`: the daemon kept exiting unexpectedly
         * soon after starting, so the supervisor stopped restarting it and exited.
         */
        phase: Type.Union([
            Type.Literal("running"),
            Type.Literal("restarting"),
            Type.Literal("gave-up"),
        ]),
        daemonPid: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
        /** Every unexpected exit this supervisor restarted after. */
        restarts: Type.Integer({ minimum: 0 }),
        /** Consecutive unexpected exits that each came soon after their start. */
        quickFailures: Type.Integer({ minimum: 0 }),
        lastExit: Type.Optional(daemonExitSchema),
        nextRestartAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        updatedAt: Type.String({ minLength: 1, maxLength: 64 }),
    },
    { additionalProperties: false },
);
export type DaemonSupervisorState = Static<typeof daemonSupervisorStateSchema>;

/** Where the crash supervisor publishes what it is doing, `<happyHome>/agent/supervisor.json`. */
export function daemonSupervisorStatePath(directory: string): string {
    return join(directory, "supervisor.json");
}

/** The published supervisor state, or undefined when no supervisor has left one. */
export async function readDaemonSupervisorState(
    path: string,
): Promise<DaemonSupervisorState | undefined> {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (
            !stat.isFile() ||
            stat.size > MAX_STATE_BYTES ||
            (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
        ) {
            throw new Error("The daemon supervisor status file is not a private, bounded file.");
        }
        const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_STATE_BYTES) {
            throw new Error("The daemon supervisor status file is too large.");
        }
        return Value.Parse(
            daemonSupervisorStateSchema,
            JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
        );
    } finally {
        await handle.close();
    }
}

/** Atomically replace the published state with a private snapshot. */
export async function writeDaemonSupervisorState(
    path: string,
    state: DaemonSupervisorState,
): Promise<void> {
    const contents = JSON.stringify(Value.Parse(daemonSupervisorStateSchema, state));
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
        await rename(temporaryPath, path);
    } finally {
        await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}

/** Remove the published state only while it still belongs to this supervisor. */
export async function removeDaemonSupervisorState(path: string, instance: string): Promise<void> {
    try {
        if ((await lstat(path)).isSymbolicLink()) return;
        if ((await readDaemonSupervisorState(path))?.instance === instance) await unlink(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

/** A daemon exit in words, such as "signal SIGTRAP" or "exit code 1". */
export function describeDaemonExit(exit: Pick<DaemonExit, "code" | "signal">): string {
    if (exit.signal !== null) return `signal ${exit.signal}`;
    if (exit.code !== null) return `exit code ${String(exit.code)}`;
    return "an unknown status";
}
