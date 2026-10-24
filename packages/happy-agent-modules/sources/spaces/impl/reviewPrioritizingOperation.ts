import {
    locateSpaceSidebarNode,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import type { SidebarAspect } from "../Space.js";
import { regroupedSidebarIds, shownSidebarRows, sidebarIds } from "./sidebarLayout.js";

/** What Prioritizing's operations are judged against. */
export interface PrioritizingRules {
    /** Whether the person last set this aspect of the node. */
    readonly person: (id: string, aspect: SidebarAspect) => boolean;
    /** The person's rows: their space IDs. */
    readonly rows: ReadonlySet<string>;
    /** Rows the person placed through the row route. */
    readonly manual: ReadonlySet<string>;
    /** New rows waiting for their first placement: placing one is an insertion, not a move. */
    readonly fresh: ReadonlySet<string>;
    /** Prioritizing's own row, which it inserts and keeps right under Happy itself. */
    readonly focusId: string | undefined;
    /**
     * Whether only the small changes a batch makes without consent apply; `false` when the
     * person asked for the change in their own words.
     */
    readonly direct: boolean;
}

/**
 * Why Prioritizing may not make this change, or `undefined` when it may. Where things go is
 * Prioritizing's decision, made from its prompt; the daemon only keeps what the person did
 * themselves: their placements, folds, names, fold ribbons, widgets, and the sessions they
 * revealed. `before` and `after` are the document around the one applied operation; a move
 * counts what it carries along, and an item that comes to sit under another heading moved.
 */
export function reviewPrioritizingOperation(
    before: SpaceSidebarDocument,
    after: SpaceSidebarDocument,
    operation: SpaceSidebarOperation,
    rules: PrioritizingRules,
): string | undefined {
    const target = operation.type === "insert" ? operation.node.id : operation.id;
    const moved = new Set<string>(regroupedSidebarIds(before, after));
    if (operation.type !== "set") moved.add(target);
    if (operation.type === "remove") {
        const at = locateSpaceSidebarNode(before, target);
        if (at !== undefined) sidebarIds([at.node]).forEach((id) => moved.add(id));
    }
    for (const id of moved)
        if (rules.person(id, "place") || rules.manual.has(id))
            return "Keep the person's manual placement.";
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
    // A session the person revealed stays in view.
    const shownAfter = new Set(shownSidebarRows(after));
    for (const id of shownSidebarRows(before))
        if (
            !rules.rows.has(id) &&
            !shownAfter.has(id) &&
            rules.person(id, "place") &&
            locateSpaceSidebarNode(before, id)?.node.type === "space"
        )
            return "Keep the sessions the person revealed in view.";
    return undefined;
}
