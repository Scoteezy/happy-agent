import type { SpaceSidebarOutline, SpaceSidebarOutlineRow } from "../../spaces/index.js";

/** The outline fits GPT-Live's startup budget; omitted entries are named as a count. */
export const VOICE_OUTLINE_BYTES = 8192;
export const VOICE_OUTLINE_TITLE = "Sidebar";

/**
 * The person's sidebar as names only, the way voice talks about it: no status, activity, messages,
 * or IDs. Folded sections and rows say how many rows they hold instead of listing them.
 */
export function renderVoiceOutline(outline: SpaceSidebarOutline): string {
    const lines: string[] = [];
    const counted = (count: number) => `${count} ${count === 1 ? "row" : "rows"}`;
    const row = (entry: SpaceSidebarOutlineRow, depth: number): string[] => [
        `${"    ".repeat(depth)}- ${oneLine(entry.name)}${entry.foldedChildren > 0 ? ` (folded, ${counted(entry.foldedChildren)})` : ""}`,
        ...entry.children.flatMap((child) => row(child, depth + 1)),
    ];
    for (const group of outline.groups) {
        if (group.label !== undefined)
            lines.push(
                "",
                `## ${oneLine(group.label)}${group.folded ? ` (folded, ${counted(group.rows.length)})` : ""}`,
            );
        else if (lines.length > 0) lines.push("", "---");
        if (group.folded) continue;
        if (group.rows.length > 0) lines.push("");
        for (const entry of group.rows) lines.push(...row(entry, 0));
    }
    const header = `# ${VOICE_OUTLINE_TITLE}\n`;
    const kept: string[] = [];
    let bytes = Buffer.byteLength(header);
    for (const [index, line] of lines.entries()) {
        const rest = lines.slice(index).filter((candidate) => /^\s*- /.test(candidate)).length;
        const marker = `\n- …and ${rest} more ${rest === 1 ? "entry" : "entries"} not listed`;
        if (
            bytes + Buffer.byteLength(`${line}\n`) + Buffer.byteLength(marker) >
            VOICE_OUTLINE_BYTES
        ) {
            kept.push(marker.trimStart());
            break;
        }
        kept.push(line);
        bytes += Buffer.byteLength(`${line}\n`);
    }
    return `${header}${kept.join("\n")}`.trimEnd();
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, 256) || "Untitled";
}
