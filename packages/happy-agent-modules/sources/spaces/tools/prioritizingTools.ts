import { cuid2Schema, defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { SIDEBAR_STYLES } from "../../artifacts/index.js";
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
                "Read {artifactId, version, html, spaces, observations, manualSpaceIds}. The HTML nesting is the authoritative layout. Pending edits are included with the version your next edit must use.",
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
            name: "edit_sidebar",
            defer: false,
            capabilities: ["Edit the person's sidebar artifact."],
            description:
                "Apply sequential exact-text edits to the sidebar HTML. Each oldText must occur exactly once. All edits make one immutable version when the calm batch applies. Read again on a stale baseVersion. Keep Happy first, manual moves unchanged, and recent work in place. New pending work may receive its first placement.",
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
            capabilities: ["Read the sidebar's allowed elements, classes, and theme tokens."],
            description:
                "Read the published HTML element/attribute contract, allowed classes, and light/dark theme tokens. The sidebar inherits the app theme; do not author style elements, inline styles, or JavaScript.",
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
            capabilities: ["Set a sidebar row's icon."],
            description:
                "Set a row's icon from the icon library. Applies immediately because it moves nothing.",
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
