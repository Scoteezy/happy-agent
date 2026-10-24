import { Type, type Static } from "@sinclair/typebox";

/** Largest one-shot TypeScript program accepted by the Bun POC. */
export const MAX_CODE_MODE_BUN_CHARACTERS = 32_000;
/** Largest Bun result, including process diagnostics, returned to the conversation. */
export const MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS = 20_000;

export const codeModeJavaScriptInputSchema = Type.Object(
    {
        code: Type.String({ maxLength: MAX_CODE_MODE_BUN_CHARACTERS }),
        // Shown to the person in place of the code; never reaches the interpreter.
        description: Type.Optional(
            Type.String({
                description:
                    "A 2–8 word description of what this code does, in active voice, shown to the user. Example: 'Count failing tests', 'Summarize the logs'.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const codeModeJavaScriptResultSchema = Type.Object(
    {
        output: Type.String({ maxLength: MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS }),
        isError: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type CodeModeJavaScriptInput = Static<typeof codeModeJavaScriptInputSchema>;
export type CodeModeJavaScriptResult = Static<typeof codeModeJavaScriptResultSchema>;
