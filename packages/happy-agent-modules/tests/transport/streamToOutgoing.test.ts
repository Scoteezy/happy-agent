import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
    createServer,
    request as httpRequest,
    type IncomingMessage,
    type OutgoingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

import { sendStoredFile } from "../../sources/api/sendStoredFile.js";
import { streamToOutgoing } from "../../sources/transport/streamToOutgoing.js";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        server.close();
    }
});

describe("streaming a body into an HTTP message", () => {
    // Node 26 can report backpressure for a corked message and then flush it without emitting
    // drain. Each fake write reports backpressure and flushes, running its callback, but drain
    // never comes; a body that waits for drain alone never finishes.
    it("serves a stored file whose writes are flushed without a drain event", async () => {
        const directory = await mkdtemp(join(tmpdir(), "stored-file-"));
        directories.push(directory);
        const contentPath = join(directory, "content");
        const content = Buffer.alloc(256 * 1_024, 7);
        await writeFile(contentPath, content);
        const request = Object.assign(new EventEmitter(), { headers: {} }) as IncomingMessage;
        const response = new FlushingWithoutDrain();

        await sendStoredFile(request, response as unknown as ServerResponse, {
            cacheControl: "no-store",
            contentPath,
            mimeType: "application/octet-stream",
            name: "content.bin",
            sha256: "a".repeat(64),
            size: content.length,
        });

        expect(Buffer.concat(response.chunks)).toEqual(content);
        expect(response.writableFinished).toBe(true);
    }, 5_000);

    it("keeps every chunk in order across backpressure", async () => {
        const target = new FlushingWithoutDrain();

        await streamToOutgoing(
            Readable.from(["one", "two", "three"]),
            target as unknown as OutgoingMessage,
        );

        expect(target.chunks.map(String)).toEqual(["one", "two", "three"]);
        expect(target.writableFinished).toBe(true);
    });

    it("rejects and stops reading when the client leaves while the source is idle", async () => {
        const source = new PassThrough();
        const { response, client } = await openResponse();
        const streaming = streamToOutgoing(source, response);
        source.write("first");
        await client.firstChunk;

        client.leave();

        await expect(streaming).rejects.toThrow();
        expect(source.destroyed).toBe(true);
    });

    it("rejects and closes the response when the source fails during backpressure", async () => {
        const source = new PassThrough();
        const { response } = await openResponse({ read: false });
        const streaming = streamToOutgoing(source, response);
        source.write(Buffer.alloc(32 * 1_024 * 1_024));
        await until(() => response.writableNeedDrain);

        source.destroy(new Error("The disk went away."));

        await expect(streaming).rejects.toThrow("The disk went away.");
        expect(response.destroyed).toBe(true);
    });

    it("rejects when a write the message accepted later fails", async () => {
        const target = new Writable({
            write(_chunk, _encoding, callback) {
                callback(new Error("The socket reset."));
            },
        });
        target.on("error", () => undefined);

        await expect(
            streamToOutgoing(Readable.from(["one"]), target as unknown as OutgoingMessage),
        ).rejects.toThrow("The socket reset.");
    });

    it("rejects instead of throwing when the message fails while the source is idle", async () => {
        const source = new PassThrough();
        const target = new Writable({
            write(_chunk, _encoding, callback) {
                callback();
            },
        });
        const streaming = streamToOutgoing(source, target as unknown as OutgoingMessage);
        source.write("first");
        await until(() => target.writableLength === 0);

        target.destroy(new Error("The socket reset."));

        await expect(streaming).rejects.toThrow("The socket reset.");
        expect(source.destroyed).toBe(true);
    });

    it("rejects and releases a response that closed before anything was sent", async () => {
        const { response } = await openResponse();
        response.destroy();
        await until(() => response.closed);
        const listeners = {
            close: response.listenerCount("close"),
            error: response.listenerCount("error"),
            finish: response.listenerCount("finish"),
        };

        await expect(streamToOutgoing(Readable.from([]), response)).rejects.toThrow();

        expect({
            close: response.listenerCount("close"),
            error: response.listenerCount("error"),
            finish: response.listenerCount("finish"),
        }).toEqual(listeners);
    });
});

/** A message that reports backpressure on every write and flushes it, but never emits drain. */
class FlushingWithoutDrain extends Writable {
    readonly chunks: Buffer[] = [];

    writeHead(): this {
        return this;
    }

    override write(chunk: unknown, ...rest: unknown[]): boolean {
        const callback = rest.find((value) => typeof value === "function") as
            | ((error?: Error | null) => void)
            | undefined;
        this.chunks.push(Buffer.from(chunk as Buffer | string));
        process.nextTick(() => callback?.());
        return false;
    }
}

async function openResponse(options: { readonly read?: boolean } = {}): Promise<{
    readonly response: ServerResponse;
    readonly client: { readonly firstChunk: Promise<void>; leave(): void };
}> {
    let respond!: (response: ServerResponse) => void;
    const responded = new Promise<ServerResponse>((resolve) => {
        respond = resolve;
    });
    const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.flushHeaders();
        respond(response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    let received!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
        received = resolve;
    });
    const outgoing = httpRequest({ host: "127.0.0.1", port, path: "/" }, (incoming) => {
        if (options.read === false) incoming.pause();
        else incoming.on("data", () => received());
    });
    outgoing.on("error", () => undefined);
    outgoing.end();
    return {
        response: await responded,
        client: { firstChunk, leave: () => outgoing.destroy() },
    };
}

async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("The condition never held.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
