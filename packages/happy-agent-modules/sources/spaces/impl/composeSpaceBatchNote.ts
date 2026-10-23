import type { SpaceBatchChange, SpaceBatchSectionChange } from "../Space.js";

/** At most this many rows are named for one fold before the rest are counted. */
const FOLDED_NAMES = 6;

/**
 * Happy's one-line note for a batch, written from what actually moved so it can never describe a
 * change the batch did not make ("Moved Preview viewer release to Releases."). Prioritizing's reasons
 * stay in the diff, never in the note, so it always reads as one clean line. Rows folded out of
 * view are always named, grouped by the section they went into, because that is the change the
 * person can no longer see on screen. Other moves name two and count the rest. A moved section is
 * one move, named by its label, however many rows travelled with it.
 */
export function composeSpaceBatchNote(
    changes: readonly SpaceBatchChange[],
    sections: readonly SpaceBatchSectionChange[],
    movedSections: readonly string[] = [],
): string {
    const folds = describeFolds(changes.filter((change) => change.to.visibility === "folded"));
    const others = [
        ...movedSections.map((label) => `moved ${label}`),
        ...changes.filter((change) => change.to.visibility !== "folded").map(describeMove),
    ];
    if (folds.length === 0 && others.length === 0) {
        const created = sections.filter((section) => section.change === "created");
        const removed = sections.filter((section) => section.change === "removed");
        if (created.length > 0) return `Added ${joinNames(created.map(({ name }) => name))}.`;
        if (removed.length > 0) return `Removed ${joinNames(removed.map(({ name }) => name))}.`;
        return "Renamed sections in your sidebar.";
    }
    const named = Math.max(0, 2 - folds.length);
    const phrases = [...folds, ...others.slice(0, named)];
    const rest = others.length - Math.min(named, others.length);
    if (rest > 0) return `${capitalize(phrases.join(", "))}, and ${String(rest)} more.`;
    if (phrases.length === 1) return `${capitalize(phrases[0]!)}.`;
    if (phrases.length === 2) return `${capitalize(phrases[0]!)} and ${phrases[1]!}.`;
    return `${capitalize(phrases.slice(0, -1).join(", "))}, and ${phrases.at(-1)!}.`;
}

/** One phrase per section that rows were folded into, naming the rows. */
function describeFolds(folds: readonly SpaceBatchChange[]): string[] {
    const groups = new Map<string | null, string[]>();
    for (const change of folds) {
        const titles = groups.get(change.to.sectionName) ?? [];
        titles.push(change.title);
        groups.set(change.to.sectionName, titles);
    }
    return [...groups].map(([section, titles]) => {
        const named = titles.slice(0, FOLDED_NAMES);
        const unnamed = titles.length - named.length;
        const names =
            unnamed === 0
                ? joinNames(named)
                : `${named.join(", ")} and ${String(unnamed)} ${unnamed === 1 ? "other" : "others"}`;
        return section === null ? `tucked away ${names}` : `tucked ${names} into ${section}`;
    });
}

function describeMove(change: SpaceBatchChange): string {
    const title = change.title;
    if (change.to.visibility === "hidden") return `hid ${title}`;
    if (change.from.visibility === "hidden" && change.to.visibility === "shown")
        return `showed ${title}`;
    // Separators have no title, so a move under one, or under no heading, names only the row.
    const section = change.to.sectionName;
    if (section === null)
        return change.from.placement === "pending" ? `placed ${title}` : `moved ${title}`;
    if (change.from.sectionId === change.to.sectionId && change.from.visibility === "shown") {
        return `reordered ${title} in ${section}`;
    }
    return change.from.placement === "pending"
        ? `put ${title} in ${section}`
        : `moved ${title} to ${section}`;
}

function joinNames(names: readonly string[]): string {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

function capitalize(text: string): string {
    return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}
