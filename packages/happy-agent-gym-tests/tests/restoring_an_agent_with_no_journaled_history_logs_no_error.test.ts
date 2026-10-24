import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, runGymSql } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("restores an agent whose journaled events all aged out without reporting a conversion failure", async () => {
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    try {
        await gym.send("Hello.");
        // A long-lived install trims old events: this agent has none left in the journal.
        await gym.restart({
            whileStopped: async () =>
                await runGymSql(gym.happyHome, [
                    `DELETE FROM happy_agent_events WHERE agent_id = '${gym.defaultSessionId}'`,
                    `DELETE FROM happy_agent_latest_events WHERE agent_id = '${gym.defaultSessionId}'`,
                ]),
        });
        await gym.send("Hello again.");
        const log = await readFile(
            join(gym.happyHome, "agent", "observation", "agent.log"),
            "utf8",
        );
        expect(log).not.toContain("The API could not convert an agent event.");
    } finally {
        await gym.dispose();
    }
}, 120_000);
