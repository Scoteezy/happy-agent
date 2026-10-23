import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertWindowsSystemImports } from "./assertWindowsSystemImports.mjs";

if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("This native file-index verification requires Windows x64.");
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binary = resolve(process.argv[2] ?? join(packageRoot, "native/target/win32-x64/fff_c.dll"));
const imports = assertWindowsSystemImports(binary);
const sdkRoot = dirname(
    await realpath(
        join(packageRoot, "../happy-agent-modules/node_modules/@ff-labs/fff-node/package.json"),
    ),
);
const sdkRequire = createRequire(join(sdkRoot, "package.json"));
const expectedVersion = JSON.parse(
    await readFile(join(packageRoot, "native/fff/source.json"), "utf8"),
).version;
assert.equal(
    JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")).version,
    expectedVersion,
);
const fixture = await mkdtemp(join(tmpdir(), "happy-native-fff-"));
let finder;
try {
    // Keep the actual installed SDK; adapt only its native resolver just as the
    // standalone builder does. No node_modules or running daemon is modified.
    const adapter = join(fixture, "sdk");
    await mkdir(adapter);
    await writeFile(join(adapter, "package.json"), '{"type":"module"}');
    const replaceOnce = (source, search, replacement) => {
        assert.equal(source.split(search).length, 2, `Expected one ${JSON.stringify(search)}.`);
        return source.replace(search, replacement);
    };
    // fff ships one bundle, so its resolver is rewritten in place rather than replaced as a file.
    const entry = join(adapter, "index.js");
    await writeFile(
        entry,
        replaceOnce(
            replaceOnce(
                await readFile(join(sdkRoot, "dist/index.js"), "utf8"),
                "function findBinary() {\n",
                `function findBinary() {\n  return ${JSON.stringify(binary)};\n`,
            ),
            'from "ffi-rs"',
            `from ${JSON.stringify(pathToFileURL(sdkRequire.resolve("ffi-rs")).href)}`,
        ),
    );
    const { FileFinder } = await import(pathToFileURL(entry).href);
    const workspace = join(fixture, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    execFileSync("git", ["init", "--quiet", workspace], { windowsHide: true });
    await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
    await writeFile(join(workspace, "ignored.txt"), "IGNORED\n");
    await writeFile(join(workspace, "src", "hello-世界.txt"), "HAPPY_NATIVE_FFF_OK\n");
    await writeFile(join(workspace, "src", "main.ts"), "export const value = 42;\n");
    const value = (result) => {
        assert.equal(result.ok, true, result.error);
        return result.value;
    };
    for (let round = 0; round < 2; round++) {
        finder = value(
            FileFinder.create({
                basePath: workspace,
                disableMmapCache: true,
                disableContentIndexing: true,
                disableWatch: true,
                aiMode: true,
            }),
        );
        assert.equal(value(await finder.waitForScan(15000)), true);
        const search = value(finder.fileSearch("main.ts", { pageSize: 20 }));
        assert.ok(
            search.items.some((item) => item.relativePath.replaceAll("\\", "/") === "src/main.ts"),
        );
        const glob = value(finder.glob("**/*.txt", { pageSize: 20 }));
        assert.deepEqual(
            glob.items.map((item) => item.relativePath.replaceAll("\\", "/")),
            ["src/hello-世界.txt"],
        );
        const grep = value(finder.grep("HAPPY_NATIVE_FFF_OK", { mode: "plain" }));
        assert.ok(
            grep.items.some(
                (item) => item.lineContent === "HAPPY_NATIVE_FFF_OK" && item.lineNumber === 1,
            ),
        );
        await writeFile(join(workspace, "src", "added.txt"), "ADDED\n");
        value(finder.scanFiles());
        assert.equal(value(await finder.waitForScan(15000)), true);
        assert.ok(
            value(finder.fileSearch("added.txt")).items.some(
                (item) => item.fileName === "added.txt",
            ),
        );
        await rm(join(workspace, "src", "added.txt"));
        finder.destroy();
        assert.equal(finder.isDestroyed, true);
        finder = undefined;
    }
    // The library stays loaded until the process exits, as it does in the daemon, which never
    // unloads it. Unloading fff_c.dll before exit makes Bun 1.4.4 on Windows crash during exit
    // with an access violation about once in twelve runs, after every check has passed.
    await rename(workspace, workspace + "-closed");
    console.log(
        JSON.stringify({
            result: "PASS",
            runtime: globalThis.Bun ? "Bun " + Bun.version : "Node " + process.version,
            binarySha256: createHash("sha256")
                .update(await readFile(binary))
                .digest("hex"),
            imports,
            checks: [
                "scan",
                "Unicode",
                "fuzzy search",
                "glob",
                "gitignore",
                "grep",
                "file change",
                "destroy/reopen",
                "immediate rename",
            ],
        }),
    );
} finally {
    finder?.destroy();
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
    assert.ok(fixture.includes("happy-native-fff-"));
    await rm(fixture, { recursive: true, force: true });
}
