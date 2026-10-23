import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Deliberately opt-in: this spends at least 65 seconds of one worker's CPU time.
// Quick ownership checks live in verify-native-monty.mjs instead.
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(resolve(root, "../happy-agent-modules/package.json"));
const { Monty } = await import(pathToFileURL(require.resolve("@pydantic/monty/node")).href);
const key = `${process.platform}-${process.arch}`;
assert.notEqual(process.platform, "win32", "The former POSIX CPU cap did not apply on Windows.");
const binaryPath = resolve(
    process.argv[2] ?? resolve(root, "../happy-agent-modules/native/target", key, "monty"),
);
const pool = await Monty.create({
    binaryPath,
    minProcesses: 0,
    maxProcesses: 1,
    maxCheckoutsPerWorker: 100,
    requestTimeout: 6,
});
let session;
try {
    session = await pool.checkout({
        limits: { maxMemory: 32 * 1024 * 1024, maxRecursionDepth: 200 },
    });
    const pid = session.workerPid;
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    function cpuSeconds() {
        return execFileSync("/bin/ps", ["-p", String(pid), "-o", "time="], { encoding: "utf8" })
            .trim()
            .split(":")
            .reduce((total, part) => total * 60 + Number(part), 0);
    }
    const initialCpu = cpuSeconds();
    const deadline = performance.now() + 180_000;
    let nextSample = 0;
    let consumedCpu = 0;
    let callbacks = 0;
    const result = await session.feedRun(
        "import os\ncounter = 0\nwhile os.getenv('continue'):\n    for i in range(200000):\n        counter += i\ncounter",
        {
            os: (name) => {
                assert.equal(name, "os.getenv");
                callbacks += 1;
                assert.ok(
                    performance.now() < deadline,
                    "Worker did not complete its CPU allowance.",
                );
                if (performance.now() >= nextSample) {
                    consumedCpu = cpuSeconds() - initialCpu;
                    nextSample = performance.now() + 500;
                }
                return consumedCpu < 65 ? "continue" : undefined;
            },
        },
    );
    assert.ok(consumedCpu >= 65);
    assert.ok(callbacks > 2);
    assert.equal(
        await session.feedRun("counter"),
        result,
        "The long call must retain Python state.",
    );
    console.log(
        `PASS one live-owner Python call consumed ${consumedCpu.toFixed(2)} worker CPU seconds ` +
            `across ${callbacks} OS callbacks and retained state with the existing six-second request watchdog.`,
    );
} finally {
    await session?.close();
    await pool.close();
}
