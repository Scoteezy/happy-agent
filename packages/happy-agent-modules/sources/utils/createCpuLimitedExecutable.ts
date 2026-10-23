import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An exec-only POSIX launcher: the kernel limit survives the caller's death. */
export async function createCpuLimitedExecutable(binary: string, seconds: number) {
    if (!Number.isSafeInteger(seconds) || seconds < 1) {
        throw new Error("The process CPU limit must be a positive whole number of seconds.");
    }
    if (process.platform === "win32") {
        return { path: binary, close: async () => undefined };
    }
    const directory = await mkdtemp(join(tmpdir(), "happy-cpu-limit-"));
    const path = join(directory, "run");
    const close = async () => await rm(directory, { recursive: true, force: true });
    try {
        // `exec` preserves the worker PID, so the pool's own timeout still kills the worker.
        // Set both limits: a soft limit alone can be caught and would not be a backstop.
        await writeFile(
            path,
            `#!/bin/sh\nulimit -S -t ${seconds} && ulimit -H -t ${seconds} || exit 125\nexec '${binary.replaceAll("'", "'\\''")}' "$@"\n`,
            {
                flag: "wx",
                mode: 0o700,
            },
        );
        return { path, close };
    } catch (error) {
        await close();
        throw error;
    }
}
