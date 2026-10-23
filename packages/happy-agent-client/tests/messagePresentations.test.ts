import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { messageMetadataSchema, toolPresentationSchema } from "../sources/protocol/messages.js";

describe("additive conversation presentations", () => {
    it("accepts answered choices and free text in the tool presentation union", () => {
        expect(
            Value.Check(toolPresentationSchema, {
                type: "user_input",
                questions: [
                    {
                        id: "scope",
                        header: "Release scope",
                        question: "Which release?",
                        multiSelect: false,
                        options: [{ label: "Preview", description: "Try the change." }],
                    },
                    {
                        id: "notes",
                        header: "Release notes",
                        question: "What should we mention?",
                        multiSelect: false,
                        options: [],
                    },
                ],
                answers: { scope: ["Preview"], notes: ["Preserves answered questions."] },
            }),
        ).toBe(true);
    });

    it("keeps metadata compatible when the sender has no explanation", () => {
        expect(Value.Check(messageMetadataSchema, {})).toBe(true);
        expect(
            Value.Check(messageMetadataSchema, {
                senderAgentId: "clh3am8s90000ml08dl0adtx1",
                senderAgentExplanation: "Validation results",
            }),
        ).toBe(true);
        expect(
            Value.Check(messageMetadataSchema, { senderAgentExplanation: "x".repeat(121) }),
        ).toBe(false);
    });
});
