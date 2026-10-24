import {
    locateSpaceSidebarNode,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import type { SidebarAspect, SidebarAuthor, SidebarAuthorship } from "../Space.js";
import { regroupedSidebarIds, sidebarIds } from "./sidebarLayout.js";

/** How many nodes keep their authorship; the least recently set are forgotten first. */
const KEPT = 2000;

/**
 * The authorship after a batch. Inserting, moving, or removing a node sets its place, and so does
 * coming to sit under another heading; moving a section sets only its heading's, because its block
 * is carried. Inserting also sets what the new node starts with: a section's label and fold, a
 * row's fold, a widget's content. `collapsed` and `expanded` set the fold, and `label`,
 * `foldRibbon`, and `html` their own aspects. The daemon's own changes record nobody, and what it
 * removes takes its authorship along.
 */
export function recordSidebarAuthorship(
    authorship: Readonly<Record<string, SidebarAuthorship>>,
    before: SpaceSidebarDocument,
    after: SpaceSidebarDocument,
    operations: readonly SpaceSidebarOperation[],
    author: SidebarAuthor | "daemon",
): Record<string, SidebarAuthorship> {
    const next = { ...authorship };
    if (author === "daemon") {
        for (const operation of operations) {
            if (operation.type !== "remove") continue;
            const at = locateSpaceSidebarNode(before, operation.id);
            for (const id of at === undefined ? [operation.id] : sidebarIds([at.node]))
                delete next[id];
        }
        return next;
    }
    const touched = new Map<string, Set<SidebarAspect>>();
    const touch = (id: string, aspect: SidebarAspect) => {
        const aspects = touched.get(id) ?? new Set<SidebarAspect>();
        aspects.add(aspect);
        touched.set(id, aspects);
    };
    for (const operation of operations) {
        if (operation.type === "insert") {
            // Whoever makes a node chose everything it starts with.
            const node = operation.node;
            touch(node.id, "place");
            if (node.type === "section") {
                touch(node.id, "label");
                touch(node.id, "fold");
            } else if (node.type === "space") {
                touch(node.id, "fold");
                if (node.foldRibbon !== undefined) touch(node.id, "foldRibbon");
            } else if (node.type === "widget") touch(node.id, "html");
        } else if (operation.type !== "set") touch(operation.id, "place");
        else {
            if (operation.collapsed !== undefined || operation.expanded !== undefined)
                touch(operation.id, "fold");
            if (operation.label !== undefined) touch(operation.id, "label");
            if (operation.foldRibbon !== undefined) touch(operation.id, "foldRibbon");
            if (operation.html !== undefined) touch(operation.id, "html");
        }
    }
    for (const id of regroupedSidebarIds(before, after)) touch(id, "place");
    for (const [id, aspects] of touched) {
        const entry: SidebarAuthorship = { ...next[id] };
        for (const aspect of aspects) entry[aspect] = author;
        // Most recently set last, so trimming forgets the oldest.
        delete next[id];
        next[id] = entry;
    }
    const keys = Object.keys(next);
    for (const id of keys.slice(0, Math.max(0, keys.length - KEPT))) delete next[id];
    return next;
}

/**
 * The authorship after the person's `set` operations that changed nothing, such as
 * `expanded: true` on a row already open: the aspects they name are still the person's choice, so
 * Prioritizing may not change them later. Operations on nodes no longer in the document are skipped.
 */
export function affirmSidebarAuthorship(
    authorship: Readonly<Record<string, SidebarAuthorship>>,
    document: SpaceSidebarDocument,
    requested: readonly SpaceSidebarOperation[],
): Record<string, SidebarAuthorship> {
    const sets = requested.filter(
        (operation) =>
            operation.type === "set" &&
            locateSpaceSidebarNode(document, operation.id) !== undefined,
    );
    return sets.length === 0
        ? { ...authorship }
        : recordSidebarAuthorship(authorship, document, document, sets, "person");
}
