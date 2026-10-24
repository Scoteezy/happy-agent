import type { LiveControllerDetail, LiveFailureCategory } from "./liveDiagnostics.js";

/** Fixed diagnostics: provider errors and desktop contents must never enter voice or logs. */
export class LiveControllerError extends Error {
    constructor(
        readonly category: LiveFailureCategory,
        readonly detail?: LiveControllerDetail,
    ) {
        const explanation = {
            inference: "The desktop controller could not complete this request.",
            deadline: "The desktop controller could not complete this request before its deadline.",
            invalidAction:
                "The desktop controller could not complete this request because it returned an unsupported or invalid action.",
            limit: "The desktop controller could not complete this request within its limits.",
            uncertainAction:
                "The desktop controller could not complete this request because a desktop action did not return a confirmed outcome.",
            capacity: "Voice reached its desktop action limit. Start a new call explicitly.",
        }[category];
        super((category === "inference" && accountExplanation(detail)) || explanation);
        this.name = "LiveControllerError";
    }

    /** A failed delegation may follow earlier successful or still-running mutations. */
    get voiceContext(): string {
        if (
            this.detail?.phase === "providerOpen" ||
            (this.detail?.phase === "context" && this.detail.round === undefined) ||
            (this.detail?.round === 0 &&
                (this.detail.phase === "providerStream" ||
                    this.detail.phase === "providerDone" ||
                    this.detail.phase === "toolValidation"))
        )
            return `${this.message} No action was started for this request.${this.detail?.reason === "contextLimit" ? " Start a new voice call to begin a fresh controller conversation." : " Continue the conversation without replaying this request."}`;
        return `${this.message} Some actions may already have completed or may still complete. Do not retry any action automatically or claim it succeeded. Explain the failure, let the person inspect the app, and continue the conversation.`;
    }
}

/**
 * The call keeps its controller account, so a rejected sign-in or spent usage is something the
 * person must fix; say which, and what they can do, instead of a failure they would only retry.
 */
function accountExplanation(detail: LiveControllerDetail | undefined): string | undefined {
    if (detail?.providerErrorType === "authentication")
        return "The desktop controller could not complete this request because its account's sign-in was rejected. The person needs to sign in to the controller account again, or choose a different controller account in the voice settings and start a new call.";
    if (detail?.providerErrorType === "out_of_tokens")
        return "The desktop controller could not complete this request because its account has run out of usage. The person can wait for that account's usage to reset, or choose a different controller account in the voice settings and start a new call.";
    return undefined;
}
