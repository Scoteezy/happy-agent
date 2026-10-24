import type { SessionEvent } from "@slopus/happy-providers";

const FAILURE_TTL_MS = 15 * 60_000;

/**
 * The accounts whose latest inference ended because their sign-in was rejected or their usage ran
 * out.
 *
 * Smart routes fail over past such an account within one agent's turn, but a caller that freezes
 * one account for its whole lifetime, such as a voice call's controller, must avoid choosing it in
 * the first place. One entry per configured provider ID, set by a typed authentication or
 * out-of-tokens failure, cleared by the next completed response, and forgotten after fifteen
 * minutes so a recovered account is not avoided forever.
 */
export class ProviderAccountFailures {
    readonly #failedAt = new Map<string, number>();

    constructor(readonly now: () => number = Date.now) {}

    /** Learn from one terminal inference event of this concrete account. */
    observe(providerId: string, event: Extract<SessionEvent, { type: "done" }>): void {
        if (event.state === "normal" || event.state === "tool_call") {
            this.#failedAt.delete(providerId);
            return;
        }
        const type = event.state === "error" ? event.providerError?.type : undefined;
        if (type === "authentication" || type === "out_of_tokens")
            this.#failedAt.set(providerId, this.now());
    }

    /** Whether this account's latest inference failed on sign-in or usage, within the last minutes. */
    has(providerId: string): boolean {
        const at = this.#failedAt.get(providerId);
        if (at === undefined) return false;
        if (this.now() - at <= FAILURE_TTL_MS) return true;
        this.#failedAt.delete(providerId);
        return false;
    }
}
