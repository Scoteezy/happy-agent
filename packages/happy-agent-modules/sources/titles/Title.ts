import { Type, type Static } from "@sinclair/typebox";

/**
 * Which names one request asks for.
 *
 * There are two, not three. A chat title is prose a person reads in a list; a slug is the
 * lower-case name a folder and a Git branch both carry, and those two are the same name — asking
 * for them separately is asking one question twice.
 */
export const titleNamesWantedSchema = Type.Object(
    {
        /** The name the workspace folder and its branch share. */
        slug: Type.Optional(Type.Boolean()),
        /** The chat title, written the way a person writes a title. */
        title: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

export type TitleNamesWanted = Static<typeof titleNamesWantedSchema>;

/** What one request produced. A name the model did not usably answer is simply absent. */
export interface TitleNames {
    readonly slug?: string;
    readonly title?: string;
}

/** How much of the first message the naming request carries. */
export const MAX_NAMING_MESSAGE_CHARS = 4_000;
/** How much of the conversation a second look at the title reads. */
export const MAX_NAMING_TRANSCRIPT_CHARS = 12_000;
/** A chat title is a label in a list, not a sentence. */
export const MAX_CHAT_TITLE_CHARS = 80;
export const MAX_CHAT_TITLE_WORDS = 6;
/** A row in the Spaces sidebar names its subject in a few words. */
export const MAX_SUBJECT_TITLE_CHARS = 32;
export const MAX_SUBJECT_TITLE_WORDS = 3;
/** A folder key and a branch segment stay short enough to read in a path. */
export const MAX_SLUG_CHARS = 48;

/**
 * How a chat is named.
 *
 * `standard` is how every chat is named: up to six words, written by the cheapest model of the
 * chat's account at the least effort. `subject` is for work a person started from the Spaces
 * sidebar: one to three words naming the subject, written by the chat's own model at its default
 * effort, because a sidebar row has room for little and must still say what the work is.
 */
export const namingStyleSchema = Type.Union([Type.Literal("standard"), Type.Literal("subject")]);

export type NamingStyle = Static<typeof namingStyleSchema>;

export const titleNameRequestSchema = Type.Object(
    {
        /** The first accepted user-role message, which is all initial naming has to go on. */
        firstMessage: Type.String({ minLength: 1 }),
        wanted: titleNamesWantedSchema,
        /** The account the chat itself runs on. */
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        /** The model the chat itself runs on, which writes subject names. */
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        /** How the chat is named; `standard` when omitted. */
        style: Type.Optional(namingStyleSchema),
    },
    { additionalProperties: true },
);

export type TitleNameRequest = Static<typeof titleNameRequestSchema>;

/** A second look at a chat's title, once there is a conversation rather than one message. */
export const titleRefineRequestSchema = Type.Object(
    {
        /** The conversation so far, already rendered as the plain text a reader would see. */
        transcript: Type.String({ minLength: 1 }),
        /** What the chat is called now, which stands unless the conversation contradicts it. */
        currentTitle: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        /** The account the chat itself runs on. */
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        /** The model the chat itself runs on, which writes subject names. */
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        /** How the chat is named; `standard` when omitted. */
        style: Type.Optional(namingStyleSchema),
    },
    { additionalProperties: true },
);

export type TitleRefineRequest = Static<typeof titleRefineRequestSchema>;

export const titleWorkspaceIdSchema = Type.String({ minLength: 1, maxLength: 256 });
