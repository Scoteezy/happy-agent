import { createId } from "@paralleldrive/cuid2";
import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { surfaceNameSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { spaceAttachableSurfaceTypeSchema } from "../Space.js";
import type { SpacesModule } from "../SpacesModule.js";

const attachToMyRowSchema = Type.Object(
    {
        spaceId: Type.Optional(
            Type.Union([cuid2Schema], {
                description:
                    "One of the person's sidebar rows to put under yours, such as another task or a Surface's row.",
            }),
        ),
        surfaceId: Type.Optional(
            Type.Union([cuid2Schema], {
                description:
                    "An existing todo, document, calendar, or chat Surface the person joined, from list_surfaces.",
            }),
        ),
        create: Type.Optional(
            Type.Object(
                {
                    kind: spaceAttachableSurfaceTypeSchema,
                    name: surfaceNameSchema,
                },
                {
                    additionalProperties: false,
                    description:
                        "A new Surface to make for the person, such as a todo list for this work.",
                },
            ),
        ),
    },
    { additionalProperties: false },
);
type AttachToMyRowInput = Static<typeof attachToMyRowSchema>;

const resultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });

/**
 * Puts a space under the calling conversation's own sidebar row, at once. Offered only to
 * conversations of a person with Stem Cells on. The new Surface's ID is kept with the call, so a
 * retried call makes and attaches it once.
 */
export function attachToMyRowTool(spaces: SpacesModule, actingAgentId: string) {
    return defineAgentTool({
        name: "attach_to_my_row",
        defer: true,
        capabilities: [
            "Show a todo list, document, calendar, chat, or another row under this conversation's row in the sidebar.",
        ],
        searchKeywords: [
            "make a todo list for this",
            "attach to sidebar",
            "add under my row",
            "sidebar subsection",
        ],
        description:
            "Put something under this conversation's own row in the person's sidebar, for example when the person asks you to make a todo list or a document for this work. Give exactly one of: spaceId, one of the person's rows; surfaceId, an existing todo, document, calendar, or chat Surface; or create, a new Surface of that kind with a short name, made for the person. It appears under your row at once and moves from wherever it was, so it is never shown twice. It never moves anything the person placed themselves. Then fill a new Surface with the ordinary Surface tools. People outside this installation cannot be invited to a chat.",
        parameters: attachToMyRowSchema,
        returnType: resultSchema,
        durable: true,
        transactional: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: (input) => input.create !== undefined,
        describeAutoPermissionAction: (input) =>
            input.create === undefined
                ? "attaching an existing space under this conversation's sidebar row. Access: the person's sidebar"
                : `creating a shared ${input.create.kind} Surface ${JSON.stringify(input.create.name)} for the person and attaching it under this conversation's sidebar row. Access: shared data write`,
        execute: async (ctx, input: AttachToMyRowInput, call) => ({
            text: await spaces.attachToRow(ctx, actingAgentId, input, {
                surfaceId: await call.kv.getOrCreate(ctx, "surfaceId", createId),
                operationId: `attach:${call.id}`,
            }),
        }),
        toLLM: (result) => [{ type: "text", text: result.text }],
    });
}
