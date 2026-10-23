import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createRootContext } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ChatMediaModule, type ChatMediaItem } from "../../sources/chatMedia/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { testConfig } from "../support/computeModule.js";
import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-image-reads-shown");

const NOTICE = "The user also sees this image inline in the chat, so do not present it again.";

/** Chat media whose snapshots always fail, as a full disk would make them. */
class FailingChatMedia extends ChatMediaModule {
    override async snapshot(): Promise<ChatMediaItem> {
        throw new Error("The disk is full.");
    }
}

async function agent(
    model: string | undefined,
    options: { readonly chatMedia?: ChatMediaModule; readonly bedrock?: boolean } = {},
) {
    const compute = new FakeCompute();
    const chatMedia = options.chatMedia ?? new ChatMediaModule(testConfig, new HistoryModule());
    return {
        compute,
        ...(await computeToolset(ctx, compute, {
            ...(model === undefined ? {} : { model }),
            ...(options.bedrock === true ? { providerKind: "bedrock" as const } : {}),
            chatMedia,
        })),
    };
}

async function png(width: number, height: number): Promise<Buffer> {
    return await sharp({
        create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
    })
        .png()
        .toBuffer();
}

function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** The one image item of a two-column media presentation, checked against the original file. */
async function shownOriginal(
    presentation: unknown,
    original: Buffer,
    name: string,
    path: string = name,
) {
    expect(presentation).toEqual({
        type: "media",
        items: [
            {
                kind: "image",
                name,
                mimeType: "image/png",
                size: original.byteLength,
                sha256: digest(original),
                width: expect.any(Number),
                height: expect.any(Number),
                thumbhash: expect.any(String),
                source: { path, absolutePath: `/workspace/${name}` },
            },
        ],
        layout: { type: "columns", columns: 2 },
    });
    const [item] = (presentation as { items: ChatMediaItem[] }).items;
    expect(await readFile(testConfig.chatMediaContentPath(item!.sha256))).toEqual(original);
    return item!;
}

describe("images an agent reads are shown in the chat", () => {
    it("shows the original of an image Claude's Read scaled down for the model", async () => {
        const { compute, tool, call } = await agent("anthropic/opus-5");
        const original = await png(2400, 1350);
        compute.writeBuffer("/workspace/retina.png", original);

        const result = await tool("Read").execute(ctx, { file_path: "retina.png" }, call);

        const item = await shownOriginal(result.presentation, original, "retina.png");
        expect(item).toMatchObject({ width: 2400, height: 1350 });
        expect(result.image.resized).toMatchObject({ width: 2000, height: 1125 });
        expect(tool("Read").toLLM(result)).toEqual([
            {
                type: "text",
                text: `Image: /workspace/retina.png (original 2400×1350, shown at 2000×1125)\n${NOTICE}`,
            },
            { type: "image", data: result.image.data, mimeType: "image/png" },
        ]);
    });

    it("leaves a text Read exactly as it was", async () => {
        const { compute, tool, call } = await agent("anthropic/opus-5");
        compute.write("/workspace/app.ts", "const a = 1;");

        const result = await tool("Read").execute(ctx, { file_path: "app.ts" }, call);

        expect(result).not.toHaveProperty("presentation");
        expect(tool("Read").toLLM(result)).toEqual([{ type: "text", text: "1\tconst a = 1;" }]);
    });

    it("shows what Codex's view_image read, and nothing for a picture the chat cannot show", async () => {
        const { compute, tool, call } = await agent(undefined);
        const original = await png(64, 32);
        compute.writeBuffer("/workspace/diagram.png", original);

        const result = await tool("view_image").execute(ctx, { path: "diagram.png" }, call);

        await shownOriginal(result.presentation, original, "diagram.png");
        expect(tool("view_image").toLLM(result)).toEqual([
            { type: "text", text: `Image: /workspace/diagram.png\n${NOTICE}` },
            { type: "image", data: original.toString("base64"), mimeType: "image/png" },
        ]);

        // A BMP reaches the model, but no chat client shows one, so the read shows nothing.
        const bmp = Buffer.concat([Buffer.from("BM"), Buffer.alloc(64)]);
        compute.writeBuffer("/workspace/old.bmp", bmp);
        const plain = await tool("view_image").execute(ctx, { path: "old.bmp" }, call);
        expect(plain).not.toHaveProperty("presentation");
        expect(tool("view_image").toLLM(plain)[0]).toEqual({
            type: "text",
            text: "Image: /workspace/old.bmp",
        });
    });

    it("shows the whole original of a region Kimi's ReadMediaFile cropped", async () => {
        const { compute, tool } = await agent("moonshotai/kimi-k3", { bedrock: true });
        const original = await png(300, 200);
        compute.writeBuffer("/workspace/a.png", original);

        const crop = await tool("ReadMediaFile").execute(ctx, {
            path: "a.png",
            region: { x: 10, y: 5, width: 100, height: 50 },
        });

        const item = await shownOriginal(crop.presentation, original, "a.png");
        expect(item).toMatchObject({ width: 300, height: 200 });
        const [text, image] = tool("ReadMediaFile").toLLM(crop);
        expect(text).toEqual({
            type: "text",
            text: `Image /workspace/a.png: original 300×200, delivered 100×50; region offset (10, 5).\n${NOTICE}`,
        });
        expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    });

    it("still answers the model when the snapshot fails", async () => {
        const chatMedia = new FailingChatMedia(testConfig, new HistoryModule());
        const { compute, tool, call } = await agent("anthropic/opus-5", { chatMedia });
        compute.writeBuffer("/workspace/shot.png", await png(20, 10));

        const result = await tool("Read").execute(ctx, { file_path: "shot.png" }, call);

        expect(result.outcome).toBe("image");
        expect(result).not.toHaveProperty("presentation");
        expect(tool("Read").toLLM(result)[0]).toEqual({
            type: "text",
            text: "Image: /workspace/shot.png",
        });
    });

    it("gives every model present_files beside its own tools", async () => {
        for (const [model, bedrock] of [
            ["anthropic/opus-5", false],
            [undefined, false],
            ["xai/grok-4.6", false],
            ["moonshotai/kimi-k3", true],
        ] as const) {
            const { tools } = await agent(model, { bedrock });
            expect(tools.at(-1)?.name, model).toBe("present_files");
        }
    });
});
