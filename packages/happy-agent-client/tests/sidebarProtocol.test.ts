import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { artifactTypeSchema } from "../sources/protocol/artifacts.js";
import {
    createStemCellRequestSchema,
    spaceSidebarResponseSchema,
    updateSpaceSidebarRequestSchema,
    spaceSidebarObservationsRequestSchema,
} from "../sources/protocol/spaces.js";

it("validates sidebar artifact and document request boundaries", () => {
    expect(Value.Check(artifactTypeSchema, "sidebar")).toBe(true);
    expect(Value.Check(createStemCellRequestSchema, { sectionId: "desktop-release" })).toBe(true);
    expect(
        Value.Check(spaceSidebarResponseSchema, {
            artifactId: "artifact1",
            version: 1,
            html: "<nav></nav>",
            spaces: [],
        }),
    ).toBe(true);
    expect(
        Value.Check(updateSpaceSidebarRequestSchema, {
            baseVersion: 1,
            html: "<nav></nav>",
            mutationId: "move-1",
        }),
    ).toBe(true);
    expect(
        Value.Check(updateSpaceSidebarRequestSchema, { html: "<nav></nav>", mutationId: "move-1" }),
    ).toBe(false);
    expect(
        Value.Check(spaceSidebarObservationsRequestSchema, {
            visibleSpaceIds: ["space1"],
            collapsed: ["older"],
        }),
    ).toBe(true);
    expect(
        Value.Check(spaceSidebarObservationsRequestSchema, {
            visibleSpaceIds: ["space1", "space1"],
        }),
    ).toBe(false);
});

it("uses sidebar routes and preserves diagnostic and conflict error bodies", async () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    const document = { artifactId: "artifact1", version: 2, html: "<nav></nav>", spaces: [] };
    const client = new HappyAgentClient({
        endpoint: "http://agent.local",
        token: "t",
        fetch: async (input, init) => {
            const path = new URL(input.toString()).pathname;
            const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
            requests.push({ method: init?.method ?? "GET", path, body });
            if (path.endsWith("observations")) return new Response(null, { status: 204 });
            if (body?.baseVersion === 1)
                return Response.json(
                    { error: "The sidebar changed.", code: "conflict", currentVersion: 2 },
                    { status: 409 },
                );
            if (body?.html === "<script>")
                return Response.json(
                    {
                        error: "Invalid sidebar.",
                        code: "invalid_request",
                        diagnostics: [{ message: "Element script is not allowed.", offset: 0 }],
                    },
                    { status: 400 },
                );
            return Response.json(document);
        },
    });
    expect(await client.getSpaceSidebar()).toEqual(document);
    const update = { baseVersion: 2, html: "<nav></nav>", mutationId: "retry-1" };
    expect(await client.updateSpaceSidebar(update)).toEqual(document);
    expect(await client.updateSpaceSidebar(update)).toEqual(document);
    await client.reportSpaceSidebarObservations({ visibleSpaceIds: [] });
    await expect(client.updateSpaceSidebar({ ...update, baseVersion: 1 })).rejects.toMatchObject({
        status: 409,
        body: { currentVersion: 2 },
    });
    await expect(client.updateSpaceSidebar({ ...update, html: "<script>" })).rejects.toMatchObject({
        status: 400,
        body: { diagnostics: [{ offset: 0 }] },
    });
    expect(requests.slice(0, 4)).toEqual([
        { method: "GET", path: "/v0/spaces/sidebar", body: null },
        { method: "PUT", path: "/v0/spaces/sidebar", body: update },
        { method: "PUT", path: "/v0/spaces/sidebar", body: update },
        { method: "POST", path: "/v0/spaces/sidebar/observations", body: { visibleSpaceIds: [] } },
    ]);
});
