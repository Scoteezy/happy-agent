import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const moduleUrl = new URL("../../happy-agent-modules/sources/monty/index.ts", import.meta.url).href;
if (process.platform === "win32") {
    console.log("IPC owner hang-up verification applies to the macOS and Linux worker patch.");
    process.exit(0);
}
const key = `${process.platform}-${process.arch}`;
const binaryPath = resolve(
    process.argv[2] ?? resolve(root, "../happy-agent-modules/native/target", key, "monty"),
);
let workerPid;
let ownerError = "";
const owner = spawn(
    process.execPath,
    [
        ...(process.versions.bun === undefined ? ["--import", "tsx"] : []),
        "--input-type=module",
        "-e",
        `
        import { createMontyPool } from ${JSON.stringify(moduleUrl)};
        const pool = await createMontyPool({
            ${process.argv[2] === undefined ? "" : `binaryPath: ${JSON.stringify(binaryPath)},`}
            minProcesses: 0, maxProcesses: 1, requestTimeout: 60,
        });
        const session = await pool.checkout();
        if (!Number.isSafeInteger(session.workerPid)) throw new Error("Missing worker PID.");
        console.log("worker:" + session.workerPid);
        // The test must own the cleanup PID before Python can enter a runaway loop.
        await new Promise(resolve => process.stdin.once("data", resolve));
        let reported = false;
        await session.feedRun("print('running')\\nwhile True:\\n    pass", {
            printCallback: () => {
                if (!reported) { reported = true; console.log("running"); }
            },
        });
        `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
);
owner.stderr.on("data", (chunk) => {
    ownerError = (ownerError + chunk).slice(-4_096);
});
try {
    await new Promise((resolveStarted, reject) => {
        let output = "";
        let requestedRun = false;
        const deadline = setTimeout(
            () => reject(new Error(`No running worker: ${ownerError}`)),
            10_000,
        );
        owner.once("exit", () => {
            clearTimeout(deadline);
            reject(new Error(`Owner exited before running Python: ${ownerError}`));
        });
        owner.stdout.on("data", (chunk) => {
            output = (output + chunk).slice(-4_096);
            const match = /^worker:(\d+)$/m.exec(output);
            if (match !== null && !requestedRun) {
                workerPid = Number(match[1]);
                requestedRun = true;
                owner.stdin.write("run\n");
            }
            if (!/^running$/m.test(output)) return;
            clearTimeout(deadline);
            resolveStarted();
        });
    });
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1, ownerError);
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    const deadline = performance.now() + 2_000;
    for (;;) {
        try {
            process.kill(workerPid, 0);
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
            workerPid = undefined;
            break;
        }
        assert.ok(performance.now() < deadline, "Busy Monty worker survived its owner's death.");
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 10));
    }
    console.log("PASS busy native worker exits promptly when its owner is SIGKILLed.");
} finally {
    owner.kill("SIGKILL");
    if (workerPid !== undefined) {
        try {
            process.kill(workerPid, "SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    }
}
