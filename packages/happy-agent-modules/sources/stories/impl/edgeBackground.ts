import type { StoryBackground } from "@slopus/happy-agent-client";

import { getImageProcessor } from "../../impl/images/getImageProcessor.js";

const MAX_DECODED_PIXELS = 40_000_000;
const SAMPLE = 8;

/** What a frame shows behind media whose edges cannot be read, and behind every video. */
export const BLACK_BACKGROUND: StoryBackground = ["#000000", "#000000"];

/**
 * The two colours a story draws behind an image to fill the canvas around it: the average of its
 * top edge and of its bottom edge, as Telegram fills a photo's bands. Transparent pixels count as
 * black. Bytes that do not decode give black.
 */
export async function edgeBackground(bytes: Uint8Array): Promise<StoryBackground> {
    try {
        const processor = await getImageProcessor();
        const image = await processor.rgba(bytes, {
            autoOrient: true,
            maxPixels: MAX_DECODED_PIXELS,
            resize: { filter: "linear", fit: "fill", width: SAMPLE, height: SAMPLE },
        });
        return [
            rowColor(image.data, image.width, 0),
            rowColor(image.data, image.width, image.height - 1),
        ];
    } catch {
        return BLACK_BACKGROUND;
    }
}

function rowColor(data: Buffer, width: number, row: number): string {
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let column = 0; column < width; column += 1) {
        const offset = (row * width + column) * 4;
        const alpha = (data[offset + 3] ?? 255) / 255;
        red += (data[offset] ?? 0) * alpha;
        green += (data[offset + 1] ?? 0) * alpha;
        blue += (data[offset + 2] ?? 0) * alpha;
    }
    const hex = (total: number) =>
        Math.round(total / Math.max(1, width))
            .toString(16)
            .padStart(2, "0")
            .toUpperCase();
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
}
