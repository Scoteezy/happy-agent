import { describe, expect, it } from "vitest";
import {
    renderVoiceOutline,
    VOICE_OUTLINE_BYTES,
} from "../sources/live/impl/renderVoiceOutline.js";
import type { SpaceSidebarOutlineRow } from "../sources/spaces/index.js";

const row = (
    name: string,
    children: SpaceSidebarOutlineRow[] = [],
    foldedChildren = 0,
): SpaceSidebarOutlineRow => ({ name, agentId: undefined, children, foldedChildren });

describe("the sidebar outline voice is told", () => {
    it("names rows, sections, separators, and folded counts without statuses or IDs", () => {
        expect(
            renderVoiceOutline({
                groups: [
                    {
                        label: undefined,
                        folded: false,
                        rows: [row("Happy", [row("Voice")]), row("Release", [], 3)],
                    },
                    { label: undefined, folded: false, rows: [row("Garden  notes\nand plans")] },
                    { label: "Distractions", folded: true, rows: [row("One"), row("Two")] },
                    { label: "Shipping", folded: false, rows: [row("Launch", [], 1)] },
                    { label: "Empty", folded: false, rows: [] },
                ],
            }),
        ).toBe(
            [
                "# Sidebar",
                "",
                "- Happy",
                "    - Voice",
                "- Release (folded, 3 rows)",
                "",
                "---",
                "",
                "- Garden notes and plans",
                "",
                "## Distractions (folded, 2 rows)",
                "",
                "## Shipping",
                "",
                "- Launch (folded, 1 row)",
                "",
                "## Empty",
            ].join("\n"),
        );
    });

    it("stays within its budget and counts the rows it leaves out", () => {
        const rows = Array.from({ length: 400 }, (_, index) =>
            row(`A deliberately long conversation name number ${index}`),
        );
        const text = renderVoiceOutline({ groups: [{ label: undefined, folded: false, rows }] });
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(VOICE_OUTLINE_BYTES);
        const listed = text.split("\n").filter((line) => line.startsWith("- A deliberately"));
        expect(text.endsWith(`- …and ${400 - listed.length} more entries not listed`)).toBe(true);
    });
});
