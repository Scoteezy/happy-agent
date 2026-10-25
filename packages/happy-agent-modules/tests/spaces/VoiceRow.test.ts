import { expect, it } from "vitest";
import type { AgentSystemRef } from "@slopus/happy-agent-base";

import { SpacesModule, spaceMigrations } from "../../sources/spaces/index.js";
import { querySpaces } from "../../sources/spaces/persistence/SpacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const OWNER = "standalone";
const VOICE = "agentvoiceaaaaaaaaaaaaaa";
const NEXT_VOICE = "agentvoicebbbbbbbbbbbbbb";
const ELSEWHERE = "agentelsewhereaaaaaaaaaa";

type Params = ConstructorParameters<typeof SpacesModule>;

/** Spaces without Stem Cells, with every collaborator stubbed except its own database. */
async function setup(team = false) {
    const database = moduleDatabase(spaceMigrations, "voice-row");
    await database.ready;
    const titles = new Map<string, string>([
        [VOICE, "Voice"],
        [NEXT_VOICE, "Voice"],
        [ELSEWHERE, "Release planning"],
    ]);
    const spaces = new SpacesModule(
        { configuration: { values: { feature: { team: { enabled: team } } } } } as Params[0],
        { listForMember: async () => [] } as unknown as Params[1],
        { list: async () => [], chiefOfStaff: async () => undefined } as unknown as Params[2],
        { list: async () => [] } as unknown as Params[3],
        {
            read: async () => ({
                messages: [
                    { message: { role: "user", blocks: [{ type: "text", text: "Ship it." }] } },
                    {
                        message: {
                            role: "assistant",
                            blocks: [{ type: "text", text: "Released version two." }],
                        },
                    },
                ],
            }),
        } as unknown as Params[4],
        { activeRunId: () => undefined } as unknown as Params[5],
        { register: () => undefined, invoke: async () => undefined } as unknown as Params[6],
        {} as Params[7],
        { enabled: team } as unknown as Params[8],
        { get: async () => ({ value: false }) } as unknown as Params[9],
        { namingStyle: async () => "standard" } as unknown as Params[10],
    );
    spaces.beforeStart(database.context, {
        config: async (_ctx: unknown, id: string) =>
            titles.has(id) ? { id, metadata: { title: titles.get(id) } } : undefined,
        parentOf: async () => null,
        childOf: async () => [],
    } as unknown as AgentSystemRef);
    const voiceRows = async () =>
        (await querySpaces(database.context, OWNER)).filter((row) => row.role === "voice");
    return { database, spaces, voiceRows };
}

it("keeps one settled Voice row per person and lets a new Voice replace the old one", async () => {
    const h = await setup();
    try {
        await h.spaces.ensureVoiceRow(h.database.context, OWNER, VOICE);
        await h.spaces.ensureVoiceRow(h.database.context, OWNER, VOICE);
        expect(await h.voiceRows()).toMatchObject([
            {
                role: "voice",
                contents: [{ kind: "agent", agentId: VOICE }],
                placement: "settled",
                visibility: "shown",
                icon: { type: "library", slug: "ai-agent" },
            },
        ]);
        await h.spaces.ensureVoiceRow(h.database.context, OWNER, NEXT_VOICE);
        expect((await h.voiceRows()).map((row) => row.contents)).toEqual([
            [{ kind: "agent", agentId: NEXT_VOICE }],
        ]);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("rolls the Voice row back with the caller's transaction", async () => {
    const h = await setup();
    try {
        await expect(
            h.database.context.inTx(async (tx) => {
                await h.spaces.ensureVoiceRow(tx, OWNER, VOICE);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await h.voiceRows()).toEqual([]);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("gives Voice read-only sidebar tools and asks Prioritizing for every rearrangement", async () => {
    const h = await setup();
    try {
        const tools = h.spaces.voiceSidebarTools(OWNER, VOICE);
        expect(tools.map((tool) => tool.name)).toEqual([
            "list_sidebar",
            "read_conversations",
            "get_sidebar_styles",
            "request_space_placement",
            "request_sidebar_tidy",
        ]);
        for (const tool of tools) expect(tool.defer).not.toBe(true);
        const tidy = tools.find((tool) => tool.name === "request_sidebar_tidy")!;
        // Without Stem Cells nobody is tidying the sidebar, and Voice is told so.
        expect(await tidy.execute(h.database.context, {} as never, {} as never)).toEqual({
            text: "Nothing organizes this sidebar yet; the person can tidy it themselves.",
        });
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("reads any live conversation on a standalone machine for Voice, but only the person's rows otherwise", async () => {
    const h = await setup();
    try {
        const read = async (scope: "rows" | "machine") =>
            await h.spaces.readConversations(h.database.context, OWNER, {
                ids: [ELSEWHERE],
                turns: 1,
                replies: 1,
                scope,
            });
        const machine = await read("machine");
        expect(machine).toContain(`Conversation ${ELSEWHERE} ("Release planning")`);
        expect(machine).toContain("Released version two.");
        expect(await read("rows")).not.toContain("Released version two.");
        const unknown = await h.spaces.readConversations(h.database.context, OWNER, {
            ids: ["agentunknownaaaaaaaaaaaa"],
            turns: 1,
            replies: 1,
            scope: "machine",
        });
        expect(unknown).not.toContain("Released version two.");
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("keeps a team machine's other conversations private from Voice", async () => {
    const h = await setup(true);
    try {
        const text = await h.spaces.readConversations(h.database.context, OWNER, {
            ids: [ELSEWHERE],
            turns: 1,
            replies: 1,
            scope: "machine",
        });
        expect(text).not.toContain("Released version two.");
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});
