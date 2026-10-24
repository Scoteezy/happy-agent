import { Type, type Static } from "@sinclair/typebox";

/** Largest one-shot program accepted by the primitive Code Mode interpreter. */
export const MAX_CODE_MODE_PYTHON_CHARACTERS = 100_000;
/** Largest result, including a failure diagnostic, returned to the conversation. */
export const MAX_CODE_MODE_OUTPUT_CHARACTERS = 20_000;

export const codeModePythonInputSchema = Type.Object(
    {
        code: Type.String({ maxLength: MAX_CODE_MODE_PYTHON_CHARACTERS }),
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

export const codeModePythonResultSchema = Type.Object(
    {
        output: Type.String({ maxLength: MAX_CODE_MODE_OUTPUT_CHARACTERS }),
        isError: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type CodeModePythonInput = Static<typeof codeModePythonInputSchema>;
export type CodeModePythonResult = Static<typeof codeModePythonResultSchema>;
