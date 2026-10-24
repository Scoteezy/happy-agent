/** The title a story's artifact and inline presentation carry: its caption on one line. */
export function storyTitle(caption: string | null): string {
    // oxlint-disable-next-line no-control-regex
    const line = (caption ?? "").replaceAll(/[\u0000-\u001f\u007f]+/gu, " ").trim();
    if (line.length === 0) return "Story";
    const characters = Array.from(line);
    return characters.length <= 256 ? line : `${characters.slice(0, 255).join("").trimEnd()}…`;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Whether the text is exactly one emoji: one extended grapheme cluster holding a pictograph or a
 * pair of regional indicators.
 */
export function isSingleEmoji(text: string): boolean {
    const clusters = [...segmenter.segment(text)];
    if (clusters.length !== 1) return false;
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3/u.test(text);
}

/** An opaque page boundary, `createdAt` and ID, as clients pass it back. */
export function encodeStoryCursor(createdAt: number, id: string): string {
    return Buffer.from(`${String(createdAt)}:${id}`, "utf8").toString("base64url");
}

export function decodeStoryCursor(
    cursor: string,
): { readonly createdAt: number; readonly id: string } | undefined {
    const match = /^(\d{1,16}):([a-z][a-z0-9]{1,31})$/.exec(
        Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (match === null) return undefined;
    return { createdAt: Number(match[1]), id: match[2] as string };
}

/** An opaque offset into an ordered list, as clients pass it back. */
export function encodeOffsetCursor(offset: number): string {
    return Buffer.from(`o:${String(offset)}`, "utf8").toString("base64url");
}

export function decodeOffsetCursor(cursor: string): number | undefined {
    const match = /^o:(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
    return match === null ? undefined : Number(match[1]);
}
