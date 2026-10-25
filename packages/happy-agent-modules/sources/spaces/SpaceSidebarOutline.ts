/**
 * The person's sidebar as names, in its order: what voice is told about it. IDs travel beside
 * the names only for targeting and are never spoken.
 */
export interface SpaceSidebarOutline {
    /** Rows before the first section or separator form a group without a label. */
    readonly groups: readonly SpaceSidebarOutlineGroup[];
}

export interface SpaceSidebarOutlineGroup {
    /** A section's label, or `undefined` for the rows above the first section or after a separator. */
    readonly label: string | undefined;
    /** A collapsed section names only how many rows it holds. */
    readonly folded: boolean;
    readonly rows: readonly SpaceSidebarOutlineRow[];
}

export interface SpaceSidebarOutlineRow {
    readonly name: string;
    /** The conversation the row or session opens, absent for a Surface. */
    readonly agentId: string | undefined;
    /** The sessions and attachments the document shows under it; folded ones are only counted. */
    readonly children: readonly SpaceSidebarOutlineRow[];
    readonly foldedChildren: number;
}
