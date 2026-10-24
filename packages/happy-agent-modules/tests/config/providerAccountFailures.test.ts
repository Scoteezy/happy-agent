import { expect, it } from "vitest";

import { ProviderAccountFailures } from "../../sources/config/impl/ProviderAccountFailures.js";

const failure = (type: "authentication" | "out_of_tokens" | "rate_limit") =>
    ({
        type: "done",
        state: "error",
        kind: "unknown",
        message: "",
        providerError: { type },
    }) as const;

it("remembers sign-in and usage failures until a response completes or fifteen minutes pass", () => {
    let now = 0;
    const failures = new ProviderAccountFailures(() => now);
    failures.observe("throttled", failure("rate_limit"));
    failures.observe("cancelled", { type: "done", state: "cancelled" });
    expect(failures.has("throttled")).toBe(false);
    expect(failures.has("cancelled")).toBe(false);

    failures.observe("signed-out", failure("authentication"));
    failures.observe("spent", failure("out_of_tokens"));
    expect(failures.has("signed-out")).toBe(true);
    expect(failures.has("spent")).toBe(true);

    failures.observe("signed-out", {
        type: "done",
        state: "normal",
        tokens: { input: 1, output: 1 },
    });
    expect(failures.has("signed-out")).toBe(false);
    now = 15 * 60_000 + 1;
    expect(failures.has("spent")).toBe(false);
});
