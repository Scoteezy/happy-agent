import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    orphanedMenuBarApps,
    reapOrphanedMenuBarApps,
} from "../../sources/menuBar/impl/reapOrphanedMenuBarApps.js";

const roots: string[] = [];
const leftovers: number[] = [];

afterEach(async () => {
    for (const pid of leftovers.splice(0)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const assets = "/var/folders/xy/T/happy-agent-501/binary-assets";
const current = `${assets}/menu-bar-new/happy-menu-bar`;

describe("orphanedMenuBarApps", () => {
    it("chooses only apps launchd adopted from this installation's menu bar directories", () => {
        const listing = [
            // An older release's app whose daemon is gone.
            `  101     1 ${assets}/menu-bar-old/happy-menu-bar`,
            // The running daemon's app: its parent is alive, so it is left alone.
            `  102   900 ${assets}/menu-bar-new/happy-menu-bar`,
            // An orphan of the current version, from a daemon that was killed outright.
            `  103     1 ${assets}/menu-bar-new/happy-menu-bar`,
            // Other orphans that only look similar.
            `  104     1 ${assets}/tailcat-abc/tailcat`,
            `  105     1 /Users/someone/dev/menu-bar-x/happy-menu-bar`,
            `  106     1 ${assets}/claude-abc/happy-menu-bar`,
            `  107     1 /var/folders/xy/T/happy-agent-501/binary-assets/menu-bar-a/happy-menu-bar-helper`,
            "garbage",
            "",
        ].join("\n");

        expect(orphanedMenuBarApps(listing, current)).toEqual([101, 103]);
    });

    it("keeps executable paths that contain spaces whole", () => {
        const spaced = "/Users/a b/binary-assets";
        expect(
            orphanedMenuBarApps(
                `  7  1 ${spaced}/menu-bar-old/happy-menu-bar\n`,
                `${spaced}/menu-bar-new/happy-menu-bar`,
            ),
        ).toEqual([7]);
    });
});

describe("reapOrphanedMenuBarApps", () => {
    it.skipIf(process.platform !== "darwin")(
        "stops an app an earlier daemon left behind and leaves a supervised one running",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "happy-menu-bar-reap-"));
            roots.push(root);
            const binaryAssets = join(root, "binary-assets");
            const app = async (version: string): Promise<string> => {
                const directory = join(binaryAssets, `menu-bar-${version}`);
                await mkdir(directory, { recursive: true });
                const executable = join(directory, "happy-menu-bar");
                // A real executable, so the process table shows this path. System binaries such as
                // sleep are killed when copied elsewhere, so a tiny one is compiled instead.
                execFileSync("cc", ["-x", "c", "-o", executable, "-"], {
                    input: "#include <unistd.h>\nint main(void) { sleep(60); return 0; }\n",
                });
                return executable;
            };
            const old = await app("old");
            const latest = await app("new");

            // The old app's daemon is gone: the shell that started it exits at once, so launchd
            // adopts it, exactly as with a daemon killed outright.
            const orphanPid = join(root, "orphan.pid");
            await new Promise<void>((resolve) => {
                spawn("/bin/sh", ["-c", `"${old}" >/dev/null 2>&1 & echo $! > "${orphanPid}"`], {
                    stdio: "ignore",
                }).once("exit", () => resolve());
            });
            // A supervised app of the running daemon, which here is this test process.
            const supervised = spawn(latest, [], { stdio: "ignore" });
            leftovers.push(supervised.pid ?? 0);

            const pidOf = async (file: string): Promise<number> => {
                for (let attempt = 0; attempt < 100; attempt++) {
                    const text = await readFile(file, "utf8").catch(() => "");
                    if (text.trim() !== "") return Number(text.trim());
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                throw new Error(`${file} was never written`);
            };
            const orphan = await pidOf(orphanPid);
            leftovers.push(orphan);

            expect(await reapOrphanedMenuBarApps(latest)).toEqual([orphan]);

            const alive = (pid: number): boolean => {
                try {
                    process.kill(pid, 0);
                    return true;
                } catch {
                    return false;
                }
            };
            for (let attempt = 0; attempt < 100 && alive(orphan); attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(alive(orphan)).toBe(false);
            expect(supervised.exitCode).toBeNull();
            expect(alive(supervised.pid ?? 0)).toBe(true);
        },
    );
});
