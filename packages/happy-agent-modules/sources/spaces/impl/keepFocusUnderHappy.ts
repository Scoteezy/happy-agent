import {
    applySpaceSidebarOperations,
    SpaceSidebarError,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

/** Whether Prioritizing's row stands at the top level right after Happy's. */
export function focusFollowsHappy(
    document: SpaceSidebarDocument,
    happyId: string,
    focusId: string,
): boolean {
    const at = document.items.findIndex((item) => item.id === happyId);
    return at >= 0 && document.items[at + 1]?.id === focusId;
}

/**
 * Happy and Prioritizing's row below it are one anchor: what Prioritizing or the daemon puts
 * "after Happy" goes after Prioritizing's row instead, so nothing ever comes between the two.
 * Positions are rewritten one operation at a time, against the document each one meets.
 */
export function keepFocusUnderHappy(
    document: SpaceSidebarDocument,
    operations: readonly SpaceSidebarOperation[],
    happyId: string | undefined,
    focusId: string | undefined,
): SpaceSidebarOperation[] {
    if (happyId === undefined || focusId === undefined) return [...operations];
    let working = document;
    return operations.map((operation) => {
        const moving = operation.type === "insert" ? operation.node.id : operation.id;
        const rewritten =
            (operation.type === "insert" || operation.type === "move") &&
            moving !== focusId &&
            "after" in operation.to &&
            operation.to.after === happyId &&
            focusFollowsHappy(working, happyId, focusId)
                ? { ...operation, to: { after: focusId } }
                : operation;
        try {
            working = applySpaceSidebarOperations(working, [rewritten]).document;
        } catch (error: unknown) {
            // The caller reports an operation that does not apply; this only moves positions.
            if (!(error instanceof SpaceSidebarError)) throw error;
        }
        return rewritten;
    });
}
