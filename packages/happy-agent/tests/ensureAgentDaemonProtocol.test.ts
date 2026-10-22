import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    health: vi.fn(),
    paths: vi.fn(),
    token: vi.fn(),
    configure: vi.fn(),
    run: vi.fn(),
}));

vi.mock("@slopus/happy-agent-client", async (original) => ({
    ...(await original<typeof import("@slopus/happy-agent-client")>()),
    HappyAgentClient: class {
        getHealth = mocks.health;
    },
}));
vi.mock("@slopus/happy-agent-modules", () => ({ loadHappyAgentConfiguration: mocks.configure }));
vi.mock("../sources/lifecycle/daemonToken.js", () => ({
    readDaemonToken: vi.fn(async () => "token"),
    readDaemonTokenIfPresent: mocks.token,
    readOrCreateDaemonToken: vi.fn(async () => "token"),
}));
vi.mock("../sources/lifecycle/getDaemonIdentity.js", () => ({
    getDaemonIdentity: () => ({ version: "test" }),
}));
vi.mock("../sources/lifecycle/getHappyDaemonPaths.js", () => ({
    getHappyDaemonPaths: mocks.paths,
}));
vi.mock("../sources/lifecycle/runAgentDaemon.js", () => ({ runAgentDaemon: mocks.run }));

import { ensureAgentDaemon } from "../sources/lifecycle/ensureAgentDaemon.js";

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proto-"));
    mocks.paths.mockReturnValue({
        happyHome: root,
        directory: join(root, "agent"),
        tokenPath: join(root, "agent/token"),
        socketPath: join(root, "agent/server.sock"),
    });
    mocks.token.mockResolvedValue("token");
    mocks.configure.mockResolvedValue({ values: { feature: { team: { enabled: false } } } });
    mocks.run.mockResolvedValue(undefined);
});
afterEach(async () => {
    vi.resetAllMocks();
    await rm(root, { recursive: true, force: true });
});

describe("additive daemon protocols", () => {
    it.each([22, 30, 31, 99])(
        "connects to same-version protocol %s without requesting a restart",
        async (protocol) => {
            mocks.health.mockResolvedValue({ ready: true, version: { protocol, daemon: "test" } });
            const confirmRestart = vi.fn(async () => false);
            expect((await ensureAgentDaemon({ confirmRestart })).token).toBe("token");
            expect(confirmRestart).not.toHaveBeenCalled();
            expect(mocks.configure).not.toHaveBeenCalled();
            expect(mocks.run).not.toHaveBeenCalled();
        },
    );

    it("still requests replacement when product versions differ", async () => {
        mocks.health.mockResolvedValue({
            ready: true,
            version: { protocol: 31, daemon: "older-product" },
        });
        const confirmRestart = vi.fn(async () => false);
        await expect(ensureAgentDaemon({ confirmRestart })).rejects.toThrow(
            "does not match this client",
        );
        expect(confirmRestart).toHaveBeenCalledWith({
            currentIdentity: { version: "test" },
            runningIdentity: { version: "older-product" },
        });
    });

    it("refuses an observed daemon below the supported minimum", async () => {
        mocks.health.mockResolvedValue({ ready: true, version: { protocol: 21, daemon: "test" } });
        await expect(ensureAgentDaemon()).rejects.toThrow("does not match this client");
    });

    it("refuses startup readiness below the supported minimum", async () => {
        mocks.token.mockResolvedValue(undefined);
        mocks.health.mockResolvedValue({ ready: true, version: { protocol: 21, daemon: "test" } });
        await expect(ensureAgentDaemon({ runInProcess: true })).rejects.toThrow(
            "requires protocol 22 or newer",
        );
    });
});
