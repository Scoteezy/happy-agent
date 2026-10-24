import {
    applySpaceSidebarOperations,
    locateSpaceSidebarNode,
    SpaceSidebarError,
    spaceSidebarRunLength,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import type { SidebarAspect } from "../Space.js";
import { describeSidebarOperation } from "./applyPrioritizingOperations.js";
import { agedLabel, STALE_SECTION_LABEL } from "./reviewPrioritizingOperation.js";
import { regroupedSidebarIds, shownSidebarRows, sidebarIds } from "./sidebarLayout.js";

/** The section that, in a proposal only, heads the rows offered for archiving. */
export const ARCHIVE_SECTION_ID = "archive";
export const ARCHIVE_SECTION_LABEL = "Archive";

/** The IDs of every item in a proposal's Archive block, the heading excluded. */
export function archiveOffers(document: SpaceSidebarDocument): string[] {
    return sectionBlock(
        document,
        (item) => item.type === "section" && item.id === ARCHIVE_SECTION_ID,
    );
}

/** The IDs of every item in the blocks of sections labelled Stale, the headings excluded. */
function staleRows(document: SpaceSidebarDocument): string[] {
    return sectionBlock(
        document,
        (item) => item.type === "section" && item.label.trim() === STALE_SECTION_LABEL,
    );
}

function sectionBlock(
    document: SpaceSidebarDocument,
    heading: (item: SpaceSidebarDocument["items"][number]) => boolean,
): string[] {
    return document.items.flatMap((item, index) =>
        heading(item)
            ? document.items
                  .slice(index + 1, index + spaceSidebarRunLength(document.items, index))
                  .map((member) => member.id)
            : [],
    );
}

/**
 * The top-level rows above the sidebar's first separator whose place the person set: what they
 * keep at the top, which a proposal builds around and never moves. Without a separator, none.
 */
export function keptAboveSeparator(
    document: SpaceSidebarDocument,
    placedByPerson: (id: string) => boolean,
): Set<string> {
    const end = document.items.findIndex((item) => item.type === "separator");
    if (end < 0) return new Set();
    return new Set(
        document.items
            .slice(0, end)
            .filter((item) => item.type === "space" && placedByPerson(item.id))
            .map((item) => item.id),
    );
}

/** The labels of open sections with rows, none of them in `keep`: what a proposal could fold. */
export function quietOpenSections(
    document: SpaceSidebarDocument,
    keep: ReadonlySet<string>,
): string[] {
    return document.items.flatMap((item, index) => {
        if (item.type !== "section" || item.collapsed || item.id === ARCHIVE_SECTION_ID) return [];
        const rows = document.items.slice(
            index + 1,
            index + spaceSidebarRunLength(document.items, index),
        );
        return rows.length > 0 && rows.every((row) => !keep.has(row.id)) ? [item.label] : [];
    });
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

type ProposalRules = {
    /** Whether the person set this aspect of the node in this proposal. */
    readonly person: (id: string, aspect: SidebarAspect) => boolean;
    /** Why this item may not be offered for archiving, or `undefined` when it may. */
    readonly mayNotArchive: (id: string) => string | undefined;
    /** Why this item may not change section, leave, or fold out of view, such as Happy. */
    readonly mayNotMove: (id: string) => string | undefined;
    /**
     * Why this item may not leave or fold out of view, though it may change section, such as
     * work active in the last two hours: accepting the proposal is the person's consent to
     * regroup it, never to hide what they are working on.
     */
    readonly mayNotHide: (id: string) => string | undefined;
    /** Why this item may not go into Stale, or `undefined` when it may. */
    readonly mayNotStale: (id: string) => string | undefined;
    /**
     * Whether the person keeps this row above the separator. It may not be moved, and the
     * proposal as a whole may not hide it, offer it for Archive or Stale, or leave it below the
     * first separator; the headings around it may still be inserted, renamed, or removed.
     */
    readonly keptAtTop: (id: string) => boolean;
};

/**
 * Prioritizing's revision of a proposal, applied one operation at a time. An operation is dropped
 * with a note when it would change what the person set in this proposal, name a section by age or
 * status, move what may not move or fold away what must stay in view, or offer something for
 * archiving or Stale that may not go there; the rest still apply. A row the person keeps above
 * the separator is checked against the whole proposal, so the order of the edits does not
 * matter: the edit that leaves it out of place for good is dropped, and the rest are reviewed
 * again.
 */
export function reviewProposalOperations(
    document: SpaceSidebarDocument,
    operations: readonly SpaceSidebarOperation[],
    rules: ProposalRules,
): { document: SpaceSidebarDocument; operations: SpaceSidebarOperation[]; notes: string[] } {
    const dropped = new Map<number, string>();
    for (;;) {
        const run = applyReviewed(document, operations, rules, dropped);
        const breach = keptBreach(document, run.states, rules);
        if (breach === undefined)
            return { document: run.document, operations: run.operations, notes: run.notes };
        dropped.set(breach.index, breach.reason);
    }
}

function applyReviewed(
    document: SpaceSidebarDocument,
    operations: readonly SpaceSidebarOperation[],
    rules: ProposalRules,
    dropped: ReadonlyMap<number, string>,
) {
    let working = document;
    const applied: SpaceSidebarOperation[] = [];
    const notes: string[] = [];
    const states: { index: number; document: SpaceSidebarDocument }[] = [];
    for (const [index, operation] of operations.entries()) {
        const reason = dropped.get(index);
        if (reason !== undefined) {
            notes.push(`Dropped ${describeSidebarOperation(operation)}: ${reason}`);
            continue;
        }
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
        states.push({ index, document: working });
    }
    return { document: working, operations: applied, notes, states };
}

/**
 * The first kept row the proposal leaves out of place, and the edit from which it stays so: the
 * earliest one after which every document leaves it out of place. Nothing when every kept row is
 * where the person keeps it, or was already out of place in the draft it revises.
 */
function keptBreach(
    document: SpaceSidebarDocument,
    states: readonly { index: number; document: SpaceSidebarDocument }[],
    rules: ProposalRules,
): { index: number; reason: string } | undefined {
    for (const { id } of document.items) {
        if (!rules.keptAtTop(id) || keptOutOfPlace(document, document, id) !== undefined) continue;
        let breach: { index: number; reason: string } | undefined;
        for (let at = states.length - 1; at >= 0; at--) {
            const reason = keptOutOfPlace(document, states[at]!.document, id);
            if (reason === undefined) break;
            breach = { index: states[at]!.index, reason };
        }
        if (breach !== undefined) return breach;
    }
    return undefined;
}

/** Why `document` leaves a row the person keeps above the separator out of place, if it does. */
function keptOutOfPlace(
    base: SpaceSidebarDocument,
    document: SpaceSidebarDocument,
    id: string,
): string | undefined {
    if (locateSpaceSidebarNode(document, id) === undefined)
        return `The person keeps ${id} above the separator; do not remove it.`;
    const at = document.items.findIndex((item) => item.id === id);
    if (at < 0) return `The person keeps ${id} above the separator; do not move it.`;
    const end = document.items.findIndex((item) => item.type === "separator");
    if (end < 0 || at > end)
        return `This would put ${id} below the separator, where the person keeps it above.`;
    if (archiveOffers(document).includes(id) && !archiveOffers(base).includes(id))
        return `${id} stays shown where the person keeps it; do not offer it for archiving.`;
    if (staleRows(document).includes(id) && !staleRows(base).includes(id))
        return `${id} stays shown where the person keeps it; do not put it in Stale.`;
    if (!shownSidebarRows(document).includes(id)) {
        const heading = document.items
            .slice(0, at)
            .findLast((item) => item.type === "section" || item.type === "separator");
        return heading?.type === "section" && heading.collapsed
            ? `Section "${heading.label}" is folded and would fold ${id}, which the person keeps shown; leave it open, or add a heading right above ${id}.`
            : `${id} stays shown where the person keeps it.`;
    }
    return undefined;
}

function review(
    before: SpaceSidebarDocument,
    after: SpaceSidebarDocument,
    operation: SpaceSidebarOperation,
    rules: ProposalRules,
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
    if (operation.type === "move" && rules.keptAtTop(target))
        return `The person keeps ${target} above the separator; do not move it.`;
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
        return `Section "${label}" sorts by age, status, or whether work is finished; name a subject, or use Stale for quiet unfinished work.`;
    }
    // What leaves or folds out of view, and what changes section; a section moved as a block
    // carries its rows without regrouping them.
    const hidden = new Set<string>();
    if (operation.type === "remove") {
        const at = locateSpaceSidebarNode(before, target);
        for (const id of at === undefined ? [target] : sidebarIds([at.node])) hidden.add(id);
    }
    const shownAfter = new Set(shownSidebarRows(after));
    for (const id of shownSidebarRows(before)) if (!shownAfter.has(id)) hidden.add(id);
    const moved = new Set([...regroupedSidebarIds(before, after), ...hidden]);
    if (operation.type === "move") moved.add(target);
    for (const id of moved) {
        const refusal = rules.mayNotMove(id) ?? (hidden.has(id) ? rules.mayNotHide(id) : undefined);
        if (refusal !== undefined) return refusal;
    }
    const offered = new Set(archiveOffers(before));
    for (const id of archiveOffers(after)) {
        if (offered.has(id)) continue;
        const refusal = rules.mayNotArchive(id);
        if (refusal !== undefined) return refusal;
    }
    const stale = new Set(staleRows(before));
    for (const id of staleRows(after)) {
        if (stale.has(id)) continue;
        const refusal = rules.mayNotStale(id);
        if (refusal !== undefined) return refusal;
    }
    return undefined;
}
