import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    MAX_MCP_QUESTION_CHOICES,
    MAX_MCP_QUESTION_HEADER_LENGTH,
    MAX_MCP_QUESTIONS_PER_REQUEST,
    mcpElicitationRequestSchema,
    mcpElicitationResultSchema,
    mcpUserInputRequestSchema,
    mcpUserInputResponseSchema,
    type McpElicitationResult,
    type McpUserInputRequest,
    type McpUserInputResponse,
} from "./Mcp.js";
import { humanizeMcpName } from "./humanizeMcpName.js";

export const mcpUserInputServiceSchema = Type.Object(
    {
        request: Type.Function(
            [mcpUserInputRequestSchema],
            Type.Promise(mcpUserInputResponseSchema),
        ),
    },
    { additionalProperties: false },
);
/** Asks the person one question and settles with what they did. Nothing else may answer it. */
export type McpUserInputService = Static<typeof mcpUserInputServiceSchema>;

const APPROVE = "Approve";
const DECLINE = "Decline";
const MAX_QUESTION_CHARACTERS = 4_000;
const MAX_OPTION_LABEL_CHARACTERS = 256;
const MAX_OPTION_DESCRIPTION_CHARACTERS = 2_000;

/**
 * Asks the person what an MCP server's `elicitation/create` wants to know, and turns what they did
 * into the server's answer.
 *
 * Only the person's own answer is ever accepted. Dismissing the question, stopping the run, being
 * away, or letting it time out is `cancel`; choosing Decline, or an answer the requested schema
 * cannot hold, is `decline`. A request this surface cannot show, or no one to show it to, is
 * declined without asking.
 */
export async function handleMcpElicitation(
    server: string,
    request: unknown,
    userInput: McpUserInputService | undefined,
): Promise<McpElicitationResult> {
    if (!Value.Check(mcpElicitationRequestSchema, request)) return { action: "decline" };
    if (userInput === undefined) return { action: "decline" };

    const { requestedSchema } = request.params;
    const label = humanizeMcpName(server);
    const message = request.params.message.trim();
    // Clients that show no context still show the first question, so it names who is asking.
    const intro =
        message.length === 0 ? `${label} is asking for your input.` : `${label} asks: ${message}`;
    const context = `**${label}** is an MCP server asking you directly. Only your own answer is sent back to it; the agent cannot answer for you.`;
    const entries = Object.entries(requestedSchema.properties);

    if (entries.length === 0) {
        const response = await ask(userInput, {
            context,
            questions: [
                {
                    header: "Approval",
                    id: "approval",
                    multiSelect: false,
                    options: [
                        { label: APPROVE, description: `Let ${label} go ahead.` },
                        { label: DECLINE, description: `Tell ${label} no.` },
                    ],
                    question: boundText(intro, MAX_QUESTION_CHARACTERS),
                },
            ],
        });
        if (response.status !== "answered") return { action: "cancel" };
        return response.answers?.approval?.includes(APPROVE) === true
            ? { action: "accept", content: {} }
            : { action: "decline" };
    }
    if (entries.length > MAX_MCP_QUESTIONS_PER_REQUEST) return { action: "decline" };

    const valuesByLabel = new Map<string, Map<string, string | number | boolean>>();
    /** Properties whose allowed values the server declared, and which no other answer satisfies. */
    const declaredChoiceIds = new Set<string>();
    const questions: McpUserInputRequest["questions"][number][] = [];
    for (const [index, [id, property]] of entries.entries()) {
        const record = asRecord(property);
        const declaredChoices = declaredChoicesFor(record);
        if (declaredChoices !== undefined) declaredChoiceIds.add(id);
        const values = declaredChoices ?? booleanChoicesFor(record);
        const enumNames = enumNamesFor(record, values);
        const names = values.map((value, position) => String(enumNames[position] ?? value));
        // A choice the person cannot tell apart from another, or cannot be shown, cannot be asked.
        if (
            values.length > MAX_MCP_QUESTION_CHOICES ||
            new Set(names).size !== names.length ||
            names.some((name) => name.length === 0 || name.length > MAX_OPTION_LABEL_CHARACTERS)
        ) {
            return { action: "decline" };
        }
        valuesByLabel.set(id, new Map(values.map((value, position) => [names[position]!, value])));
        const title =
            typeof record?.title === "string" && record.title.trim().length > 0
                ? record.title.trim()
                : humanizeMcpName(id, "Answer");
        const description =
            typeof record?.description === "string" && record.description.trim().length > 0
                ? record.description.trim()
                : undefined;
        const propertyType = typeof record?.type === "string" ? record.type : undefined;
        const fieldText = description ?? title;
        questions.push({
            header: boundText(title, MAX_MCP_QUESTION_HEADER_LENGTH),
            id,
            multiSelect: propertyType === "array",
            options: values.map((value, position) => ({
                label: names[position]!,
                description: boundText(
                    propertyType === "boolean"
                        ? `Answer ${names[position]!.toLowerCase()}.`
                        : `Use ${String(value)}.`,
                    MAX_OPTION_DESCRIPTION_CHARACTERS,
                ),
            })),
            question: boundText(
                index === 0 ? `${intro}\n\n${fieldText}` : fieldText,
                MAX_QUESTION_CHARACTERS,
            ),
            ...(requestedSchema.required?.includes(id) === true ? { required: true } : {}),
        });
    }

    const response = await ask(userInput, { context, questions });
    if (response.status !== "answered") return { action: "cancel" };

    const content: Record<string, string | number | boolean | Array<string | number | boolean>> =
        {};
    for (const [id, property] of entries) {
        const record = asRecord(property);
        const answers = response.answers?.[id] ?? [];
        const labels = valuesByLabel.get(id);
        /*
         * A server that declared the values it accepts gets one of those values back or nothing at
         * all.  An answer that matches no offered label is not a choice the server described, so
         * the whole request is declined rather than passing an invented value through.
         */
        if (declaredChoiceIds.has(id) && answers.some((answer) => labels?.has(answer) !== true)) {
            return { action: "decline" };
        }
        const normalized = answers.map((answer) => labels?.get(answer) ?? answer);
        const propertyType = typeof record?.type === "string" ? record.type : undefined;
        const raw = propertyType === "array" ? normalized : normalized[0];
        if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
            if (requestedSchema.required?.includes(id) === true) return { action: "decline" };
            continue;
        }
        if (propertyType === "boolean" && typeof raw === "string") {
            if (raw !== "true" && raw !== "false") return { action: "decline" };
            content[id] = raw === "true";
        } else if (
            (propertyType === "number" || propertyType === "integer") &&
            typeof raw === "string"
        ) {
            const number = Number(raw);
            if (raw.trim().length === 0 || !Number.isFinite(number)) return { action: "decline" };
            // An integer property means a whole number; 1.5 replicas is not a value to hand back.
            if (propertyType === "integer" && !Number.isInteger(number)) {
                return { action: "decline" };
            }
            content[id] = number;
        } else if (Array.isArray(raw)) {
            // Selections keep the type the server declared them with, so a numeric choice comes
            // back as the number it was rather than as its label.
            content[id] = [...raw];
        } else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
            content[id] = raw;
        } else {
            return { action: "decline" };
        }
    }
    const result = { action: "accept" as const, content };
    if (!Value.Check(mcpElicitationResultSchema, result)) return { action: "decline" };
    return result;
}

/** A response this module cannot read is not an answer, so it counts as no answer at all. */
async function ask(
    userInput: McpUserInputService,
    request: McpUserInputRequest,
): Promise<McpUserInputResponse> {
    if (!Value.Check(mcpUserInputRequestSchema, request)) return { status: "cancelled" };
    const response: unknown = await userInput.request(request);
    return Value.Check(mcpUserInputResponseSchema, response) ? response : { status: "cancelled" };
}

function boundText(value: string, maximum: number): string {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * The values the server said it accepts, or nothing when it named none.
 *
 * The distinction matters when the answer comes back: a declared set is the complete list of
 * acceptable values, while a property with no declared set is parsed by its type instead.
 */
function declaredChoicesFor(
    record: Record<string, unknown> | undefined,
): Array<string | number | boolean> | undefined {
    if (Array.isArray(record?.enum)) return record.enum.filter(isPrimitive);
    if (Array.isArray(record?.oneOf)) {
        return record.oneOf
            .map(asRecord)
            .map((item) => item?.const)
            .filter(isPrimitive);
    }
    const items = asRecord(record?.items);
    if (record?.type === "array" && Array.isArray(items?.enum)) {
        return items.enum.filter(isPrimitive);
    }
    if (record?.type === "array" && Array.isArray(items?.anyOf)) {
        return items.anyOf
            .map(asRecord)
            .map((item) => item?.const)
            .filter(isPrimitive);
    }
    return undefined;
}

/** Yes and no, which this module offers itself rather than reading from the server's schema. */
function booleanChoicesFor(
    record: Record<string, unknown> | undefined,
): Array<string | number | boolean> {
    return record?.type === "boolean" ? ["true", "false"] : [];
}

function enumNamesFor(
    record: Record<string, unknown> | undefined,
    values: readonly (string | number | boolean)[],
): readonly unknown[] {
    if (Array.isArray(record?.enumNames)) return record.enumNames;
    if (Array.isArray(record?.oneOf)) {
        return record.oneOf.map(asRecord).map((item) => item?.title ?? undefined);
    }
    const items = asRecord(record?.items);
    if (record?.type === "array" && Array.isArray(items?.anyOf)) {
        return items.anyOf.map(asRecord).map((item) => item?.title ?? undefined);
    }
    if (record?.type === "boolean") return ["Yes", "No"];
    return values;
}

function isPrimitive(value: unknown): value is string | number | boolean {
    return (
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean"
    );
}
