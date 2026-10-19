import type {
    SpaceBatchChange,
    SpaceBatchSectionChange,
    SpacePendingChange,
    SpaceRecord,
    SpaceSectionRecord,
} from "../Space.js";
import { spaceOrderKeyBetween } from "./spaceOrderKeyBetween.js";

/** What one batch does to a sidebar, decided before anything is stored. */
export interface SpaceChangeOutcome {
    /** Rows whose stored state changes, already carrying their next version. */
    readonly spaces: readonly { readonly space: SpaceRecord; readonly previousVersion: number }[];
    readonly createdSections: readonly SpaceSectionRecord[];
    readonly updatedSections: readonly {
        readonly section: SpaceSectionRecord;
        readonly previousVersion: number;
    }[];
    readonly removedSectionIds: readonly string[];
    /** Every row that moved, from where to where, in sidebar order of its destination. */
    readonly changes: readonly SpaceBatchChange[];
    readonly sectionChanges: readonly SpaceBatchSectionChange[];
}

/**
 * Apply queued changes to one person's sidebar, in the order they were asked for.
 *
 * A change naming a row or section that no longer exists is dropped rather than failing the whole
 * batch: the person may have closed or moved things since the manager decided. Placing a row
 * shows it and settles its placement; a section that is removed while rows remain in it folds
 * those rows into Older instead of losing them.
 */
export function applySpaceChanges(
    ownerUserId: string,
    spaces: readonly SpaceRecord[],
    sections: readonly SpaceSectionRecord[],
    changes: readonly SpacePendingChange[],
    titles: ReadonlyMap<string, string>,
    now: number,
): SpaceChangeOutcome {
    const rows = new Map(spaces.map((space) => [space.id, structuredClone(space)]));
    const shelves = new Map(sections.map((section) => [section.id, structuredClone(section)]));
    const created = new Set<string>();
    const removed = new Set<string>();

    for (const change of changes) {
        switch (change.type) {
            case "section": {
                let section = shelves.get(change.sectionId);
                if (section === undefined) {
                    if (!change.create || change.name === undefined) break;
                    section = {
                        id: change.sectionId,
                        ownerUserId,
                        name: change.name,
                        collapsed: false,
                        tailExpanded: false,
                        orderKey: sectionKeyAfter([...shelves.values()], undefined),
                        version: 1,
                        createdAt: now,
                        updatedAt: now,
                    };
                    shelves.set(section.id, section);
                    created.add(section.id);
                    removed.delete(section.id);
                }
                if (change.name !== undefined) section.name = change.name;
                if (change.visibleCount === null) delete section.visibleCount;
                else if (change.visibleCount !== undefined)
                    section.visibleCount = change.visibleCount;
                if (change.afterSectionId !== undefined) {
                    const others = [...shelves.values()].filter((other) => other.id !== section.id);
                    section.orderKey = sectionKeyAfter(others, change.afterSectionId);
                }
                break;
            }
            case "remove_section":
                if (shelves.has(change.sectionId)) removed.add(change.sectionId);
                break;
            case "place": {
                const row = rows.get(change.spaceId);
                if (row === undefined || row.role !== "item") break;
                const sectionId = change.sectionId ?? undefined;
                if (sectionId !== undefined && (!shelves.has(sectionId) || removed.has(sectionId)))
                    break;
                const siblings = [...rows.values()]
                    .filter(
                        (other) =>
                            other.id !== row.id &&
                            other.role === "item" &&
                            other.sectionId === sectionId,
                    )
                    .sort(compareRows);
                row.orderKey = rowKeyAfter(siblings, change.afterId ?? null);
                if (sectionId === undefined) delete row.sectionId;
                else row.sectionId = sectionId;
                row.visibility = "shown";
                row.placement = "settled";
                break;
            }
            case "visibility": {
                const row = rows.get(change.spaceId);
                if (row === undefined || row.role !== "item") break;
                row.visibility = change.visibility;
                row.placement = "settled";
                break;
            }
        }
    }

    // A section the batch made but left empty would be a stray label in the sidebar.
    for (const sectionId of created) {
        const used = [...rows.values()].some(
            (row) => row.sectionId === sectionId && row.visibility === "shown",
        );
        if (!used) removed.add(sectionId);
    }
    for (const sectionId of removed) {
        for (const row of rows.values()) {
            if (row.sectionId !== sectionId) continue;
            delete row.sectionId;
            if (row.visibility === "shown") row.visibility = "folded";
        }
    }

    const finalSections = [...shelves.values()].filter((section) => !removed.has(section.id));
    const before = positions(spaces, sections);
    const after = positions([...rows.values()], finalSections);
    const changed: { space: SpaceRecord; previousVersion: number }[] = [];
    const batchChanges: SpaceBatchChange[] = [];
    for (const original of spaces) {
        const next = rows.get(original.id);
        if (next === undefined) continue;
        if (
            next.sectionId === original.sectionId &&
            next.orderKey === original.orderKey &&
            next.visibility === original.visibility &&
            next.placement === original.placement
        ) {
            continue;
        }
        next.version = original.version + 1;
        next.updatedAt = now;
        changed.push({ space: next, previousVersion: original.version });
        const from = before.get(original.id);
        const to = after.get(original.id);
        if (original.role !== "item" || from === undefined || to === undefined) continue;
        if (
            from.sectionId === to.sectionId &&
            from.index === to.index &&
            from.visibility === to.visibility &&
            from.placement === to.placement
        ) {
            continue;
        }
        batchChanges.push({
            spaceId: original.id,
            title: titles.get(original.id) ?? "Untitled",
            from,
            to,
        });
    }

    const updatedSections: { section: SpaceSectionRecord; previousVersion: number }[] = [];
    const sectionChanges: SpaceBatchSectionChange[] = [];
    for (const section of finalSections) {
        if (created.has(section.id)) {
            sectionChanges.push({ sectionId: section.id, name: section.name, change: "created" });
            continue;
        }
        const original = sections.find((candidate) => candidate.id === section.id);
        if (original === undefined || sameSection(original, section)) continue;
        section.version = original.version + 1;
        section.updatedAt = now;
        updatedSections.push({ section, previousVersion: original.version });
        sectionChanges.push({ sectionId: section.id, name: section.name, change: "updated" });
    }
    const removedSectionIds = [...removed].filter((sectionId) => !created.has(sectionId));
    for (const sectionId of removedSectionIds) {
        const original = sections.find((section) => section.id === sectionId);
        sectionChanges.push({
            sectionId,
            name: original?.name ?? "Section",
            change: "removed",
        });
    }

    return {
        spaces: changed,
        createdSections: finalSections.filter((section) => created.has(section.id)),
        updatedSections,
        removedSectionIds,
        changes: batchChanges,
        sectionChanges,
    };
}

/** Rows within one section, by key and then identity. */
export function compareRows(left: SpaceRecord, right: SpaceRecord): number {
    return left.orderKey < right.orderKey
        ? -1
        : left.orderKey > right.orderKey
          ? 1
          : left.id.localeCompare(right.id);
}

/** A key placing a row after `afterId` among `siblings`, or first when it is null or absent. */
export function rowKeyAfter(siblings: readonly SpaceRecord[], afterId: string | null): string {
    const ordered = [...siblings].sort(compareRows);
    if (afterId === null) return spaceOrderKeyBetween(null, ordered[0]?.orderKey ?? null);
    const index = ordered.findIndex((sibling) => sibling.id === afterId);
    const anchor = index === -1 ? ordered.at(-1) : ordered[index];
    const next = index === -1 ? undefined : ordered[index + 1];
    return betweenOrEnd(anchor?.orderKey ?? null, next?.orderKey ?? null);
}

/** A key placing a section after `afterSectionId`, first when it is null, last when absent. */
function sectionKeyAfter(
    sections: readonly SpaceSectionRecord[],
    afterSectionId: string | null | undefined,
): string {
    const ordered = [...sections].sort((left, right) =>
        left.orderKey < right.orderKey
            ? -1
            : left.orderKey > right.orderKey
              ? 1
              : left.id.localeCompare(right.id),
    );
    if (afterSectionId === null) return spaceOrderKeyBetween(null, ordered[0]?.orderKey ?? null);
    const index =
        afterSectionId === undefined
            ? ordered.length - 1
            : ordered.findIndex((section) => section.id === afterSectionId);
    const anchor = index === -1 ? ordered.at(-1) : ordered[index];
    const next = index === -1 ? undefined : ordered[index + 1];
    return betweenOrEnd(anchor?.orderKey ?? null, next?.orderKey ?? null);
}

/** Equal keys can only come from ties; place after the lower one rather than failing. */
function betweenOrEnd(lower: string | null, upper: string | null): string {
    if (lower !== null && upper !== null && lower >= upper)
        return spaceOrderKeyBetween(lower, null);
    return spaceOrderKeyBetween(lower, upper);
}

function sameSection(left: SpaceSectionRecord, right: SpaceSectionRecord): boolean {
    return (
        left.name === right.name &&
        left.visibleCount === right.visibleCount &&
        left.orderKey === right.orderKey
    );
}

/**
 * Where every row is drawn: shown rows by section (or under Happy) and key, folded rows in Older,
 * hidden rows nowhere. The index counts within that place, so it is what a person would see.
 */
export function positions(
    spaces: readonly SpaceRecord[],
    sections: readonly SpaceSectionRecord[],
): Map<string, SpaceBatchChange["from"]> {
    const names = new Map(sections.map((section) => [section.id, section.name]));
    const groups = new Map<string, SpaceRecord[]>();
    for (const space of spaces) {
        if (space.role !== "item") continue;
        const group =
            space.visibility === "shown" ? `shown:${space.sectionId ?? ""}` : space.visibility;
        groups.set(group, [...(groups.get(group) ?? []), space]);
    }
    const result = new Map<string, SpaceBatchChange["from"]>();
    for (const [group, members] of groups) {
        const ordered =
            group === "folded" || group === "hidden"
                ? [...members].sort(
                      (left, right) =>
                          right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
                  )
                : [...members].sort(compareRows);
        ordered.forEach((space, index) => {
            const sectionId = space.sectionId ?? null;
            result.set(space.id, {
                sectionId,
                sectionName: sectionId === null ? null : (names.get(sectionId) ?? null),
                index,
                visibility: space.visibility,
                placement: space.placement,
            });
        });
    }
    return result;
}
