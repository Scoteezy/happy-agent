import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("new task and bot naming", () => {
    for (const kind of ["task", "bot"] as const) {
        it(`preserves a deliberate ${kind} rename while naming is in flight`, async () => {
            let attempts = 0;
            const gym = await createAgentGym({
                inference(request) {
                    if (!request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "Done." }] };
                    attempts += 1;
                    return { delayMs: 60_000, content: [{ type: "text", text: "Generated name" }] };
                },
            });
            running.add(gym);
            const work =
                kind === "task"
                    ? (await gym.client.createTask({})).task
                    : (await gym.client.createBot({})).bot;
            await gym.send("Write release notes.", { sessionId: work.agent.id });
            await gym.waitUntil(() => (attempts === 1 ? true : undefined), "naming to begin");
            if (kind === "task")
                await gym.client.renameTask(
                    work.id,
                    { name: "My chosen name" },
                    { ifMatch: work.version },
                );
            else
                await gym.client.renameBot(
                    work.id,
                    { name: "My chosen name" },
                    { ifMatch: work.version },
                );
            await gym.restart();
            await gym.send("Continue the work.", { sessionId: work.agent.id });
            expect((await gym.client.getAgent(work.agent.id)).agent.title).toBe("My chosen name");
            expect(attempts).toBe(1);
            expect(gym.errors).toEqual([]);
        }, 30_000);

        it(`uses the first message after exhausting the ${kind} naming budget`, async () => {
            let attempts = 0;
            const gym = await createAgentGym({
                timeoutMs: 15_000,
                inference(request) {
                    if (!request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "Done." }] };
                    attempts += 1;
                    return { error: { message: "Naming unavailable" } };
                },
            });
            running.add(gym);
            const work =
                kind === "task"
                    ? (await gym.client.createTask({})).task
                    : (await gym.client.createBot({})).bot;
            await gym.send("Release notes cleanup", { sessionId: work.agent.id });
            await gym.waitUntil(async () => {
                const current =
                    kind === "task"
                        ? (await gym.client.getTask(work.id)).task
                        : (await gym.client.getBot(work.id)).bot;
                return current.name === "Release notes cleanup" ? current : undefined;
            }, "a useful first-message name after three failures");
            expect(attempts).toBe(3);
            await gym.restart();
            await gym.send("A different topic", { sessionId: work.agent.id });
            expect(attempts).toBe(3);
            expect((await gym.client.getAgent(work.agent.id)).agent.title).toBe(
                "Release notes cleanup",
            );
            expect(gym.errors).toEqual([]);
        }, 30_000);

        it(`retries a temporary ${kind} naming failure without another message`, async () => {
            let attempts = 0;
            const gym = await createAgentGym({
                inference(request) {
                    if (!request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "Done." }] };
                    attempts += 1;
                    return attempts === 1
                        ? { error: { message: "Temporary naming outage" } }
                        : { content: [{ type: "text", text: "<title>Release Notes</title>" }] };
                },
            });
            running.add(gym);
            const work =
                kind === "task"
                    ? (await gym.client.createTask({})).task
                    : (await gym.client.createBot({})).bot;
            await gym.send("Write the release notes.", { sessionId: work.agent.id });
            await gym.waitUntil(async () => {
                const current =
                    kind === "task"
                        ? (await gym.client.getTask(work.id)).task
                        : (await gym.client.getBot(work.id)).bot;
                return current.name === "Release Notes" ? current : undefined;
            }, "the original naming job to recover");
            expect(attempts).toBe(2);
            expect((await gym.client.getAgent(work.agent.id)).agent.title).toBe("Release Notes");
            await gym.send("Also check spelling.", { sessionId: work.agent.id });
            expect(attempts).toBe(2);
            expect(gym.errors).toEqual([]);
        }, 30_000);

        it(`resumes the pending ${kind} naming job after a restart`, async () => {
            let attempts = 0;
            const gym = await createAgentGym({
                inference(request) {
                    if (!request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "Done." }] };
                    attempts += 1;
                    return attempts === 1
                        ? { error: { message: "Temporary naming outage" } }
                        : { content: [{ type: "text", text: "<title>Release Notes</title>" }] };
                },
            });
            running.add(gym);
            const work =
                kind === "task"
                    ? (await gym.client.createTask({})).task
                    : (await gym.client.createBot({})).bot;
            await gym.send("Write the release notes.", { sessionId: work.agent.id });
            await gym.waitUntil(
                () => (attempts === 1 ? true : undefined),
                "the first naming attempt",
            );
            await gym.restart();
            await gym.waitUntil(async () => {
                const current =
                    kind === "task"
                        ? (await gym.client.getTask(work.id)).task
                        : (await gym.client.getBot(work.id)).bot;
                return current.name === "Release Notes" ? current : undefined;
            }, "the pending name to survive the restart");
            expect(attempts).toBe(2);
            expect(gym.errors).toEqual([]);
        }, 30_000);
    }
});
