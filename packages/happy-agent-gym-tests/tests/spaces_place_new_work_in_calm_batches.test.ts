import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

interface Space {
    readonly id: string;
    readonly role: string;
    readonly title: string | null;
    readonly icon: { readonly type: string; readonly slug?: string } | null;
    readonly target: { readonly kind: string; readonly agentId: string | null };
    readonly sectionId: string | null;
    readonly orderKey: string;
    readonly placement: string;
    readonly visibility: string;
}
interface Section {
    readonly id: string;
    readonly name: string;
    readonly tailExpanded: boolean;
}
interface Snapshot {
    readonly spaces: readonly Space[];
    readonly sections: readonly Section[];
    readonly cursor: string;
}
interface Batch {
    readonly note: string;
    readonly noteMessageId: string | null;
    readonly changes: readonly {
        readonly spaceId: string;
        readonly from: { readonly sectionName: string | null; readonly visibility: string };
        readonly to: { readonly sectionName: string | null; readonly visibility: string };
    }[];
}

const MANAGER_TOOLS = [
    "list_sidebar",
    "place_space",
    "remove_section",
    "set_space_icon",
    "set_space_visibility",
    "update_section",
];

/**
 * A scripted sidebar manager. New work gets an icon and, when unplaced, a "Releases" section and
 * a placement there; a tidy request hides the row the test named. Everything else is plain text.
 */
function scriptedManager(state: { hideOnTidy?: string }) {
    let call = 0;
    const tool = (name: string, args: Record<string, unknown>) => ({
        type: "tool_call" as const,
        name,
        arguments: args,
        callId: `space_tool_${String(++call)}`,
    });
    return (request: GymInferenceRequest): GymTurn => {
        if (!request.instructions.includes("You are the sidebar manager")) {
            return { content: [{ type: "text", text: "Done." }] };
        }
        const last = request.messages.at(-1);
        const text = JSON.stringify(last);
        if (last?.role === "user") {
            const row = /New work started in row ([a-z0-9]+)/.exec(text)?.[1];
            if (row !== undefined && text.includes("already placed it")) {
                return { content: [tool("set_space_icon", { spaceId: row, slug: "build" })] };
            }
            if (row !== undefined) {
                return {
                    content: [
                        tool("set_space_icon", { spaceId: row, slug: "android" }),
                        tool("update_section", { name: "Releases", visibleCount: 3 }),
                    ],
                };
            }
            if (text.includes("tidy the sidebar now") && state.hideOnTidy !== undefined) {
                return {
                    content: [
                        tool("set_space_visibility", {
                            spaceId: state.hideOnTidy,
                            visibility: "hidden",
                        }),
                    ],
                };
            }
        }
        const section = /Section ([a-z0-9]+) queued for creation/.exec(text)?.[1];
        if (last?.role === "tool" && section !== undefined) {
            const all = JSON.stringify(request.messages);
            const rows = [...all.matchAll(/New work started in row ([a-z0-9]+)/g)];
            const row = rows.at(-1)?.[1];
            return {
                content: [tool("place_space", { spaceId: row, sectionId: section })],
            };
        }
        return { content: [{ type: "text", text: "Sidebar updated." }] };
    };
}

describe("spaces over the API", () => {
    it("places new work after its first message at a calm moment, with one note and a diff", async () => {
        const state: { hideOnTidy?: string } = {};
        const gym = await createAgentGym({ timeoutMs: 30_000, inference: scriptedManager(state) });
        running.add(gym);
        const snapshot = async () => await gym.http.ok<Snapshot>("GET", "/v0/spaces");
        const space = async (id: string) => (await snapshot()).spaces.find((row) => row.id === id)!;
        const batches = async () =>
            (await gym.http.ok<{ batches: Batch[] }>("GET", "/v0/spaces/batches")).batches;
        const isManager = (request: GymInferenceRequest) =>
            request.instructions.includes("You are the sidebar manager");
        // The manager is idle once every run it started has finished.
        const managerIdle = async () => {
            const managerId = gym.inference.requests.find(isManager)?.sessionId;
            if (managerId === undefined) return undefined;
            const events = await gym.sessionEvents(managerId);
            const started = events.filter((event) => event["type"] === "run.started").length;
            const finished = events.filter((event) => event["type"] === "run.finished").length;
            return started > 0 && started === finished ? true : undefined;
        };

        // Happy is row one before anything else exists.
        const initial = await snapshot();
        const happy = initial.spaces[0]!;
        expect(happy).toMatchObject({ role: "happy", title: "Happy", visibility: "shown" });
        // The manager is a helper of Happy, not a row.
        expect(initial.spaces.map(({ role }) => role)).toEqual(["happy"]);

        // ⌘N: a fresh conversation with no project, waiting under Happy.
        const created = await gym.http.ok<{
            space: Space;
            agent: { id: string; workspaceId: string };
        }>("POST", "/v0/spaces/stem-cells", {});
        expect(created.space).toMatchObject({
            placement: "pending",
            visibility: "shown",
            sectionId: null,
            icon: { type: "stem_cell" },
            target: { kind: "task", agentId: created.agent.id },
        });
        expect(created.agent.workspaceId).toEqual(expect.any(String));
        const retried = await gym.http.post("/v0/spaces/stem-cells", { id: created.space.id });
        expect(retried.status).toBe(200);

        // The first message is an ordinary send; the manager names an icon at once and queues
        // the placement, which waits while the person is interacting.
        await gym.http.ok("POST", "/v0/spaces/attention", { state: "interacting" });
        await gym.send("Plan the Android 2.4 release.", { sessionId: created.agent.id });
        await gym.waitUntil(
            async () =>
                (await space(created.space.id)).icon?.slug === "android" ? true : undefined,
            "the manager's icon",
        );
        await gym.waitUntil(
            () =>
                gym.inference.requests.some(
                    (request) =>
                        isManager(request) &&
                        JSON.stringify(request.messages.at(-1)).includes("Change queued"),
                )
                    ? true
                    : undefined,
            "the queued placement",
        );
        await gym.waitUntil(managerIdle, "the manager to finish");
        const queued = await snapshot();
        expect(await batches()).toEqual([]);
        expect(queued.spaces.find((row) => row.id === created.space.id)).toMatchObject({
            placement: "pending",
            sectionId: null,
        });
        expect(queued.sections).toEqual([]);

        // The manager has exactly its own tools; ordinary conversations may only ask it.
        const managerRequest = gym.inference.requests.find((request) =>
            request.instructions.includes("You are the sidebar manager"),
        )!;
        expect(managerRequest.tools.map(({ name }) => name).sort()).toEqual(MANAGER_TOOLS);
        expect(JSON.stringify(managerRequest.messages)).toContain("Plan the Android 2.4 release.");
        const taskRequest = gym.inference.requests.find(
            (request) => request.sessionId === created.agent.id,
        )!;
        expect(taskRequest.tools.map(({ name }) => name)).not.toContain("place_space");

        // The client's calm signal applies it: one batch, one note in Happy's chat, one diff.
        const calm = await gym.http.ok<{ batch: Batch | null }>("POST", "/v0/spaces/attention", {
            state: "calm",
        });
        expect(calm.batch).not.toBeNull();
        const placed = await snapshot();
        const releases = placed.sections[0]!;
        expect(releases).toMatchObject({ name: "Releases", visibleCount: 3 });
        expect(placed.spaces.find((row) => row.id === created.space.id)).toMatchObject({
            placement: "settled",
            sectionId: releases.id,
        });
        const [batch] = await batches();
        const title = placed.spaces.find((row) => row.id === created.space.id)!.title;
        expect(batch).toMatchObject({
            note: `Put ${title ?? "a new chat"} in Releases.`,
            changes: [
                {
                    spaceId: created.space.id,
                    from: { sectionName: null, visibility: "shown" },
                    to: { sectionName: "Releases", visibility: "shown" },
                },
            ],
        });
        const notes = await gym.http.ok<{
            runs: { messages: { id: string; content: unknown }[] }[];
        }>("GET", `/v0/agents/${happy.target.agentId!}/messages`);
        const note = notes.runs
            .flatMap((run) => run.messages)
            .find((message) => message.id === batch!.noteMessageId);
        expect(JSON.stringify(note?.content)).toContain(batch!.note);

        // A section's +: placed by the person, at the top; the manager only chooses its icon.
        const second = await gym.http.ok<{ space: Space; agent: { id: string } }>(
            "POST",
            "/v0/spaces/stem-cells",
            { sectionId: releases.id },
        );
        expect(second.space).toMatchObject({ placement: "settled", sectionId: releases.id });
        expect(
            second.space.orderKey <
                placed.spaces.find((row) => row.id === created.space.id)!.orderKey,
        ).toBe(true);
        await gym.send("Summarize this week's build changes.", { sessionId: second.agent.id });
        await gym.waitUntil(
            async () => ((await space(second.space.id)).icon?.slug === "build" ? true : undefined),
            "the second icon",
        );
        await gym.waitUntil(managerIdle, "the manager to finish");
        expect(await batches()).toHaveLength(1);

        // The person's own drag and disclosure apply at once.
        const moved = await gym.http.ok<{ space: Space }>(
            "POST",
            `/v0/spaces/${second.space.id}/move`,
            { sectionId: releases.id, afterId: created.space.id },
        );
        expect(
            moved.space.orderKey >
                placed.spaces.find((row) => row.id === created.space.id)!.orderKey,
        ).toBe(true);
        expect(moved.space).toMatchObject({ placement: "settled", visibility: "shown" });
        const opened = await gym.http.ok<{ section: Section }>(
            "POST",
            `/v0/spaces/sections/${releases.id}/collapse`,
            { tailExpanded: true },
        );
        expect(opened.section.tailExpanded).toBe(true);
        const badMove = await gym.http.post(`/v0/spaces/${happy.id}/move`, {
            sectionId: null,
            afterId: null,
        });
        expect(badMove.status).toBe(409);

        // "Tidy now" applies the manager's batch as soon as it finishes, without a calm moment.
        state.hideOnTidy = second.space.id;
        expect((await gym.http.post("/v0/spaces/tidy", {})).status).toBe(202);
        const tidy = await gym.waitUntil(async () => {
            const applied = await batches();
            return applied.length === 2 ? applied[0] : undefined;
        }, "the tidy batch");
        expect(tidy).toMatchObject({
            changes: [{ spaceId: second.space.id, to: { visibility: "hidden" } }],
        });
        expect(tidy.note).toMatch(/^Hid [^.]+\.$/);

        // Every step reached the event journal for live clients.
        const types = new Set<string>();
        for (let after = initial.cursor; ; ) {
            const page = await gym.client.getEvents({ after, limit: 100 });
            for (const event of page.events) types.add(event.type);
            if (page.events.length === 0 || page.cursor === page.latestCursor) break;
            after = page.cursor;
        }
        expect([...types].filter((type) => type.startsWith("space.")).sort()).toEqual([
            "space.batch.applied",
            "space.created",
            "space.section.created",
            "space.section.updated",
            "space.updated",
        ]);
        expect(gym.errors).toEqual([]);
    });
});
