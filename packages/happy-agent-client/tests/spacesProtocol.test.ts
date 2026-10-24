import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    spaceBatchAppliedPayloadSchema,
    spacePayloadSchema,
    spaceRemovedPayloadSchema,
    spaceSectionPayloadSchema,
    spaceSectionRemovedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import {
    createStemCellRequestSchema,
    spaceAttentionRequestSchema,
    spaceAttentionResponseSchema,
    spaceBatchSchema,
    spaceListResponseSchema,
    spaceSchema,
    spaceSectionSchema,
    removeSpaceRequestSchema,
    updateSpaceRequestSchema,
    updateSpaceSectionRequestSchema,
    type Space,
    type SpaceBatch,
    type SpaceSection,
} from "../sources/protocol/spaces.js";

const at = 1_755_400_000_000;

const space: Space = {
    createdAt: at - 10_000,
    icon: { slug: "app-store-release", type: "library" },
    id: "space1",
    orderKey: "5",
    placement: "settled",
    sectionId: "section1",
    target: { agentId: "agent1", id: "task1", kind: "task", workspaceId: "workspace1" },
    title: "Android 2.5 release",
    updatedAt: at,
    version: 4,
    visibility: "shown",
    working: false,
};

const section: SpaceSection = {
    collapsed: false,
    createdAt: at - 10_000,
    id: "section1",
    name: "Releases",
    orderKey: "5",
    tailExpanded: false,
    updatedAt: at,
    version: 2,
    visibleCount: 3,
};

const batch: SpaceBatch = {
    appliedAt: at,
    changes: [
        {
            from: { index: 0, sectionId: "section1", sectionName: "Releases", visibility: "shown" },
            spaceId: "space1",
            title: "Preview viewer release",
            to: { index: 0, sectionId: null, sectionName: null, visibility: "folded" },
        },
    ],
    id: "batch1",
    note: "Moved Preview viewer release to Older.",
    noteMessageId: "message1",
};

describe("spaces protocol", () => {
    it("validates rows, sections, and batches", () => {
        expect(Value.Check(spaceSchema, space)).toBe(true);
        // New work has no title and no icon yet; a Surface has no conversation.
        expect(
            Value.Check(spaceSchema, {
                ...space,
                icon: null,
                placement: "pending",
                sectionId: null,
                title: null,
                target: { agentId: null, id: "surface1", kind: "surface", workspaceId: null },
            }),
        ).toBe(true);
        expect(Value.Check(spaceSchema, { ...space, icon: { type: "stem_cell" } })).toBe(true);
        expect(Value.Check(spaceSchema, { ...space, icon: { type: "image", url: "/a" } })).toBe(
            true,
        );
        expect(
            Value.Check(spaceSchema, { ...space, target: { ...space.target, kind: "file" } }),
        ).toBe(false);
        expect(Value.Check(spaceSchema, { ...space, visibility: "older" })).toBe(false);
        expect(Value.Check(spaceSectionSchema, section)).toBe(true);
        expect(Value.Check(spaceSectionSchema, { ...section, visibleCount: null })).toBe(true);
        expect(Value.Check(spaceBatchSchema, batch)).toBe(true);
        expect(Value.Check(spaceBatchSchema, { ...batch, noteMessageId: null, changes: [] })).toBe(
            true,
        );
        expect(
            Value.Check(spaceListResponseSchema, {
                cursor: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
                sections: [section],
                spaces: [space],
            }),
        ).toBe(true);
        expect(Value.Check(spaceAttentionResponseSchema, { batch: null })).toBe(true);
    });

    it("validates requests", () => {
        expect(Value.Check(createStemCellRequestSchema, {})).toBe(true);
        expect(Value.Check(createStemCellRequestSchema, { sectionId: null, id: "space1" })).toBe(
            true,
        );
        expect(
            Value.Check(createStemCellRequestSchema, {
                id: "space1",
                taskId: "task1",
                workspaceId: "workspace1",
                agentId: "agent1",
            }),
        ).toBe(true);
        expect(
            Value.Check(healthResponseSchema, {
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol: 32, daemon: "1.0.0" },
                capabilities: { stemCellIdentities: true, sidebarAttachments: true },
            }),
        ).toBe(true);
        expect(Value.Check(updateSpaceRequestSchema, { sectionId: null, afterId: null })).toBe(
            true,
        );
        expect(Value.Check(updateSpaceRequestSchema, { visibility: "folded" })).toBe(true);
        expect(Value.Check(updateSpaceRequestSchema, { visibility: "gone" })).toBe(false);
        expect(Value.Check(removeSpaceRequestSchema, { removed: true })).toBe(true);
        expect(Value.Check(removeSpaceRequestSchema, { removed: false })).toBe(false);
        expect(Value.Check(updateSpaceSectionRequestSchema, { tailExpanded: true })).toBe(true);
        expect(Value.Check(spaceAttentionRequestSchema, { state: "calm" })).toBe(true);
        expect(Value.Check(spaceAttentionRequestSchema, { state: "idle" })).toBe(false);
    });

    it("validates space events", () => {
        const events: HappyAgentEvent[] = [
            { cursor: "c1", occurredAt: at, payload: { space }, type: "space.created" },
            {
                cursor: "c2",
                occurredAt: at,
                payload: { mutationId: "move-1", space },
                type: "space.updated",
            },
            { cursor: "c3", occurredAt: at, payload: { spaceId: "space1" }, type: "space.removed" },
            { cursor: "c4", occurredAt: at, payload: { section }, type: "space.section.created" },
            {
                cursor: "c5",
                occurredAt: at,
                payload: { sectionId: "section1" },
                type: "space.section.removed",
            },
            { cursor: "c6", occurredAt: at, payload: { batch }, type: "space.batch.applied" },
        ];
        expect(Value.Check(spacePayloadSchema, events[0]?.payload)).toBe(true);
        expect(Value.Check(spacePayloadSchema, events[1]?.payload)).toBe(true);
        expect(Value.Check(spaceRemovedPayloadSchema, events[2]?.payload)).toBe(true);
        expect(Value.Check(spaceSectionPayloadSchema, events[3]?.payload)).toBe(true);
        expect(Value.Check(spaceSectionRemovedPayloadSchema, events[4]?.payload)).toBe(true);
        expect(Value.Check(spaceBatchAppliedPayloadSchema, events[5]?.payload)).toBe(true);
    });

    it("calls the space routes", async () => {
        const requests: { method: string; url: string; body: string | null }[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            const url = input.toString();
            if (url.endsWith("/tidy") || init?.body?.toString().includes('"removed"')) {
                return new Response(null, { status: url.endsWith("/tidy") ? 202 : 204 });
            }
            const body = url.endsWith("/v0/spaces")
                ? { cursor: "c1", sections: [section], spaces: [space] }
                : url.includes("/batches")
                  ? { batches: [batch] }
                  : url.endsWith("/attention")
                    ? { batch }
                    : url.includes("/sections/")
                      ? { section }
                      : { space };
            return new Response(JSON.stringify(body), {
                headers: { "content-type": "application/json" },
                status: 200,
            });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.listSpaces()).resolves.toEqual({
            cursor: "c1",
            sections: [section],
            spaces: [space],
        });
        await expect(client.listSpaceBatches({ limit: 100 })).resolves.toEqual({
            batches: [batch],
        });
        await client.createStemCell({ sectionId: "section1" });
        await client.createStemCell({
            id: "space2",
            taskId: "task2",
            workspaceId: "workspace2",
            agentId: "agent2",
        });
        await expect(
            client.updateSpace("space1", { afterId: null, sectionId: null, mutationId: "m1" }),
        ).resolves.toEqual({ space });
        await client.updateSpace("space1", { visibility: "hidden" });
        await client.removeSpace("space1", { mutationId: "m2" });
        await expect(
            client.updateSpaceSection("section1", { collapsed: true, tailExpanded: false }),
        ).resolves.toEqual({ section });
        await expect(client.reportSpaceAttention({ state: "calm" })).resolves.toEqual({ batch });
        await client.tidySpaces({ mutationId: "tidy-1" });

        expect(requests).toEqual([
            { body: null, method: "GET", url: "http://agent.local/v0/spaces" },
            { body: null, method: "GET", url: "http://agent.local/v0/spaces/batches?limit=100" },
            {
                body: JSON.stringify({ sectionId: "section1" }),
                method: "POST",
                url: "http://agent.local/v0/spaces/stem-cells",
            },
            {
                body: JSON.stringify({
                    id: "space2",
                    taskId: "task2",
                    workspaceId: "workspace2",
                    agentId: "agent2",
                }),
                method: "POST",
                url: "http://agent.local/v0/spaces/stem-cells",
            },
            {
                body: JSON.stringify({ afterId: null, sectionId: null, mutationId: "m1" }),
                method: "PATCH",
                url: "http://agent.local/v0/spaces/space1",
            },
            {
                body: JSON.stringify({ visibility: "hidden" }),
                method: "PATCH",
                url: "http://agent.local/v0/spaces/space1",
            },
            {
                body: JSON.stringify({ removed: true, mutationId: "m2" }),
                method: "PATCH",
                url: "http://agent.local/v0/spaces/space1",
            },
            {
                body: JSON.stringify({ collapsed: true, tailExpanded: false }),
                method: "PATCH",
                url: "http://agent.local/v0/spaces/sections/section1",
            },
            {
                body: JSON.stringify({ state: "calm" }),
                method: "POST",
                url: "http://agent.local/v0/spaces/attention",
            },
            {
                body: JSON.stringify({ mutationId: "tidy-1" }),
                method: "POST",
                url: "http://agent.local/v0/spaces/tidy",
            },
        ]);
    });
});
