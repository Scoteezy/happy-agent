import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
    artifactAddressLoopback,
    artifactAddressPublic,
    artifactNetworkDestinations,
    artifactNetworkHost,
    connectArtifactNetwork,
} from "../../sources/artifacts/impl/artifactNetwork.js";

describe("artifact network addresses", () => {
    it.each([
        ["8.8.8.8", true, false],
        ["2606:4700:4700::1111", true, false],
        ["127.0.0.1", false, true],
        ["127.12.34.56", false, true],
        ["::1", false, true],
        ["::ffff:127.0.0.1", false, true],
        ["::ffff:0:127.0.0.1", false, true],
        ["::ffff:8.8.8.8", true, false],
        ["::ffff:0:8.8.8.8", true, false],
        ["::ffff:0:192.168.0.1", false, false],
        ["::ffff:0:169.254.169.254", false, false],
        ["64:ff9b::a00:1", false, false],
        ["64:ff9b:1::808:808", false, false],
        ["2002:c0a8:101::", false, false],
        ["2001::808:808", false, false],
        ["0.0.0.0", false, false],
        ["::", false, false],
        ["10.1.2.3", false, false],
        ["172.16.0.1", false, false],
        ["192.168.1.1", false, false],
        ["fc00::1", false, false],
        ["169.254.169.254", false, false],
        ["fe80::1", false, false],
        ["fe80::1%eth0", false, false],
        ["100.64.0.1", false, false],
        ["192.0.2.1", false, false],
        ["224.0.0.1", false, false],
        ["ff02::1", false, false],
        ["not-an-address", false, false],
    ])("classifies %s", (address, isPublic, loopback) => {
        expect(artifactAddressPublic(address)).toBe(isPublic);
        expect(artifactAddressLoopback(address)).toBe(loopback);
    });

    it.each(["2130706433", "0x7f.1", "0177.0.0.1", "127.1"])(
        "classifies numeric spelling %s as its address",
        (host) => {
            const address = artifactNetworkHost(host);
            expect(address).toBe("127.0.0.1");
            expect(artifactAddressPublic(address)).toBe(false);
            expect(artifactAddressLoopback(address)).toBe(true);
        },
    );

    it("checks all DNS answers and returns only a checked public literal", async () => {
        const lookup = vi.fn(
            async (_host: string): Promise<readonly string[]> => ["8.8.8.8", "1.1.1.1"],
        );
        await expect(
            artifactNetworkDestinations("https://example.com/", "cdn.example", 443, lookup),
        ).resolves.toEqual(["8.8.8.8"]);
        expect(lookup).toHaveBeenCalledExactlyOnceWith("cdn.example");
        for (const addresses of [["127.0.0.1"], ["8.8.8.8", "10.0.0.1"], []]) {
            lookup.mockResolvedValue(addresses);
            await expect(
                artifactNetworkDestinations("https://example.com/", "example.com", 443, lookup),
            ).resolves.toBeUndefined();
        }
    });

    it("allows only the exact recorded loopback authority, without DNS", async () => {
        const lookup = vi.fn(async (_host: string): Promise<readonly string[]> => {
            throw new Error("No DNS");
        });
        await expect(
            artifactNetworkDestinations("http://localhost:5173/", "LOCALHOST", 5173, lookup),
        ).resolves.toEqual(["127.0.0.1", "::1"]);
        await expect(
            artifactNetworkDestinations("http://127.0.0.1/", "127.0.0.1", 80, lookup),
        ).resolves.toEqual(["127.0.0.1"]);
        await expect(
            artifactNetworkDestinations("http://[::1]/", "::1", 80, lookup),
        ).resolves.toEqual(["::1"]);
        for (const [url, host, port] of [
            ["http://127.0.0.1/", "2130706433", 80],
            ["http://127.0.0.1/", "127.0.0.1", 81],
            ["http://localhost:5173/", "127.0.0.1", 5173],
            ["http://10.0.0.1/", "10.0.0.1", 80],
            ["http://169.254.169.254/", "169.254.169.254", 80],
            ["http://[fe80::1]/", "fe80::1", 80],
            ["http://0.0.0.0/", "0.0.0.0", 80],
        ] as const) {
            await expect(
                artifactNetworkDestinations(url, host, port, lookup),
            ).resolves.toBeUndefined();
        }
        expect(lookup).not.toHaveBeenCalled();
    });

    it("connects only to the checked public literal and never connects rebinding or mixed answers", async () => {
        const socket = new PassThrough();
        const connect = vi.fn(async (_host: string, _port: number) => socket);
        const lookup = vi.fn(async (_host: string): Promise<readonly string[]> => ["8.8.8.8"]);
        expect(
            await connectArtifactNetwork(
                "https://example.com/",
                "example.com",
                443,
                lookup,
                connect,
            ),
        ).toBe(socket);
        expect(connect).toHaveBeenCalledExactlyOnceWith("8.8.8.8", 443);
        expect(lookup).toHaveBeenCalledTimes(1);
        connect.mockClear();
        for (const addresses of [["127.0.0.1"], ["8.8.8.8", "::1"], ["169.254.169.254"]]) {
            lookup.mockResolvedValue(addresses);
            expect(
                await connectArtifactNetwork(
                    "https://example.com/",
                    "example.com",
                    443,
                    lookup,
                    connect,
                ),
            ).toBeUndefined();
        }
        expect(connect).not.toHaveBeenCalled();
        socket.destroy();
    });

    it("tries IPv6 localhost only after an IPv4 connection refusal", async () => {
        const socket = new PassThrough();
        const lookup = vi.fn(async (_host: string): Promise<readonly string[]> => []);
        const connect = vi.fn(async (_host: string, _port: number) => socket);
        connect.mockRejectedValueOnce(
            Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
        );
        expect(
            await connectArtifactNetwork("http://localhost/", "localhost", 80, lookup, connect),
        ).toBe(socket);
        expect(connect.mock.calls).toEqual([
            ["127.0.0.1", 80],
            ["::1", 80],
        ]);
        expect(lookup).not.toHaveBeenCalled();
        connect.mockClear();
        connect.mockRejectedValueOnce(Object.assign(new Error("away"), { code: "ETIMEDOUT" }));
        await expect(
            connectArtifactNetwork("http://localhost/", "localhost", 80, lookup, connect),
        ).rejects.toThrow("away");
        expect(connect).toHaveBeenCalledTimes(1);
        socket.destroy();
    });
});
