import { Monty, type MontyOptions, findMontyBinary } from "@pydantic/monty/node";

import { createCpuLimitedExecutable } from "../utils/createCpuLimitedExecutable.js";

/** Shared native-interpreter safety boundary for workflows and Code Mode. */
export async function createMontyPool(options: MontyOptions, cpuLimitSeconds = 60): Promise<Monty> {
    // Native request watchdogs live in the harness and disappear if it is killed. The kernel
    // independently limits each worker to 60 CPU seconds, comfortably above the longest normal
    // request watchdog (31 wall seconds). Idle and external-call wait time consume no CPU budget.
    const executable = await createCpuLimitedExecutable(
        findMontyBinary(options.binaryPath),
        cpuLimitSeconds,
    );
    try {
        const pool = await Monty.create({
            ...options,
            binaryPath: executable.path,
            // A checkpoint restored after an external call must get a fresh kernel budget too.
            ...(process.platform === "win32" ? {} : { maxCheckoutsPerWorker: 1 }),
        });
        const close = pool.close.bind(pool);
        pool.close = async () => {
            await close();
            await executable.close();
        };
        return pool;
    } catch (error) {
        await executable.close();
        throw error;
    }
}
