/**
 * Applies operations to the sidebar document. This is the function the daemon applies every batch
 * with, so a client that applies its own unconfirmed batches with it draws exactly what the daemon
 * will commit, and a client replaying `space.sidebar.changed` reaches exactly the announced version.
 */

import { Value } from "@sinclair/typebox/value";

import {
    formatSpaceSidebar,
    SPACE_SIDEBAR_LIMITS,
    SPACE_SIDEBAR_RESERVED_IDS,
    SpaceSidebarError,
    utf8Length,
    widgetCheck,
} from "./spaceSidebarDocument.js";
import {
    spaceSidebarOperationSchema,
    type SpaceSidebarDocument,
    type SpaceSidebarItem,
    type SpaceSidebarNewNode,
    type SpaceSidebarOperation,
    type SpaceSidebarPosition,
    type SpaceSidebarSpaceNode,
} from "./protocol/spaces.js";

/** The document a batch produced, and the operations that changed it, as they applied. */
export interface SpaceSidebarApplication {
    readonly document: SpaceSidebarDocument;
    /**
     * What applied: an `after` anchor that fell back is replaced by the position used, and
     * operations that changed nothing are left out. Applying these to the same document without a
     * base gives the same result.
     */
    readonly operations: SpaceSidebarOperation[];
}

/** An operation that cannot apply; `operationIndex` is its zero-based place in the batch. */
export class SpaceSidebarOperationError extends SpaceSidebarError {
    readonly operationIndex: number;

    constructor(operationIndex: number, operation: SpaceSidebarOperation, reason: string) {
        super(
            `Operation ${String(operationIndex)} (${describe(operation)}) cannot apply: ${reason}`,
        );
        this.name = "SpaceSidebarOperationError";
        this.operationIndex = operationIndex;
    }
}

/**
 * Applies `operations` in order to `document`, which is left unchanged. With `base` — the version
 * the operations were made against — an `after` anchor that is gone falls back to the nearest node
 * that preceded it among its siblings in `base` and still sits under the same parent, or first
 * under that parent. Without `base` a missing anchor cannot apply. Throws
 * `SpaceSidebarOperationError` for the first operation that cannot apply.
 */
export function applySpaceSidebarOperations(
    document: SpaceSidebarDocument,
    operations: readonly SpaceSidebarOperation[],
    options: { readonly base?: SpaceSidebarDocument } = {},
): SpaceSidebarApplication {
    const working = structuredClone(document) as SpaceSidebarDocument;
    const applied: SpaceSidebarOperation[] = [];
    for (const [index, operation] of operations.entries()) {
        const done = applyOperation(working, operation, options.base, index);
        if (done !== undefined) applied.push(done);
    }
    if (utf8Length(formatSpaceSidebar(working)) > SPACE_SIDEBAR_LIMITS.bytes) {
        // Find the first operation that crossed the limit, so the refusal names it.
        const probe = structuredClone(document) as SpaceSidebarDocument;
        for (const [index, operation] of operations.entries()) {
            applyOperation(probe, operation, options.base, index);
            if (utf8Length(formatSpaceSidebar(probe)) > SPACE_SIDEBAR_LIMITS.bytes)
                throw new SpaceSidebarOperationError(
                    index,
                    operation,
                    "the sidebar would exceed 128 KiB.",
                );
        }
    }
    return { document: working, operations: applied };
}

/**
 * Applies one operation to `document` in place and returns it as applied, or `undefined` when it
 * changed nothing. Shared with the document differ; not part of the public surface.
 */
export function applyOperation(
    document: SpaceSidebarDocument,
    operation: SpaceSidebarOperation,
    base: SpaceSidebarDocument | undefined,
    index: number,
): SpaceSidebarOperation | undefined {
    if (!Value.Check(spaceSidebarOperationSchema, operation))
        throw new SpaceSidebarOperationError(
            index,
            operation,
            "it is not a valid sidebar operation.",
        );
    try {
        switch (operation.type) {
            case "insert":
                return insert(document, operation, base);
            case "move":
                return move(document, operation, base);
            case "remove":
                return remove(document, operation);
            case "set":
                return set(document, operation);
        }
    } catch (error: unknown) {
        if (error instanceof SpaceSidebarError && !(error instanceof SpaceSidebarOperationError))
            throw new SpaceSidebarOperationError(index, operation, error.message);
        throw error;
    }
}

type Node = SpaceSidebarItem | SpaceSidebarSpaceNode;

/** Where a node sits: its sibling list, its parent's ID (`nav` at the top), and its depth. */
export interface SpaceSidebarLocation {
    readonly node: Node;
    readonly siblings: Node[];
    readonly parentId: string;
    /** Element depth: `nav` is 1, the top-level items 2. */
    readonly depth: number;
}

/** Finds a node by ID anywhere in the document. */
export function locateSpaceSidebarNode(
    document: SpaceSidebarDocument,
    id: string,
): SpaceSidebarLocation | undefined {
    const search = (
        siblings: Node[],
        parentId: string,
        depth: number,
    ): SpaceSidebarLocation | undefined => {
        for (const node of siblings) {
            if (node.id === id) return { node, siblings, parentId, depth };
            if (node.type === "space") {
                const found = search(node.children, node.id, depth + 1);
                if (found !== undefined) return found;
            }
        }
        return undefined;
    };
    return search(document.items, "nav", 2);
}

/**
 * How many items a move of the item at `index` takes along: a section takes its block, the
 * heading and every item after it up to the next section or separator; anything else only itself.
 */
export function spaceSidebarRunLength(siblings: readonly Node[], index: number): number {
    if (siblings[index]?.type !== "section") return 1;
    let end = index + 1;
    while (
        end < siblings.length &&
        siblings[end]!.type !== "section" &&
        siblings[end]!.type !== "separator"
    )
        end++;
    return end - index;
}

function insert(
    document: SpaceSidebarDocument,
    operation: Extract<SpaceSidebarOperation, { type: "insert" }>,
    base: SpaceSidebarDocument | undefined,
): SpaceSidebarOperation {
    const node = operation.node;
    if (SPACE_SIDEBAR_RESERVED_IDS.includes(node.id))
        throw new SpaceSidebarError(`the ID ${node.id} is reserved.`);
    if (locateSpaceSidebarNode(document, node.id) !== undefined)
        throw new SpaceSidebarError(`${node.id} is already in the sidebar.`);
    if (node.type === "widget") widgetCheck(node.html);
    const place = resolve(document, operation.to, base);
    standCheck(node.type, place.parentId);
    if (place.depth > SPACE_SIDEBAR_LIMITS.depth)
        throw new SpaceSidebarError("the sidebar would nest deeper than 16.");
    if (elementCount(document) + 1 > SPACE_SIDEBAR_LIMITS.elements)
        throw new SpaceSidebarError("the sidebar would hold more than 1,000 elements.");
    place.siblings.splice(place.index, 0, nodeOf(node));
    return { type: "insert", node: operation.node, to: place.position };
}

function move(
    document: SpaceSidebarDocument,
    operation: Extract<SpaceSidebarOperation, { type: "move" }>,
    base: SpaceSidebarDocument | undefined,
): SpaceSidebarOperation | undefined {
    if (operation.id === "nav") throw new SpaceSidebarError("the nav root cannot move.");
    const at = locateSpaceSidebarNode(document, operation.id);
    if (at === undefined)
        throw new SpaceSidebarError(`${operation.id} is no longer in the sidebar.`);
    const from = at.siblings.indexOf(at.node);
    const moving = at.siblings.slice(from, from + spaceSidebarRunLength(at.siblings, from));
    const target = "after" in operation.to ? operation.to.after : operation.to.parent;
    if (target !== null && moving.some((node) => contains(node, target)))
        throw new SpaceSidebarError(`${operation.id} cannot move into itself or what it carries.`);
    at.siblings.splice(from, moving.length);
    const place = resolve(document, operation.to, base);
    for (const node of moving) {
        standCheck(node.type, place.parentId);
        if (place.depth + height(node) - 1 > SPACE_SIDEBAR_LIMITS.depth)
            throw new SpaceSidebarError("the sidebar would nest deeper than 16.");
    }
    place.siblings.splice(place.index, 0, ...moving);
    if (place.siblings === at.siblings && place.index === from) return undefined;
    return { type: "move", id: operation.id, to: place.position };
}

function remove(
    document: SpaceSidebarDocument,
    operation: Extract<SpaceSidebarOperation, { type: "remove" }>,
): SpaceSidebarOperation | undefined {
    if (SPACE_SIDEBAR_RESERVED_IDS.includes(operation.id))
        throw new SpaceSidebarError(`${operation.id} cannot be removed.`);
    const at = locateSpaceSidebarNode(document, operation.id);
    // Already gone: what the operation asked for is true.
    if (at === undefined) return undefined;
    at.siblings.splice(at.siblings.indexOf(at.node), 1);
    return operation;
}

function set(
    document: SpaceSidebarDocument,
    operation: Extract<SpaceSidebarOperation, { type: "set" }>,
): SpaceSidebarOperation | undefined {
    const { type: _type, id, ...fields } = operation;
    const given = Object.keys(fields) as (keyof typeof fields)[];
    if (given.length === 0) throw new SpaceSidebarError("it changes nothing.");
    const node: { type: string; [field: string]: unknown } | undefined =
        id === "nav"
            ? (document as unknown as { type: string })
            : locateSpaceSidebarNode(document, id)?.node;
    if (node === undefined) throw new SpaceSidebarError(`${id} is no longer in the sidebar.`);
    const kind = id === "nav" ? "nav" : node.type;
    const allowed: Record<string, readonly string[]> = {
        nav: ["foldRibbon"],
        section: ["label", "collapsed"],
        space: ["expanded", "foldRibbon"],
        widget: ["html"],
    };
    for (const field of given)
        if (!(allowed[kind] ?? []).includes(field))
            throw new SpaceSidebarError(
                `${kind === "nav" ? "the nav" : `a ${kind}`} has no ${field}.`,
            );
    if (fields.html !== undefined) widgetCheck(fields.html);
    const changed: Record<string, unknown> = {};
    for (const field of given) {
        const value = fields[field];
        if (field === "foldRibbon" && value === null) {
            if (node[field] === undefined) continue;
            delete node[field];
        } else {
            if (node[field] === value) continue;
            node[field] = value;
        }
        changed[field] = value;
    }
    if (Object.keys(changed).length === 0) return undefined;
    return { type: "set", id, ...changed } as SpaceSidebarOperation;
}

interface Place {
    readonly siblings: Node[];
    readonly index: number;
    readonly parentId: string;
    /** The depth a node placed here stands at. */
    readonly depth: number;
    /** The position as applied: the anchor actually used. */
    readonly position: SpaceSidebarPosition;
}

function resolve(
    document: SpaceSidebarDocument,
    to: SpaceSidebarPosition,
    base: SpaceSidebarDocument | undefined,
): Place {
    if ("parent" in to) return first(document, to.parent);
    if (to.after === "nav") throw new SpaceSidebarError("nothing stands after the nav root.");
    const anchor = locateSpaceSidebarNode(document, to.after);
    if (anchor !== undefined)
        return {
            siblings: anchor.siblings,
            index: anchor.siblings.indexOf(anchor.node) + 1,
            parentId: anchor.parentId,
            depth: anchor.depth,
            position: { after: to.after },
        };
    const before = base === undefined ? undefined : locateSpaceSidebarNode(base, to.after);
    if (before === undefined) throw new SpaceSidebarError(`${to.after} is not in the sidebar.`);
    // The anchor left: follow the nearest node that preceded it and is still under its parent.
    for (let index = before.siblings.indexOf(before.node) - 1; index >= 0; index--) {
        const candidate = locateSpaceSidebarNode(document, before.siblings[index]!.id);
        if (candidate !== undefined && candidate.parentId === before.parentId)
            return {
                siblings: candidate.siblings,
                index: candidate.siblings.indexOf(candidate.node) + 1,
                parentId: candidate.parentId,
                depth: candidate.depth,
                position: { after: candidate.node.id },
            };
    }
    return first(document, before.parentId === "nav" ? null : before.parentId);
}

function first(document: SpaceSidebarDocument, parent: string | null): Place {
    if (parent === null)
        return {
            siblings: document.items,
            index: 0,
            parentId: "nav",
            depth: 2,
            position: { parent: null },
        };
    const holder = locateSpaceSidebarNode(document, parent);
    if (holder === undefined) throw new SpaceSidebarError(`${parent} is no longer in the sidebar.`);
    if (holder.node.type !== "space")
        throw new SpaceSidebarError(`only a row or a session holds sessions, not ${parent}.`);
    return {
        siblings: holder.node.children,
        index: 0,
        parentId: parent,
        depth: holder.depth + 1,
        position: { parent },
    };
}

/** Rows and sessions may stand under a row or session; every other kind only in the list. */
function standCheck(type: Node["type"], parentId: string): void {
    if (parentId !== "nav" && type !== "space")
        throw new SpaceSidebarError(`a ${type} stands only in the top-level list.`);
}

function nodeOf(node: SpaceSidebarNewNode): Node {
    switch (node.type) {
        case "space":
            return {
                type: "space",
                id: node.id,
                expanded: node.expanded === true,
                ...(node.foldRibbon === undefined ? {} : { foldRibbon: node.foldRibbon }),
                children: [],
            };
        case "section":
            return {
                type: "section",
                id: node.id,
                label: node.label,
                collapsed: node.collapsed === true,
            };
        case "separator":
            return { type: "separator", id: node.id };
        case "widget":
            return { type: "widget", id: node.id, html: node.html };
    }
}

function contains(node: Node, id: string): boolean {
    return (
        node.id === id ||
        (node.type === "space" && node.children.some((child) => contains(child, id)))
    );
}

function height(node: Node): number {
    return node.type === "space" ? 1 + Math.max(0, ...node.children.map(height)) : 1;
}

function elementCount(document: SpaceSidebarDocument): number {
    const count = (node: Node): number =>
        1 +
        (node.type === "space" ? node.children.reduce((sum, child) => sum + count(child), 0) : 0);
    return 1 + document.items.reduce((sum, item) => sum + count(item), 0);
}

function describe(operation: SpaceSidebarOperation): string {
    return `${operation.type} ${operation.type === "insert" ? operation.node.id : operation.id}`;
}
