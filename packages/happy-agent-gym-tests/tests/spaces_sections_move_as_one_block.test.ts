import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;
const section = (id: string, label: string) => `  <happy-section id="${id}" label="${label}"/>\n`;

it("puts new work right below Happy, or right after Create when Happy is folded away", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const happy = (await h.read()).spaces.find((space) => space.title === "Happy")!;
        const first = await h.create();
        expect((await h.read()).html).toContain(
            `  <happy-create/>\n${line(happy.id)}${line(first.space.id)}  <happy-separator id="divider"/>\n`,
        );
        // The person tucks Happy into a collapsed section of their own.
        const current = await h.read();
        await h.gym.http.ok("PUT", "/v0/spaces/sidebar", {
            html: current.html
                .replace(line(happy.id), "")
                .replace(
                    "</nav>",
                    `  <happy-section id="mine" label="Mine" collapsed="true"/>\n${line(happy.id)}</nav>`,
                ),
            baseVersion: current.version,
            mutationId: "tuck-happy",
        });
        const second = await h.create();
        expect((await h.read()).html).toContain(`  <happy-create/>\n${line(second.space.id)}`);
    } finally {
        await h.gym.dispose();
    }
}, 120000);

it("moves a section with its rows as one block and protects the person's section moves", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const cell = await h.create();
        await h.gym.send("Fix the sidebar UI and make every space draggable.", {
            sessionId: cell.agent.id,
        });
        const title = await h.gym.waitUntil(async () => {
            const row = (await h.read()).spaces.find((space) => space.id === cell.space.id);
            return row?.title ?? undefined;
        }, "the generated title");
        const notes = async () =>
            (
                await h.gym.http.ok<{ batches: { note: string }[] }>("GET", "/v0/spaces/batches")
            ).batches.map((batch) => batch.note);
        const apply = async (html: string, what: string) => {
            expect((await h.edit(html)).text).toContain("queued");
            await h.calm();
            return await h.gym.waitUntil(async () => {
                const doc = await h.read();
                return doc.html === html ? doc : undefined;
            }, what);
        };

        // Prioritizing gives the new work a section of its own: its first placement.
        await h.hold();
        const before = await h.read();
        const ideas = `${section("ideas", "Ideas")}${line(cell.space.id)}`;
        const placed = await apply(
            before.html.replace(line(cell.space.id), "").replace("</nav>", `${ideas}</nav>`),
            "the Ideas section",
        );
        expect(await notes()).toEqual([`Put ${title} in Ideas.`]);

        // Moving the section carries recent work, so Prioritizing may not move it.
        const raised = placed.html
            .replace(ideas, "")
            .replace(
                '  <happy-separator id="divider"/>\n',
                `  <happy-separator id="divider"/>\n${ideas}`,
            );
        await h.hold();
        expect((await h.edit(raised)).text).toContain("last two hours");

        // The person may: dragging the block marks only its heading as placed by hand.
        const dragged = await h.gym.http.ok<{ version: number; html: string }>(
            "PUT",
            "/v0/spaces/sidebar",
            { html: raised, baseVersion: placed.version, mutationId: "drag-ideas" },
        );
        expect(JSON.parse((await h.call("list_sidebar", {})).text)).toMatchObject({
            manualIds: ["ideas"],
        });
        expect((await h.edit(placed.html)).text).toContain("manual placement");

        // A section with nothing recent in it moves as one block and one note.
        const research = section("research", "Research");
        const added = await apply(
            dragged.html.replace("</nav>", `${research}</nav>`),
            "the Research section",
        );
        await h.hold();
        await apply(
            added.html
                .replace(research, "")
                .replace('  <happy-section id="bots"', `${research}  <happy-section id="bots"`),
            "Research above Bots",
        );
        expect((await notes()).slice(0, 2)).toEqual(["Moved Research.", "Added Research."]);

        // Bots and Tasks are the person's defaults.
        await h.hold();
        const latest = await h.read();
        expect(
            (await h.edit(latest.html.replace('  <happy-section id="bots" label="Bots"/>\n', "")))
                .text,
        ).toContain("Keep the Bots and Tasks sections");
        expect(
            (await h.edit(latest.html.replace('label="Tasks"', 'label="Projects"'))).text,
        ).toContain("Keep the Bots and Tasks sections");
    } finally {
        await h.gym.dispose();
    }
}, 120000);
