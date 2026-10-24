import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const STORIES = "happy-desktop.experiments.stories";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

async function raw(
    gym: AgentGym,
    path: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    return await new Promise((resolve, reject) => {
        const call = httpRequest(
            {
                headers: { authorization: `Bearer ${gym.http.token}` },
                method: "GET",
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
        call.end();
    });
}

interface FixtureSticker {
    readonly id: string;
    readonly emoji: readonly string[];
    readonly format: "webp" | "tgs" | "webm";
    readonly bytes: Buffer;
}

/** Writes one tiny generated pack; nothing from a real pack is ever a fixture. */
async function writePack(
    home: string,
    id: string,
    title: string,
    kind: "stickers" | "emoji",
    stickers: readonly FixtureSticker[],
    tamper = false,
) {
    const folder = join(home, id);
    await mkdir(folder, { recursive: true });
    const entries = [];
    for (const sticker of stickers) {
        const file = `${sticker.id}.${sticker.format}`;
        await writeFile(join(folder, file), sticker.bytes);
        entries.push({
            id: sticker.id,
            file,
            emoji: sticker.emoji,
            format: sticker.format,
            width: 64,
            height: 64,
            size: sticker.bytes.byteLength + (tamper ? 1 : 0),
            sha256: createHash("sha256").update(sticker.bytes).digest("hex"),
        });
    }
    await writeFile(
        join(folder, "pack.json"),
        JSON.stringify({
            id,
            title,
            kind,
            thumbnail: stickers[0]!.id,
            stickers: entries,
            source: "test",
        }),
    );
}

const LOTTIE = JSON.stringify({ v: "5.5.2", fr: 30, ip: 0, op: 30, w: 64, h: 64, layers: [] });
const still = (label: string) => Buffer.from(`RIFF${label}WEBP`);

describe("stickers serve the packs in the agent home's sticker folder", () => {
    it("lists, searches, serves, and remembers stickers, and leaves broken packs out", async () => {
        const gym = await createAgentGym({ timeoutMs: 20_000 });
        running.push(gym);
        await gym.client.saveUserSetting(STORIES, { value: true });
        const home = join(gym.happyHome, "agent", "stickers");

        // Nothing is bundled: an empty folder is an empty catalog.
        expect((await gym.client.listStickerPacks()).packs).toEqual([]);

        await writePack(home, "utyaduck", "Utya Duck", "stickers", [
            { id: "duck_laugh", emoji: ["😂"], format: "tgs", bytes: gzipSync(LOTTIE) },
            { id: "duck_wave", emoji: ["👋🏽"], format: "webp", bytes: still("wave") },
        ]);
        await writePack(home, "aardvark", "Aardvark Life", "stickers", [
            { id: "aard_ok", emoji: ["👍"], format: "webm", bytes: Buffer.from("webm-bytes") },
        ]);
        await writePack(home, "faces", "Faces", "emoji", [
            { id: "face_wave", emoji: ["👋"], format: "webp", bytes: still("face") },
        ]);
        await writePack(
            home,
            "broken",
            "Broken",
            "stickers",
            [{ id: "nope", emoji: ["😂"], format: "webp", bytes: still("nope") }],
            true,
        );
        await writeFile(join(home, "order.json"), JSON.stringify(["utyaduck"]));

        // The folder is read again when it changes; order.json leads and title order follows.
        const packs = (await gym.client.listStickerPacks()).packs;
        expect(packs.map((pack) => pack.id)).toEqual(["utyaduck", "aardvark", "faces"]);
        expect(packs[0]).toEqual({
            id: "utyaduck",
            title: "Utya Duck",
            kind: "stickers",
            thumbnail: "duck_laugh",
            stickerCount: 2,
            version: expect.stringMatching(/^[0-9a-f]{16}$/),
        });
        const duck = await gym.client.getStickerPack("utyaduck");
        expect(duck.stickers.map((sticker) => sticker.id)).toEqual(["duck_laugh", "duck_wave"]);
        expect(duck.stickers[0]).toMatchObject({
            packId: "utyaduck",
            format: "tgs",
            emoji: ["😂"],
        });
        expect((await gym.http.get("/v0/stickers/packs/broken")).status).toBe(404);

        // Files are served as stored, and a tgs sticker also as its Lottie JSON.
        const tgs = await raw(gym, "/v0/stickers/packs/utyaduck/stickers/duck_laugh/file");
        expect(tgs.status).toBe(200);
        expect(tgs.headers["content-type"]).toBe("application/x-tgsticker");
        expect(tgs.headers["x-content-type-options"]).toBe("nosniff");
        expect(gzipSync(LOTTIE).equals(tgs.body)).toBe(true);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const lottie = await raw(
                gym,
                "/v0/stickers/packs/utyaduck/stickers/duck_laugh/file?as=lottie",
            );
            expect(lottie.status).toBe(200);
            expect(lottie.headers["content-type"]).toBe("application/json");
            expect(lottie.body.toString("utf8")).toBe(LOTTIE);
        }
        const webm = await raw(gym, "/v0/stickers/packs/aardvark/stickers/aard_ok/file?as=lottie");
        expect(webm.headers["content-type"]).toBe("video/webm");
        expect((await raw(gym, "/v0/stickers/packs/utyaduck/stickers/missing/file")).status).toBe(
            404,
        );

        // Emoji search ignores skin tones and keeps to the kind asked for; words match titles.
        const waves = await gym.client.searchStickers({ emoji: "👋" });
        expect(waves.stickers.map((sticker) => sticker.id)).toEqual(["duck_wave"]);
        const emojiWaves = await gym.client.searchStickers({ q: "👋", kind: "emoji" });
        expect(emojiWaves.stickers.map((sticker) => sticker.id)).toEqual(["face_wave"]);
        const byTitle = await gym.client.searchStickers({ q: "LIF" });
        expect(byTitle.stickers.map((sticker) => sticker.id)).toEqual(["aard_ok"]);
        expect((await gym.http.get("/v0/stickers/search")).status).toBe(400);

        // Recents move to the front, keep at most 20, and reach the person's connections.
        const start = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        await gym.client.useSticker({ packId: "utyaduck", stickerId: "duck_wave" });
        const used = await gym.client.useSticker({
            packId: "aardvark",
            stickerId: "aard_ok",
            mutationId: "use-2",
        });
        expect(used.recents).toEqual([
            { packId: "aardvark", stickerId: "aard_ok" },
            { packId: "utyaduck", stickerId: "duck_wave" },
        ]);
        const events = (await gym.client.getEvents({ after: start, limit: 100 })).events.filter(
            (event) => event.type === "sticker_recents.updated",
        );
        expect(events.map((event) => event.payload)).toEqual([
            { recents: [{ packId: "utyaduck", stickerId: "duck_wave" }] },
            { recents: used.recents, mutationId: "use-2" },
        ]);
        expect(
            (await gym.http.post("/v0/stickers/recents", { packId: "utyaduck", stickerId: "x" }))
                .status,
        ).toBe(404);
        const first = await gym.client.searchStickers({ q: "duck" });
        expect(first.stickers.map((sticker) => sticker.id)).toEqual(["duck_wave", "duck_laugh"]);

        await writePack(
            home,
            "many",
            "Many",
            "stickers",
            Array.from({ length: 22 }, (_, index) => ({
                id: `s${String(index)}`,
                emoji: [],
                format: "webp" as const,
                bytes: still(`s${String(index)}`),
            })),
        );
        await gym.waitUntil(
            async () =>
                (await gym.client.listStickerPacks()).packs.length === 4 ? true : undefined,
            "the new pack is read",
        );
        for (let index = 0; index < 22; index += 1) {
            await gym.client.useSticker({ packId: "many", stickerId: `s${String(index)}` });
        }
        const capped = (await gym.client.getStickerRecents()).recents;
        expect(capped).toHaveLength(20);
        expect(capped[0]).toEqual({ packId: "many", stickerId: "s21" });
        expect(capped.at(-1)).toEqual({ packId: "many", stickerId: "s2" });
        expect((await gym.client.clearStickerRecents()).recents).toEqual([]);

        // Posting a story records the stickers on it.
        const upload = await gym.client.uploadArtifactFile({ data: new Uint8Array(PIXEL) });
        const draft = (
            await gym.client.createStory({
                frames: [
                    {
                        upload: { uploadId: upload.upload.id, name: "pixel.png" },
                        overlays: [
                            {
                                id: "k2b1st1ck3r0000000000000",
                                type: "sticker",
                                packId: "utyaduck",
                                stickerId: "duck_laugh",
                                transform: { x: 0.5, y: 0.5, scale: 0.4, rotation: 0 },
                            },
                        ],
                    },
                ],
            })
        ).story;
        expect((await gym.client.getStickerRecents()).recents).toEqual([]);
        await gym.client.postStory(draft.id, { artifactVersion: 1 });
        expect((await gym.client.getStickerRecents()).recents).toEqual([
            { packId: "utyaduck", stickerId: "duck_laugh" },
        ]);

        // Stickers follow the Stories setting.
        await gym.client.saveUserSetting(STORIES, { value: false });
        expect((await gym.http.get("/v0/stickers/packs")).status).toBe(404);
        expect(gym.errors).toEqual([]);
    }, 60_000);
});

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);
