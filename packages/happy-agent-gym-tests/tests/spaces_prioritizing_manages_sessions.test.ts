import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("seeds the sidebar as a mirror of the classic one and lets Prioritizing change it only from its next notice", async () => {
    const h = await sidebarGym();
    try {
        // Work that exists before Spaces is turned on: a task with a subtask under it.
        const { task } = await h.gym.client.createTask({ name: "Release" });
        const created = await h.call(
            "create_subtask",
            {
                title: "Fix tests",
                text: "Fix the failing tests.",
                model: h.gym.selection.modelId,
                effort: h.gym.selection.effort,
                provider: h.gym.selection.providerId,
            },
            task.agent.id,
        );
        const subtaskId = /Created subtask ([a-z0-9]+)/.exec(created.text)![1]!;
        const seeded = await h.read();
        const happy = seeded.spaces.find((space) => space.title === "Happy")!;
        const release = seeded.spaces.find((space) => space.target.id === task.id)!;
        expect(seeded.seed).toBe(true);
        expect(seeded.html).toContain(
            [
                "<nav>",
                "  <happy-search/>",
                "  <happy-create/>",
                `  <happy-space id="${happy.id}"/>`,
                '  <happy-separator id="divider"/>',
                '  <happy-section id="bots" label="Bots"/>',
                '  <happy-section id="tasks" label="Tasks"/>',
            ].join("\n"),
        );
        // Rows only: the subtask exists, but sessions are not shown in the sidebar.
        expect(seeded.html).toContain(`  <happy-space id="${release.id}"/>\n`);
        expect(seeded.html).not.toContain(subtaskId);
        expect(seeded.html).not.toContain("expanded");
        expect(seeded.html).not.toMatch(/older|done/i);
        // Turning Spaces on moves nothing: Prioritizing may not rearrange the mirror.
        expect(
            (await h.edit(seeded.html.replace(`  <happy-space id="${release.id}"/>\n`, ""))).text,
        ).toContain("classic sidebar");
        expect(
            (await h.gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
        ).toEqual([]);
        // The desktop applies the person's classic folds with one write, which ends the seed.
        const folded = await h.gym.http.ok<{ version: number; html: string; seed?: true }>(
            "PUT",
            "/v0/spaces/sidebar",
            {
                html: seeded.html.replace('label="Bots"/>', 'label="Bots" collapsed="true"/>'),
                baseVersion: seeded.version,
                mutationId: "classic-folds",
            },
        );
        expect(folded.seed).toBeUndefined();
        // The person's own fold stays theirs.
        expect(
            (await h.edit(folded.html.replace('label="Bots" collapsed="true"/>', 'label="Bots"/>')))
                .text,
        ).toContain("own folds");
    } finally {
        await h.gym.dispose();
    }
}, 120000);

it("gives every session an icon, keeps sessions hidden until Prioritizing shows one, and drops archived ones", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const cell = await h.create();
        await h.gym.send("Ship the release.", { sessionId: cell.agent.id });
        const subtask = /Created subtask ([a-z0-9]+)/.exec(
            (
                await h.call(
                    "create_subtask",
                    {
                        title: "Fix tests",
                        text: "Fix the failing tests.",
                        model: h.gym.selection.modelId,
                        effort: h.gym.selection.effort,
                        provider: h.gym.selection.providerId,
                    },
                    cell.agent.id,
                )
            ).text,
        )![1]!;
        const helper = /Created collaborator ([a-z0-9]+)/.exec(
            (
                await h.call(
                    "create_agent",
                    {
                        title: "Release notes",
                        text: "Draft the release notes.",
                        model: h.gym.selection.modelId,
                        effort: h.gym.selection.effort,
                        provider: h.gym.selection.providerId,
                    },
                    cell.agent.id,
                )
            ).text,
        )![1]!;
        // Prioritizing hears about both sessions and sees them with their parent.
        const listed = JSON.parse((await h.call("list_sidebar", {})).text) as {
            sessions: { id: string; parentId: string }[];
        };
        expect(listed.sessions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: subtask, parentId: cell.agent.id }),
                expect.objectContaining({ id: helper, parentId: cell.agent.id }),
            ]),
        );
        // Every working session gets an icon, shown in the sidebar or not.
        expect((await h.call("set_space_icon", { spaceId: subtask, slug: "testing" })).text).toBe(
            "Icon set to testing.",
        );
        expect((await h.call("set_space_icon", { spaceId: helper, slug: "docs" })).text).toBe(
            "Icon set to docs.",
        );
        expect((await h.read()).agentIcons).toEqual({
            [subtask]: { type: "library", slug: "testing" },
            [helper]: { type: "library", slug: "docs" },
        });
        const before = await h.read();
        // Creating subtasks and collaborators shows nothing in the sidebar by itself.
        expect(before.html).not.toContain(subtask);
        expect(before.html).not.toContain(helper);
        const row = `  <happy-space id="${cell.space.id}"/>\n`;
        const shown = before.html.replace(
            row,
            `  <happy-space id="${cell.space.id}" expanded="true">\n    <happy-space id="${subtask}"/>\n  </happy-space>\n`,
        );
        // A nested node must be a session of the row it sits under.
        expect(
            (
                await h.edit(
                    shown.replace(
                        `<happy-space id="${subtask}"/>`,
                        '<happy-space id="elsewhere"/>',
                    ),
                )
            ).text,
        ).toContain("not a session");
        expect((await h.edit(shown)).text).toContain("queued");
        await h.settle();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === shown ? true : undefined),
            "the shown subtask",
        );
        const batches = await h.gym.http.ok<{ batches: { note: string }[] }>(
            "GET",
            "/v0/spaces/batches",
        );
        expect(batches.batches[0]!.note).toBe("Showed Fix tests.");
        // Archiving the subtask takes its node out of the document.
        await h.gym.client.archiveAgent(subtask);
        await h.gym.waitUntil(
            async () => ((await h.read()).html.includes(subtask) ? undefined : true),
            "the archived subtask leaving the sidebar",
        );
    } finally {
        await h.gym.dispose();
    }
}, 120000);

it("names work with three words at most", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        const cell = await h.create();
        await h.gym.send("Fix the sidebar UI and make every space draggable.", {
            sessionId: cell.agent.id,
        });
        const title = await h.gym.waitUntil(async () => {
            const row = (await h.read()).spaces.find((space) => space.id === cell.space.id);
            return row?.title ?? undefined;
        }, "the generated title");
        // The model answered "Sidebar UI fixes and draggable spaces".
        expect(title).toBe("Sidebar UI fixes");
    } finally {
        await h.gym.dispose();
    }
}, 120000);
