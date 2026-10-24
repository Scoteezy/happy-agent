import {
    locateSpaceSidebarNode,
    spaceSidebarRunLength,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import type { SidebarAspect } from "../Space.js";
import {
    regroupedSidebarIds,
    shownSidebarRows,
    sidebarIds,
    type SidebarNode,
} from "./sidebarLayout.js";

/** What Prioritizing's operations are judged against. */
export interface PrioritizingRules {
    /** Whether the person last set this aspect of the node. */
    readonly person: (id: string, aspect: SidebarAspect) => boolean;
    /** The person's rows: their space IDs. */
    readonly rows: ReadonlySet<string>;
    readonly happyId: string | undefined;
    /** New work nobody has written in yet. */
    readonly untouched: ReadonlySet<string>;
    /** Rows with work active in the last two hours, other than new work's first placement. */
    readonly recent: ReadonlySet<string>;
    /** Rows the person placed through the row route. */
    readonly manual: ReadonlySet<string>;
    /** New rows waiting for their first placement: placing one is an insertion, not a move. */
    readonly fresh: ReadonlySet<string>;
    /**
     * How many rows already in place one batch may move, or `undefined` when the person asked for
     * the change in their own words.
     */
    readonly moveLimit: number | undefined;
}

/** Rows already in place that one calm batch may move unless the person asked for more. */
export const SIDEBAR_MOVE_LIMIT = 2;

/** The seed's default sections, which only the person may remove or rename. */
export const DEFAULT_SIDEBAR_SECTION_IDS: readonly string[] = ["bots", "tasks"];

/**
 * Why Prioritizing may not make this change, or `undefined` when it may. `before` and `after` are
 * the document around the one applied operation. A move counts what it carries along: a section's
 * block travels with its heading, and an item that comes to sit under another heading moved.
 */
export function reviewPrioritizingOperation(
    before: SpaceSidebarDocument,
    after: SpaceSidebarDocument,
    operation: SpaceSidebarOperation,
    rules: PrioritizingRules,
): string | undefined {
    const target = operation.type === "insert" ? operation.node.id : operation.id;
    const moved = new Set<string>(regroupedSidebarIds(before, after));
    const carried = new Set<string>();
    if (operation.type !== "set") moved.add(target);
    if (operation.type === "remove") {
        const at = locateSpaceSidebarNode(before, target);
        if (at !== undefined) sidebarIds([at.node]).forEach((id) => moved.add(id));
    }
    if (operation.type === "move") {
        const at = locateSpaceSidebarNode(before, target)!;
        const from = at.siblings.indexOf(at.node);
        for (const node of at.siblings.slice(from, from + spaceSidebarRunLength(at.siblings, from)))
            sidebarIds([node]).forEach((id) => carried.add(id));
    }
    for (const id of moved) {
        if (id === "happy-search" || id === "happy-create")
            return "Search and Create are the person's to move.";
        if (rules.person(id, "place") || rules.manual.has(id))
            return "Keep the person's manual placement.";
    }
    if (operation.type === "set") {
        if (
            (operation.collapsed !== undefined || operation.expanded !== undefined) &&
            rules.person(target, "fold")
        )
            return "Keep the person's own folds.";
        if (operation.label !== undefined && rules.person(target, "label"))
            return "Keep the person's name for this section.";
        if (operation.foldRibbon !== undefined && rules.person(target, "foldRibbon"))
            return "Keep the person's choice of fold ribbon.";
        if (operation.html !== undefined && rules.person(target, "html"))
            return "Keep the person's widget as they left it.";
    }
    if (
        DEFAULT_SIDEBAR_SECTION_IDS.includes(target) &&
        (operation.type === "remove" || (operation.type === "set" && operation.label !== undefined))
    )
        return "Keep the Bots and Tasks sections and their names; only the person reorganizes them.";
    const label =
        operation.type === "set"
            ? operation.label
            : operation.type === "insert" && operation.node.type === "section"
              ? operation.node.label
              : undefined;
    if (label !== undefined) {
        if (agedLabel(label))
            return `Section "${label}" sorts by age or whether work is finished; name a subject instead.`;
        const name = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
        const twin = after.items.find(
            (item) =>
                item.type === "section" && item.id !== target && name(item.label) === name(label),
        ) as Extract<SidebarNode, { type: "section" }> | undefined;
        if (twin !== undefined)
            return `Section ${twin.id} is already called "${twin.label.trim()}". Move rows there instead.`;
    }
    const shownBefore = new Set(shownSidebarRows(before));
    const shownAfter = new Set(shownSidebarRows(after));
    for (const row of rules.rows) {
        const travelled = moved.has(row) || carried.has(row);
        const tucked = shownBefore.has(row) && !shownAfter.has(row);
        const folded = operation.type === "set" && target === row;
        if (!travelled && !tucked && !folded) continue;
        if (rules.untouched.has(row))
            return "Leave new work alone until the person sends its first message.";
        if (row === rules.happyId && (travelled || tucked))
            return "Prioritizing cannot move or hide Happy.";
        if ((travelled || tucked) && rules.recent.has(row))
            return "Leave work active in the last two hours where it is, and shown.";
    }
    return undefined;
}

/**
 * The rows one operation moves, carries, or regroups under another heading. Removing a row is not
 * counted: it leaves rather than moving.
 */
export function travelledSidebarIds(
    before: SpaceSidebarDocument,
    after: SpaceSidebarDocument,
    operation: SpaceSidebarOperation,
): Set<string> {
    const travelled = new Set<string>(regroupedSidebarIds(before, after));
    if (operation.type === "move") {
        const at = locateSpaceSidebarNode(before, operation.id);
        if (at !== undefined) {
            const from = at.siblings.indexOf(at.node);
            const run = at.siblings.slice(from, from + spaceSidebarRunLength(at.siblings, from));
            for (const node of run) sidebarIds([node]).forEach((id) => travelled.add(id));
        }
    }
    return travelled;
}

/** An "Older" or "Done" section reads as finished work; sections name subjects instead. */
export function agedLabel(label: string): boolean {
    return /\b(old|older|oldest|done|finished|archive|archived|stale)\b/i.test(label);
}
