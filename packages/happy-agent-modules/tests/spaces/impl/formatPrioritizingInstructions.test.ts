import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import {
    formatPrioritizingInstructions,
    PRIORITIZING_REVISION,
} from "../../../sources/spaces/impl/formatPrioritizingInstructions.js";

/**
 * Every revision of Prioritizing's instructions, oldest first, with the digest of its text. A
 * running Prioritizing hears about new instructions only when the revision rises, so changing the
 * text means adding a row here with the next revision and raising PRIORITIZING_REVISION to match.
 */
const REVISIONS: readonly { readonly revision: number; readonly sha256: string }[] = [
    { revision: 2, sha256: "f40d25bc2aa5cb091a3b4bfe151cdbec77e10941f0b251521853e6fdb4f7d11f" },
];

it("raises the instructions revision with every change to their text", () => {
    const sha256 = createHash("sha256").update(formatPrioritizingInstructions()).digest("hex");
    const latest = REVISIONS.at(-1)!;
    expect(
        { revision: PRIORITIZING_REVISION, sha256 },
        "Prioritizing's instructions changed: add a row to REVISIONS with the next revision and this digest, and raise PRIORITIZING_REVISION to it, so running Prioritizing agents are told on the next start.",
    ).toEqual(latest);
    // Every revision is newer than the one before it, and no text comes back under a new number.
    REVISIONS.forEach((row, index) => {
        if (index > 0) expect(row.revision).toBeGreaterThan(REVISIONS[index - 1]!.revision);
    });
    expect(new Set(REVISIONS.map((row) => row.sha256)).size).toBe(REVISIONS.length);
});
