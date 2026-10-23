import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * A tool call's time budget, which stands still while the server waits on a person.
 *
 * The budget bounds the server's own work. A person deciding whether a printer may start is not
 * the server being slow, so time spent answering an elicitation is not charged to it; the server's
 * own wait for that answer is bounded by the server, which withdraws its request when it gives up.
 * When the budget runs out, `signal` aborts with the same timeout error the SDK raises itself.
 */
export class McpToolDeadline {
    readonly #controller = new AbortController();
    readonly #timeoutMs: number;
    #remainingMs: number;
    #startedAt = 0;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #pauses = 0;
    #disposed = false;

    constructor(timeoutMs: number) {
        this.#timeoutMs = timeoutMs;
        this.#remainingMs = timeoutMs;
        this.#start();
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    /** Runs `work` with the budget stopped; overlapping pauses resume it only once all end. */
    async pausedWhile<T>(work: () => Promise<T>): Promise<T> {
        this.#pauses += 1;
        if (this.#pauses === 1) this.#stop();
        try {
            return await work();
        } finally {
            this.#pauses -= 1;
            if (this.#pauses === 0) this.#start();
        }
    }

    dispose(): void {
        this.#disposed = true;
        this.#stop();
    }

    #start(): void {
        if (this.#disposed || this.#controller.signal.aborted) return;
        this.#startedAt = Date.now();
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#controller.abort(
                new McpError(ErrorCode.RequestTimeout, "Request timed out", {
                    timeout: this.#timeoutMs,
                }),
            );
        }, this.#remainingMs);
    }

    #stop(): void {
        if (this.#timer === undefined) return;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#remainingMs = Math.max(0, this.#remainingMs - (Date.now() - this.#startedAt));
    }
}
