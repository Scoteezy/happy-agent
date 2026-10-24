import {
    applySpaceSidebarOperations,
    locateSpaceSidebarNode,
    SpaceSidebarError,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import type { SidebarNode } from "./sidebarLayout.js";

/** The top-level item a node sits under, or the node itself at the top level. */
export function topLevelSidebarId(document: SpaceSidebarDocument, id: string): string {
    let at = locateSpaceSidebarNode(document, id);
    while (at !== undefined && at.parentId !== "nav")
        at = locateSpaceSidebarNode(document, at.parentId);
    return at?.node.id ?? id;
}

/**
 * A space attached under a row stays in the sidebar when someone takes it out: each `remove` of a
 * nested space becomes a move to the top level right after the row that held it. The operations
 * are followed one at a time, with `base` as the batch applies them; from the first that cannot
 * apply, the rest are left as they are, so applying them refuses that one.
 */
export function liftRemovedAttachments(
    document: SpaceSidebarDocument,
    operations: readonly SpaceSidebarOperation[],
    isSpace: (id: string) => boolean,
    base?: SpaceSidebarDocument,
): SpaceSidebarOperation[] {
    let working = document;
    const lifted: SpaceSidebarOperation[] = [];
    for (const [index, operation] of operations.entries()) {
        let next = operation;
        if (operation.type === "remove" && isSpace(operation.id)) {
            const at = locateSpaceSidebarNode(working, operation.id);
            if (at !== undefined && at.parentId !== "nav")
                next = {
                    type: "move",
                    id: operation.id,
                    to: { after: topLevelSidebarId(working, operation.id) },
                };
        }
        try {
            working = applySpaceSidebarOperations(
                working,
                [next],
                base === undefined ? {} : { base },
            ).document;
        } catch (error: unknown) {
            if (!(error instanceof SpaceSidebarError)) throw error;
            return [...lifted, next, ...operations.slice(index + 1)];
        }
        lifted.push(next);
    }
    return lifted;
}

/**
 * Before a row or session leaves, the spaces attached under it move to the top level right after
 * its top-level row, in their order, carrying what is nested in them. Its sessions leave with it.
 */
export function liftAttachmentsOut(
    document: SpaceSidebarDocument,
    hostId: string,
    isSpace: (id: string) => boolean,
): SpaceSidebarOperation[] {
    const host = locateSpaceSidebarNode(document, hostId);
    if (host === undefined || host.node.type !== "space") return [];
    const attached: string[] = [];
    const visit = (nodes: readonly SidebarNode[]) => {
        for (const node of nodes) {
            if (node.type !== "space") continue;
            if (isSpace(node.id)) attached.push(node.id);
            else visit(node.children);
        }
    };
    visit(host.node.children);
    let after = topLevelSidebarId(document, hostId);
    return attached.map((id) => {
        const operation: SpaceSidebarOperation = { type: "move", id, to: { after } };
        after = id;
        return operation;
    });
}
