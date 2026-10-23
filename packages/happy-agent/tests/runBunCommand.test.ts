import { describe, expect, it } from "vitest";

import { runBunCommand } from "../sources/binary/runBunCommand.js";
import { AgentDaemonError } from "../sources/lifecycle/AgentDaemonError.js";

describe("runBunCommand", () => {
    it("starts its own executable as Bun and reports the exit code", async () => {
        // Node stands in for the binary: it receives the arguments and the variable that makes a
        // compiled Bun executable behave as the Bun CLI.
        const code = await runBunCommand(
            [
                "-e",
                "process.exit(process.env.BUN_BE_BUN === '1' && process.argv[1] === 'kept' ? 7 : 1)",
                "kept",
            ],
            { environment: process.env, executable: process.execPath, standalone: true },
        );
        expect(code).toBe(7);
    });

    it("reports a signal-terminated child the way a shell would", async () => {
        const code = await runBunCommand(["-e", "process.kill(process.pid, 'SIGTERM')"], {
            environment: process.env,
            executable: process.execPath,
            standalone: true,
        });
        expect(code).toBe(143);
    });

    it("refuses outside the standalone binary", async () => {
        await expect(
            runBunCommand(["--version"], {
                environment: process.env,
                executable: process.execPath,
                standalone: false,
            }),
        ).rejects.toBeInstanceOf(AgentDaemonError);
    });
});
