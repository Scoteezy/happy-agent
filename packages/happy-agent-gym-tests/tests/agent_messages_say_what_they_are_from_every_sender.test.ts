import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/**
 * A bot that runs whatever tool call it is asked to, while every conversation it opens or messages
 * just settles, so the message each one received can be read through the API.
 */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        inference: (request) => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Work settled." }] };
        },
    });
    running.add(gym);
    const bot = (await gym.client.createBot({ name: "Coordinator" })).bot;
    let callIndex = 0;
    async function call(name: string, args: Record<string, unknown>) {
        const callId = `explained_${++callIndex}`;
        commands.set(bot.agent.id, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, {
            sessionId: bot.agent.id,
            permissionMode: "auto",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    /** The metadata of the one message the bot sent this agent, once it has been accepted. */
    async function received(agentId: string) {
        return await gym.waitUntil(async () => {
            const message = (await gym.client.getMessages(agentId)).runs
                .flatMap((run) => run.messages)
                .find(
                    (candidate) =>
                        candidate.role === "agent" &&
                        candidate.metadata.senderAgentId === bot.agent.id,
                );
            return message?.metadata;
        }, "the bot's message to be accepted");
    }
    return { gym, bot, call, received };
}

describe("a message one agent sends another", () => {
    it("says what it is, whichever tool sent it, and keeps saying so after a restart", async () => {
        const { gym, bot, call, received } = await harness();
        const peer = (await gym.client.createBot({ name: "Researcher" })).bot;
        const { task } = await gym.client.createTask({ name: "Audit exports" });

        await call("send_bot_message", {
            botId: peer.id,
            explanation: "Incident report request",
            text: "Collect last week's incident reports.",
        });
        await call("send_task_message", {
            taskId: task.id,
            explanation: "Billing export check",
            text: "Check the billing exports.",
        });
        await call("create_task", {
            name: "Fix login redirect",
            text: "The login page loops back to itself.",
        });
        const opened = (await gym.client.listTasks()).tasks.find(
            (candidate) => candidate.name === "Fix login redirect",
        )!;
        const subtask = await call("create_subtask", {
            title: "Parser review",
            text: "Review the parser change.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        });
        const subtaskId = /Created subtask ([a-z0-9]+)/.exec(subtask.text)![1]!;
        await call("create_agent", {
            title: "CSV quoting check",
            text: "Check how the CSV writer quotes fields.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        });
        const collaborator = await gym.waitUntil(
            async () =>
                (await gym.client.getAgentActivity(bot.agent.id)).subagents.find(
                    (child) => child.title === "CSV quoting check",
                ),
            "the created collaborator",
        );

        const expected = {
            [peer.agent.id]: "Incident report request",
            [task.agent.id]: "Billing export check",
            [opened.agent.id]: "Fix login redirect",
            [subtaskId]: "Parser review",
            [collaborator.id]: "CSV quoting check",
        };
        for (const [agentId, explanation] of Object.entries(expected)) {
            expect(await received(agentId), agentId).toMatchObject({
                senderAgentExplanation: explanation,
            });
        }

        await gym.restart();
        for (const [agentId, explanation] of Object.entries(expected)) {
            expect(await received(agentId), agentId).toMatchObject({
                senderAgentExplanation: explanation,
            });
        }
        expect(gym.errors).toEqual([]);
    }, 90_000);

    it("leaves an unnamed task's opening message to the sender's name alone", async () => {
        const { gym, call, received } = await harness();
        await call("create_task", { text: "Look into the flaky upload test." });
        const task = (await gym.client.listTasks()).tasks[0]!;

        const metadata = await received(task.agent.id);
        expect(metadata.senderAgentId).toBeDefined();
        expect(metadata).not.toHaveProperty("senderAgentExplanation");
        expect(gym.errors).toEqual([]);
    }, 45_000);
});
