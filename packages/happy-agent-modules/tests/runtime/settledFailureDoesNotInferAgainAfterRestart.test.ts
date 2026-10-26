import { expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

// Maintainer discussion #9: since @slopus/happy-agent-base 0.0.66, a settled run leaves nothing
// owed after a restart, so a trailing failure note is not answered again before the next send.
// Only an explicit start, or a run an earlier process left unfinished, resumes from the
// transcript. One send makes one foreground request. Keep it independent of credential
// diagnostics.
it("the restart-send regression fixture accepts the new user message and sends its foreground request", async () => {
    const result = await restartSend();
    expect(result.userAccepted).toBe(true);
    expect(result.userRequests).toEqual([
        { method: "POST", path: "/v1/responses", sessionId: result.agentId },
    ]);
});

it("after a settled failure and restart, a new send makes exactly one foreground request", async () => {
    const result = await restartSend();
    // No session filter or exclusion can conceal an extra foreground request.
    expect(result.requests).toHaveLength(1);
    expect(result.requests).toEqual([
        { method: "POST", path: "/v1/responses", sessionId: result.agentId },
    ]);
}, 30_000);

async function restartSend() {
    const fixture = await credentialWriterRuntime("owner");
    const acceptedSchema = Type.Object(
        { id: Type.String(), runId: Type.String() },
        { additionalProperties: true },
    );
    try {
        const sendAndSettle = async () => {
            const before = (await fixture.owner.getEvents()).latestCursor;
            const acceptances = new Map<string, { runId: string; requestCount: number }>();
            const stop = fixture.runtime.modules.events.subscribe((event) => {
                if (
                    event.agentId === fixture.agent.id &&
                    event.type === "message.accepted" &&
                    Value.Check(acceptedSchema, event.payload)
                )
                    acceptances.set(event.payload.id, {
                        runId: event.payload.runId,
                        requestCount: fixture.requests.length,
                    });
            });
            try {
                const sent = await fixture.owner.sendMessage(fixture.agent.id, {
                    text: "One deliberate request.",
                    mode: writerMode,
                });
                // API.md:8959-8963: run.finished is a terminal run with no immediate successor.
                let acceptedRunId: string | undefined;
                await vi.waitFor(
                    async () => {
                        const page = await fixture.owner.getMessages(fixture.agent.id);
                        const run = page.runs.find((candidate) =>
                            candidate.messages.some((message) => message.id === sent.message.id),
                        );
                        expect(run?.status).toBe("failed");
                        const events = await fixture.owner.getEvents({ after: before });
                        expect(
                            events.events.some(
                                (event) =>
                                    event.type === "run.finished" &&
                                    event.payload.run.id === run!.id,
                            ),
                        ).toBe(true);
                        acceptedRunId = run!.id;
                    },
                    { timeout: 10_000, interval: 10 },
                );
                await vi.waitFor(
                    async () =>
                        expect((await fixture.owner.getAgent(fixture.agent.id)).agent.status).toBe(
                            "idle",
                        ),
                    { timeout: 10_000, interval: 10 },
                );
                return {
                    sent,
                    acceptedRunId,
                    requestsAtAcceptance: acceptances.get(sent.message.id)?.requestCount,
                    events: (await fixture.owner.getEvents({ after: before })).events,
                };
            } finally {
                stop();
            }
        };
        await sendAndSettle();
        const expected = { method: "POST", path: "/v1/responses", sessionId: fixture.agent.id };
        expect(fixture.requests).toEqual([expected]);
        // The closed recorded shape is deliberately only method/path/session-id; no body or other header.
        expect(fixture.requests.map((request) => Object.keys(request).sort())).toEqual([
            ["method", "path", "sessionId"],
        ]);
        await fixture.restart();
        const before = fixture.requests.length;
        const second = await sendAndSettle();
        expect(second.requestsAtAcceptance).toBeDefined();
        return {
            agentId: fixture.agent.id,
            requests: fixture.requests.slice(before),
            userRequests: fixture.requests.slice(second.requestsAtAcceptance!),
            userAccepted: second.events.some(
                (event) =>
                    event.type === "run.started" &&
                    event.payload.run.id === second.acceptedRunId &&
                    event.payload.acceptedMessageIds.includes(second.sent.message.id),
            ),
        };
    } finally {
        await fixture.close();
    }
}
