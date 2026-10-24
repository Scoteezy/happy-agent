import {
    locateSpaceSidebarNode,
    type SpaceSidebarDocument,
    type SpaceSidebarOperation,
} from "@slopus/happy-agent-client";

import type { PrioritizingRules } from "./reviewPrioritizingOperation.js";
import { regroupedSidebarIds } from "./sidebarLayout.js";

/** The folded section for work outside the person's focus, which a batch may add without a proposal. */
export const DISTRACTIONS_SECTION_ID = "distractions";

/**
 * Why one of Prioritizing's operations may not apply without the person's consent, or
 * `undefined` when it may. A batch only places new work, adds Distractions, adds Prioritizing's
 * own row, and changes what is nested under a row; anything larger is a proposal the person accepts.
 */
export function reviewDirectOperation(
    before: SpaceSidebarDocument,
    after: SpaceSidebarDocument,
    operation: SpaceSidebarOperation,
    rules: Pick<PrioritizingRules, "fresh" | "rows" | "focusId">,
): string | undefined {
    const nested = (document: SpaceSidebarDocument, id: string) => {
        const at = locateSpaceSidebarNode(document, id);
        return at !== undefined && at.parentId !== "nav";
    };
    const refusal =
        "without a proposal your edits only place new work, add Distractions, add your own row, and change what is nested under a row. Propose it with propose_sidebar instead.";
    switch (operation.type) {
        case "set": {
            const { type: _type, id: _id, expanded, ...rest } = operation;
            if (expanded === undefined || Object.keys(rest).length > 0) return refusal;
            break;
        }
        case "insert": {
            const node = operation.node;
            const allowed =
                nested(after, node.id) ||
                (node.type === "space" && node.id === rules.focusId) ||
                (node.type === "section" &&
                    node.id === DISTRACTIONS_SECTION_ID &&
                    node.label === "Distractions" &&
                    node.collapsed === true);
            if (!allowed) return refusal;
            break;
        }
        case "move":
            if (
                !nested(before, operation.id) &&
                !nested(after, operation.id) &&
                !rules.fresh.has(operation.id)
            )
                return refusal;
            break;
        case "remove":
            if (!nested(before, operation.id)) return refusal;
            break;
    }
    const target = operation.type === "insert" ? operation.node.id : operation.id;
    const regrouped = regroupedSidebarIds(before, after).filter(
        (id) => id !== target && rules.rows.has(id) && !rules.fresh.has(id),
    );
    if (regrouped.length > 0)
        return `it would put ${regrouped.join(", ")} under another heading, and ${refusal}`;
    return undefined;
}
