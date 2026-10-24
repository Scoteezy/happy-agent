import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { artifactTypeSchema } from "../sources/protocol/artifacts.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    stickerPackResponseSchema,
    stickerRecentsResponseSchema,
    stickerRecentsUpdatedPayloadSchema,
    stickerGridColumns,
    MAX_STICKER_RECENTS,
} from "../sources/protocol/stickers.js";
import {
    createStoryRequestSchema,
    setStoryReactionRequestSchema,
    STORIES_SETTING_KEY,
    STORY_HAPTIC_MOMENTS,
    storyFeedResponseSchema,
    storyOverlaySchema,
    storyReactedPayloadSchema,
    storySchema,
    storyViewersResponseSchema,
    updateStoryRequestSchema,
    type Story,
} from "../sources/protocol/stories.js";

const transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

const story: Story = {
    id: "s7k2m9q4w1e5t8y3u6i0o2p5",
    status: "draft",
    authorUserId: "u1x2y3z4a5b6c7d8e9f0g1h2",
    createdBy: { kind: "agent", agentId: "a9b8c7d6e5f4g3h2i1j0k9l8" },
    source: { agentId: "a9b8c7d6e5f4g3h2i1j0k9l8", toolCallId: "c3v5b7n9m1q2w4e6r8t0y2u4" },
    caption: "Login redirect loop: fixed.",
    frames: [
        {
            id: "f1a2b3c4d5e6f7g8h9i0j1k2",
            kind: "image",
            width: 1440,
            height: 900,
            scale: 2,
            thumbhash: "3PcNNYSFeXh/d3eld0iHZoZgVwh2",
            durationMs: null,
            asset: {
                type: "chat_media",
                agentId: "a9b8c7d6e5f4g3h2i1j0k9l8",
                toolCallId: "k8j7h6g5f4d3s2a1q0w9e8r7",
                index: 0,
            },
            available: true,
            placement: transform,
            background: ["#1D2B3A", "#4A6A84"],
            overlays: [
                {
                    id: "o4r5t6y7u8i9o0p1a2s3d4f5",
                    type: "text",
                    text: "No more loops",
                    style: {
                        font: "sanFrancisco",
                        fill: "filled",
                        color: "#FFFFFF",
                        align: "center",
                        width: 0.8,
                    },
                    transform: { ...transform, y: 0.2 },
                },
                {
                    id: "o9p8i7u6y5t4r3e2w1q0a9s8",
                    type: "sticker",
                    packId: "utyaduck",
                    stickerId: "AgAD8gADVp29Cg",
                    transform: { x: 0.78, y: 0.8, scale: 0.35, rotation: -0.2 },
                },
                {
                    id: "o1q2w3e4r5t6y7u8i9o0p1a2",
                    type: "reaction",
                    emoji: "❤️",
                    flipped: true,
                    transform: { x: 0.2, y: 0.8, scale: 0.2, rotation: 0.1 },
                },
            ],
        },
    ],
    audience: "team",
    artifactVersion: 3,
    createdAt: 1755300000000,
    updatedAt: 1755300500000,
    postedAt: null,
    expiresAt: null,
    seen: false,
    viewCount: null,
    myReaction: null,
    reactions: [],
    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
};

describe("story schemas", () => {
    it("accepts the documented story, its artifact type, and the capabilities", () => {
        expect(Value.Check(storySchema, story)).toBe(true);
        expect(Value.Check(artifactTypeSchema, "story")).toBe(true);
        expect(
            Value.Check(healthResponseSchema, {
                capabilities: { stories: true, stickers: true },
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol: 22, daemon: "1.2.3" },
            }),
        ).toBe(true);
        expect(STORIES_SETTING_KEY).toBe("happy-desktop.experiments.stories");
    });

    it("keeps overlays on the canvas bounds and the documented styles", () => {
        const sticker = story.frames[0]!.overlays[1]!;
        expect(
            Value.Check(storyOverlaySchema, { ...sticker, transform: { ...transform, x: 1.6 } }),
        ).toBe(false);
        expect(
            Value.Check(storyOverlaySchema, {
                ...sticker,
                transform: { ...transform, scale: 0.01 },
            }),
        ).toBe(false);
        expect(
            Value.Check(storyOverlaySchema, {
                id: "l1",
                type: "link",
                url: "https://happy.engineering/",
                label: null,
                style: "blur",
                transform,
            }),
        ).toBe(true);
        expect(
            Value.Check(storyOverlaySchema, {
                id: "l1",
                type: "link",
                url: "javascript:alert(1)",
                label: null,
                style: "white",
                transform,
            }),
        ).toBe(false);
        expect(
            Value.Check(storyOverlaySchema, {
                id: "t1",
                type: "text",
                text: "Hi",
                style: {
                    font: "comicSans",
                    fill: "regular",
                    color: "#000000",
                    align: "left",
                    width: 1,
                },
                transform,
            }),
        ).toBe(false);
        expect(
            Value.Check(storyOverlaySchema, {
                id: "r1",
                type: "reaction",
                emoji: "🔥",
                dark: true,
                transform,
            }),
        ).toBe(true);
    });

    it("bounds frames and requires media on a new frame", () => {
        const upload = { upload: { uploadId: "u8p2l4o6a1d3e5f7g9h0j2k4", name: "IMG_0042.jpg" } };
        expect(Value.Check(createStoryRequestSchema, { frames: [upload] })).toBe(true);
        expect(Value.Check(createStoryRequestSchema, { frames: [] })).toBe(false);
        expect(
            Value.Check(createStoryRequestSchema, {
                frames: Array.from({ length: 11 }, () => upload),
            }),
        ).toBe(false);
        expect(Value.Check(createStoryRequestSchema, { frames: [{ overlays: [] }] })).toBe(false);
        // On PATCH, a frame that keeps its ID keeps its media.
        expect(
            Value.Check(updateStoryRequestSchema, {
                frames: [{ id: "f1a2b3c4d5e6f7g8h9i0j1k2", overlays: [] }],
            }),
        ).toBe(true);
    });

    it("describes the stories row with the caller's circle first", () => {
        const feed = {
            authors: [
                {
                    userId: "u1x2y3z4a5b6c7d8e9f0g1h2",
                    name: "Kirill",
                    photo: "/v0/users/u1x2y3z4a5b6c7d8e9f0g1h2/photo",
                    thumbhash: null,
                    isSelf: true,
                    storyIds: [],
                    unseenCount: 0,
                    draftCount: 1,
                    latestPostedAt: null,
                },
            ],
            stories: {},
            cursor: "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
        };
        expect(Value.Check(storyFeedResponseSchema, feed)).toBe(true);
        expect(Value.Check(storyFeedResponseSchema, { ...feed, authors: [] })).toBe(false);
    });

    it("carries reactions, viewers, and the haptic moments", () => {
        expect(Value.Check(setStoryReactionRequestSchema, { emoji: "❤️" })).toBe(true);
        expect(
            Value.Check(storyReactedPayloadSchema, {
                storyId: story.id,
                reactions: [{ emoji: "❤️", count: 2 }],
            }),
        ).toBe(true);
        expect(
            Value.Check(storyReactedPayloadSchema, {
                storyId: story.id,
                reactions: [],
                myReaction: null,
            }),
        ).toBe(true);
        expect(
            Value.Check(storyViewersResponseSchema, {
                viewers: [
                    {
                        userId: "u9z8y7x6w5v4u3t2s1r0q9p8",
                        name: "Steve",
                        photo: null,
                        thumbhash: null,
                        reaction: "🔥",
                        reactedAt: 1755400000000,
                    },
                ],
                nextCursor: null,
            }),
        ).toBe(true);
        expect(STORY_HAPTIC_MOMENTS).toContain("story.react");
        expect(STORY_HAPTIC_MOMENTS).toContain("overlay.snap");
    });
});

describe("sticker schemas", () => {
    it("accepts a pack and bounds recents", () => {
        expect(
            Value.Check(stickerPackResponseSchema, {
                pack: {
                    id: "utyaduck",
                    title: "Duck",
                    kind: "stickers",
                    thumbnail: "AgAD8gADVp29Cg",
                    stickerCount: 1,
                    version: "a34d668493927d74",
                },
                stickers: [
                    {
                        packId: "utyaduck",
                        id: "AgAD8gADVp29Cg",
                        emoji: ["😂"],
                        format: "tgs",
                        width: 512,
                        height: 512,
                        size: 5272,
                        sha256: "a34d668493927d74a2b2032a496f7e31f77d47c2e6f3a4e568933950d293e206",
                    },
                ],
            }),
        ).toBe(true);
        const ref = { packId: "utyaduck", stickerId: "AgAD8gADVp29Cg" };
        expect(Value.Check(stickerRecentsResponseSchema, { recents: [ref], cursor: "c" })).toBe(
            true,
        );
        expect(
            Value.Check(stickerRecentsUpdatedPayloadSchema, {
                recents: Array.from({ length: MAX_STICKER_RECENTS + 1 }, () => ref),
            }),
        ).toBe(false);
    });

    it("computes the picker's columns as Telegram does", () => {
        expect(stickerGridColumns("stickers", 375 - 20, 8)).toBe(5);
        expect(stickerGridColumns("stickers", 300, 8)).toBe(5);
        expect(stickerGridColumns("stickers", 700, 8)).toBe(9);
        expect(stickerGridColumns("emoji", 355, 8)).toBe(8);
    });
});

describe("story and sticker routes", () => {
    it("sends each route with its method, path, query, body, and If-Match", async () => {
        const requests: { method: string; url: string; body: unknown; ifMatch: string | null }[] =
            [];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                const headers = new Headers(init?.headers);
                requests.push({
                    method: init?.method ?? "GET",
                    url: input.toString().replace("http://agent.local", ""),
                    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                    ifMatch: headers.get("if-match"),
                });
                return Response.json({ story });
            },
        });
        await client.getStoryFeed();
        await client.listStories({ status: ["draft", "posted"], limit: 10 });
        await client.createStory({ id: story.id, frames: [{ asset: story.frames[0]!.asset }] });
        await client.listStoryMedia({ agentId: "a1" });
        await client.getStory(story.id);
        await client.updateStory(story.id, { caption: "x" }, { ifMatch: story.version });
        await client.postStory(story.id, { artifactVersion: 3 });
        await client.deleteStory(story.id, { ifMatch: story.version, mutationId: "m" });
        await client.markStorySeen(story.id);
        await client.setStoryReaction(story.id, { emoji: "❤️" });
        await client.removeStoryReaction(story.id);
        await client.listStoryViewers(story.id, { limit: 5 });
        await client.listStickerPacks();
        await client.getStickerPack("utyaduck");
        await client.searchStickers({ emoji: "😂" });
        await client.getStickerRecents();
        await client.useSticker({ packId: "utyaduck", stickerId: "AgAD8gADVp29Cg" });
        await client.clearStickerRecents();
        const id = story.id;
        expect(requests).toEqual([
            { method: "GET", url: "/v0/stories/feed", body: null, ifMatch: null },
            {
                method: "GET",
                url: "/v0/stories?status=draft%2Cposted&limit=10",
                body: null,
                ifMatch: null,
            },
            {
                method: "POST",
                url: "/v0/stories",
                body: { id, frames: [{ asset: story.frames[0]!.asset }] },
                ifMatch: null,
            },
            { method: "GET", url: "/v0/stories/media?agentId=a1", body: null, ifMatch: null },
            { method: "GET", url: `/v0/stories/${id}`, body: null, ifMatch: null },
            {
                method: "PATCH",
                url: `/v0/stories/${id}`,
                body: { caption: "x" },
                ifMatch: story.version,
            },
            {
                method: "POST",
                url: `/v0/stories/${id}/post`,
                body: { artifactVersion: 3 },
                ifMatch: null,
            },
            {
                method: "POST",
                url: `/v0/stories/${id}/delete`,
                body: { mutationId: "m" },
                ifMatch: story.version,
            },
            { method: "POST", url: `/v0/stories/${id}/seen`, body: {}, ifMatch: null },
            {
                method: "PUT",
                url: `/v0/stories/${id}/reaction`,
                body: { emoji: "❤️" },
                ifMatch: null,
            },
            { method: "DELETE", url: `/v0/stories/${id}/reaction`, body: {}, ifMatch: null },
            { method: "GET", url: `/v0/stories/${id}/viewers?limit=5`, body: null, ifMatch: null },
            { method: "GET", url: "/v0/stickers/packs", body: null, ifMatch: null },
            { method: "GET", url: "/v0/stickers/packs/utyaduck", body: null, ifMatch: null },
            {
                method: "GET",
                url: `/v0/stickers/search?emoji=${encodeURIComponent("😂")}`,
                body: null,
                ifMatch: null,
            },
            { method: "GET", url: "/v0/stickers/recents", body: null, ifMatch: null },
            {
                method: "POST",
                url: "/v0/stickers/recents",
                body: { packId: "utyaduck", stickerId: "AgAD8gADVp29Cg" },
                ifMatch: null,
            },
            { method: "DELETE", url: "/v0/stickers/recents", body: {}, ifMatch: null },
        ]);
        expect(client.storyFrameUrl(id, "f1")).toBe(
            `http://agent.local/v0/stories/${id}/frames/f1`,
        );
        expect(client.stickerFileUrl("utyaduck", "AgAD8gADVp29Cg", true)).toBe(
            "http://agent.local/v0/stickers/packs/utyaduck/stickers/AgAD8gADVp29Cg/file?as=lottie",
        );
    });

    it("surfaces a stale post as a conflict carrying the current story", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async () =>
                Response.json(
                    { error: "The story changed since you saw it.", code: "conflict", story },
                    { status: 409 },
                ),
        });
        await expect(client.postStory(story.id, { artifactVersion: 2 })).rejects.toMatchObject({
            status: 409,
            body: { code: "conflict", story: { artifactVersion: 3 } },
        });
    });
});
