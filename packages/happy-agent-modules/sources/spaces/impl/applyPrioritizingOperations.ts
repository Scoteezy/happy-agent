import {
    applySpaceSidebarOperations,
    SpaceSidebarError,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import {
    reviewPrioritizingOperation,
    type PrioritizingRules,
} from "./reviewPrioritizingOperation.js";

/**
 * Prioritizing's operations, applied one at a time through the same rebase as the person's. An
 * operation that no longer applies, or that the rules refuse, is dropped with a note saying why,
 * and the rest still apply.
 */
export function applyPrioritizingOperations(
    document: SpaceSidebarDocument,
    operations: readonly SpaceSidebarOperation[],
    rules: PrioritizingRules,
    base: SpaceSidebarDocument | undefined,
): { document: SpaceSidebarDocument; operations: SpaceSidebarOperation[]; notes: string[] } {
    let working = document;
    const applied: SpaceSidebarOperation[] = [];
    const notes: string[] = [];
    for (const operation of operations) {
        let step: ReturnType<typeof applySpaceSidebarOperations>;
        try {
            step = applySpaceSidebarOperations(
                working,
                [operation],
                base === undefined ? {} : { base },
            );
        } catch (error: unknown) {
            if (!(error instanceof SpaceSidebarError)) throw error;
            notes.push(
                `Dropped ${describeSidebarOperation(operation)}: ${error.message.replace(/^Operation \d+ \([^)]*\) cannot apply: /, "")}`,
            );
            continue;
        }
        const done = step.operations[0];
        if (done === undefined) continue;
        const refusal = reviewPrioritizingOperation(working, step.document, done, rules);
        if (refusal !== undefined) {
            notes.push(`Dropped ${describeSidebarOperation(operation)}: ${refusal}`);
            continue;
        }
        working = step.document;
        applied.push(done);
    }
    return { document: working, operations: applied, notes };
}

/** The applied operations, ignoring every rule, for drawing what queued proposals will make. */
export function projectSidebar(
    document: SpaceSidebarDocument,
    proposals: readonly { readonly operations: readonly SpaceSidebarOperation[] }[],
): SpaceSidebarDocument {
    let working = document;
    for (const proposal of proposals)
        for (const operation of proposal.operations) {
            try {
                working = applySpaceSidebarOperations(working, [operation]).document;
            } catch (error: unknown) {
                if (!(error instanceof SpaceSidebarError)) throw error;
            }
        }
    return working;
}

/** An operation in a few words, such as "move s3k8 after releases". */
export function describeSidebarOperation(operation: SpaceSidebarOperation): string {
    const where = (to: Extract<SpaceSidebarOperation, { type: "move" }>["to"]) =>
        "after" in to ? `after ${to.after}` : to.parent === null ? "first" : `into ${to.parent}`;
    switch (operation.type) {
        case "insert":
            return `insert ${operation.node.type} ${operation.node.id} ${where(operation.to)}`;
        case "move":
            return `move ${operation.id} ${where(operation.to)}`;
        case "remove":
            return `remove ${operation.id}`;
        case "set": {
            const { type: _type, id, ...fields } = operation;
            return `set ${Object.keys(fields).join(" and ")} on ${id}`;
        }
    }
}

/** The nodes an operation places: what it inserts or moves. */
export function placedSidebarIds(operations: readonly SpaceSidebarOperation[]): Set<string> {
    return new Set(
        operations.flatMap((operation) =>
            operation.type === "insert"
                ? [operation.node.id]
                : operation.type === "move"
                  ? [operation.id]
                  : [],
        ),
    );
}
