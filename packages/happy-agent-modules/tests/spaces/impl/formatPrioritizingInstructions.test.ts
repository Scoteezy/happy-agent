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
    { revision: 3, sha256: "3be0ce92f1a88c95d86102bdf3796d04b74e2f64d95be34fe8aee15ed2f8dee7" },
    { revision: 4, sha256: "1c13954d59d979586cd4d915fe306d901b44514e8c872cf6a0e6dd233a408114" },
];

it("arranges by the person's own priorities into the Focus layout within the budget", () => {
    const text = formatPrioritizingInstructions();
    // Priorities come from the person's words only, and are guessed aloud until they state any.
    expect(text).toContain('end your reply with one line "Priorities: …"');
    expect(text).toContain("Only their explicit words change it");
    expect(text).toContain('"Priorities (my guess): …"');
    // The layout, top to bottom, with its folded catch-all last.
    const order = [
        "1. Now, no label",
        'id="tell-people" label="Tell people"',
        'id="priorities" label="Priorities"',
        'id="waiting" label="Waiting on you"',
        'id="in-hand" label="In hand"',
        'id="later" label="Later" collapsed="true"',
    ].map((part) => text.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("At most 10 rows shown");
    expect(text).toContain("at most 6 sections");
    expect(text).toContain("Over budget is not a resting state");
    expect(text).not.toContain("Doing nothing is usually right");
    // Shipping needs explicit evidence, and real work is never nagged about.
    expect(text).toContain("Approval alone is not shipping.");
    expect(text).toContain("Never nudge about releases, regressions, bug fixes");
    // Focus is reached by unfolding Happy, never from a top-level row of its own.
    expect(text).toContain("You never take a top-level row");
    expect(text).toContain("Keep your conversation nested under Happy's row as a session");
    expect(text).not.toContain("immediately after Happy's row");
    // After the update, one bold reorganization through the ordinary proposal.
    expect(text).toContain("make one bold proposal that rebuilds it into this layout");
});

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
