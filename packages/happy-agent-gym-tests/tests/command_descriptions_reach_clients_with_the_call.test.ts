import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const COMMAND = { cmd: "echo described", max_output_tokens: 1_000, yield_time_ms: 2_000 };

function command(callId: string, args: Record<string, unknown>): GymTurn {
    return { content: [{ type: "tool_call", name: "exec_command", arguments: args, callId }] };
}

describe("a command's description", () => {
    it("reaches clients unchanged in the call's arguments without changing what ran", async () => {
        let turns = 0;
        const gym = await createAgentGym({
            timeoutMs: 20_000,
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ type: "text", text: "<title>Greeting</title>" }] };
                }
                turns += 1;
                if (turns === 1) return command("plaincommand", COMMAND);
                if (turns === 2) {
                    return command("describedcommand", {
                        ...COMMAND,
                        description: "Print a greeting",
                    });
                }
                return { content: [{ type: "text", text: "Both commands ran." }] };
            },
        });
        running.add(gym);

        await gym.send("Run the greeting twice.");
        const results = gym.inference.toolResults();
        const plain = results.find((result) => result.callId === "plaincommand")!;
        const described = results.find((result) => result.callId === "describedcommand")!;
        // Only the wall time may differ between the two runs of one command.
        const withoutWallTime = (text: string) => text.replace(/Wall time: [0-9.]+ seconds/, "");
        expect(withoutWallTime(described.text)).toBe(withoutWallTime(plain.text));
        expect(described.text).toContain("described");

        const commandCalls = async () =>
            (await gym.client.getMessages(gym.defaultSessionId)).runs
                .flatMap((run) => run.messages)
                .flatMap((message) => message.content)
                .filter(
                    (block): block is Extract<typeof block, { type: "tool_call" }> =>
                        block.type === "tool_call" && block.name === "exec_command",
                );
        const history = await commandCalls();
        expect(history).toHaveLength(2);
        expect(history[1]).toMatchObject({
            status: "completed",
            arguments: { ...COMMAND, description: "Print a greeting" },
        });
        expect(history[0]).not.toHaveProperty("arguments.description");

        const live = (await gym.client.getEvents({ limit: 10_000 })).events
            .filter((event) => event.type === "message.updated")
            .flatMap((event) => event.payload.message.content)
            .find(
                (block) =>
                    block.type === "tool_call" &&
                    block.id === history[1]?.id &&
                    block.status === "completed",
            );
        expect(live).toMatchObject({ arguments: { ...COMMAND, description: "Print a greeting" } });

        await gym.restart();
        expect(await commandCalls()).toEqual(history);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 45_000);
});
