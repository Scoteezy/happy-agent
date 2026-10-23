import { once } from "node:events";
import { dirname } from "node:path";

import { createAgentGym } from "@slopus/happy-agent-gym";

// The gym normally hosts its real daemon in the test process. This isolated fixture lets the
// outer scenario kill that daemon's owner without killing Vitest or anybody's real installation.
const gym = await createAgentGym({
    config: "[feature.codemode]\nenabled = true\nengine = 'monty'\n",
    inference: [
        {
            content: [
                {
                    type: "tool_call",
                    name: "python",
                    arguments: {
                        code: "from pathlib import Path\nPath('native-ready').write_text('ready')\nwhile not Path('native-ack').exists():\n    pass\nPath('native-started').write_text('running')\nwhile True:\n    pass",
                    },
                },
            ],
        },
    ],
});
try {
    console.log(
        `gym-root:${JSON.stringify({ root: dirname(gym.happyHome), workspacePath: gym.workspacePath })}`,
    );
    // Cleanup ownership must reach the outer test before it admits runaway Python.
    await once(process.stdin, "data");
    const accepted = await gym.send("Execute Python until this throwaway daemon is killed.", {
        wait: false,
    });
    await gym.waitUntil(async () => {
        try {
            return (await gym.readFile("native-started")) === "running" ? true : undefined;
        } catch {
            return undefined;
        }
    }, "Code Mode to write its started marker");
    console.log(`gym-running:${accepted.runId}`);
    await once(process.stdin, "end");
} finally {
    await gym.dispose();
}
