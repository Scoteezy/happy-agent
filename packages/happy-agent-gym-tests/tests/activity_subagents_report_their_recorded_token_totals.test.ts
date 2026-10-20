import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("reports own recorded input plus output for finished helpers, zero measurements, and unmeasured work", async () => {
    let parentId = "";
    let issued = false;
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference(request) {
            if (request.sessionId === parentId) {
                if (!issued) {
                    issued = true;
                    return {
                        content: ["Measured helper", "Zero helper", "Unmeasured helper"].map(
                            (title, index) => ({
                                type: "tool_call",
                                name: "create_agent",
                                callId: `helper_${index}`,
                                arguments: {
                                    title,
                                    text: title,
                                    provider: "gym",
                                    model: "gym/model",
                                    effort: "medium",
                                },
                            }),
                        ),
                        usage: {
                            input: 500,
                            output: 100,
                            cacheRead: 0,
                            cacheWrite: 0,
                            totalTokens: 600,
                        },
                    };
                }
                return { content: [{ type: "text", text: "Helpers started." }] };
            }
            const text = JSON.stringify(request.messages);
            if (text.includes("Unmeasured helper")) {
                return { delayMs: 60_000, content: [{ type: "text", text: "Still working." }] };
            }
            return {
                content: [{ type: "text", text: "Finished." }],
                usage: text.includes("Measured helper")
                    ? {
                          input: 10_800,
                          output: 1_400,
                          cacheRead: 200,
                          cacheWrite: 100,
                          totalTokens: 12_500,
                      }
                    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            };
        },
    });
    running.add(gym);
    parentId = gym.defaultSessionId;
    await gym.send("Start the three helpers.");
    const activity = await gym.waitUntil(async () => {
        const snapshot = await gym.client.getAgentActivity(parentId);
        const measured = snapshot.subagents.find((child) => child.title === "Measured helper");
        const zero = snapshot.subagents.find((child) => child.title === "Zero helper");
        const unmeasured = snapshot.subagents.find((child) => child.title === "Unmeasured helper");
        if (
            measured === undefined ||
            zero === undefined ||
            unmeasured === undefined ||
            unmeasured.status === "idle"
        )
            return undefined;
        const finished = await Promise.all(
            [measured, zero].map(async (child) =>
                (await gym.client.getMessages(child.id)).runs.some(
                    (run) => run.status === "completed",
                ),
            ),
        );
        return finished.every(Boolean) ? snapshot : undefined;
    }, "finished and unmeasured helpers");
    const bootstrap = await gym.client.getAgentBootstrap(parentId);
    const unmeasured = activity.subagents.find((child) => child.title === "Unmeasured helper")!;
    await gym.abort(unmeasured.id);
    const expected = [
        expect.objectContaining({ title: "Measured helper", totalTokens: 12_200 }),
        expect.objectContaining({ title: "Zero helper", totalTokens: 0 }),
        expect.objectContaining({ title: "Unmeasured helper", totalTokens: null }),
    ];
    expect(activity.subagents).toEqual(expect.arrayContaining(expected));
    expect(bootstrap.subagents).toEqual(expect.arrayContaining(expected));
    await gym.restart();
    expect((await gym.client.getAgentActivity(parentId)).subagents).toEqual(
        expect.arrayContaining(expected.slice(0, 2)),
    );
}, 120_000);
