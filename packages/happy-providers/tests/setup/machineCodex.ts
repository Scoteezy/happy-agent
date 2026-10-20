import { vi } from "vitest";

/**
 * A Codex session names this machine's Codex in its user agent by running `codex --version` and
 * `sw_vers`, with a five-second timeout each. That is the machine, not a contract under test, and
 * under a loaded run the first session in a worker could wait out a whole test timeout on it.
 * Live tests use their own configuration and keep the real lookup.
 */
vi.mock("@/vendors/codex/impl/codexUserAgent.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/vendors/codex/impl/codexUserAgent.js")>()),
    resolveCodexUserAgent: async () => "codex_exec/0.0.0 (Mac OS 26.0; arm64) test",
}));
