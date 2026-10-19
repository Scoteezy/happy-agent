import type { SpaceBatchChange, SpaceBatchSectionChange } from "../Space.js";

/**
 * Happy's one-line note for a batch, written from what actually moved so it can never describe a
 * change the batch did not make ("Moved Preview viewer release to Older."). Prioritizing's reasons
 * stay in the diff, never in the note: a cheap model's wording would not read as one clean line.
 * A bigger batch names two moves and counts the rest.
 */
export function composeSpaceBatchNote(
    changes: readonly SpaceBatchChange[],
    sections: readonly SpaceBatchSectionChange[],
): string {
    if (changes.length === 0) {
        const created = sections.filter((section) => section.change === "created");
        const removed = sections.filter((section) => section.change === "removed");
        if (created.length > 0) return `Added ${joinNames(created.map(({ name }) => name))}.`;
        if (removed.length > 0) return `Removed ${joinNames(removed.map(({ name }) => name))}.`;
        return "Renamed sections in your sidebar.";
    }
    if (changes.length === 1) {
        return `${capitalize(describeMove(changes[0] as SpaceBatchChange))}.`;
    }
    const [first, second] = changes.map(describeMove) as [string, string];
    const rest = changes.length - 2;
    return rest === 0
        ? `${capitalize(first)} and ${second}.`
        : `${capitalize(first)}, ${second}, and ${String(rest)} more.`;
}

function describeMove(change: SpaceBatchChange): string {
    const title = change.title;
    if (change.to.visibility === "hidden") return `hid ${title}`;
    if (change.to.visibility === "folded") return `moved ${title} to Older`;
    if (change.to.sectionId === null) return `put ${title} under Happy`;
    const section = change.to.sectionName ?? "its section";
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
