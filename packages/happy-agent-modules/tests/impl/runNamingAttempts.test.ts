import { createRootContext } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import { runNamingAttempts } from "../../sources/impl/runNamingAttempts.js";
import { sharedKV } from "../support/fixtures.js";

const ctx = createRootContext().named("naming-budget-test");

it("resumes an exhausted durable budget directly at fallback", async () => {
    const kv = sharedKV();
    await kv.write(ctx, "progress", { attempts: 3, retryAt: Date.now() + 5_000 });
    const attempt = vi.fn();
    await expect(runNamingAttempts(ctx, kv, async () => true, attempt)).resolves.toBeUndefined();
    expect(attempt).not.toHaveBeenCalled();
});

it("does not treat an eligibility storage error as a provider failure", async () => {
    const kv = sharedKV();
    const attempt = vi.fn();
    await expect(
        runNamingAttempts(
            ctx,
            kv,
            async () => {
                throw new Error("Database unavailable");
            },
            attempt,
        ),
    ).rejects.toThrow("Database unavailable");
    expect(await kv.read(ctx, "progress")).toBeUndefined();
    expect(attempt).not.toHaveBeenCalled();
});

it("reserves the attempt before provider execution", async () => {
    const kv = sharedKV();
    await expect(
        runNamingAttempts(
            ctx,
            kv,
            async () => true,
            async () => {
                expect(await kv.read(ctx, "progress")).toMatchObject({ attempts: 1 });
                return "A name";
            },
        ),
    ).resolves.toBe("A name");
});

it("does not reset an invalid stored budget", async () => {
    const kv = sharedKV();
    await kv.write(ctx, "progress", { attempts: 4, retryAt: 0 });
    await expect(runNamingAttempts(ctx, kv, async () => true, vi.fn())).rejects.toThrow(
        "budget is invalid",
    );
});
