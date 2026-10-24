import { crc32, deflateSync } from "node:zlib";

import { HappyAgentApiError, type HappyAgentClient } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const STORIES = "happy-desktop.experiments.stories";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

/** A decodable one-colour PNG. */
function png(width: number, height: number, color: readonly number[]): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.byteLength);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) rows.set(color, y * (width * 4 + 1) + 1 + x * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

async function status(promise: Promise<unknown>): Promise<number> {
    try {
        await promise;
        return 200;
    } catch (error) {
        if (error instanceof HappyAgentApiError) return error.status;
        throw error;
    }
}

async function storyEvents(client: HappyAgentClient, after: string) {
    return (await client.getEvents({ after, limit: 1_000 })).events.filter((event) =>
        event.type.startsWith("story."),
    );
}

describe("stories reach teammates, who see and react to them", () => {
    it("shows a posted story to teammates with Stories on, tracks who saw it, and keeps drafts private", async () => {
        const team = await surfaceTeamClients({ timeoutMs: 20_000 });
        disposers.push(() => team.gym.dispose());
        const { alice, bob, aliceId, bobId } = team;
        const carol = team.clientFor("carol");
        const carolId = await team.onboard(carol, "Carol");
        await alice.saveUserSetting(STORIES, { value: true });
        await bob.saveUserSetting(STORIES, { value: true });

        // Bob makes a story by hand from an upload; it starts as his private draft.
        const red = png(16, 32, [255, 0, 0, 255]);
        const upload = await bob.uploadArtifactFile({ data: new Uint8Array(red) });
        const draft = (
            await bob.createStory({
                caption: "Shipped it",
                frames: [{ upload: { uploadId: upload.upload.id, name: "shot.png" } }],
                mutationId: "bob-create",
            })
        ).story;
        expect(draft).toMatchObject({
            status: "draft",
            authorUserId: bobId,
            createdBy: { kind: "user", userId: bobId },
            source: null,
            audience: "team",
            artifactVersion: 1,
        });
        expect(draft.frames).toEqual([
            expect.objectContaining({
                kind: "image",
                width: 16,
                height: 32,
                available: true,
                asset: {
                    type: "artifact_file",
                    artifactId: draft.id,
                    version: 1,
                    path: `media/${draft.frames[0]!.id}.png`,
                },
                background: ["#FF0000", "#FF0000"],
            }),
        ]);
        expect(await status(alice.getStory(draft.id))).toBe(404);
        expect(await status(alice.getStoryFrame(draft.id, draft.frames[0]!.id))).toBe(404);
        const aliceRow = await alice.getStoryFeed();
        expect(aliceRow.authors.map((author) => author.userId)).toEqual([aliceId]);
        expect(aliceRow.stories[draft.id]).toBeUndefined();

        // Keeping a frame by ID keeps its media; the edit adds a reaction bubble.
        const bubbleId = "k2b1u0bb1e0000000000000a";
        const edited = (
            await bob.updateStory(
                draft.id,
                {
                    frames: [
                        {
                            id: draft.frames[0]!.id,
                            overlays: [
                                {
                                    id: bubbleId,
                                    type: "reaction",
                                    emoji: "🔥",
                                    transform: { x: 0.5, y: 0.7, scale: 0.3, rotation: 0 },
                                },
                            ],
                        },
                    ],
                },
                { ifMatch: draft.version },
            )
        ).story;
        expect(edited.artifactVersion).toBe(2);
        expect(edited.frames[0]).toMatchObject({
            id: draft.frames[0]!.id,
            asset: draft.frames[0]!.asset,
            available: true,
            overlays: [expect.objectContaining({ id: bubbleId, emoji: "🔥" })],
        });

        // Posting reaches Alice, who has Stories on, and never Carol, who does not.
        const aliceStart = (await alice.getEvents({ limit: 1 })).latestCursor;
        const carolStart = (await carol.getEvents({ limit: 1 })).latestCursor;
        const posted = (await bob.postStory(draft.id, { artifactVersion: 2 })).story;
        expect(posted.status).toBe("posted");
        const reached = await team.gym.waitUntil(async () => {
            const events = await storyEvents(alice, aliceStart);
            return events.length > 0 ? events : undefined;
        }, "Alice hears of Bob's story");
        expect(reached.map((event) => event.type)).toEqual(["story.posted"]);
        expect(reached[0]!.payload).toMatchObject({
            story: { id: draft.id, seen: false, viewCount: null, myReaction: null },
        });
        expect(await storyEvents(carol, carolStart)).toEqual([]);
        expect(await status(carol.getStoryFeed())).toBe(404);
        expect(await status(carol.getStory(draft.id))).toBe(404);

        const row = await alice.getStoryFeed();
        expect(row.authors).toEqual([
            expect.objectContaining({ userId: aliceId, isSelf: true, storyIds: [], draftCount: 0 }),
            expect.objectContaining({
                userId: bobId,
                name: "Bob",
                isSelf: false,
                storyIds: [draft.id],
                unseenCount: 1,
                draftCount: null,
                latestPostedAt: posted.postedAt,
            }),
        ]);
        const frame = await alice.getStoryFrame(draft.id, draft.frames[0]!.id);
        expect(Buffer.from(frame!.data)).toEqual(red);

        // Alice sees it, then reacts; only Bob learns who saw it and how they reacted.
        const bobStart = (await bob.getEvents({ limit: 1 })).latestCursor;
        const aliceSeenStart = (await alice.getEvents({ limit: 1 })).latestCursor;
        const seen = (await alice.markStorySeen(draft.id)).story;
        expect(seen.seen).toBe(true);
        const marked = await team.gym.waitUntil(async () => {
            const events = await storyEvents(alice, aliceSeenStart);
            return events.length > 0 ? events : undefined;
        }, "Alice's other devices hear of her seen mark");
        expect(marked.map((event) => event.type)).toEqual(["story.seen"]);
        expect(marked[0]!.payload).toMatchObject({ authorUserId: bobId, storyId: draft.id });
        expect((await alice.getStoryFeed()).authors[1]).toMatchObject({ unseenCount: 0 });
        const reacted = (
            await alice.setStoryReaction(draft.id, { emoji: "🔥", mutationId: "react-1" })
        ).story;
        expect(reacted).toMatchObject({ myReaction: "🔥", reactions: [{ emoji: "🔥", count: 1 }] });
        const replaced = (await alice.setStoryReaction(draft.id, { emoji: "👍" })).story;
        expect(replaced).toMatchObject({
            myReaction: "👍",
            reactions: [{ emoji: "👍", count: 1 }],
        });

        const bobView = (await bob.getStory(draft.id)).story;
        expect(bobView).toMatchObject({
            viewCount: 1,
            myReaction: null,
            reactions: [{ emoji: "👍", count: 1 }],
        });
        const viewers = await bob.listStoryViewers(draft.id);
        expect(viewers.viewers).toEqual([
            expect.objectContaining({ userId: aliceId, name: "Alice", reaction: "👍" }),
        ]);
        expect(await status(alice.listStoryViewers(draft.id))).toBe(404);
        const bobEvents = await team.gym.waitUntil(async () => {
            const events = await storyEvents(bob, bobStart);
            return events.filter((event) => event.type === "story.reacted").length >= 2
                ? events
                : undefined;
        }, "Bob hears of Alice's reactions");
        // The seen mark is Alice's alone; Bob reads his view count again instead.
        expect(bobEvents.map((event) => event.type)).toEqual(["story.reacted", "story.reacted"]);
        expect(bobEvents[1]!.payload).toMatchObject({
            storyId: draft.id,
            reactions: [{ emoji: "👍", count: 1 }],
        });
        expect(bobEvents[1]!.payload).not.toHaveProperty("myReaction");

        // Taking a reaction back clears it everywhere.
        const cleared = (await alice.removeStoryReaction(draft.id)).story;
        expect(cleared).toMatchObject({ myReaction: null, reactions: [], seen: true });
        expect((await bob.listStoryViewers(draft.id)).viewers).toEqual([
            expect.objectContaining({ userId: aliceId, reaction: null, reactedAt: null }),
        ]);

        // Turning Stories off hides Bob from Alice's row, and his story with him.
        await bob.saveUserSetting(STORIES, { value: false });
        expect((await alice.getStoryFeed()).authors.map((author) => author.userId)).toEqual([
            aliceId,
        ]);
        expect(await status(alice.getStory(draft.id))).toBe(404);
        expect(carolId).not.toBe(bobId);
        expect(team.gym.errors).toEqual([]);
    }, 60_000);
});
