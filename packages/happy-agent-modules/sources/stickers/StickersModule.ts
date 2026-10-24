import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { createId } from "@paralleldrive/cuid2";
import { agentDatabaseRows, agentDatabaseRun, type AgentModule } from "@slopus/happy-agent-base";
import {
    MAX_STICKER_RECENTS,
    stickerPackIdSchema,
    type Sticker,
    type StickerPack,
    type StickerPackKind,
    type StickerRef,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { ConfigModule } from "../config/index.js";
import { STANDALONE_STORY_PERSON, StoriesModule, type StoryPerson } from "../stories/index.js";
import { TeamAuthenticationError, TeamModule, teamUser } from "../team/index.js";
import {
    readStickerPack,
    stickerPackStamp,
    type LoadedStickerPack,
} from "./impl/readStickerPack.js";
import { stickerMigrations, STICKER_RECENTS_TABLE } from "./StickerMigrations.js";

const MAX_LOTTIE_BYTES = 16 * 1024 * 1024;
const FORMAT_TYPES = {
    webp: "image/webp",
    tgs: "application/x-tgsticker",
    webm: "video/webm",
} as const;

/** One sticker file to serve. */
export interface StickerFile {
    readonly contentPath: string;
    readonly sha256: string;
    readonly size: number;
    readonly mimeType: string;
    readonly name: string;
}

/** A person's recents changed; their connections alone hear of it. */
export interface StickerRecentsEvent {
    readonly userId: string | undefined;
    readonly at: number;
    readonly recents: readonly StickerRef[];
    readonly mutationId?: string;
}

export class StickerNotFoundError extends Error {
    constructor(message = "The sticker was not found.") {
        super(message);
        this.name = "StickerNotFoundError";
    }
}

/**
 * The sticker packs the story editor offers, and each person's recently used stickers.
 *
 * Packs are never part of the agent: they are folders an installation's owner puts under
 * `stickers` in the agent home. The catalog is read on first use and again whenever a manifest
 * or the folder changes, and a pack whose manifest or files do not check out is left out. A
 * `tgs` sticker's Lottie JSON is decompressed on its first request and cached beside the other
 * caches. Stickers follow Stories' setting: for a person with Stories off, there are none.
 */
export class StickersModule implements AgentModule {
    readonly name = "stickers";
    readonly migrations = stickerMigrations;

    readonly #config: ConfigModule;
    readonly #team: TeamModule;
    readonly #stories: StoriesModule;
    readonly #listeners = new Set<(event: StickerRecentsEvent) => void>();
    #catalog: { readonly stamp: string; readonly packs: readonly LoadedStickerPack[] } | undefined;
    #loading: Promise<readonly LoadedStickerPack[]> | undefined;
    readonly #lottie = new Map<string, StickerFile>();

    constructor(config: ConfigModule, team: TeamModule, stories: StoriesModule) {
        this.#config = config;
        this.#team = team;
        this.#stories = stories;
        // Posting a story records every sticker on it, in the transaction that posts it.
        stories.onPostedTransact(async (ctx, story) => {
            const used = story.content.frames.flatMap((frame) =>
                frame.overlays.flatMap((overlay) =>
                    overlay.type === "sticker"
                        ? [{ packId: overlay.packId, stickerId: overlay.stickerId }]
                        : [],
                ),
            );
            if (used.length > 0) await this.#use(ctx, story.author, used.reverse(), undefined);
        });
    }

    onEvent(listener: (event: StickerRecentsEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Whether the caller may see stickers at all. */
    async enabled(ctx: Context): Promise<boolean> {
        return await this.#stories.enabled(ctx);
    }

    async packs(ctx: Context): Promise<StickerPack[]> {
        await this.#requireEnabled(ctx);
        return (await this.#packs()).map((loaded) => loaded.pack);
    }

    async pack(
        ctx: Context,
        packId: string,
    ): Promise<{ readonly pack: StickerPack; readonly stickers: readonly Sticker[] }> {
        await this.#requireEnabled(ctx);
        const loaded = (await this.#packs()).find((candidate) => candidate.pack.id === packId);
        if (loaded === undefined) throw new StickerNotFoundError("The sticker pack was not found.");
        return { pack: loaded.pack, stickers: loaded.stickers };
    }

    /** A sticker's file, or with `lottie` a `tgs` sticker's uncompressed Lottie JSON. */
    async file(
        ctx: Context,
        packId: string,
        stickerId: string,
        lottie: boolean,
    ): Promise<StickerFile> {
        await this.#requireEnabled(ctx);
        const loaded = (await this.#packs()).find((candidate) => candidate.pack.id === packId);
        const sticker = loaded?.stickers.find((candidate) => candidate.id === stickerId);
        const path = loaded?.files.get(stickerId);
        if (sticker === undefined || path === undefined) throw new StickerNotFoundError();
        const file: StickerFile = {
            contentPath: path,
            sha256: sticker.sha256,
            size: sticker.size,
            mimeType: FORMAT_TYPES[sticker.format],
            name: `${sticker.id}.${sticker.format}`,
        };
        return lottie && sticker.format === "tgs" ? await this.#lottieFile(file) : file;
    }

    /** Stickers tagged with an emoji, or the stickers of packs whose title has a word starting with `q`. */
    async search(
        ctx: Context,
        query: {
            readonly q?: string;
            readonly emoji?: string;
            readonly kind: StickerPackKind;
            readonly limit: number;
        },
    ): Promise<Sticker[]> {
        const person = await this.#requireEnabled(ctx);
        const packs = (await this.#packs()).filter((loaded) => loaded.pack.kind === query.kind);
        const emoji =
            query.emoji ?? (query.q !== undefined && isEmoji(query.q) ? query.q : undefined);
        let found: Sticker[];
        if (emoji !== undefined) {
            const wanted = bareEmoji(emoji);
            found = packs.flatMap((loaded) =>
                loaded.stickers.filter((sticker) =>
                    sticker.emoji.some((tag) => bareEmoji(tag) === wanted),
                ),
            );
        } else {
            const prefix = (query.q ?? "").toLocaleLowerCase();
            found = packs
                .filter((loaded) =>
                    loaded.pack.title
                        .toLocaleLowerCase()
                        .split(/[^\p{L}\p{N}]+/u)
                        .some((word) => word.startsWith(prefix)),
                )
                .flatMap((loaded) => [...loaded.stickers]);
        }
        const recents = await this.#recents(ctx, person);
        const rank = new Map(
            recents.map((ref, index) => [`${ref.packId}/${ref.stickerId}`, index]),
        );
        const ordered = found
            .map((sticker, index) => ({
                sticker,
                index,
                recent: rank.get(`${sticker.packId}/${sticker.id}`),
            }))
            .sort((left, right) => {
                if ((left.recent === undefined) !== (right.recent === undefined)) {
                    return left.recent === undefined ? 1 : -1;
                }
                return (left.recent ?? 0) - (right.recent ?? 0) || left.index - right.index;
            })
            .map((entry) => entry.sticker);
        return ordered.slice(0, query.limit);
    }

    async recents(ctx: Context): Promise<StickerRef[]> {
        return await this.#recents(ctx, await this.#requireEnabled(ctx));
    }

    /** Move a sticker the catalog holds to the front of the caller's recents. */
    async use(
        ctx: Context,
        ref: StickerRef,
        mutationId: string | undefined,
    ): Promise<StickerRef[]> {
        const person = await this.#requireEnabled(ctx);
        const loaded = (await this.#packs()).find((candidate) => candidate.pack.id === ref.packId);
        if (loaded?.stickers.some((sticker) => sticker.id === ref.stickerId) !== true) {
            throw new StickerNotFoundError();
        }
        return await ctx.inTx(async (txCtx) => await this.#use(txCtx, person, [ref], mutationId));
    }

    async clear(ctx: Context, mutationId: string | undefined): Promise<StickerRef[]> {
        const person = await this.#requireEnabled(ctx);
        return await ctx.inTx(async (txCtx) => {
            await agentDatabaseRun(
                txCtx.db,
                sql`DELETE FROM ${sql.raw(STICKER_RECENTS_TABLE)} WHERE person_key = ${person}`,
            );
            this.#publish(txCtx, person, [], mutationId);
            return [];
        });
    }

    /** Put these stickers at the front, the last one first, and keep the newest twenty. */
    async #use(
        ctx: Context,
        person: StoryPerson,
        refs: readonly StickerRef[],
        mutationId: string | undefined,
    ): Promise<StickerRef[]> {
        const newest = await agentDatabaseRows<{ used_at: number | string }>(
            ctx.db,
            sql`SELECT MAX(used_at) AS used_at FROM ${sql.raw(STICKER_RECENTS_TABLE)}
                WHERE person_key = ${person}`,
        );
        let at = Math.max(Date.now(), Number(newest[0]?.used_at ?? 0) + 1);
        for (const ref of refs) {
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(STICKER_RECENTS_TABLE)} (person_key, pack_id, sticker_id, used_at)
                    VALUES (${person}, ${ref.packId}, ${ref.stickerId}, ${at})
                    ON CONFLICT (person_key, pack_id, sticker_id) DO UPDATE SET used_at = excluded.used_at`,
            );
            at += 1;
        }
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM ${sql.raw(STICKER_RECENTS_TABLE)}
                WHERE person_key = ${person} AND used_at < (
                    SELECT MIN(used_at) FROM (
                        SELECT used_at FROM ${sql.raw(STICKER_RECENTS_TABLE)}
                        WHERE person_key = ${person} ORDER BY used_at DESC LIMIT ${MAX_STICKER_RECENTS}
                    )
                )`,
        );
        const recents = await this.#recents(ctx, person);
        this.#publish(ctx, person, recents, mutationId);
        return recents;
    }

    async #recents(ctx: Context, person: StoryPerson): Promise<StickerRef[]> {
        const rows = await agentDatabaseRows<{ pack_id: string; sticker_id: string }>(
            ctx.db,
            sql`SELECT pack_id, sticker_id FROM ${sql.raw(STICKER_RECENTS_TABLE)}
                WHERE person_key = ${person} ORDER BY used_at DESC LIMIT ${MAX_STICKER_RECENTS}`,
        );
        return rows.map((row) => ({ packId: row.pack_id, stickerId: row.sticker_id }));
    }

    #publish(
        ctx: Context,
        person: StoryPerson,
        recents: readonly StickerRef[],
        mutationId: string | undefined,
    ): void {
        const event: StickerRecentsEvent = {
            userId: person === STANDALONE_STORY_PERSON ? undefined : person,
            at: Date.now(),
            recents: [...recents],
            ...(mutationId === undefined ? {} : { mutationId }),
        };
        afterCommit(ctx, async () => {
            for (const listener of [...this.#listeners]) listener(event);
        });
    }

    async #requireEnabled(ctx: Context): Promise<StoryPerson> {
        const person = this.#team.enabled ? teamUser(ctx)?.id : STANDALONE_STORY_PERSON;
        if (person === undefined) throw new TeamAuthenticationError();
        if (!(await this.#stories.enabledFor(ctx, person))) throw new StickerNotFoundError();
        return person;
    }

    /** The catalog in picker order, read again when a manifest or the folder changed. */
    async #packs(): Promise<readonly LoadedStickerPack[]> {
        const stamp = await this.#folderStamp();
        if (this.#catalog?.stamp === stamp) return this.#catalog.packs;
        this.#loading ??= this.#load(stamp).finally(() => {
            this.#loading = undefined;
        });
        return await this.#loading;
    }

    async #load(stamp: string): Promise<readonly LoadedStickerPack[]> {
        const home = this.#config.stickersHome;
        const previous = new Map(
            (this.#catalog?.packs ?? []).map((loaded) => [loaded.pack.id, loaded]),
        );
        const packs: LoadedStickerPack[] = [];
        for (const name of await this.#folders()) {
            const folder = join(home, name);
            const known = previous.get(name);
            const loaded =
                known !== undefined && known.stamp === (await stickerPackStamp(folder))
                    ? known
                    : await readStickerPack(folder, name);
            if (loaded !== undefined) packs.push(loaded);
        }
        const order = await readOrder(join(home, "order.json"));
        packs.sort((left, right) => {
            const leftIndex = order.indexOf(left.pack.id);
            const rightIndex = order.indexOf(right.pack.id);
            if (leftIndex !== rightIndex) {
                if (leftIndex === -1) return 1;
                if (rightIndex === -1) return -1;
                return leftIndex - rightIndex;
            }
            return (
                left.pack.title.localeCompare(right.pack.title) ||
                left.pack.id.localeCompare(right.pack.id)
            );
        });
        this.#catalog = { stamp, packs };
        return packs;
    }

    async #folders(): Promise<string[]> {
        const entries = await readdir(this.#config.stickersHome, { withFileTypes: true }).catch(
            () => [],
        );
        return entries
            .filter((entry) => entry.isDirectory() && Value.Check(stickerPackIdSchema, entry.name))
            .map((entry) => entry.name)
            .sort();
    }

    /** What changes when a pack is added, removed, or edited, or the order changes. */
    async #folderStamp(): Promise<string> {
        const home = this.#config.stickersHome;
        const parts: string[] = [];
        const order = await stat(join(home, "order.json")).catch(() => undefined);
        parts.push(order === undefined ? "-" : `${String(order.mtimeMs)}:${String(order.size)}`);
        for (const name of await this.#folders()) {
            parts.push(`${name}=${(await stickerPackStamp(join(home, name))) ?? "-"}`);
        }
        return parts.join("|");
    }

    async #lottieFile(file: StickerFile): Promise<StickerFile> {
        const cached = this.#lottie.get(file.sha256);
        if (
            cached !== undefined &&
            (await stat(cached.contentPath).catch(() => undefined)) !== undefined
        ) {
            return cached;
        }
        const target = this.#config.stickerLottieCachePath(file.sha256);
        let json = await readFile(target).catch(() => undefined);
        if (json === undefined) {
            json = gunzipSync(await readFile(file.contentPath), {
                maxOutputLength: MAX_LOTTIE_BYTES,
            });
            await mkdir(dirname(target), { recursive: true });
            const temporary = `${target}.${createId()}.tmp`;
            await writeFile(temporary, json);
            await rename(temporary, target);
        }
        const lottie: StickerFile = {
            contentPath: target,
            sha256: createHash("sha256").update(json).digest("hex"),
            size: json.byteLength,
            mimeType: "application/json",
            name: file.name.replace(/\.tgs$/u, ".json"),
        };
        this.#lottie.set(file.sha256, lottie);
        return lottie;
    }
}

async function readOrder(path: string): Promise<string[]> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return Array.isArray(parsed)
            ? parsed.filter((id): id is string => typeof id === "string")
            : [];
    } catch {
        return [];
    }
}

/** An emoji without skin tones or variation selectors, as search compares them. */
function bareEmoji(emoji: string): string {
    return emoji.replaceAll(/[\u{1F3FB}-\u{1F3FF}]|\uFE0E|\uFE0F/gu, "");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isEmoji(text: string): boolean {
    return (
        [...segmenter.segment(text)].length === 1 &&
        /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)
    );
}
