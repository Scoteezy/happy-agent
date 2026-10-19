import type { SpaceRecord, SpaceRef } from "../Space.js";

/**
 * The identity a person's row is unique by: Happy and the manager are one each, and every other
 * row is the one place its primary content appears in that person's sidebar.
 */
export function spaceRefKey(space: Pick<SpaceRecord, "contents" | "id" | "role">): string {
    if (space.role === "happy") return "happy";
    if (space.role === "manager") return "manager";
    const primary = space.contents[0];
    return primary === undefined ? `space:${space.id}` : spaceContentKey(primary);
}

/** The identity of one piece of content. */
export function spaceContentKey(ref: SpaceRef): string {
    switch (ref.kind) {
        case "task":
            return `task:${ref.taskId}`;
        case "bot":
            return `bot:${ref.botId}`;
        case "agent":
            return `agent:${ref.agentId}`;
        case "artifact":
            return `artifact:${ref.artifactId}`;
        case "surface":
            return `surface:${ref.surfaceId}`;
        case "file":
            return `file:${ref.workspaceId}:${ref.path}`;
    }
}
