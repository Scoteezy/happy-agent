import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createSseWriter } from "../../sources/transport/sseWriter.js";
import { describe, expect, it } from "vitest";

describe("Happy Agent SSE writer", () => {
    it("resumes once its frames are flushed and preserves whole-frame order", () => {
        const request = new EventEmitter() as IncomingMessage;
        const response = new FakeResponse([false, true, true]);
        const writer = createSseWriter(request, response.asServerResponse());

        expect(writer.write("one\n\n")).toBe(true);
        expect(writer.write("two\n\n")).toBe(true);
        expect(writer.write("three\n\n")).toBe(true);
        expect(response.writes).toEqual(["one\n\n"]);

        response.flush();
        expect(response.writes).toEqual(["one\n\n", "two\n\n", "three\n\n"]);
        writer.close();
    });

    it("resumes when a blocked frame is flushed without a drain event", () => {
        // Node 26 corks a response per tick and measures that buffer against the high-water
        // mark, so a replay burst can report backpressure. The socket can then flush below its
        // own mark, never needing drain, and the response's drain never fires. Every byte still
        // reaches the client and each write's callback runs.
        const request = new EventEmitter() as IncomingMessage;
        const response = new FakeResponse([false, true]);
        const writer = createSseWriter(request, response.asServerResponse());
        const finished = "id: finished\nevent: run.finished\ndata: {}\n\n";

        expect(writer.write("replay\n\n")).toBe(true);
        expect(writer.write(finished)).toBe(true);
        expect(response.writes).toEqual(["replay\n\n"]);

        response.flush();
        expect(response.writes).toEqual(["replay\n\n", finished]);
        writer.close();
    });

    it("disconnects instead of growing its pending queue while blocked", async () => {
        const request = new EventEmitter() as IncomingMessage;
        const response = new FakeResponse([false]);
        const writer = createSseWriter(request, response.asServerResponse(), {
            maxBufferedBytes: 8,
        });

        expect(writer.write("blocked\n\n")).toBe(true);
        expect(writer.write("1234")).toBe(true);
        expect(writer.write("56789")).toBe(false);
        await writer.done;
        expect(writer.closed).toBe(true);
        expect(response.destroyed).toBe(true);

        response.flush();
        expect(response.writes).toEqual(["blocked\n\n"]);
    });

    it("keeps an image-sized event and later run events ordered across backpressure", async () => {
        const request = new EventEmitter() as IncomingMessage;
        const response = new FakeResponse([false, true, true]);
        const writer = createSseWriter(request, response.asServerResponse(), {
            maxBufferedBytes: 64 * 1_024 * 1_024,
            maxWritableBytes: 64 * 1_024 * 1_024,
        });
        const image = `id: image\nevent: message.created\ndata: ${"A".repeat(48 * 1_024 * 1_024)}\n\n`;
        const run = "id: run\nevent: run.started\ndata: {}\n\n";
        const tool = "id: tool\nevent: message.updated\ndata: {}\n\n";

        expect(writer.write(image)).toBe(true);
        expect(writer.write(run)).toBe(true);
        expect(writer.write(tool)).toBe(true);
        expect(writer.closed).toBe(false);
        expect(response.writes).toEqual([image]);

        response.flush();
        expect(response.writes).toEqual([image, run, tool]);
        expect(writer.closed).toBe(false);
        writer.close();
        await writer.done;
    });
});

class FakeResponse extends EventEmitter {
    destroyed = false;
    headersSent = true;
    writableEnded = false;
    writableLength = 0;
    readonly writes: string[] = [];
    readonly #results: boolean[];
    readonly #flushed: (() => void)[] = [];

    constructor(results: boolean[]) {
        super();
        this.#results = [...results];
    }

    asServerResponse(): ServerResponse {
        return this as unknown as ServerResponse;
    }

    write(frame: string, callback?: () => void): boolean {
        this.writes.push(frame);
        this.writableLength = Buffer.byteLength(frame);
        if (callback !== undefined) this.#flushed.push(callback);
        return this.#results.shift() ?? true;
    }

    /** Hand every written frame to the socket, running write callbacks but emitting no drain. */
    flush(): void {
        this.writableLength = 0;
        for (const callback of this.#flushed.splice(0)) callback();
    }

    end(): void {
        this.writableEnded = true;
        this.emit("finish");
    }

    destroy(): void {
        this.destroyed = true;
        this.emit("close");
    }
}
