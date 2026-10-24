import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
    stickerFormatSchema,
    stickerIdSchema,
    stickerPackIdSchema,
    stickerPackKindSchema,
    type Sticker,
    type StickerPack,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_STICKER_BYTES = 4 * 1024 * 1024;

/** A pack folder's `pack.json`. Fields beyond these, such as where the pack came from, are kept out. */
const packManifestSchema = Type.Object({
    id: stickerPackIdSchema,
    title: Type.String({ minLength: 1, maxLength: 128 }),
    kind: stickerPackKindSchema,
    thumbnail: stickerIdSchema,
    stickers: Type.Array(
        Type.Object({
            id: stickerIdSchema,
            file: Type.String({ minLength: 1, maxLength: 255, pattern: "^[A-Za-z0-9._-]+$" }),
            emoji: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
            format: stickerFormatSchema,
            width: Type.Integer({ minimum: 1, maximum: 512 }),
            height: Type.Integer({ minimum: 1, maximum: 512 }),
            size: Type.Integer({ minimum: 1, maximum: MAX_STICKER_BYTES }),
            sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        }),
        { minItems: 1, maxItems: 1_000 },
    ),
});
type PackManifest = Static<typeof packManifestSchema>;

/** One pack as the catalog holds it, with where each sticker's file is. */
export interface LoadedStickerPack {
    readonly pack: StickerPack;
    readonly stickers: readonly Sticker[];
    readonly files: ReadonlyMap<string, string>;
    /** The manifest's modification time and size, which decide whether to read it again. */
    readonly stamp: string;
}

/** The manifest's stamp, or undefined when the folder has no manifest. */
export async function stickerPackStamp(folder: string): Promise<string | undefined> {
    const facts = await stat(join(folder, "pack.json")).catch(() => undefined);
    return facts?.isFile() === true ? `${String(facts.mtimeMs)}:${String(facts.size)}` : undefined;
}

/**
 * Read one pack folder. A manifest that does not validate, names a folder other than its own,
 * or lists a file whose size or digest does not match leaves the pack out.
 */
export async function readStickerPack(
    folder: string,
    folderName: string,
): Promise<LoadedStickerPack | undefined> {
    const stamp = await stickerPackStamp(folder);
    if (stamp === undefined) return undefined;
    let manifest: PackManifest;
    let bytes: Buffer;
    try {
        bytes = await readFile(join(folder, "pack.json"));
        if (bytes.byteLength > MAX_MANIFEST_BYTES) return undefined;
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (!Value.Check(packManifestSchema, parsed)) return undefined;
        manifest = parsed;
    } catch {
        return undefined;
    }
    if (manifest.id !== folderName) return undefined;
    const ids = new Set(manifest.stickers.map((sticker) => sticker.id));
    if (ids.size !== manifest.stickers.length || !ids.has(manifest.thumbnail)) return undefined;
    const files = new Map<string, string>();
    const stickers: Sticker[] = [];
    for (const entry of manifest.stickers) {
        const path = join(folder, entry.file);
        const content = await readFile(path).catch(() => undefined);
        if (
            content?.byteLength !== entry.size ||
            createHash("sha256").update(content).digest("hex") !== entry.sha256
        ) {
            return undefined;
        }
        files.set(entry.id, path);
        stickers.push({
            packId: manifest.id,
            id: entry.id,
            emoji: entry.emoji,
            format: entry.format,
            width: entry.width,
            height: entry.height,
            size: entry.size,
            sha256: entry.sha256,
        });
    }
    return {
        pack: {
            id: manifest.id,
            title: manifest.title,
            kind: manifest.kind,
            thumbnail: manifest.thumbnail,
            stickerCount: stickers.length,
            version: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
        },
        stickers,
        files,
        stamp,
    };
}
