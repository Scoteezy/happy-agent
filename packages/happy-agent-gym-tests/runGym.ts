import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { pinnedBunVersion } from "../../scripts/pinnedBunVersion.js";
import { nodeLaneModuleTests, nodeLaneScenarios, nodeOnlyScenarios } from "./nodeLane.js";

// Every scenario runs on the pinned Bun, the runtime Happy Agent ships on; the Node lane then runs
// its deliberate selection under Node. `--lane=bun` or `--lane=node` runs only one of them. Other
// arguments go to every gym Vitest run.
const root = dirname(fileURLToPath(import.meta.url));
const modulesRoot = join(root, "../happy-agent-modules");
const vitestEntry = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
const modulesVitestEntry = createRequire(join(modulesRoot, "package.json")).resolve(
    "vitest/vitest.mjs",
);
const testDirectory = join(root, "tests");
const timingSensitiveTests = new Set([
    "active_run_finishes_after_daemon_restart.test.ts",
    "happy_api_chaos_catalog.test.ts",
    "happy_api_chaos_files.test.ts",
    "happy_api_chaos_recovery.test.ts",
    "happy_api_chaos_runs.test.ts",
    "happy_api_chaos_runtime.test.ts",
    "happy_api_chaos_sync.test.ts",
]);
const isolatedChaosSeeds = new Map<string, readonly string[]>([
    ["happy_api_chaos_catalog.test.ts", namedSeeds("C", 24)],
    ["happy_api_chaos_files.test.ts", namedSeeds("F", 16)],
    ["happy_api_chaos_recovery.test.ts", namedSeeds("X", 20)],
    ["happy_api_chaos_runs.test.ts", namedSeeds("R", 20)],
    ["happy_api_chaos_runtime.test.ts", namedSeeds("T", 12)],
    ["happy_api_chaos_sync.test.ts", namedSeeds("S", 28)],
]);

const laneArgument = process.argv.slice(2).find((argument) => argument.startsWith("--lane="));
const lane = laneArgument?.slice("--lane=".length) ?? "all";
if (lane !== "all" && lane !== "bun" && lane !== "node") {
    throw new Error(`--lane must be "bun" or "node", not "${lane}".`);
}
const vitestArguments = process.argv.slice(2).filter((argument) => argument !== laneArgument);
const pinned = pinnedBunVersion();
if (process.versions.bun !== pinned) {
    throw new Error(
        `The gym runner needs the pinned Bun ${pinned}; run it with \`pnpm test:gym\`.`,
    );
}

const tests = readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => ({ name, path: join("tests", name) }));
for (const name of [...nodeLaneScenarios, ...nodeOnlyScenarios]) {
    if (!tests.some((test) => test.name === name)) {
        throw new Error(`The Node lane names ${name}, which is not a gym scenario.`);
    }
}

const results: Awaited<ReturnType<typeof runTests>>[] = [];
if (lane !== "node") {
    const bunTests = tests.filter((test) => !nodeOnlyScenarios.includes(test.name));
    process.stdout.write(`Running ${String(bunTests.length)} gym test files on Bun ${pinned}.\n`);
    results.push(
        await runTests(
            "ordinary",
            bunTests
                .filter((test) => !timingSensitiveTests.has(test.name))
                .map((test) => test.path),
            3,
        ),
    );
    for (const test of bunTests.filter((candidate) => timingSensitiveTests.has(candidate.name))) {
        results.push(...(await runTimingSensitiveTest(test)));
    }
}
if (lane !== "bun") {
    const node = nodeExecutable();
    const scenarios = [...nodeLaneScenarios, ...nodeOnlyScenarios];
    process.stdout.write(
        `Running the Node lane on ${node}: ${String(scenarios.length)} gym test files and ` +
            `${nodeLaneModuleTests.join(", ")} in @slopus/happy-agent-modules.\n`,
    );
    results.push(
        await runTests(
            "Node lane",
            scenarios.map((name) => join("tests", name)),
            3,
            { HAPPY_GYM_RUNTIME: "node" },
            node,
        ),
    );
    results.push(
        await runVitest(node, [modulesVitestEntry, "run", ...nodeLaneModuleTests], modulesRoot, {}),
    );
}

for (const result of results) {
    if (result.error !== undefined) throw result.error;
}
process.exit(results.every((result) => result.status === 0) ? 0 : 1);

function runTests(
    label: string,
    paths: readonly string[],
    workers: number,
    additionalEnvironment: Readonly<Record<string, string>> = {},
    node?: string,
): Promise<{ error?: Error; status: number | null }> {
    process.stdout.write(
        `Running ${String(paths.length)} ${label} gym test files with ${String(workers)} workers.\n`,
    );
    if (paths.length === 0) return Promise.resolve({ status: 0 });
    const args = [
        vitestEntry,
        "run",
        `--maxWorkers=${String(workers)}`,
        "--testTimeout=120000",
        ...paths,
        ...vitestArguments,
    ];
    return node === undefined
        ? runVitest(process.execPath, ["--bun", ...args], root, {
              HAPPY_GYM_RUNTIME: "bun",
              ...additionalEnvironment,
          })
        : runVitest(node, args, root, additionalEnvironment);
}

function runVitest(
    command: string,
    args: readonly string[],
    cwd: string,
    additionalEnvironment: Readonly<Record<string, string>>,
): Promise<{ error?: Error; status: number | null }> {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            env: { ...process.env, ...additionalEnvironment },
            stdio: "inherit",
            windowsHide: true,
        });
        let error: Error | undefined;
        child.once("error", (cause) => {
            error = cause;
        });
        child.once("close", (status) => {
            resolve({ ...(error === undefined ? {} : { error }), status });
        });
    });
}

async function runTimingSensitiveTest(test: {
    readonly name: string;
    readonly path: string;
}): Promise<Awaited<ReturnType<typeof runTests>>[]> {
    const seeds = isolatedChaosSeeds.get(test.name);
    if (seeds === undefined)
        return [await runTests(`timing-sensitive ${test.name}`, [test.path], 1)];
    const results: Awaited<ReturnType<typeof runTests>>[] = [];
    for (const seed of seeds) {
        results.push(
            await runTests(`timing-sensitive ${test.name} seed=${seed}`, [test.path], 1, {
                API_CHAOS_SEED: seed,
            }),
        );
    }
    return results;
}

/** The Node that runs the Node lane: `HAPPY_GYM_NODE`, else `node` on the path, proven not Bun. */
function nodeExecutable(): string {
    const node = process.env.HAPPY_GYM_NODE ?? "node";
    const probe = spawnSync(node, ["-p", "process.versions.bun ? 'bun' : 'node'"], {
        encoding: "utf8",
    });
    if (probe.error !== undefined || probe.status !== 0) {
        throw new Error(`The Node lane could not start ${node}.`, { cause: probe.error });
    }
    if (probe.stdout.trim() !== "node") {
        throw new Error(`The Node lane needs Node, but ${node} is Bun.`);
    }
    return node;
}

function namedSeeds(prefix: string, count: number): readonly string[] {
    return Array.from(
        { length: count },
        (_, index) => `${prefix}${String(index).padStart(3, "0")}`,
    );
}
