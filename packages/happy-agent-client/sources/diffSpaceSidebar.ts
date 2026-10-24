/**
 * Turns a proposed whole document into operations by node ID, so a whole-document write goes
 * through the same rebase and authorship rules as a batch of operations. The daemon converts
 * Prioritizing's HTML and older clients' whole-document writes with it.
 */

import {
    applyOperation,
    applySpaceSidebarOperations,
    locateSpaceSidebarNode,
    spaceSidebarRunLength,
} from "./applySpaceSidebarOperations.js";
import { formatSpaceSidebar, SpaceSidebarError } from "./spaceSidebarDocument.js";
import type {
    SpaceSidebarDocument,
    SpaceSidebarItem,
    SpaceSidebarNewNode,
    SpaceSidebarOperation,
    SpaceSidebarPosition,
    SpaceSidebarSpaceNode,
} from "./protocol/spaces.js";

type Node = SpaceSidebarItem | SpaceSidebarSpaceNode;

/**
 * The operations that turn `current` into `proposed`. As few items as possible move: the most
 * items stay put at every level, a section whose block travelled whole moves as one block, and
 * only what changed is set. Applying the result to `current` gives `proposed` exactly.
 *
 * With `widgets: false` the proposal comes from a writer that cannot see widgets: it may not
 * contain one, and the current widgets stay where they are.
 */
export function diffSpaceSidebar(
    current: SpaceSidebarDocument,
    proposed: SpaceSidebarDocument,
    options: { readonly widgets?: boolean } = {},
): SpaceSidebarOperation[] {
    const keepWidgets = options.widgets === false;
    if (keepWidgets && proposed.items.some((item) => item.type === "widget"))
        throw new SpaceSidebarError("This write cannot contain widgets.");
    const wanted = formatSpaceSidebar(proposed, { widgets: !keepWidgets });
    // Moving whole blocks keeps a dragged section one move. A proposal that breaks a moved
    // section's block apart is written item by item instead, which is always exact.
    for (const blocks of [true, false]) {
        let operations: SpaceSidebarOperation[];
        try {
            operations = plan(current, proposed, keepWidgets, blocks);
        } catch (error: unknown) {
            if (blocks && error instanceof SpaceSidebarError) continue;
            throw error;
        }
        const { document } = applySpaceSidebarOperations(current, operations);
        if (formatSpaceSidebar(document, { widgets: !keepWidgets }) === wanted) return operations;
    }
    throw new Error("The sidebar change could not be expressed as operations.");
}

function plan(
    current: SpaceSidebarDocument,
    proposed: SpaceSidebarDocument,
    keepWidgets: boolean,
    blocks: boolean,
): SpaceSidebarOperation[] {
    const working = structuredClone(current) as SpaceSidebarDocument;
    const operations: SpaceSidebarOperation[] = [];
    const emit = (operation: SpaceSidebarOperation) => {
        if (applyOperation(working, operation, undefined, operations.length) !== undefined)
            operations.push(operation);
    };
    const visible = (items: readonly SpaceSidebarItem[]) =>
        keepWidgets ? items.filter((item) => item.type !== "widget") : [...items];
    const exists = (id: string) => locateSpaceSidebarNode(working, id) !== undefined;
    const place = (id: string, node: Node, to: SpaceSidebarPosition) =>
        emit(exists(id) ? { type: "move", id, to } : { type: "insert", node: newNode(node), to });

    const target = visible(proposed.items);
    if (blocks) {
        for (const step of topLevelUnits(visible(current.items), target))
            place(step.id, step.node, step.to);
    } else {
        // Item by item: each item lands right after the one before it, so the placed items always
        // lead the list and a section carries only items that are placed again after it.
        for (const [index, node] of target.entries()) {
            if (visible(working.items)[index]?.id === node.id) continue;
            place(node.id, node, index === 0 ? { parent: null } : { after: target[index - 1]!.id });
        }
    }

    // Each row's and session's nested sessions, top down.
    const nest = (parent: SpaceSidebarSpaceNode) => {
        const holder = locateSpaceSidebarNode(working, parent.id)!.node as SpaceSidebarSpaceNode;
        const wanted = parent.children.map((child) => child.id);
        const present = holder.children
            .map((child) => child.id)
            .filter((id) => wanted.includes(id));
        const still = stationary(
            present,
            wanted.filter((id) => present.includes(id)),
        );
        for (const [index, child] of parent.children.entries())
            if (!still.has(child.id))
                place(
                    child.id,
                    child,
                    index === 0 ? { parent: parent.id } : { after: parent.children[index - 1]!.id },
                );
        parent.children.forEach(nest);
    };
    for (const item of target) if (item.type === "space") nest(item);

    // Switches and text.
    const settle = (node: Node) => {
        const now = locateSpaceSidebarNode(working, node.id)!.node;
        const fields = changedFields(now, node);
        if (Object.keys(fields).length > 0) emit({ type: "set", id: node.id, ...fields });
        if (node.type === "space") node.children.forEach(settle);
    };
    target.forEach(settle);
    if ((working.foldRibbon ?? null) !== (proposed.foldRibbon ?? null))
        emit({ type: "set", id: "nav", foldRibbon: proposed.foldRibbon ?? null });

    // Whatever the proposal left out, outermost first; anything it kept was moved out already.
    const kept = new Set<string>();
    const collect = (node: Node) => {
        kept.add(node.id);
        if (node.type === "space") node.children.forEach(collect);
    };
    proposed.items.forEach(collect);
    const leaving: string[] = [];
    const sweep = (node: Node) => {
        if (keepWidgets && node.type === "widget") return;
        if (!kept.has(node.id)) leaving.push(node.id);
        else if (node.type === "space") node.children.forEach(sweep);
    };
    working.items.forEach(sweep);
    for (const id of leaving) emit({ type: "remove", id });
    return operations;
}

/**
 * The top-level moves and inserts, block by block. A section whose current block is the start of
 * its proposed block travels as one unit; everything else is a unit of its own. The longest run of
 * units already in order stays, and every other unit lands right after the unit before it. A
 * section that moved without its block cannot be one move, so this refuses and the caller writes
 * item by item.
 */
function topLevelUnits(
    current: readonly SpaceSidebarItem[],
    proposed: readonly SpaceSidebarItem[],
): { id: string; node: Node; to: SpaceSidebarPosition }[] {
    const runOf = (items: readonly SpaceSidebarItem[], index: number) =>
        items.slice(index + 1, index + spaceSidebarRunLength(items, index)).map((item) => item.id);
    const currentRuns = new Map(
        current.flatMap((item, index) =>
            item.type === "section" ? [[item.id, runOf(current, index)] as const] : [],
        ),
    );
    const whole = new Set<string>();
    for (const [index, item] of proposed.entries()) {
        const before = currentRuns.get(item.id);
        const after = runOf(proposed, index);
        if (before !== undefined && before.every((id, at) => after[at] === id)) whole.add(item.id);
    }
    const units = (items: readonly SpaceSidebarItem[], runs: (id: string) => readonly string[]) => {
        const result: { id: string; node: Node; last: string }[] = [];
        for (let index = 0; index < items.length; index++) {
            const item = items[index]!;
            const run = whole.has(item.id) ? runs(item.id) : [];
            result.push({ id: item.id, node: item, last: run.at(-1) ?? item.id });
            index += run.length;
        }
        return result;
    };
    const before = units(current, (id) => currentRuns.get(id)!);
    const after = units(proposed, (id) => currentRuns.get(id)!);
    const known = new Set(before.map((unit) => unit.id));
    const still = stationary(
        before.map((unit) => unit.id).filter((id) => after.some((unit) => unit.id === id)),
        after.map((unit) => unit.id).filter((id) => known.has(id)),
    );
    for (const unit of after)
        if (
            unit.node.type === "section" &&
            known.has(unit.id) &&
            !still.has(unit.id) &&
            !whole.has(unit.id)
        )
            throw new SpaceSidebarError(`Section ${unit.id} moved without its block.`);
    const steps: { id: string; node: Node; to: SpaceSidebarPosition }[] = [];
    let previous: string | undefined;
    for (const unit of after) {
        if (!still.has(unit.id))
            steps.push({
                id: unit.id,
                node: unit.node,
                to: previous === undefined ? { parent: null } : { after: previous },
            });
        previous = unit.last;
    }
    return steps;
}

/**
 * The keys that keep their place: the longest subsequence of `before` that `after` keeps in order.
 * Both hold the same unique keys. Documents hold at most 1,000 elements, bounding this to 1M pairs.
 */
function stationary(before: readonly string[], after: readonly string[]): Set<string> {
    const positions = new Map(before.map((id, index) => [id, index]));
    const lengths = after.map(() => 1);
    const previous = after.map(() => -1);
    let best = -1;
    for (let index = 0; index < after.length; index++) {
        for (let earlier = 0; earlier < index; earlier++) {
            if (
                positions.get(after[earlier]!)! < positions.get(after[index]!)! &&
                lengths[earlier]! + 1 > lengths[index]!
            ) {
                lengths[index] = lengths[earlier]! + 1;
                previous[index] = earlier;
            }
        }
        if (best === -1 || lengths[index]! > lengths[best]!) best = index;
    }
    const kept = new Set<string>();
    for (let index = best; index !== -1; index = previous[index]!) kept.add(after[index]!);
    return kept;
}

function newNode(node: Node): SpaceSidebarNewNode {
    switch (node.type) {
        case "space":
            return {
                type: "space",
                id: node.id,
                ...(node.expanded ? { expanded: true } : {}),
                ...(node.foldRibbon === undefined ? {} : { foldRibbon: node.foldRibbon }),
            };
        case "section":
            return {
                type: "section",
                id: node.id,
                label: node.label,
                ...(node.collapsed ? { collapsed: true } : {}),
            };
        case "separator":
            return { type: "separator", id: node.id };
        case "widget":
            return { type: "widget", id: node.id, html: node.html };
        case "search":
        case "create":
            throw new SpaceSidebarError(`The sidebar needs exactly one ${node.id}.`);
    }
}

function changedFields(now: Node, wanted: Node): Record<string, unknown> {
    if (now.type === "section" && wanted.type === "section")
        return {
            ...(now.label === wanted.label ? {} : { label: wanted.label }),
            ...(now.collapsed === wanted.collapsed ? {} : { collapsed: wanted.collapsed }),
        };
    if (now.type === "space" && wanted.type === "space")
        return {
            ...(now.expanded === wanted.expanded ? {} : { expanded: wanted.expanded }),
            ...(now.foldRibbon === wanted.foldRibbon
                ? {}
                : { foldRibbon: wanted.foldRibbon ?? null }),
        };
    if (now.type === "widget" && wanted.type === "widget" && now.html !== wanted.html)
        return { html: wanted.html };
    return {};
}
