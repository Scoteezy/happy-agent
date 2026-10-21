import { describe, expect, it } from "vitest";

import {
    artifactAddressLoopback,
    artifactAddressPublic,
    artifactNetworkHost,
} from "../sources/index.js";

describe("shared artifact address policy", () => {
    it.each([
        ["8.8.8.8", true, false],
        ["1.1.1.1", true, false],
        ["127.0.0.1", false, true],
        ["127.255.255.255", false, true],
        ["126.255.255.255", true, false],
        ["128.0.0.0", true, false],
        ["0.0.0.0", false, false],
        ["0.255.255.255", false, false],
        ["10.0.0.1", false, false],
        ["100.63.255.255", true, false],
        ["100.64.0.0", false, false],
        ["100.127.255.255", false, false],
        ["100.128.0.0", true, false],
        ["169.254.169.254", false, false],
        ["172.15.255.255", true, false],
        ["172.16.0.0", false, false],
        ["172.31.255.255", false, false],
        ["172.32.0.0", true, false],
        ["192.0.0.1", false, false],
        ["192.0.1.1", true, false],
        ["192.0.2.1", false, false],
        ["192.88.99.1", false, false],
        ["192.168.0.1", false, false],
        ["198.17.255.255", true, false],
        ["198.18.0.0", false, false],
        ["198.19.255.255", false, false],
        ["198.20.0.0", true, false],
        ["198.51.100.1", false, false],
        ["203.0.113.1", false, false],
        ["223.255.255.255", true, false],
        ["224.0.0.0", false, false],
        ["239.255.255.255", false, false],
        ["240.0.0.0", false, false],
        ["255.255.255.255", false, false],
        ["2606:4700:4700::1111", true, false],
        ["::1", false, true],
        ["0:0:0:0:0:0:0:1", false, true],
        ["::", false, false],
        ["::ffff:127.0.0.1", false, true],
        ["::ffff:0:127.0.0.1", false, true],
        ["::FFFF:7F00:1", false, true],
        ["::FFFF:0:7F00:1", false, true],
        ["::ffff:8.8.8.8", true, false],
        ["::ffff:0:8.8.8.8", true, false],
        ["::ffff:0:192.168.0.1", false, false],
        ["::ffff:0:169.254.169.254", false, false],
        ["::127.0.0.1", false, false],
        ["::8.8.8.8", false, false],
        ["64:ff9b::808:808", true, false],
        ["64:ff9b::8.8.8.8", true, false],
        ["64:ff9b::7f00:1", false, false],
        ["64:ff9b::a00:1", false, false],
        ["64:ff9b:1::808:808", false, false],
        ["2000::1", true, false],
        ["2001::808:808", false, false],
        ["2001:2::1", false, false],
        ["2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff", false, false],
        ["2001:200::1", true, false],
        ["2001:db8::1", false, false],
        ["2001:db9::1", true, false],
        ["2002:7f00:1::", false, false],
        ["2002:808:808::", false, false],
        ["2002:c0a8:101::", false, false],
        ["2003::1", true, false],
        ["3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true, false],
        ["3fff::1", false, false],
        ["3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", false, false],
        ["3fff:1000::1", true, false],
        ["3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true, false],
        ["4000::1", false, false],
        ["8000::1", false, false],
        ["fc00::1", false, false],
        ["fe80::1", false, false],
        ["fe80::1%eth0", false, false],
        ["ff02::1", false, false],
    ])("classifies %s", (address, publicAddress, loopback) => {
        expect(artifactAddressPublic(address)).toBe(publicAddress);
        expect(artifactAddressLoopback(address)).toBe(loopback);
    });

    it.each([
        "",
        "localhost",
        "example.com",
        "127.1",
        "2130706433",
        "0x7f.1",
        "0177.0.0.1",
        "256.1.1.1",
        "1.2.3.4.5",
        "1.2.3.-1",
        "1.2.3.01",
        "1.2.3.4 ",
        "[::1]",
        ":::1",
        "1::2::3",
        "2000:1:2:3:4:5:6:7:8",
        "2000:1:2:3:4:5:6::7",
        "2000:1:2:3:4:5:6",
        "2000:1:2:3:4:5:6:",
        "2000:1:2:3:4:5:6:gg",
        "2000:1:2:3:4:5:6:10000",
        "::ffff:127.00.0.1",
        "::ffff:256.0.0.1",
        "::1%",
        "::1%eth_0",
        "::1%%eth0",
        "https://8.8.8.8/",
    ])("refuses non-literals and malformed literals: %s", (address) => {
        expect(artifactAddressPublic(address)).toBe(false);
        expect(artifactAddressLoopback(address)).toBe(false);
    });

    it.each([
        ["2130706433", "127.0.0.1"],
        ["0x7f.1", "127.0.0.1"],
        ["0177.0.0.1", "127.0.0.1"],
        ["127.1", "127.0.0.1"],
        ["0x08080808", "8.8.8.8"],
        ["[::FFFF:7F00:1]", "::ffff:7f00:1"],
        ["::FFFF:7F00:1", "::ffff:7f00:1"],
        ["LOCALHOST", "localhost"],
        ["EXAMPLE.COM", "example.com"],
    ])("normalizes %s for classification, not origin equality", (host, normalized) => {
        expect(artifactNetworkHost(host)).toBe(normalized);
    });

    it.each(["[::xyz]", "::1%eth0", "256.0.0.1", "bad host"])(
        "rejects invalid URL host %s",
        (host) => {
            expect(() => artifactNetworkHost(host)).toThrow();
        },
    );
});
