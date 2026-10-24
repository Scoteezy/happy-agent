import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { crc32, deflateSync } from "node:zlib";

import type { Story } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const STORIES = "happy-desktop.experiments.stories";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

/** A decodable PNG whose top rows are dark red and bottom rows bright blue. */
function png(width: number, height: number): Buffer {
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
        for (let x = 0; x < width; x += 1) {
            const color = y < height / 2 ? [128, 0, 0, 255] : [0, 0, 255, 255];
            rows.set(color, y * (width * 4 + 1) + 1 + x * 4);
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const CHART = png(8, 8);

/** A raw request, for headers the typed client neither sends nor surfaces. */
async function raw(
    gym: AgentGym,
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    const payload =
        options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    return await new Promise((resolve, reject) => {
        const call = httpRequest(
            {
                headers: {
                    authorization: `Bearer ${gym.http.token}`,
                    ...(payload === undefined
                        ? {}
                        : {
                              "content-type": "application/json",
                              "content-length": String(payload.byteLength),
                          }),
                    ...options.headers,
                },
                method: options.method ?? "GET",
                path,
                socketPath: gym.http.socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                    }),
                );
            },
        );
        call.on("error", reject);
        call.end(payload);
    });
}

/** A gym whose model makes the tool call each message's marker names, then says it is done. */
async function harness() {
    const calls = new Map<string, GymTurn>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        files: { "out/chart.png": CHART },
        inference: (request) => {
            // Detached title naming sees the first message too; only the agent loop acts on it.
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "Chart story" }] };
            }
            const last = JSON.stringify(request.messages.at(-1));
            for (const [marker, turn] of calls) {
                if (last.includes(marker)) {
                    calls.delete(marker);
                    return turn;
                }
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    running.push(gym);
    let count = 0;
    async function call(
        name: string,
        args: Record<string, unknown>,
        permissionMode: "auto" | "read_only" = "auto",
    ) {
        const marker = `story_step_${String(++count)}`;
        calls.set(marker, {
            content: [{ type: "tool_call", name, arguments: args, callId: marker }],
        });
        await gym.send(`Please do the next step, ${marker}.`, { permissionMode });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === marker),
            `the ${name} result`,
        );
    }
    return { gym, call };
}

async function toolBlocks(gym: AgentGym, name: string) {
    const page = await gym.client.getMessages(gym.defaultSessionId);
    return page.runs
        .flatMap((run) => run.messages)
        .flatMap((message) => message.content)
        .filter((block) => block.type === "tool_call" && block.name === name) as {
        id: string;
        status: string;
        presentation?: Record<string, unknown>;
    }[];
}

async function eventsAfter(gym: AgentGym, cursor: string) {
    return (await gym.client.getEvents({ after: cursor, limit: 1_000 })).events;
}

describe('"post it" drafts a story inline for its author to post', () => {
    it("drafts from the conversation's media, keeps the person's edits, and posts only on Post", async () => {
        const { gym, call } = await harness();
        await gym.client.saveUserSetting(STORIES, { value: true });
        const agentId = gym.defaultSessionId;

        await call("present_files", { filepaths: ["out/chart.png"] });
        const [shown] = await toolBlocks(gym, "present_files");
        const start = (await gym.client.getEvents({ limit: 1 })).latestCursor;

        const drafted = await call("draft_story", { caption: "The chart is done." });
        expect(drafted.text).toContain("Drafted story");
        expect(drafted.text).toContain("nothing is shared until they press Post");
        const [block] = await toolBlocks(gym, "draft_story");
        const storyId = (block!.presentation as { artifactId: string }).artifactId;
        expect(block).toMatchObject({
            status: "completed",
            presentation: {
                type: "artifact",
                artifactId: storyId,
                version: 1,
                artifactType: "story",
                title: "The chart is done.",
                shows: "latest",
            },
        });

        const { story } = await gym.client.getStory(storyId);
        expect(story).toMatchObject({
            id: storyId,
            status: "draft",
            authorUserId: null,
            createdBy: { kind: "agent", agentId },
            source: { agentId, toolCallId: block!.id },
            caption: "The chart is done.",
            audience: "self",
            artifactVersion: 1,
            postedAt: null,
            expiresAt: null,
            seen: true,
            viewCount: null,
            myReaction: null,
            reactions: [],
        });
        expect(story.frames).toEqual([
            {
                id: expect.any(String),
                kind: "image",
                width: 8,
                height: 8,
                thumbhash: expect.any(String),
                durationMs: null,
                asset: { type: "chat_media", agentId, toolCallId: shown!.id, index: 0 },
                available: true,
                placement: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
                background: ["#800000", "#0000FF"],
                overlays: [],
            },
        ]);
        const created = (await eventsAfter(gym, start)).filter(
            (event) => event.type === "story.created",
        );
        expect(created).toHaveLength(1);
        expect(created[0]!.payload).toEqual({ story });

        // A frame is served through the story, exactly like chat media.
        const frame = await raw(gym, `/v0/stories/${storyId}/frames/${story.frames[0]!.id}`);
        expect(frame.status).toBe(200);
        expect(frame.body).toEqual(CHART);
        expect(frame.headers).toMatchObject({
            "content-type": "image/png",
            "cache-control": "private, max-age=31536000, immutable",
            etag: `"${createHash("sha256").update(CHART).digest("hex")}"`,
            "x-content-type-options": "nosniff",
        });

        // The story's artifact is never listed and never written through the artifact routes.
        const catalog = await gym.http.get<{ artifacts: { id: string }[] }>("/v0/artifacts");
        expect(catalog.body.artifacts.map((artifact) => artifact.id)).not.toContain(storyId);
        const artifact = await gym.http.get<{ artifact: { type: string; version: string } }>(
            `/v0/artifacts/${storyId}`,
        );
        expect(artifact.body.artifact.type).toBe("story");
        const patched = await raw(gym, `/v0/artifacts/${storyId}`, {
            method: "PATCH",
            body: { title: "Hijacked" },
            headers: { "if-match": artifact.body.artifact.version },
        });
        expect(patched.status).toBe(400);

        // The person edits the draft; the agent's stale revision then loses to it.
        const edited = await gym.client.updateStory(
            storyId,
            { caption: "Chart, finally.", mutationId: "edit-1" },
            { ifMatch: story.version },
        );
        expect(edited.story).toMatchObject({
            caption: "Chart, finally.",
            artifactVersion: 2,
            status: "draft",
        });
        const stale = await call("draft_story", {
            storyId,
            baseVersion: 1,
            caption: "Overwritten",
        });
        expect(stale.text).toContain("their edits win");
        expect((await gym.client.getStory(storyId)).story.caption).toBe("Chart, finally.");

        // Post answers only for the version the person saw.
        const conflict = await gym.http.post<{ code: string; story: Story }>(
            `/v0/stories/${storyId}/post`,
            { artifactVersion: 1 },
        );
        expect(conflict.status).toBe(409);
        expect(conflict.body).toMatchObject({ code: "conflict", story: { artifactVersion: 2 } });
        const beforePost = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const posted = (
            await gym.client.postStory(storyId, { artifactVersion: 2, mutationId: "post-1" })
        ).story;
        expect(posted.status).toBe("posted");
        expect(posted.expiresAt).toBe(posted.postedAt! + 24 * 60 * 60 * 1000);
        expect(posted.viewCount).toBe(0);
        const again = (await gym.client.postStory(storyId, { artifactVersion: 2 })).story;
        expect(again.version).toBe(posted.version);
        const postEvents = (await eventsAfter(gym, beforePost)).filter((event) =>
            event.type.startsWith("story."),
        );
        expect(postEvents.map((event) => event.type)).toEqual(["story.posted"]);
        expect(postEvents[0]!.payload).toEqual({ story: posted, mutationId: "post-1" });

        // The author's own circle comes first and holds it; nobody reacts to their own story.
        const feed = await gym.client.getStoryFeed();
        expect(feed.authors).toEqual([
            expect.objectContaining({
                isSelf: true,
                storyIds: [storyId],
                unseenCount: 0,
                draftCount: 0,
            }),
        ]);
        expect(feed.stories[storyId]).toMatchObject({ seen: true, viewCount: 0 });
        const ownReaction = await gym.http.put(`/v0/stories/${storyId}/reaction`, { emoji: "❤️" });
        expect(ownReaction.status).toBe(409);

        // The conversation's media is what the editor offers to choose from.
        const media = await gym.client.listStoryMedia({ agentId });
        expect(media.items).toEqual([
            expect.objectContaining({
                asset: { type: "chat_media", agentId, toolCallId: shown!.id, index: 0 },
                kind: "image",
                name: "chart.png",
                width: 8,
                height: 8,
            }),
        ]);

        // Deleting leaves a tombstone only its author reads, whose frames are no longer served.
        const noVersion = await gym.http.post(`/v0/stories/${storyId}/delete`, {});
        expect(noVersion.status).toBe(400);
        const deleted = (await gym.client.deleteStory(storyId, { ifMatch: posted.version })).story;
        expect(deleted.status).toBe("deleted");
        expect(deleted.frames[0]!.available).toBe(false);
        expect(
            (await raw(gym, `/v0/stories/${storyId}/frames/${story.frames[0]!.id}`)).status,
        ).toBe(404);
        expect((await gym.client.getStoryFeed()).authors[0]!.storyIds).toEqual([]);
        expect(
            (await gym.client.listStories({ status: ["deleted"] })).stories.map((item) => item.id),
        ).toEqual([storyId]);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("marks a frame unavailable once its asset is gone, and drafts nothing in Read only", async () => {
        const { gym, call } = await harness();
        await gym.client.saveUserSetting(STORIES, { value: true });

        // A story made by hand from an image artifact references the artifact's file.
        const upload = await gym.client.uploadArtifactFile({ data: new Uint8Array(CHART) });
        const { artifact } = await gym.client.createArtifact({
            type: "image",
            title: "Chart",
            files: [{ path: "chart.png", uploadId: upload.upload.id }],
        });
        const asset = {
            type: "artifact_file" as const,
            artifactId: artifact.id,
            version: 1,
            path: "chart.png",
        };
        const draft = (await gym.client.createStory({ frames: [{ asset }] })).story;
        expect(draft).toMatchObject({
            createdBy: { kind: "user", userId: null },
            source: null,
            caption: null,
        });
        expect(draft.frames[0]).toMatchObject({ asset, available: true, width: 8, height: 8 });

        // Deleting the artifact leaves the frame in place but unavailable, and unpostable.
        await gym.client.deleteArtifact(artifact.id, { ifMatch: artifact.version });
        const orphaned = (await gym.client.getStory(draft.id)).story;
        expect(orphaned.frames[0]).toMatchObject({ asset, available: false });
        expect(
            (await raw(gym, `/v0/stories/${draft.id}/frames/${draft.frames[0]!.id}`)).status,
        ).toBe(404);
        const refused = await gym.http.post<{ code: string }>(`/v0/stories/${draft.id}/post`, {
            artifactVersion: 1,
        });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe("conflict");

        // Replacing the frame with fresh media makes it postable again.
        const fresh = await gym.client.uploadArtifactFile({ data: new Uint8Array(CHART) });
        const replaced = (
            await gym.client.updateStory(
                draft.id,
                { frames: [{ upload: { uploadId: fresh.upload.id, name: "again.png" } }] },
                { ifMatch: orphaned.version },
            )
        ).story;
        expect(replaced.frames[0]).toMatchObject({
            available: true,
            asset: { type: "artifact_file", artifactId: draft.id, version: 2 },
        });
        expect((await gym.client.postStory(draft.id, { artifactVersion: 2 })).story.status).toBe(
            "posted",
        );

        // Read only offers the tool but drafts nothing.
        const blocked = await call("draft_story", { caption: "Nope" }, "read_only");
        expect(blocked.text).toContain("Read only mode cannot draft a story.");
        expect((await gym.client.listStories()).stories.map((story) => story.id)).toEqual([
            draft.id,
        ]);
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
