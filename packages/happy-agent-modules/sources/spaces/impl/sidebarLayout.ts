import {
    escapeSidebarText,
    parseSidebar,
    sidebarNodes,
    type SidebarNode,
} from "../../artifacts/index.js";
import type { SpaceSnapshot } from "../Space.js";

export class SidebarConflictError extends Error {
    constructor(
        readonly currentVersion: number,
        message = "The sidebar changed. Read its current version before editing.",
    ) {
        super(message);
    }
}

export function seedSidebar(snapshot: SpaceSnapshot): string {
    const row = (id: string) => `<happy-space ref="${escapeSidebarText(id)}" tree></happy-space>`;
    const happy = snapshot.spaces.find((space) => space.role === "happy");
    const shown = snapshot.spaces.filter(
        (space) => space.role !== "happy" && space.visibility === "shown",
    );
    const sections = snapshot.sections.map(
        (section) =>
            `<happy-section id="${section.id}" label="${escapeSidebarText(section.name)}"${section.collapsed ? " collapsed" : ""}>\n${shown
                .filter((space) => space.sectionId === section.id)
                .map((space) => row(space.id))
                .join("\n")}\n</happy-section>`,
    );
    return [
        "<nav>",
        ...(happy === undefined ? [] : [row(happy.id)]),
        ...shown.filter((space) => space.sectionId === undefined).map((space) => row(space.id)),
        ...sections,
        '<happy-section id="older" label="Older" collapsed>',
        ...snapshot.spaces
            .filter((space) => space.role !== "happy" && space.visibility !== "shown")
            .map((space) => row(space.id)),
        "</happy-section>",
        "</nav>",
    ].join("\n");
}

export function insertSidebarSpace(
    html: string,
    spaceId: string,
    happyId: string | undefined,
    sectionId?: string,
): string {
    const root = parseSidebar(html);
    const nodes = sidebarNodes(root);
    if (nodes.some((node) => node.attrs["ref"] === spaceId)) return html;
    const section =
        sectionId === undefined
            ? undefined
            : nodes.find((node) => node.tag === "happy-section" && node.attrs["id"] === sectionId);
    if (sectionId !== undefined && section === undefined)
        throw new Error("The section was not found.");
    const happy = nodes.find((node) => node.attrs["ref"] === happyId);
    const at = section?.openEnd ?? happy?.end ?? root.openEnd;
    return `${html.slice(0, at)}\n<happy-space ref="${escapeSidebarText(spaceId)}" tree></happy-space>${html.slice(at)}`;
}

export function removeSidebarSpace(html: string, id: string): string {
    const node = sidebarNodes(parseSidebar(html)).find(
        (candidate) => candidate.attrs["ref"] === id,
    );
    return node === undefined
        ? html
        : html.slice(0, node.start) +
              html.slice(node.openEnd, node.closeStart) +
              html.slice(node.end);
}

/** Position compares authored ancestry, disclosure, and relative order among existing peers. */
export function sidebarPosition(node: SidebarNode, peerIds: ReadonlySet<string>): string {
    const ancestors: string[] = [];
    let current = node.parent;
    while (current !== undefined) {
        ancestors.unshift(
            JSON.stringify([
                current.tag,
                current.attrs["id"] ??
                    current.parent?.children
                        .filter((sibling) => sibling.tag === current!.tag)
                        .indexOf(current) ??
                    0,
                Object.hasOwn(current.attrs, "collapsed"),
                current.parent?.children
                    .filter(
                        (sibling) =>
                            sibling.start < current!.start &&
                            sibling.tag === "happy-section" &&
                            peerIds.has(`section:${sibling.attrs["id"]}`),
                    )
                    .map((sibling) => sibling.attrs["id"]),
            ]),
        );
        current = current.parent;
    }
    const preceding = node.parent?.children
        .filter(
            (peer) =>
                peer.start < node.start &&
                peer.attrs["ref"] !== undefined &&
                peerIds.has(peer.attrs["ref"]),
        )
        .map((peer) => peer.attrs["ref"]);
    return JSON.stringify([ancestors, preceding, Object.hasOwn(node.attrs, "collapsed")]);
}

export function changedSidebarRefs(before: string, after: string): string[] {
    const beforeNodes = sidebarNodes(parseSidebar(before));
    const afterNodes = sidebarNodes(parseSidebar(after));
    const left = beforeNodes.filter((node) => node.tag === "happy-space");
    const right = afterNodes.filter((node) => node.tag === "happy-space");
    const next = new Map(right.map((node) => [node.attrs["ref"]!, node]));
    const nextSections = new Set(
        afterNodes.filter((node) => node.tag === "happy-section").map((node) => node.attrs["id"]!),
    );
    const sectionPeers = new Set(
        beforeNodes
            .filter((node) => node.tag === "happy-section" && nextSections.has(node.attrs["id"]!))
            .map((node) => `section:${node.attrs["id"]}`),
    );
    // Compare ancestry and disclosure independently of sibling offsets. Rows that changed
    // containers are removed from the reorder comparison, so their old neighbors stay put.
    const peers = new Set(
        left
            .filter((node) => {
                const other = next.get(node.attrs["ref"]!);
                return (
                    other !== undefined &&
                    sidebarPosition(node, sectionPeers) === sidebarPosition(other, sectionPeers)
                );
            })
            .map((node) => node.attrs["ref"]!),
    );
    const stationary = stationarySidebarRefs(
        left.map((node) => node.attrs["ref"]!).filter((id) => peers.has(id)),
        right.map((node) => node.attrs["ref"]!).filter((id) => peers.has(id)),
    );
    return left
        .filter((node) => !stationary.has(node.attrs["ref"]!))
        .map((node) => node.attrs["ref"]!);
}

/** Unique refs let a longest increasing subsequence identify the minimum moved set. */
function stationarySidebarRefs(before: readonly string[], after: readonly string[]): Set<string> {
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
