import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";

import { createStemCellRequestSchema } from "../../sources/api/ApiSpaceProjection.js";

it("accepts new work with or without client-chosen conversation IDs", () => {
    expect(Value.Check(createStemCellRequestSchema, {})).toBe(true);
    expect(Value.Check(createStemCellRequestSchema, { id: "spaceaaaa", sectionId: null })).toBe(
        true,
    );
    expect(
        Value.Check(createStemCellRequestSchema, {
            id: "spaceaaaa",
            taskId: "taskaaaa",
            workspaceId: "workspaceaaaa",
            agentId: "agentaaaa",
            mutationId: "m1",
        }),
    ).toBe(true);
});

it("rejects malformed conversation IDs and unknown fields", () => {
    for (const field of ["taskId", "workspaceId", "agentId"]) {
        expect(Value.Check(createStemCellRequestSchema, { [field]: "Not-An-Id" })).toBe(false);
        expect(Value.Check(createStemCellRequestSchema, { [field]: "" })).toBe(false);
    }
    expect(Value.Check(createStemCellRequestSchema, { folderName: "work" })).toBe(false);
});
