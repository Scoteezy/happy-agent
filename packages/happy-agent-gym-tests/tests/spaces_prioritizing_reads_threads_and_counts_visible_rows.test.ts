import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;

it("lets Prioritizing read several rows and sessions by turn, without tool calls", async () => {
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
        const read = async (args: unknown) => (await h.call("read_conversations", args)).text;
        const thread = await h.gym.waitUntil(async () => {
            const text = await read({ ids: [cell.space.id] });
            return /\nAnother agent, .* ago: [^]*\nAgent, .* ago: Done\.$/.test(text)
                ? text
                : undefined;
        }, "the subtask's report in the row's thread");
        // Turns oldest first: the person's words or a report, each with the reply that answered it.
        expect(thread.startsWith(`Row ${cell.space.id} (`)).toBe(true);
        expect(thread).toMatch(/Person, .* ago: Ship the release\.\nAgent, .* ago: Done\./);
        expect(thread.indexOf("Ship the release.")).toBeLessThan(
            thread.indexOf("Execute sidebar request"),
        );
        // Tool calls and their output stay out.
        expect(thread).not.toContain("create_subtask");
        expect(thread).not.toContain("Created subtask");

        // `turns` keeps the latest turns and says how many were left out.
        const latest = await read({ ids: [cell.space.id], turns: 1 });
        expect(latest).toMatch(/\n\(2 earlier turns left out\)\nAnother agent, /);
        expect(latest).not.toContain("Ship the release.");

        // Several conversations at once; a session under the person's row is read by its agent
        // ID, with the task it was given; anything else is not the person's to read.
        const both = (
            await read({ ids: [cell.space.id, subtask, "zzzzzzzzzzzzzzzzzzzzzzzz"] })
        ).split("\n\n---\n\n");
        expect(both).toHaveLength(3);
        expect(both[1]).toMatch(
            /^Session [a-z0-9]+ \("Fix tests"\):\nAnother agent, .* ago: Message from agent [a-z0-9]+:\n\nFix the failing tests\.\nAgent, .* ago: Done\.$/,
        );
        expect(both[2]).toBe(
            "zzzzzzzzzzzzzzzzzzzzzzzz is not one of the person's rows or sessions.",
        );
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
