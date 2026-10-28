import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
    isKnownMessageFailure,
    messageFailureSchema,
    providerAccountUsageStateSchema,
    providerConfigSchema,
    providerUsageEntrySchema,
    providerUsageUpdatedPayloadSchema,
    type MessageFailure,
    type ProviderAccountSignIn,
    type ProviderUsageUpdatedPayload,
} from "../sources/index.js";

const smart = {
    type: "codex",
    enabled: true,
    models: [{ id: "openai/gpt-6.1-sol", enabled: true }],
};
const pool = { strategy: "round_robin", members: ["codex", "codex_work"] };

const state = {
    providerId: "codex_work",
    usage: null,
    checkedAt: 1_755_400_000_100,
    error: null,
    refreshedAt: null,
    refreshError: null,
    retryAt: null,
    refreshing: false,
};

const codex = { id: "codex", type: "codex", vendorName: "Codex", label: "codex" };
const spentPool = {
    kind: "no_account_available",
    message: "No Pool account is available. The first one resets in about 5 days.",
    fallbackProviders: [],
    poolName: "Pool",
    resetsAt: 1_755_832_000_000,
};

describe("smart provider pools", () => {
    it("describes a pool's members on its configuration and usage entries", () => {
        expect(Value.Check(providerConfigSchema, { ...smart, pool })).toBe(true);
        expect(
            Value.Check(providerUsageEntrySchema, { ...smart, ...state, providerId: "pool", pool }),
        ).toBe(true);
    });

    it("keeps a strategy added later readable and accepts a pool with no routable member", () => {
        expect(
            Value.Check(providerConfigSchema, {
                ...smart,
                pool: { strategy: "priority", members: [] },
            }),
        ).toBe(true);
    });

    it("rejects a malformed pool", () => {
        expect(Value.Check(providerConfigSchema, { ...smart, pool: { strategy: "" } })).toBe(false);
        expect(
            Value.Check(providerConfigSchema, {
                ...smart,
                pool: { strategy: "round_robin", members: "codex" },
            }),
        ).toBe(false);
    });

    it("accepts older daemons' entries without a pool", () => {
        expect(Value.Check(providerConfigSchema, smart)).toBe(true);
    });
});

describe("account sign-in", () => {
    it.each(["signed_in", "signed_out", "unknown"])(
        "accepts %s on entries and events",
        (signIn) => {
            expect(Value.Check(providerAccountUsageStateSchema, { ...state, signIn })).toBe(true);
            expect(Value.Check(providerUsageUpdatedPayloadSchema, { ...state, signIn })).toBe(true);
            expect(
                Value.Check(providerUsageEntrySchema, {
                    ...smart,
                    ...state,
                    signIn,
                    pool: undefined,
                }),
            ).toBe(true);
        },
    );

    it("leaves sign-in optional for smart providers and older daemons", () => {
        expect(Value.Check(providerUsageUpdatedPayloadSchema, state)).toBe(true);
        expect(Value.Check(providerUsageEntrySchema, { ...smart, ...state })).toBe(true);
        expectTypeOf<ProviderUsageUpdatedPayload["signIn"]>().toEqualTypeOf<
            ProviderAccountSignIn | undefined
        >();
    });

    it("rejects an invented sign-in value", () => {
        expect(
            Value.Check(providerUsageUpdatedPayloadSchema, { ...state, signIn: "expired" }),
        ).toBe(false);
    });
});

describe("a spent pool's members", () => {
    const members = [
        { provider: codex, reason: "usage_limit", command: null, resetsAt: 1_755_832_000_000 },
        {
            provider: { ...codex, id: "codex_work", label: "Work" },
            reason: "signin_missing",
            command: "codex login",
            resetsAt: null,
        },
    ];

    it("lists each account it set aside", () => {
        const failure = { ...spentPool, members };
        expect(Value.Check(messageFailureSchema, failure)).toBe(true);
        expect(isKnownMessageFailure(failure)).toBe(true);
        expectTypeOf<
            NonNullable<
                Extract<MessageFailure, { kind: "no_account_available" }>["members"]
            >[number]
        >().toMatchTypeOf<{ reason: string; command: string | null; resetsAt: number | null }>();
    });

    it("accepts an empty list, a reason added later, and failures without members", () => {
        for (const failure of [
            { ...spentPool, members: [] },
            { ...spentPool, members: [{ ...members[0], reason: "paused" }] },
            spentPool,
        ]) {
            expect(isKnownMessageFailure(failure as MessageFailure)).toBe(true);
        }
    });

    it("never narrows a malformed member list to the known kind", () => {
        const { command: _, ...withoutCommand } = members[0]!;
        for (const failure of [
            { ...spentPool, members: [withoutCommand] },
            { ...spentPool, members: [{ ...members[0], provider: { id: "codex" } }] },
            { ...spentPool, members: Array.from({ length: 65 }, () => members[0]) },
        ]) {
            expect(Value.Check(messageFailureSchema, failure)).toBe(true);
            expect(isKnownMessageFailure(failure as MessageFailure)).toBe(false);
        }
    });
});
