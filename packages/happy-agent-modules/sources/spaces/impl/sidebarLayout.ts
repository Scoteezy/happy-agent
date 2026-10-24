import {
    formatSpaceSidebar,
    locateSpaceSidebarNode,
    type SpaceSidebarDocument,
    type SpaceSidebarItem,
    type SpaceSidebarPosition,
    type SpaceSidebarSpaceNode,
} from "@slopus/happy-agent-client";

export class SidebarConflictError extends Error {
    constructor(
        readonly currentVersion: number,
        message = "The sidebar changed. Read its current version before editing.",
        /** The zero-based operation of a batch that no longer applies, when one did not. */
        readonly operationIndex?: number,
    ) {
        super(message);
    }
}

export type SidebarNode = SpaceSidebarItem | SpaceSidebarSpaceNode;

/** The classic sidebar's row IDs: Happy, joined Surfaces, the other bots, then Tasks. */
export interface ClassicSidebar {
    readonly happy: string | undefined;
    readonly surfaces: readonly string[];
    readonly bots: readonly string[];
    readonly tasks: readonly string[];
}

/**
 * The first document mirrors the sidebar the person already knows: Search and Create, Happy with
 * new work arriving right below it, the joined Surfaces, a separator, then the Bots and Tasks
 * sections. It shows rows only; sessions stay out of the sidebar.
 */
export function seedSidebar(classic: ClassicSidebar): string {
    const row = (id: string): SpaceSidebarItem => ({
        type: "space",
        id,
        expanded: false,
        children: [],
    });
    // Bots and Tasks are default sections, present even when empty, with fixed IDs so a client
    // can apply the person's classic folds by section; row IDs are CUID2s.
    const group = (id: string, label: string, entries: readonly string[]): SpaceSidebarItem[] => [
        { type: "section", id, label, collapsed: false },
        ...entries.map(row),
    ];
    return formatSpaceSidebar({
        items: [
            { type: "search", id: "happy-search" },
            { type: "create", id: "happy-create" },
            ...(classic.happy === undefined ? [] : [row(classic.happy)]),
            ...classic.surfaces.map(row),
            { type: "separator", id: "divider" },
            ...group("bots", "Bots", classic.bots),
            ...group("tasks", "Tasks", classic.tasks),
        ],
    });
}

/** Sections and separators: the top-level items that start a run of rows. */
export function isSidebarHeading(node: SidebarNode): boolean {
    return node.type === "section" || node.type === "separator";
}

/**
 * Where a new row goes: right after the section or separator it was created under. Otherwise
 * right below Happy, after everything nested under it, where new work is expected; when Happy is
 * gone, nested, or folded inside a collapsed section, right after Create instead, so new work is
 * never hidden.
 */
export function newSpacePosition(
    document: SpaceSidebarDocument,
    place: { readonly headingId?: string; readonly happyId?: string } = {},
): SpaceSidebarPosition {
    if (
        place.headingId !== undefined &&
        document.items.some((item) => isSidebarHeading(item) && item.id === place.headingId)
    )
        return { after: place.headingId };
    if (
        place.happyId !== undefined &&
        document.items.some((item) => item.type === "space" && item.id === place.happyId) &&
        sidebarPlacement(document, place.happyId).visibility === "shown"
    )
        return { after: place.happyId };
    return { after: "happy-create" };
}

/** How many rows Prioritizing aims to leave shown, not counting Happy and untouched new work. */
export const SIDEBAR_VISIBLE_BUDGET = 10;

/**
 * What is drawn, in order: top-level rows and widgets outside collapsed sections, and the sessions
 * nested under expanded rows among them.
 */
export function shownSidebarRows(document: SpaceSidebarDocument): string[] {
    const shown: string[] = [];
    const draw = (node: SpaceSidebarSpaceNode) => {
        shown.push(node.id);
        if (node.expanded) node.children.forEach(draw);
    };
    let collapsed = false;
    for (const item of document.items) {
        if (item.type === "section") collapsed = item.collapsed;
        else if (item.type === "separator") collapsed = false;
        else if (collapsed) continue;
        else if (item.type === "space") draw(item);
        else if (item.type === "widget") shown.push(item.id);
    }
    return shown;
}

/** Every node's ID with the IDs nested under it, in document order. */
export function sidebarIds(nodes: readonly SidebarNode[]): string[] {
    return nodes.flatMap((node) => [
        node.id,
        ...(node.type === "space" ? sidebarIds(node.children) : []),
    ]);
}

/**
 * Where each node sits: its parent's ID (`nav` at the top level), and for a top-level item other
 * than a heading, the section or separator whose block holds it ("" before the first heading).
 */
export function sidebarPositions(
    document: SpaceSidebarDocument,
): Map<string, { parent: string; block: string }> {
    const result = new Map<string, { parent: string; block: string }>();
    const nest = (node: SpaceSidebarSpaceNode) => {
        for (const child of node.children) {
            result.set(child.id, { parent: node.id, block: "" });
            nest(child);
        }
    };
    let block = "";
    for (const item of document.items) {
        if (isSidebarHeading(item)) block = item.id;
        result.set(item.id, { parent: "nav", block: isSidebarHeading(item) ? "" : block });
        if (item.type === "space") nest(item);
    }
    return result;
}

/** The IDs whose parent or block differ between two versions, among those in both. */
export function regroupedSidebarIds(
    before: SpaceSidebarDocument,
    after: SpaceSidebarDocument,
): string[] {
    const from = sidebarPositions(before);
    const changed: string[] = [];
    for (const [id, place] of sidebarPositions(after)) {
        const previous = from.get(id);
        if (
            previous !== undefined &&
            (previous.parent !== place.parent || previous.block !== place.block)
        )
            changed.push(id);
    }
    return changed;
}

/**
 * Where an item stands, for a batch's diff: the section or separator above its top-level item,
 * named when it is a section, its index among its siblings, and whether it is drawn, folded under
 * a collapsed section or parent, or absent.
 */
export function sidebarPlacement(document: SpaceSidebarDocument, key: string) {
    const at = locateSpaceSidebarNode(document, key);
    if (at === undefined)
        return { sectionId: null, sectionName: null, index: 0, visibility: "hidden" as const };
    // The chain from the top-level item down to this node.
    let top: SidebarNode = at.node;
    let folded = false;
    for (let parent = at.parentId; parent !== "nav"; ) {
        const holder = locateSpaceSidebarNode(document, parent)!;
        top = holder.node;
        folded ||= holder.node.type === "space" && !holder.node.expanded;
        parent = holder.parentId;
    }
    const heading = document.items
        .slice(0, document.items.indexOf(top as SpaceSidebarItem))
        .reverse()
        .find(isSidebarHeading);
    folded ||= heading?.type === "section" && heading.collapsed;
    return {
        sectionId: heading?.id ?? null,
        sectionName: heading?.type === "section" ? heading.label : null,
        index: at.siblings.indexOf(at.node),
        visibility: folded ? ("folded" as const) : ("shown" as const),
    };
}

/** The top-level rows above the first separator that the person placed: what they keep at the top. */
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
