import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { claudeSessionAttachments } from "@/vendors/claude/impl/claudeSessionAttachments.js";

// 00:41 UTC on Oct 21 2026 is still 5:41pm on Oct 20 in Los Angeles.
const AFTER_UTC_MIDNIGHT = new Date(Date.UTC(2026, 9, 21, 0, 41));

function recordedDate(env: NodeJS.ProcessEnv, now = AFTER_UTC_MIDNIGHT): string | undefined {
    const date = claudeSessionAttachments({
        cwd: tmpdir(),
        env,
        model: "anthropic/opus-5-5",
        now,
    }).find((attachment) => attachment.type === "date");
    return date?.type === "date" ? date.date : undefined;
}

describe("Claude session date attachment", () => {
    it("records the date in the time zone the CLI is started with, not this process's", () => {
        expect(recordedDate({ TZ: "UTC" })).toBe("2026-10-21");
        expect(recordedDate({ TZ: "America/Los_Angeles" })).toBe("2026-10-20");
        expect(recordedDate({ TZ: ":Asia/Tokyo" })).toBe("2026-10-21");
    });

    it("falls back to UTC for a zone the CLI cannot resolve, as its runtime does", () => {
        expect(recordedDate({ TZ: "" })).toBe("2026-10-21");
        expect(recordedDate({ TZ: "Not/AZone" })).toBe("2026-10-21");
    });

    it("uses the shared system zone when the CLI inherits no TZ", () => {
        const now = AFTER_UTC_MIDNIGHT;
        const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        expect(recordedDate({}, now)).toBe(local);
    });
});
