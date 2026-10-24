import {
    applySpaceSidebarOperations,
    formatSpaceSidebar,
    parseSpaceSidebar,
    type SpaceSidebarChangedPayload,
} from "@slopus/happy-agent-client";
import { expect, it } from "vitest";

import { sidebarGym } from "./support/sidebarGym.js";

const separator = (id: string) => `  <happy-separator id="${id}"/>\n`;
const section = (id: string, label: string) => `  <happy-section id="${id}" label="${label}"/>\n`;

type Gym = Awaited<ReturnType<typeof sidebarGym>>;

/** The document as a client that knows widgets reads it. */
async function full(h: Gym) {
    return await h.gym.client.getSpaceSidebar({ widgets: true });
}

/** Every sidebar change announced since `after`, in order. */
async function sidebarChanges(h: Gym, after: string | undefined) {
    const changes: SpaceSidebarChangedPayload[] = [];
    let cursor = after;
    for (;;) {
        const page = await h.gym.client.getEvents(cursor === undefined ? {} : { after: cursor });
        for (const event of page.events)
            if (event.type === "space.sidebar.changed")
                changes.push(event.payload as SpaceSidebarChangedPayload);
        if (page.cursor === cursor || page.cursor === page.latestCursor) return changes;
        cursor = page.cursor;
    }
}

/** What Prioritizing reads: the document with its own queued edits drawn in. */
async function prioritizingView(h: Gym) {
    return JSON.parse((await h.call("list_sidebar", {})).text) as { version: number; html: string };
}

it("lands the person's drags and Prioritizing's queued edit together, whichever commits first", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        await h.hold();
        const start = await full(h);
        const cursor = (await h.gym.client.getEvents()).latestCursor;

        // Prioritizing queues a Releases section right after the divider.
        const view = await prioritizingView(h);
        expect(view.version).toBe(start.version);
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: view.version,
                    edits: [
                        {
                            oldText: separator("divider"),
                            newText: `${separator("divider")}${section("releases", "Releases")}`,
                        },
                    ],
                })
            ).text,
        ).toContain("queued");

        // Meanwhile the person takes the divider out and folds Tasks.
        const dragged = await h.gym.client.applySpaceSidebarOperations({
            mutationId: "drag-1",
            baseVersion: start.version,
            operations: [
                { type: "remove", id: "divider" },
                { type: "set", id: "tasks", collapsed: true },
            ],
        });
        expect(dragged.version).toBe(start.version + 1);

        // At calm Prioritizing's section still lands, where the divider stood.
        await h.calm();
        const tidied = await h.gym.waitUntil(async () => {
            const doc = await full(h);
            return doc.version === start.version + 2 ? doc : undefined;
        }, "Prioritizing's queued edit");
        expect(tidied.html).not.toContain('id="divider"');
        expect(tidied.html).toContain('<happy-section id="releases" label="Releases"/>');
        expect(tidied.html).toContain('<happy-section id="tasks" label="Tasks" collapsed="true"/>');

        // A drag the person made before the tidy arrived still applies on top of it.
        await h.hold();
        const late = await h.gym.client.applySpaceSidebarOperations({
            mutationId: "drag-2",
            baseVersion: start.version + 1,
            operations: [{ type: "move", id: "tasks", to: { after: "happy-create" } }],
        });
        expect(late.version).toBe(start.version + 3);
        expect(late.operations).toEqual([
            { type: "move", id: "tasks", to: { after: "happy-create" } },
        ]);
        const final = await full(h);
        expect(final.html).toBe(late.html);
        expect(final.html).toContain("releases");
        expect(final.html.indexOf('id="tasks"')).toBeLessThan(final.html.indexOf('id="bots"'));

        // Replaying the announced operations from the start reaches every version exactly.
        const changes = await sidebarChanges(h, cursor);
        expect(
            changes.map(({ previousVersion, version, author, mutationId }) => ({
                previousVersion,
                version,
                author,
                mutationId,
            })),
        ).toEqual([
            {
                previousVersion: start.version,
                version: start.version + 1,
                author: "person",
                mutationId: "drag-1",
            },
            {
                previousVersion: start.version + 1,
                version: start.version + 2,
                author: "prioritizing",
                mutationId: undefined,
            },
            {
                previousVersion: start.version + 2,
                version: start.version + 3,
                author: "person",
                mutationId: "drag-2",
            },
        ]);
        let replayed = parseSpaceSidebar(start.html);
        for (const change of changes)
            replayed = applySpaceSidebarOperations(replayed, change.operations).document;
        expect(formatSpaceSidebar(replayed)).toBe(final.html);
    } finally {
        await h.gym.dispose();
    }
}, 120_000);

it("answers a retried batch once, refuses real conflicts by operation, and reports the capability", async () => {
    const h = await sidebarGym();
    try {
        expect((await h.gym.client.getHealth()).capabilities).toMatchObject({
            sidebarOperations: true,
            sidebarAttachments: true,
        });
        const start = await full(h);
        expect(start.seed).toBe(true);
        const happy = start.spaces.find((row) => row.title === "Happy")!;
        const request = {
            mutationId: "fold-bots",
            baseVersion: start.version,
            operations: [{ type: "set" as const, id: "bots", collapsed: true }],
        };
        // Retries racing each other apply once and answer alike.
        const answers = await Promise.all([
            h.gym.client.applySpaceSidebarOperations(request),
            h.gym.client.applySpaceSidebarOperations(request),
            h.gym.client.applySpaceSidebarOperations(request),
        ]);
        expect(new Set(answers.map((answer) => answer.version))).toEqual(
            new Set([start.version + 1]),
        );
        expect(answers[0]).toEqual(answers[1]);
        expect((await full(h)).version).toBe(start.version + 1);
        // The person's first batch ends the seed.
        expect((await full(h)).seed).toBeUndefined();
        const reused = await h.gym.http.post("/v0/spaces/sidebar/operations", {
            ...request,
            operations: [{ type: "set", id: "bots", collapsed: false }],
        });
        expect(reused.status).toBe(409);

        // A batch that changes nothing makes no version.
        expect(
            (
                await h.gym.client.applySpaceSidebarOperations({
                    ...request,
                    mutationId: "fold-bots-again",
                })
            ).version,
        ).toBe(start.version + 1);

        // Happy's row leaves; a batch made before that still folds Tasks but cannot move Happy.
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "remove-happy",
            baseVersion: start.version + 1,
            operations: [{ type: "remove", id: happy.id }],
        });
        const conflict = await h.gym.http.post("/v0/spaces/sidebar/operations", {
            mutationId: "stale-move",
            baseVersion: start.version + 1,
            operations: [
                { type: "set", id: "tasks", collapsed: true },
                { type: "move", id: happy.id, to: { after: "tasks" } },
            ],
        });
        expect(conflict.status).toBe(409);
        expect(conflict.body).toMatchObject({
            currentVersion: start.version + 2,
            operationIndex: 1,
        });
        expect((await full(h)).html).not.toContain('id="tasks" label="Tasks" collapsed');

        // A batch that could never apply is the client's mistake, not a conflict.
        const invalid = await h.gym.http.post("/v0/spaces/sidebar/operations", {
            mutationId: "nonsense",
            baseVersion: start.version + 2,
            operations: [
                { type: "set", id: "tasks", collapsed: true },
                { type: "move", id: "nowhere", to: { parent: null } },
            ],
        });
        expect(invalid.status).toBe(400);
        expect(invalid.body).toMatchObject({ operationIndex: 1, diagnostics: [expect.anything()] });
        const ahead = await h.gym.http.post("/v0/spaces/sidebar/operations", {
            mutationId: "from-the-future",
            baseVersion: start.version + 9,
            operations: [{ type: "set", id: "tasks", collapsed: true }],
        });
        expect(ahead.status).toBe(409);
        expect(ahead.body).toMatchObject({ currentVersion: start.version + 2 });
        // A row that is not the person's is refused by the document rules.
        const unknown = await h.gym.http.post("/v0/spaces/sidebar/operations", {
            mutationId: "unknown-row",
            baseVersion: start.version + 2,
            operations: [
                {
                    type: "insert",
                    node: { type: "space", id: "zzzzzzzzzzzzzzzzzzzzzzzz" },
                    to: { parent: null },
                },
            ],
        });
        expect(unknown.status).toBe(400);
        expect(unknown.body).toHaveProperty("diagnostics");
        expect((await h.gym.http.get("/v0/spaces/sidebar?widgets=false")).status).toBe(400);
        expect((await full(h)).version).toBe(start.version + 2);
    } finally {
        await h.gym.dispose();
    }
}, 120_000);

it("keeps widgets away from older clients and the person's widget away from Prioritizing", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        await h.hold();
        const start = await full(h);
        const card = "<div class='card'>3 reviews <b>waiting</b> &amp; one <i>blocked</i></div>";
        const added = await h.gym.client.applySpaceSidebarOperations({
            mutationId: "add-card",
            baseVersion: start.version,
            operations: [
                {
                    type: "insert",
                    node: { type: "widget", id: "reviews", html: card },
                    to: { after: "happy-create" },
                },
            ],
        });
        expect(added.html).toContain(`<happy-widget id="reviews">${card}</happy-widget>`);
        // A client that predates widgets never meets one, and its whole-document write keeps it.
        const old = await h.read();
        expect(old.version).toBe(added.version);
        expect(old.html).not.toContain("happy-widget");
        const cursor = (await h.gym.client.getEvents()).latestCursor;
        const put = await h.gym.http.ok<{ version: number; html: string }>(
            "PUT",
            "/v0/spaces/sidebar",
            {
                html: old.html.replace(separator("divider"), ""),
                baseVersion: old.version,
                mutationId: "old-client-removes-divider",
            },
        );
        expect(put.html).not.toContain("happy-widget");
        expect((await full(h)).html).toContain(`<happy-widget id="reviews">${card}</happy-widget>`);
        expect(await sidebarChanges(h, cursor)).toEqual([
            {
                artifactId: start.artifactId,
                previousVersion: old.version,
                version: put.version,
                author: "person",
                operations: [{ type: "remove", id: "divider" }],
                mutationId: "old-client-removes-divider",
            },
        ]);
        const smuggled = await h.gym.http.put("/v0/spaces/sidebar", {
            html: put.html.replace(
                "</nav>",
                '  <happy-widget id="sneaky">hi</happy-widget>\n</nav>',
            ),
            baseVersion: put.version,
            mutationId: "old-client-adds-widget",
        });
        expect(smuggled.status).toBe(400);
        const huge = await h.gym.http.post("/v0/spaces/sidebar/operations", {
            mutationId: "huge-card",
            baseVersion: put.version,
            operations: [{ type: "set", id: "reviews", html: "x".repeat(17 * 1024) }],
        });
        expect(huge.status).toBe(400);

        // Prioritizing may not rewrite the person's card, but may add one of its own.
        const view = await prioritizingView(h);
        expect(view.html).toContain(card);
        const rewrite = await h.call("edit_sidebar", {
            baseVersion: view.version,
            edits: [{ oldText: card, newText: "Nothing to review." }],
        });
        expect(rewrite.text).toContain("Keep the person's widget as they left it.");
        const summary = "<p>2 sessions waiting on you</p>";
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: view.version,
                    edits: [
                        {
                            oldText: "</nav>",
                            newText: `  <happy-widget id="waiting">${summary}</happy-widget>\n</nav>`,
                        },
                    ],
                })
            ).text,
        ).toContain("queued");
        await h.calm();
        const tidied = await h.gym.waitUntil(async () => {
            const doc = await full(h);
            return doc.version === put.version + 1 ? doc : undefined;
        }, "Prioritizing's widget");
        expect(tidied.html).toContain(`<happy-widget id="waiting">${summary}</happy-widget>`);
        expect(tidied.html).toContain(card);
    } finally {
        await h.gym.dispose();
    }
}, 120_000);
