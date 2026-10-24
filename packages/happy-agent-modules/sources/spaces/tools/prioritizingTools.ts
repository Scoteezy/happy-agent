import { cuid2Schema, defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { SIDEBAR_STYLES } from "../impl/sidebarStyles.js";
import { spaceIconSlugSchema } from "../Space.js";
import type { SpacesModule } from "../SpacesModule.js";

const resultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
const toLLM = (result: Static<typeof resultSchema>) => [
    { type: "text" as const, text: result.text },
];
const emptySchema = Type.Object({}, { additionalProperties: false });
const editsSchema = Type.Object(
    {
        baseVersion: Type.Integer({ minimum: 1 }),
        edits: Type.Array(
            Type.Object(
                {
                    oldText: Type.String({ minLength: 1, maxLength: 131072 }),
                    newText: Type.String({ maxLength: 131072 }),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 64 },
        ),
    },
    { additionalProperties: false },
);
const conversationSchema = Type.Object(
    {
        id: cuid2Schema,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
    },
    { additionalProperties: false },
);
const iconSchema = Type.Object(
    { spaceId: cuid2Schema, slug: spaceIconSlugSchema },
    { additionalProperties: false },
);

/** One fixed tool surface; layout changes all enter the existing calm batch. */
export function prioritizingTools(
    spaces: SpacesModule,
    ownerUserId: string,
    agentId: string,
): AnyAgentTool[] {
    return [
        defineAgentTool({
            name: "list_sidebar",
            defer: false,
            capabilities: ["Read the person's sidebar artifact and live spaces."],
            description:
                "Read {artifactId, version, html, spaces, sessions, visibleRows, manualIds}. The html is the sidebar exactly as the person sees it. spaces describe each row; sessions list every session under the rows with its parent, whether or not it is shown. visibleRows counts the rows and widgets shown outside collapsed sections and the sessions shown under them, not counting Happy and new work waiting for its first message, against the budget to stay within. manualIds are the items whose place, fold, name, or content the person last set. Pending edits are included with the version your next edit must use.",
            parameters: emptySchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx) => ({
                text: JSON.stringify(await spaces.prioritizingSidebar(ctx, ownerUserId)),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "read_row_conversation",
            defer: false,
            capabilities: ["Read what was said in a sidebar row's conversation."],
            description:
                "Read what the person, the agent, and other agents writing to it (such as the task a subtask was given, or a subtask reporting back) said in a row's conversation (its space ID) or a session under a row (its agent ID), newest first. Tool calls, their output and reasoning are left out; long messages are shortened and the whole answer is capped. Read the conversations a decision rests on before placing, ranking, or tucking anything away.",
            parameters: conversationSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof conversationSchema>) => ({
                text: await spaces.rowConversation(ctx, ownerUserId, input.id, input.limit ?? 12),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "edit_sidebar",
            defer: false,
            capabilities: ["Edit the person's sidebar artifact."],
            description:
                "Apply sequential exact-text edits to the sidebar document. Each oldText must occur exactly once. All edits make one immutable version when the calm batch applies. Read again on a stale baseVersion. Leave Happy, Search, Create, the person's manual moves and folds, their widgets, new work without a first message, and recent work in place: a change that would touch them is dropped, the rest still queues, and the result lists what was dropped. New pending work may receive its first placement.",
            parameters: editsSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof editsSchema>, call) => ({
                text: await spaces.editSidebar(ctx, ownerUserId, input, call.id),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "get_sidebar_styles",
            defer: false,
            capabilities: ["Read the sidebar document's grammar."],
            description:
                "Read the sidebar's allowed elements, their attributes and children, and its rules. The app draws every element itself; nothing else is allowed.",
            parameters: emptySchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async () => ({ text: JSON.stringify(SIDEBAR_STYLES) }),
            toLLM,
        }),
        defineAgentTool({
            name: "set_space_icon",
            defer: false,
            capabilities: ["Set the icon of a sidebar row or a session under it."],
            description:
                "Set an icon from the icon library on a row (its space ID) or a session under a row (its agent ID), shown or not. Applies immediately because it moves nothing. New work without a first message keeps its stem-cell mark.",
            parameters: iconSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof iconSchema>) => ({
                text: await spaces.setIcon(ctx, ownerUserId, input.spaceId, input.slug),
            }),
            toLLM,
        }),
        ...spaces.sidebarArtifactTools(agentId),
    ];
}
