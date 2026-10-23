import {
    createAgentGym,
    runIdOf,
    type AgentGym,
    type GymAgentEvent,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const SKILL = "---\nname: review\ndescription: Review the changes.\n---\n\nReview carefully.";

const echoOf = (event: GymAgentEvent): unknown =>
    (event.payload as { readonly mutationId?: unknown }).mutationId;

/** The agent an event is about, when it names one. */
function agentNamedBy(event: GymAgentEvent): string | undefined {
    const payload = event.payload as {
        readonly agentId?: unknown;
        readonly agent?: { readonly id?: unknown };
        readonly question?: { readonly agentId?: unknown };
    };
    for (const candidate of [payload.agentId, payload.agent?.id, payload.question?.agentId]) {
        if (typeof candidate === "string") return candidate;
    }
    return undefined;
}

function reviewing(request: GymInferenceRequest): boolean {
    return JSON.stringify(request.messages).includes("Review carefully.");
}

const patched = (request: GymInferenceRequest): boolean =>
    JSON.stringify(request.messages).includes("restoredskillpatch");

/**
 * An agent that waits through a daemon restart with a tagged skill queued behind it, so after the
 * restart a loop no request woke accepts the skill and runs it.
 */
async function restoredSkillRun(gym: AgentGym, mutationId: string): Promise<string> {
    await gym.send("wait a moment", { permissionMode: "full_access", wait: false });
    await gym.waitForEvent(
        (event) =>
            event.type === "agent.updated" &&
            event.payload.agentId === gym.defaultSessionId &&
            event.payload.changes.wait != null,
        "the agent to start waiting",
    );
    await gym.client.invokeSlashCommand(gym.defaultSessionId, "review", {
        mode: {
            effort: gym.selection.effort,
            modelId: gym.selection.modelId,
            permissionMode: "full_access",
            providerId: gym.selection.providerId,
            serviceTier: null,
        },
        mutationId,
    });
    await gym.restart();
    const started = await gym.waitForEvent(
        (event) => event.type === "run.started" && event.payload.mutationId === mutationId,
        "the restored loop to start the skill's run",
    );
    if (started.type !== "run.started") throw new Error("The skill run did not start.");
    await gym.waitForRun(started.payload.run.id);
    return started.payload.run.id;
}

function restoredAgentTurns(request: GymInferenceRequest): GymTurn {
    if (request.sessionId.startsWith("naming:")) {
        return { content: [{ text: "<title>Restored review</title>", type: "text" }] };
    }
    if (reviewing(request)) {
        return patched(request)
            ? { content: [{ text: "review finished", type: "text" }] }
            : {
                  content: [
                      {
                          arguments: {
                              patch: [
                                  "*** Begin Patch",
                                  "*** Update File: notes.txt",
                                  "@@",
                                  "-old line",
                                  "+reviewed line",
                                  "*** End Patch",
                                  "",
                              ].join("\n"),
                          },
                          callId: "restoredskillpatch",
                          name: "apply_patch",
                          type: "tool_call",
                      },
                  ],
              };
    }
    return JSON.stringify(request.messages).includes("restoredwait")
        ? { content: [{ text: "waited", type: "text" }] }
        : {
              content: [
                  {
                      arguments: { duration: { seconds: 3 } },
                      callId: "restoredwait",
                      name: "wait",
                      type: "tool_call",
                  },
              ],
          };
}

describe("a mutation echo owned by an agent's run", () => {
    it("survives a restart in the middle of the run", async () => {
        const gym = await createAgentGym({
            files: { ".agents/skills/review/SKILL.md": SKILL },
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Restarted review</title>", type: "text" }] };
                }
                return JSON.stringify(request.messages).includes("taggedwait")
                    ? { content: [{ text: "review finished", type: "text" }] }
                    : {
                          content: [
                              {
                                  arguments: { duration: { seconds: 3 } },
                                  callId: "taggedwait",
                                  name: "wait",
                                  type: "tool_call",
                              },
                          ],
                      };
            },
        });
        running.add(gym);
        await gym.client.invokeSlashCommand(gym.defaultSessionId, "review", {
            mode: {
                effort: gym.selection.effort,
                modelId: gym.selection.modelId,
                permissionMode: "full_access",
                providerId: gym.selection.providerId,
                serviceTier: null,
            },
            mutationId: "restarted-skill",
        });
        const started = await gym.waitForEvent(
            (event) =>
                event.type === "run.started" && event.payload.mutationId === "restarted-skill",
            "the tagged run to start",
        );
        if (started.type !== "run.started") throw new Error("The tagged run did not start.");
        const runId = started.payload.run.id;
        await gym.waitForEvent(
            (event) =>
                event.type === "agent.updated" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.changes.wait != null,
            "the run to start waiting",
        );
        const before = new Set((await gym.events()).map((event) => event.cursor));
        await gym.restart();
        await gym.waitForRun(runId);

        // What the run did after the restart, from its resumed wait to its finish.
        const resumed = (await gym.events()).filter(
            (event) => runIdOf(event) === runId && !before.has(event.cursor),
        );
        expect(resumed.map((event) => event.type)).toContain("run.finished");
        expect(
            resumed.flatMap((event) =>
                echoOf(event) === "restarted-skill" ? [] : [[event.type, echoOf(event) ?? null]],
            ),
        ).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("never reaches an event that names no agent, during a restored run or after it", async () => {
        const gym = await createAgentGym({
            files: { ".agents/skills/review/SKILL.md": SKILL, "notes.txt": "old line\n" },
            inference: restoredAgentTurns,
        });
        running.add(gym);
        const skillRunId = await restoredSkillRun(gym, "restored-skill");
        // Reading the file watches it, so a change made once the run has settled, outside any run
        // or request, publishes an update that names no agent.
        const { workspaceId } = await gym.getSession();
        await gym.client.readFile(workspaceId, "notes.txt");
        await gym.writeFile("notes.txt", "settled line\n");
        await gym.waitForEvent(
            (event) =>
                event.type === "files.updated" &&
                event.payload.paths?.includes("notes.txt") === true,
            "a workspace update after the run settled",
        );

        const events = await gym.events();
        const skillRun = events.filter((event) => runIdOf(event) === skillRunId);
        expect(skillRun.length).toBeGreaterThan(4);
        expect(skillRun.filter((event) => echoOf(event) !== "restored-skill")).toEqual([]);
        expect(
            events
                .filter((event) => agentNamedBy(event) === undefined)
                .filter((event) => echoOf(event) !== undefined)
                .map((event) => [event.type, echoOf(event)]),
        ).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("ends with the run, so another agent's run and its background work never echo it", async () => {
        let releaseOther!: () => void;
        const otherGate = new Promise<void>((resolve) => {
            releaseOther = resolve;
        });
        let otherStarted!: () => void;
        const otherRunning = new Promise<void>((resolve) => {
            otherStarted = resolve;
        });
        let otherAgentId = "";
        const gym = await createAgentGym({
            files: { ".agents/skills/review/SKILL.md": SKILL, "notes.txt": "old line\n" },
            inference: async (request: GymInferenceRequest): Promise<GymTurn> => {
                if (request.sessionId !== otherAgentId) return restoredAgentTurns(request);
                otherStarted();
                await otherGate;
                return { content: [{ text: "other finished", type: "text" }] };
            },
        });
        running.add(gym);
        const skillRunId = await restoredSkillRun(gym, "restored-skill");

        // A second agent's tagged run is still going while the restored agent stays settled.
        otherAgentId = (await gym.createSession({ title: "Other" })).id;
        await gym.client.invokeSlashCommand(otherAgentId, "review", {
            mode: {
                effort: gym.selection.effort,
                modelId: gym.selection.modelId,
                permissionMode: "auto",
                providerId: gym.selection.providerId,
                serviceTier: null,
            },
            mutationId: "other-skill",
        });
        await otherRunning;
        releaseOther();
        const otherStart = await gym.waitForEvent(
            (event) =>
                event.type === "run.started" &&
                event.payload.agentId === otherAgentId &&
                event.payload.mutationId === "other-skill",
            "the other agent's run to start",
        );
        if (otherStart.type !== "run.started") throw new Error("The other run did not start.");
        await gym.waitForRun(otherStart.payload.run.id);

        const events = await gym.events();
        const skillRun = events.filter((event) => runIdOf(event) === skillRunId);
        expect(skillRun.map((event) => event.type)).toContain("run.finished");
        expect(skillRun.filter((event) => echoOf(event) !== "restored-skill")).toEqual([]);
        // Nothing about the other agent echoes the settled run, including its metadata refreshed
        // in the background after its usage.
        expect(
            events
                .filter((event) => agentNamedBy(event) === otherAgentId)
                .filter((event) => echoOf(event) === "restored-skill")
                .map((event) => event.type),
        ).toEqual([]);
        const otherRun = events.filter((event) => runIdOf(event) === otherStart.payload.run.id);
        expect(otherRun.length).toBeGreaterThan(2);
        expect(otherRun.filter((event) => echoOf(event) !== "other-skill")).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
