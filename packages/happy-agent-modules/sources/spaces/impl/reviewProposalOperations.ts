import {
    applySpaceSidebarOperations,
    SpaceSidebarError,
    spaceSidebarRunLength,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import type { SidebarAspect } from "../Space.js";
import { describeSidebarOperation } from "./applyPrioritizingOperations.js";
import { agedLabel } from "./reviewPrioritizingOperation.js";

/** The section that, in a proposal only, heads the rows offered for archiving. */
export const ARCHIVE_SECTION_ID = "archive";
export const ARCHIVE_SECTION_LABEL = "Archive";

/** The IDs of every item in a proposal's Archive block, the heading excluded. */
export function archiveOffers(document: SpaceSidebarDocument): string[] {
    const index = document.items.findIndex(
        (item) => item.type === "section" && item.id === ARCHIVE_SECTION_ID,
    );
    if (index < 0) return [];
    return document.items
        .slice(index + 1, index + spaceSidebarRunLength(document.items, index))
        .map((item) => item.id);
}

/** The proposal as the sidebar would take it: no Archive heading and none of `leaving`. */
export function withoutArchive(
    document: SpaceSidebarDocument,
    leaving: ReadonlySet<string>,
): SpaceSidebarDocument {
    return {
        ...document,
        items: document.items.filter(
            (item) =>
                !leaving.has(item.id) &&
                !(item.type === "section" && item.id === ARCHIVE_SECTION_ID),
        ),
    };
}

/**
 * Prioritizing's revision of a proposal, applied one operation at a time. An operation is dropped
 * with a note when it would change what the person set in this proposal, name a section by age, or
 * offer something for archiving that may not be archived; the rest still apply.
 */
export function reviewProposalOperations(
    document: SpaceSidebarDocument,
    operations: readonly SpaceSidebarOperation[],
    rules: {
        /** Whether the person set this aspect of the node in this proposal. */
        readonly person: (id: string, aspect: SidebarAspect) => boolean;
        /** Why this item may not be offered for archiving, or `undefined` when it may. */
        readonly mayNotArchive: (id: string) => string | undefined;
    },
): { document: SpaceSidebarDocument; operations: SpaceSidebarOperation[]; notes: string[] } {
    let working = document;
    const applied: SpaceSidebarOperation[] = [];
    const notes: string[] = [];
    for (const operation of operations) {
        let step: ReturnType<typeof applySpaceSidebarOperations>;
        try {
            step = applySpaceSidebarOperations(working, [operation]);
        } catch (error: unknown) {
            if (!(error instanceof SpaceSidebarError)) throw error;
            notes.push(`Dropped ${describeSidebarOperation(operation)}: ${error.message}`);
            continue;
        }
        const done = step.operations[0];
        if (done === undefined) continue;
        const refusal = review(working, step.document, done, rules);
        if (refusal !== undefined) {
            notes.push(`Dropped ${describeSidebarOperation(operation)}: ${refusal}`);
            continue;
        }
        working = step.document;
        applied.push(done);
    }
    return { document: working, operations: applied, notes };
}

function review(
    before: SpaceSidebarDocument,
    after: SpaceSidebarDocument,
    operation: SpaceSidebarOperation,
    rules: Parameters<typeof reviewProposalOperations>[2],
): string | undefined {
    const target = operation.type === "insert" ? operation.node.id : operation.id;
    const kept = "Keep the person's edit of this proposal.";
    if (operation.type !== "set" && rules.person(target, "place")) return kept;
    if (operation.type === "set") {
        if (
            (operation.collapsed !== undefined || operation.expanded !== undefined) &&
            rules.person(target, "fold")
        )
            return kept;
        if (operation.label !== undefined && rules.person(target, "label")) return kept;
        if (operation.foldRibbon !== undefined && rules.person(target, "foldRibbon")) return kept;
        if (operation.html !== undefined && rules.person(target, "html")) return kept;
    }
    const label =
        operation.type === "set"
            ? operation.label
            : operation.type === "insert" && operation.node.type === "section"
              ? operation.node.label
              : undefined;
    if (target === ARCHIVE_SECTION_ID) {
        if (label !== undefined && label !== ARCHIVE_SECTION_LABEL)
            return `The archive section is labelled "${ARCHIVE_SECTION_LABEL}".`;
    } else if (label !== undefined && agedLabel(label)) {
        return `Section "${label}" sorts by age or whether work is finished; name a subject, or use Stale for quiet unfinished work.`;
    }
    const offered = new Set(archiveOffers(before));
    for (const id of archiveOffers(after)) {
        if (offered.has(id)) continue;
        const refusal = rules.mayNotArchive(id);
        if (refusal !== undefined) return refusal;
    }
    return undefined;
}
