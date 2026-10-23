import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;

it("lets Prioritizing read what was said in a row or session, newest first, without tool calls", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
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

        // The subtask reports back into the row's conversation, which answers it.
        const thread = await h.gym.waitUntil(async () => {
            const text = (await h.call("read_row_conversation", { id: cell.space.id })).text;
            return /^Agent, .* ago: Done\.\n\nAnother agent, /.test(text) ? text : undefined;
        }, "the subtask's report in the row's thread");
        // The person's words, the agent's replies, and the report, newest first.
        expect(thread).toMatch(/Person, .* ago: Execute sidebar request/);
        expect(thread).toMatch(/Person, .* ago: Ship the release\.$/);
        expect(thread.indexOf("Execute sidebar request")).toBeLessThan(
            thread.indexOf("Ship the release."),
        );
        // Tool calls and their output stay out.
        expect(thread).not.toContain("create_subtask");
        expect(thread).not.toContain("Created subtask");

        // The limit caps the messages returned, newest first.
        expect(
            (await h.call("read_row_conversation", { id: cell.space.id, limit: 1 })).text,
        ).toMatch(/^Agent, .* ago: Done\.$/);

        // A session under the person's row is read by its agent ID, with the task it was given.
        expect((await h.call("read_row_conversation", { id: subtask })).text).toMatch(
            /^Agent, .* ago: Done\.\n\nAnother agent, .* ago: Message from agent [a-z0-9]+:\n\nFix the failing tests\.$/,
        );
        // Anything else is not the person's to read.
        expect(
            (await h.call("read_row_conversation", { id: "zzzzzzzzzzzzzzzzzzzzzzzz" })).text,
        ).toMatch(/not found/i);
    } finally {
        await h.gym.dispose();
    }
}, 120000);

it("reports the shown rows against the visible budget, without Happy or untouched new work", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const visible = async () =>
            (
                JSON.parse((await h.call("list_sidebar", {})).text) as {
                    visibleRows: { shown: number; budget: number };
                }
            ).visibleRows;
        const cell = await h.create();
        // New work waiting for its first message is outside the budget.
        const baseline = await visible();
        expect(baseline.budget).toBe(10);
        await h.gym.send("Ship the release.", { sessionId: cell.agent.id });
        expect((await visible()).shown).toBe(baseline.shown + 1);

        // A session shown under an expanded row counts too.
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
        expect((await visible()).shown).toBe(baseline.shown + 1);
        let current = await h.read();
        const shown = await h.gym.http.ok<{ version: number; html: string }>(
            "PUT",
            "/v0/spaces/sidebar",
            {
                html: current.html.replace(
                    line(cell.space.id),
                    `  <happy-space id="${cell.space.id}" expanded="true">\n    <happy-space id="${subtask}"/>\n  </happy-space>\n`,
                ),
                baseVersion: current.version,
                mutationId: "show-subtask",
            },
        );
        expect((await visible()).shown).toBe(baseline.shown + 2);

        // Rows folded under a collapsed section are not shown.
        current = await h.read();
        expect(current.version).toBe(shown.version);
        const block = shown.html.slice(
            shown.html.indexOf(`  <happy-space id="${cell.space.id}"`),
            shown.html.indexOf("  </happy-space>\n") + "  </happy-space>\n".length,
        );
        await h.gym.http.ok("PUT", "/v0/spaces/sidebar", {
            html: shown.html
                .replace(block, "")
                .replace(
                    "</nav>",
                    `  <happy-section id="later" label="Release" collapsed="true"/>\n${block}</nav>`,
                ),
            baseVersion: shown.version,
            mutationId: "fold-release",
        });
        expect((await visible()).shown).toBe(baseline.shown);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
