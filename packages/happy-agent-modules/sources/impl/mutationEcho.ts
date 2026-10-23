import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * The client mutation an agent's work answers, carried on what that work sends or creates.
 *
 * A client echoes `mutationId` to recognize its own change coming back. A run answers the mutation
 * recorded on the message that started it. When a run sends another agent a message, schedules
 * one, or creates an agent, the work that follows answers the same mutation however long it
 * waits, so the sender stamps it then. Nothing reads the sender's run later, when it may already
 * be answering something else. This is attribution for the echo only and grants nothing.
 */
export const MUTATION_ID_METADATA_KEY = "mutationId";

const mutationIdSchema = Type.String({ minLength: 1, maxLength: 512 });

/** Metadata carrying `mutationId`, or nothing when the work answers no mutation. */
export function mutationIdMetadata(mutationId: string | undefined): {
    readonly [MUTATION_ID_METADATA_KEY]?: string;
} {
    return mutationId === undefined ? {} : { [MUTATION_ID_METADATA_KEY]: mutationId };
}

/** The mutation a message's or an agent's metadata carries, when it carries a valid one. */
export function mutationIdOf(metadata: unknown): string | undefined {
    if (metadata === undefined || metadata === null || typeof metadata !== "object") {
        return undefined;
    }
    const value = Object.hasOwn(metadata, MUTATION_ID_METADATA_KEY)
        ? (metadata as Record<string, unknown>)[MUTATION_ID_METADATA_KEY]
        : undefined;
    return Value.Check(mutationIdSchema, value) ? value : undefined;
}
