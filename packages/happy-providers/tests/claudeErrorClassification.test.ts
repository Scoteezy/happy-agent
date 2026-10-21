import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { classifyClaudeError, claudeErrorKind } from "@/vendors/claude/errors/claudeErrors.js";

/** Oct 21 2026, 6pm America/Los_Angeles, as the limiter reports it in epoch seconds. */
const WEEKLY_RESET_SECONDS = 1_792_630_800;

describe("Claude usage limit classification", () => {
    it("reports a spent weekly window as out of tokens with the window's reset", () => {
        // The CLI's own words and limiter report when the weekly allowance is used up.
        const message = "You've hit your weekly limit · resets Oct 21 at 6pm (America/Los_Angeles)";
        const rateLimitInfo: SDKRateLimitInfo = {
            status: "rejected",
            resetsAt: WEEKLY_RESET_SECONDS,
            rateLimitType: "seven_day",
            utilization: 1.02,
            overageStatus: "rejected",
            overageDisabledReason: "org_level_disabled",
            isUsingOverage: false,
        };
        const providerError = classifyClaudeError({
            assistantError: "rate_limit",
            message,
            rateLimitInfo,
        });
        expect(providerError).toMatchObject({
            type: "out_of_tokens",
            resetAt: WEEKLY_RESET_SECONDS * 1_000,
        });
        expect(claudeErrorKind(message, providerError)).toBe("billing_error");
    });

    it("reports a spent session window the same way, without an overage reset", () => {
        expect(
            classifyClaudeError({
                assistantError: "rate_limit",
                message: "You've hit your session limit · resets 11pm (America/Los_Angeles)",
                rateLimitInfo: {
                    status: "rejected",
                    resetsAt: 2_000,
                    rateLimitType: "five_hour",
                    overageStatus: "rejected",
                    overageResetsAt: 1_000,
                },
            }),
        ).toMatchObject({ type: "out_of_tokens", resetAt: 2_000_000 });
    });

    it("keeps a momentary throttle a rate limit", () => {
        // A 429 the limiter did not reject the account for, in the CLI's own wording.
        expect(
            classifyClaudeError({
                assistantError: "rate_limit",
                message:
                    "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
                rateLimitInfo: {
                    status: "allowed",
                    rateLimitType: "five_hour",
                    utilization: 0.4,
                    resetsAt: 2_000,
                },
            }),
        ).toMatchObject({ type: "rate_limit" });
        expect(
            classifyClaudeError({
                assistantError: "rate_limit",
                message:
                    "API Error: Request rejected (429) · this may be a temporary capacity issue.",
            }),
        ).toMatchObject({ type: "rate_limit" });
    });

    it("does not call an account spent while overage is still paying for it", () => {
        expect(
            classifyClaudeError({
                assistantError: "rate_limit",
                message: "Rate limited.",
                rateLimitInfo: { status: "rejected", resetsAt: 2_000, isUsingOverage: true },
            }),
        ).toMatchObject({ type: "rate_limit" });
    });
});

describe("Claude authentication classification", () => {
    it("uses the SDK authentication code even when the upstream message mentions usage", () => {
        expect(
            classifyClaudeError({
                assistantError: "authentication_failed",
                message: "Authentication failed while checking the usage limit.",
            }),
        ).toMatchObject({
            type: "authentication",
            diagnostics: { code: "authentication_failed" },
        });
    });

    it("does not infer an authentication rejection from text alone", () => {
        expect(
            classifyClaudeError({ message: "An example mentions 401 authentication_failed." }),
        ).toMatchObject({ type: "unclassified" });
    });
});
