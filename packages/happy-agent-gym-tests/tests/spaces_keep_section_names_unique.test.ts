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
    readonly sectionId: string | null;
    readonly placement: string;
}
interface Snapshot {
    readonly spaces: readonly Space[];
    readonly sections: readonly { readonly id: string; readonly name: string }[];
}

/** A Prioritizing script that makes a "Movies" section for every piece of new work, as a cheap model did. */
function sectionPerRow(request: GymInferenceRequest): GymTurn {
    if (!request.instructions.includes("You are Prioritizing")) {
        return { content: [{ type: "text", text: "Done." }] };
    }
    const last = request.messages.at(-1);
    const text = JSON.stringify(last);
    const briefs = [
        ...JSON.stringify(request.messages).matchAll(/New work started in row ([a-z0-9]+)/g),
    ];
    const row = briefs.at(-1)?.[1];
    if (last?.role === "user" && text.includes("New work started")) {
        return {
            content: [
                {
                    type: "tool_call",
                    name: "update_section",
                    arguments: { name: briefs.length === 1 ? "Movies" : " movies" },
                    callId: `section_${row!}`,
                },
            ],
        };
    }
    const section = /Section ([a-z0-9]+) (?:queued for creation|is already called)/.exec(text)?.[1];
    if (last?.role === "tool" && section !== undefined && row !== undefined) {
        return {
            content: [
                {
                    type: "tool_call",
                    name: "place_space",
                    arguments: { spaceId: row, sectionId: section },
                    callId: `place_${row}`,
                },
            ],
        };
    }
    return { content: [{ type: "text", text: "Sidebar updated." }] };
}

describe("sidebar sections", () => {
    it("are never duplicated by name, so new work joins the section that already exists", async () => {
        const gym = await createAgentGym({ timeoutMs: 30_000, inference: sectionPerRow });
        running.add(gym);
        const snapshot = async () => await gym.http.ok<Snapshot>("GET", "/v0/spaces");

        // Both placements wait for one batch while the person is interacting.
        await gym.http.ok("POST", "/v0/spaces/attention", { state: "interacting" });
        const placements = () =>
            gym.inference.requests.filter(
                (request) =>
                    request.instructions.includes("You are Prioritizing") &&
                    JSON.stringify(request.messages.at(-1)).includes("Change queued"),
            ).length;
        const rows: string[] = [];
        for (const text of ["Plan movie night.", "Track the movies I downloaded."]) {
            const created = await gym.http.ok<{ space: Space; agent: { id: string } }>(
                "POST",
                "/v0/spaces/stem-cells",
                {},
            );
            rows.push(created.space.id);
            await gym.send(text, { sessionId: created.agent.id });
            await gym.waitUntil(
                () => (placements() >= rows.length ? true : undefined),
                "the queued placement",
            );
        }

        await gym.http.ok("POST", "/v0/spaces/attention", { state: "calm" });
        const placed = await gym.waitUntil(async () => {
            const current = await snapshot();
            return current.spaces
                .filter((row) => rows.includes(row.id))
                .every((row) => row.placement === "settled")
                ? current
                : undefined;
        }, "both rows placed");
        expect(placed.sections.map(({ name }) => name)).toEqual(["Movies"]);
        const [movies] = placed.sections;
        expect(
            placed.spaces.filter((row) => rows.includes(row.id)).map((row) => row.sectionId),
        ).toEqual([movies!.id, movies!.id]);
    }, 120_000);
});
