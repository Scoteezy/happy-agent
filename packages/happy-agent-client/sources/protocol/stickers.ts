/**
 * Stickers: the packs a daemon serves from its own sticker folder, for the story editor's picker,
 * and each person's recently used stickers. The daemon ships no packs. Part of Stories, and off
 * with it.
 */

import { type Static, Type } from "@sinclair/typebox";

import { eventCursorSchema, mutationIdSchema } from "./common.js";

/** How many recently used stickers a person keeps, most recent first. */
export const MAX_STICKER_RECENTS = 20;

/** The picker's grid: at least this many columns, and as many cells of this size as fit. */
export const STICKER_GRID = {
    stickers: { minColumns: 5, cellSize: 70 },
    emoji: { minColumns: 8, cellSize: 40 },
} as const;

/** How many columns a picker grid of `width` points with `spacing` between cells has. */
export function stickerGridColumns(kind: StickerPackKind, width: number, spacing: number): number {
    const { minColumns, cellSize } = STICKER_GRID[kind];
    return Math.max(minColumns, Math.floor((width + spacing) / (cellSize + spacing)));
}

/** The pack folder's name. */
export const stickerPackIdSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z0-9_-]+$",
});
export type StickerPackId = Static<typeof stickerPackIdSchema>;

/** Unique within its pack. */
export const stickerIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9_-]+$",
});
export type StickerId = Static<typeof stickerIdSchema>;

/** `"stickers"` are shown large in the Stickers tab; `"emoji"` at text size in the Emoji tab. */
export const stickerPackKindSchema = Type.Union([Type.Literal("stickers"), Type.Literal("emoji")]);
export type StickerPackKind = Static<typeof stickerPackKindSchema>;

/** A still image, a gzip-compressed Lottie animation, or a VP9 video with transparency. */
export const stickerFormatSchema = Type.Union([
    Type.Literal("webp"),
    Type.Literal("tgs"),
    Type.Literal("webm"),
]);
export type StickerFormat = Static<typeof stickerFormatSchema>;

export const stickerPackSchema = Type.Object({
    id: stickerPackIdSchema,
    /** Shown uppercase as the pack's header in the picker. */
    title: Type.String({ minLength: 1 }),
    kind: stickerPackKindSchema,
    /** The sticker that stands for the pack. */
    thumbnail: stickerIdSchema,
    stickerCount: Type.Integer({ minimum: 0 }),
    /** Changes whenever the pack's manifest changes. */
    version: Type.String(),
});
export type StickerPack = Static<typeof stickerPackSchema>;

export const stickerSchema = Type.Object({
    packId: stickerPackIdSchema,
    id: stickerIdSchema,
    /** What search and the category chips match; possibly none. */
    emoji: Type.Array(Type.String({ minLength: 1 })),
    format: stickerFormatSchema,
    /** At most 512 on the longer side. */
    width: Type.Integer({ minimum: 1, maximum: 512 }),
    height: Type.Integer({ minimum: 1, maximum: 512 }),
    size: Type.Integer({ minimum: 1 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
});
export type Sticker = Static<typeof stickerSchema>;

/** `GET /v0/stickers/packs` — in catalog order. */
export const stickerPacksResponseSchema = Type.Object({ packs: Type.Array(stickerPackSchema) });
export type StickerPacksResponse = Static<typeof stickerPacksResponseSchema>;

/** `GET /v0/stickers/packs/:packId` — stickers in pack order. */
export const stickerPackResponseSchema = Type.Object({
    pack: stickerPackSchema,
    stickers: Type.Array(stickerSchema),
});
export type StickerPackResponse = Static<typeof stickerPackResponseSchema>;

/** `GET /v0/stickers/search` query parameters; one of `q` and `emoji` is required. */
export interface StickerSearchQuery {
    /** One emoji matches tags; anything else matches pack-title words by prefix. */
    q?: string;
    emoji?: string;
    /** Default `stickers`. */
    kind?: StickerPackKind;
    /** 1–200, default 100. */
    limit?: number;
}

/** `GET /v0/stickers/search` — catalog order, the person's recents first. */
export const stickerSearchResponseSchema = Type.Object({ stickers: Type.Array(stickerSchema) });
export type StickerSearchResponse = Static<typeof stickerSearchResponseSchema>;

export const stickerRefSchema = Type.Object({
    packId: stickerPackIdSchema,
    stickerId: stickerIdSchema,
});
export type StickerRef = Static<typeof stickerRefSchema>;

/** `GET`, `POST`, and `DELETE /v0/stickers/recents` — most recent first. */
export const stickerRecentsResponseSchema = Type.Object({
    recents: Type.Array(stickerRefSchema, { maxItems: MAX_STICKER_RECENTS }),
    /** Present on `GET`: follow `sticker_recents.updated` from it. */
    cursor: Type.Optional(eventCursorSchema),
});
export type StickerRecentsResponse = Static<typeof stickerRecentsResponseSchema>;

/** `POST /v0/stickers/recents` — moves the sticker to the front. */
export const useStickerRequestSchema = Type.Object({
    packId: stickerPackIdSchema,
    stickerId: stickerIdSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type UseStickerRequest = Static<typeof useStickerRequestSchema>;

/** `sticker_recents.updated` — a complete replacement, only to that person. */
export const stickerRecentsUpdatedPayloadSchema = Type.Object({
    recents: Type.Array(stickerRefSchema, { maxItems: MAX_STICKER_RECENTS }),
    mutationId: Type.Optional(mutationIdSchema),
});
export type StickerRecentsUpdatedPayload = Static<typeof stickerRecentsUpdatedPayloadSchema>;
