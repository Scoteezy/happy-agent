import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

/**
 * A stopped turn settles without a reply, so the conversation ends with the person's prompt. After
 * a restart, the next message must be answered on its own: the stopped prompt is not streamed
 * again, and the new message does not wait behind it.
 */
it("keeps a stopped turn stopped across a restart, and answers the next message instead", async () => {
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference: (request) => {
            if (request.sessionId.startsWith("naming:"))
                return { content: [{ type: "text", text: "Long answer" }] };
            const last = JSON.stringify(request.messages.at(-1));
            if (last.includes("Something else.")) return { content: [{ type: "text", text: "Ok." }] };
            // Streams slowly, so the person stops it partway.
            return {
                content: [{ type: "text", text: "word ".repeat(2_000) }],
                textDeltaChunkSize: 5,
                textDeltaDelayMs: 50,
            };
        },
    });
    try {
        const accepted = await gym.send("Write a long answer.", { wait: false });
        await gym.waitForEvent(
            (event) =>
                event.type === "message.delta" && event.payload.agentId === gym.defaultSessionId,
            "the answer to start streaming",
        );
        await gym.abort();
        expect(await gym.waitForRun(accepted.runId)).toMatchObject({
            payload: { run: { status: "aborted" } },
        });
        const before = gym.inference.requests.length;

        await gym.restart();
        await gym.send("Something else.");
        const asked = gym.inference.requests
            .slice(before)
            .filter((request) => request.sessionId === gym.defaultSessionId);
        // One request, answering the new message; the stopped prompt is not answered again.
        expect(asked).toHaveLength(1);
        expect(JSON.stringify(asked[0]!.messages.at(-1))).toContain("Something else.");
    } finally {
        await gym.dispose();
    }
}, 120_000);
