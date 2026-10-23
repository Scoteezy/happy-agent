import {
    formatSidebar,
    parseLegacySidebar,
    parseSidebar,
    sidebarNodes,
    SidebarValidationError,
    type SidebarNode,
} from "../../artifacts/index.js";

export class SidebarConflictError extends Error {
    constructor(
        readonly currentVersion: number,
        message = "The sidebar changed. Read its current version before editing.",
    ) {
        super(message);
    }
}

function element(tag: string, attrs: Record<string, string> = {}): SidebarNode {
    return { tag, attrs, start: 0, end: 0, parent: undefined, children: [] };
}

function adopt(parent: SidebarNode, nodes: readonly SidebarNode[]): SidebarNode {
    for (const node of nodes) node.parent = parent;
    parent.children.push(...nodes);
    return parent;
}

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
    const item = (id: string): SidebarNode => element("happy-space", { id });
    // Bots and Tasks are default sections, present even when empty, with fixed IDs so a client
    // can apply the person's classic folds by section; row IDs are CUID2s.
    const group = (id: string, label: string, entries: readonly string[]) => [
        element("happy-section", { id, label }),
        ...entries.map(item),
    ];
    return formatSidebar(
        adopt(element("nav"), [
            element("happy-search"),
            element("happy-create"),
            ...(classic.happy === undefined ? [] : [item(classic.happy)]),
            ...classic.surfaces.map(item),
            element("happy-separator", { id: "divider" }),
            ...group("bots", "Bots", classic.bots),
            ...group("tasks", "Tasks", classic.tasks),
        ]),
    );
}

/**
 * A document in the first grammar, rewritten once: its sections flatten into section headings,
 * except the old "older" bucket, which marked age rather than a subject and becomes a plain
 * separator. Rows keep their order, plain HTML is dropped, and Search and Create lead. Undefined
 * when it is current.
 */
export function migrateLegacySidebar(html: string): string | undefined {
    try {
        parseSidebar(html);
        return undefined;
    } catch (error: unknown) {
        if (!(error instanceof SidebarValidationError)) throw error;
    }
    const legacy = parseLegacySidebar(html);
    if (legacy === undefined) return undefined;
    const items: SidebarNode[] = [];
    const walk = (node: SidebarNode): void => {
        if (node.tag === "happy-space") {
            items.push(element("happy-space", { id: node.attrs["ref"]! }));
            return;
        }
        if (node.tag === "happy-section") {
            const id = node.attrs["id"]!;
            items.push(
                id === "older"
                    ? element("happy-separator", { id })
                    : element("happy-section", {
                          id,
                          label: node.attrs["label"]!,
                          ...(Object.hasOwn(node.attrs, "collapsed") ? { collapsed: "true" } : {}),
                      }),
            );
        }
        node.children.forEach(walk);
    };
    legacy.children.forEach(walk);
    return formatSidebar(
        adopt(element("nav"), [element("happy-search"), element("happy-create"), ...items]),
    );
}

/** Sections and separators: the top-level items that start a run of rows. */
export function isSidebarHeading(node: SidebarNode): boolean {
    return node.tag === "happy-section" || node.tag === "happy-separator";
}

/**
 * A new row goes right after the section or separator it was created under. Otherwise it goes
 * right below Happy, after everything nested under it, where new work is expected; when Happy is
 * gone, nested, or folded inside a collapsed section, right after Create instead, so new work is
 * never hidden.
 */
export function insertSidebarSpace(
    html: string,
    spaceId: string,
    place: { readonly headingId?: string; readonly happyId?: string } = {},
): string {
    const root = parseSidebar(html);
    if (sidebarNodes(root).some((node) => node.attrs["id"] === spaceId)) return html;
    const happy = root.children.find(
        (node) => node.tag === "happy-space" && node.attrs["id"] === place.happyId,
    );
    const anchor =
        root.children.find(
            (node) => isSidebarHeading(node) && node.attrs["id"] === place.headingId,
        ) ??
        (happy !== undefined && sidebarPlacement(html, place.happyId!).visibility === "shown"
            ? happy
            : undefined) ??
        root.children.find((node) => node.tag === "happy-create");
    const node = element("happy-space", { id: spaceId });
    node.parent = root;
    root.children.splice(anchor === undefined ? 0 : root.children.indexOf(anchor) + 1, 0, node);
    return formatSidebar(root);
}

/** How many rows Prioritizing aims to leave shown, not counting Happy and untouched new work. */
export const SIDEBAR_VISIBLE_BUDGET = 10;

/**
 * The rows and sessions drawn, in order: top-level rows outside collapsed sections, and the
 * sessions nested under expanded rows among them.
 */
export function shownSidebarRows(html: string): string[] {
    const shown: string[] = [];
    const draw = (node: SidebarNode) => {
        shown.push(node.attrs["id"]!);
        if (node.attrs["expanded"] === "true") node.children.forEach(draw);
    };
    let collapsed = false;
    for (const node of parseSidebar(html).children) {
        if (isSidebarHeading(node)) collapsed = node.attrs["collapsed"] === "true";
        else if (node.tag === "happy-space" && !collapsed) draw(node);
    }
    return shown;
}

/** A row or session that left takes the sessions nested under it along. */
export function removeSidebarNode(html: string, id: string): string {
    const root = parseSidebar(html);
    const node = sidebarNodes(root).find(
        (candidate) => candidate.tag === "happy-space" && candidate.attrs["id"] === id,
    );
    if (node?.parent === undefined) return html;
    node.parent.children.splice(node.parent.children.indexOf(node), 1);
    return formatSidebar(root);
}

/** What identifies an item across versions: its ID, or the tag of Search and Create. */
export function sidebarKey(node: SidebarNode): string {
    return node.attrs["id"] ?? node.tag;
}

function itemNodes(root: SidebarNode): SidebarNode[] {
    return sidebarNodes(root).filter((node) => node !== root);
}

/**
 * Where each item sits: its parent's key ("" at the top level), and for a top-level item other
 * than a heading, the section or separator whose block holds it ("" before the first heading).
 */
function positions(root: SidebarNode): Map<string, { parent: string; block: string }> {
    const result = new Map<string, { parent: string; block: string }>();
    let block = "";
    for (const node of itemNodes(root)) {
        const top = node.parent === root;
        if (top && isSidebarHeading(node)) block = sidebarKey(node);
        result.set(sidebarKey(node), {
            parent: top ? "" : sidebarKey(node.parent!),
            block: top && !isSidebarHeading(node) ? block : "",
        });
    }
    return result;
}

/**
 * What an edit did. `moved` holds the items it moved, added, or removed; `carried` the rows that
 * travelled inside a moved section without moving themselves; `folded` the items still present
 * whose expanded or collapsed switch it flipped.
 *
 * A section is its heading plus the rows after it, up to the next section or separator, and it
 * moves as one block: heading order is compared first, then each block's rows, then each parent's
 * sessions. A longest common subsequence keeps the most items still at every level, so a drag is
 * attributed to what was dragged rather than to everything whose index shifted, and a row that
 * now sits in another block moved even if its order among the other items did not.
 */
export function sidebarEdits(before: string, after: string) {
    const left = parseSidebar(before);
    const right = parseSidebar(after);
    const from = positions(left);
    const to = positions(right);
    const moved = new Set<string>();
    for (const key of from.keys()) if (!to.has(key)) moved.add(key);
    for (const [key, place] of to) {
        const previous = from.get(key);
        if (
            previous === undefined ||
            previous.parent !== place.parent ||
            previous.block !== place.block
        )
            moved.add(key);
    }
    const kept = (root: SidebarNode, match: (key: string) => boolean) =>
        itemNodes(root)
            .map(sidebarKey)
            .filter((key) => !moved.has(key) && match(key));
    const reorder = (match: (key: string) => boolean) => {
        const order = kept(left, match);
        const stationary = stationarySidebarKeys(order, kept(right, match));
        for (const key of order) if (!stationary.has(key)) moved.add(key);
    };
    const headings = new Set(
        [...right.children].filter(isSidebarHeading).map((node) => sidebarKey(node)),
    );
    reorder((key) => headings.has(key));
    for (const block of new Set([...to.values()].map((place) => place.block)))
        reorder(
            (key) =>
                !headings.has(key) && to.get(key)!.parent === "" && to.get(key)!.block === block,
        );
    for (const parent of new Set([...to.values()].map((place) => place.parent)))
        if (parent !== "") reorder((key) => to.get(key)!.parent === parent);
    const carried = [...to]
        .filter(([key, place]) => !moved.has(key) && moved.has(place.block))
        .map(([key]) => key);
    const order = [...to.keys(), ...from.keys()];
    const next = new Map(itemNodes(right).map((node) => [sidebarKey(node), node]));
    const folded = itemNodes(left)
        .filter((node) => {
            const other = next.get(sidebarKey(node));
            return (
                other !== undefined &&
                (other.attrs["expanded"] !== node.attrs["expanded"] ||
                    other.attrs["collapsed"] !== node.attrs["collapsed"])
            );
        })
        .map(sidebarKey);
    return {
        moved: [...new Set(order)].filter((key) => moved.has(key)),
        carried,
        folded,
    };
}

/**
 * Where an item stands, for a batch's diff: the section or separator above its top-level item,
 * named when it is a section, its index among its siblings, and whether it is drawn, folded under
 * a collapsed section or parent, or absent.
 */
export function sidebarPlacement(html: string, key: string) {
    const root = parseSidebar(html);
    const node = itemNodes(root).find((candidate) => sidebarKey(candidate) === key);
    if (node === undefined)
        return { sectionId: null, sectionName: null, index: 0, visibility: "hidden" as const };
    let top = node;
    let folded = false;
    while (top.parent !== undefined && top.parent !== root) {
        top = top.parent;
        folded ||= top.attrs["expanded"] !== "true";
    }
    const heading = root.children
        .slice(0, root.children.indexOf(top))
        .reverse()
        .find(isSidebarHeading);
    folded ||= heading?.attrs["collapsed"] === "true";
    return {
        sectionId: heading?.attrs["id"] ?? null,
        sectionName: heading?.attrs["label"] ?? null,
        index: node.parent!.children.indexOf(node),
        visibility: folded ? ("folded" as const) : ("shown" as const),
    };
}

/** Unique keys let a longest increasing subsequence identify the minimum moved set. */
function stationarySidebarKeys(before: readonly string[], after: readonly string[]): Set<string> {
    const positions = new Map(before.map((id, index) => [id, index]));
    const lengths = after.map(() => 1);
    const previous = after.map(() => -1);
    let best = -1;
    // Documents contain at most 1,000 elements, bounding this comparison to 1M pairs.
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
    const stationary = new Set<string>();
    for (let index = best; index !== -1; index = previous[index]!) {
        stationary.add(after[index]!);
    }
    return stationary;
}
