import type { Context } from "@steve.kite/stdlib";

import type { ChatMediaModule, ChatMediaPresentation } from "../../chatMedia/index.js";
import { basenameComputePath } from "./resolveComputePath.js";

/** What a reading tool tells the model once the image it read is shown to the user as well. */
export const READ_IMAGE_SHOWN_NOTICE =
    "The user also sees this image inline in the chat, so do not present it again.";

/**
 * Show an image the agent read to the user too, as the original file rather than the copy the
 * model was given. `source` is the path the agent read, as written and resolved.
 *
 * The read is what the model asked for, so showing it never costs the read: a file over the chat's
 * size limit, one that does not decode as an image clients can show, or a snapshot that fails for
 * any other reason leaves the result without a presentation. Without chat media, nothing is shown.
 */
export async function showReadImage(
    ctx: Context,
    chatMedia: ChatMediaModule | undefined,
    bytes: Uint8Array,
    source: { readonly path: string; readonly absolutePath: string },
): Promise<ChatMediaPresentation | undefined> {
    if (chatMedia === undefined) return undefined;
    try {
        const item = await chatMedia.snapshot(bytes, basenameComputePath(source.absolutePath), {
            path: source.path,
            absolutePath: source.absolutePath,
        });
        if (item.kind !== "image") return undefined;
        return chatMedia.presentation([item], { type: "columns", columns: 2 });
    } catch (error: unknown) {
        ctx.log.warn("An image the agent read could not be shown in the chat.", {}, error);
        return undefined;
    }
}
