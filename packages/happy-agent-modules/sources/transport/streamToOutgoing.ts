import type { OutgoingMessage } from "node:http";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Streams a body into an HTTP message and ends it.
 *
 * `pipeline()` straight into the message resumes after backpressure only on the message's 'drain',
 * and Node 26 can report backpressure for a corked message and then flush it without emitting one.
 * The body therefore goes through a sink that finishes each chunk when the message's own write
 * callback reports it flushed. `pipeline()` still owns the transfer: a failure on either side
 * destroys the other and rejects.
 */
export async function streamToOutgoing(source: Readable, target: OutgoingMessage): Promise<void> {
    // A closed message never emits 'close' again, so the sink could not learn of it.
    if (target.destroyed) {
        source.destroy();
        throw prematureClose();
    }
    await pipeline(source, messageSink(target));
}

function messageSink(target: OutgoingMessage): Writable {
    const closed = (): void => {
        if (!target.writableFinished) sink.destroy(prematureClose());
    };
    const failed = (error: Error): void => {
        sink.destroy(error);
    };
    const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            target.write(chunk, (error) => callback(error ?? undefined));
        },
        final(callback) {
            target.end(() => callback());
        },
        destroy(error, callback) {
            target.off("close", closed);
            target.off("error", failed);
            if (error !== null) target.destroy();
            callback(error);
        },
    });
    target.on("close", closed);
    target.on("error", failed);
    return sink;
}

function prematureClose(): Error {
    return new Error("The HTTP message closed before its body was sent.");
}
