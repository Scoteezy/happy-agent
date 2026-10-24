import { cuid2Schema } from "@slopus/happy-agent-base";
import {
    MAX_STORY_CAPTION_LENGTH,
    MAX_STORY_FRAMES,
    storyCreatorSchema,
    storyFrameSchema,
    storyStatusSchema,
    type Story,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/** The one person of a standalone installation, who has no user ID. */
export const STANDALONE_STORY_PERSON = "standalone";

/** A team user's ID, or {@link STANDALONE_STORY_PERSON}. */
export type StoryPerson = string;

/** A frame as stored: everything but `available`, which is decided when it is read. */
export const storedStoryFrameSchema = Type.Omit(storyFrameSchema, ["available"]);
export type StoredStoryFrame = Static<typeof storedStoryFrameSchema>;

/** A story's content: what its `story.json` holds and every version changes. */
export const storyContentSchema = Type.Object(
    {
        caption: Type.Union([
            Type.String({ minLength: 1, maxLength: MAX_STORY_CAPTION_LENGTH }),
            Type.Null(),
        ]),
        frames: Type.Array(storedStoryFrameSchema, { minItems: 1, maxItems: MAX_STORY_FRAMES }),
    },
    { additionalProperties: false },
);
export type StoryContent = Static<typeof storyContentSchema>;

/** One story's row. */
export const storyRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        author: Type.String({ minLength: 1 }),
        status: storyStatusSchema,
        createdBy: storyCreatorSchema,
        source: Type.Union([
            Type.Object({ agentId: cuid2Schema, toolCallId: cuid2Schema }),
            Type.Null(),
        ]),
        content: storyContentSchema,
        artifactVersion: Type.Integer({ minimum: 1 }),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
        postedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        expiresAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        version: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
export type StoryRecord = Static<typeof storyRecordSchema>;

/** One viewer's seen mark for one author. */
export interface StorySeenMark {
    readonly author: StoryPerson;
    readonly storyId: string;
    readonly postedAt: number;
}

/** What one change sends to each connection that should hear of it. */
export interface StoryEventDelivery {
    /** The team user whose connections receive it; undefined for the standalone person. */
    readonly userId: string | undefined;
    readonly payload: unknown;
}

export interface StoryEvent {
    readonly type:
        | "story.created"
        | "story.updated"
        | "story.posted"
        | "story.deleted"
        | "story.seen"
        | "story.reacted";
    readonly at: number;
    readonly deliveries: readonly StoryEventDelivery[];
}

export type StoryEventListener = (event: StoryEvent) => void;

/** Watches a story being posted, inside the transaction that posts it. */
export type StoryPostedListener = (
    ctx: Context,
    story: { readonly author: StoryPerson; readonly content: StoryContent },
) => Promise<void>;

/** The bytes of one frame, for a route that serves them. */
export interface StoryFrameFile {
    readonly contentPath: string;
    readonly sha256: string;
    readonly size: number;
    readonly mimeType: string;
    readonly name: string;
}

export type { Story };
