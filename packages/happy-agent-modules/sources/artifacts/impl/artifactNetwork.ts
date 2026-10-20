import { BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Kept in step with Happy Desktop's artifactNetwork.ts.
const refusedAddresses = (() => {
    const list = new BlockList();
    for (const [network, prefix] of [
        ["0.0.0.0", 8],
        ["10.0.0.0", 8],
        ["100.64.0.0", 10],
        ["127.0.0.0", 8],
        ["169.254.0.0", 16],
        ["172.16.0.0", 12],
        ["192.0.0.0", 24],
        ["192.0.2.0", 24],
        ["192.88.99.0", 24],
        ["192.168.0.0", 16],
        ["198.18.0.0", 15],
        ["198.51.100.0", 24],
        ["203.0.113.0", 24],
        ["224.0.0.0", 4],
        ["240.0.0.0", 4],
    ] as const)
        list.addSubnet(network, prefix, "ipv4");
    for (const [network, prefix] of [
        ["2001::", 23],
        ["2001:db8::", 32],
        ["2002::", 16],
        ["3fff::", 20],
    ] as const)
        list.addSubnet(network, prefix, "ipv6");
    return list;
})();

const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

function ipv6Bytes(address: string): number[] {
    let text = address.toLowerCase();
    const zone = text.indexOf("%");
    if (zone >= 0) text = text.slice(0, zone);
    let quad: number[] | undefined;
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
    if (dotted) {
        quad = dotted[1]!.split(".").map(Number);
        text = `${text.slice(0, -dotted[1]!.length)}0:0`;
    }
    const halves = text.split("::");
    const groupsOf = (part: string | undefined) => (part ? part.split(":") : []);
    const head = groupsOf(halves[0]);
    const tail = groupsOf(halves[1]);
    const groups = [
        ...head,
        ...Array<string>(halves.length === 2 ? 8 - head.length - tail.length : 0).fill("0"),
        ...tail,
    ];
    const bytes = groups.flatMap((group) => {
        const value = Number.parseInt(group, 16);
        return [value >> 8, value & 255];
    });
    if (quad) bytes.splice(12, 4, ...quad);
    return bytes;
}

/** Only mapped and translated addresses can share the literal IPv4 loopback exception. */
function ipv6Mapped(bytes: readonly number[]): string | undefined {
    const zero = (from: number, to: number) => bytes.slice(from, to).every((value) => value === 0);
    const quad = (at: number) => bytes.slice(at, at + 4).join(".");
    if (zero(0, 10) && bytes[10] === 255 && bytes[11] === 255) return quad(12);
    if (zero(0, 8) && bytes[8] === 255 && bytes[9] === 255 && zero(10, 12)) return quad(12);
    return undefined;
}

export function artifactAddressPublic(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return !refusedAddresses.check(address, "ipv4");
    if (family !== 6) return false;
    const bytes = ipv6Bytes(address);
    const nat64 =
        bytes[0] === 0 &&
        bytes[1] === 0x64 &&
        bytes[2] === 0xff &&
        bytes[3] === 0x9b &&
        bytes.slice(4, 12).every((byte) => byte === 0);
    const embedded = ipv6Mapped(bytes) ?? (nat64 ? bytes.slice(12).join(".") : undefined);
    if (embedded !== undefined) return !refusedAddresses.check(embedded, "ipv4");
    const literal = address.replace(/%.*$/u, "");
    return globalIpv6.check(literal, "ipv6") && !refusedAddresses.check(literal, "ipv6");
}

export function artifactAddressLoopback(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return address.startsWith("127.");
    if (family !== 6) return false;
    const bytes = ipv6Bytes(address);
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
    const embedded = ipv6Mapped(bytes);
    return embedded !== undefined && embedded.startsWith("127.");
}

/** Normalize only for address classification; exception equality uses the host as written. */
export function artifactNetworkHost(host: string): string {
    const authority = isIP(host) === 6 ? `[${host}]` : host;
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "");
}

type Resolve = (host: string) => Promise<readonly string[]>;
type Connect = (host: string, port: number) => Promise<Duplex>;
const refusedConnection = Type.Object({ code: Type.Literal("ECONNREFUSED") });

/** The sole destination policy: an exact recorded loopback origin, or entirely public answers. */
export async function artifactNetworkDestinations(
    recordedUrl: string,
    requestedHost: string,
    port: number,
    resolve: Resolve,
): Promise<readonly string[] | undefined> {
    const recorded = new URL(recordedUrl);
    const recordedHost = recorded.hostname.replace(/^\[|\]$/g, "");
    const recordedPort = Number(recorded.port || (recorded.protocol === "https:" ? 443 : 80));
    if (requestedHost.toLowerCase() === recordedHost && port === recordedPort) {
        if (recordedHost === "localhost") return ["127.0.0.1", "::1"];
        if (artifactAddressLoopback(recordedHost)) return [recordedHost];
    }
    const host = artifactNetworkHost(requestedHost);
    const addresses = isIP(host) === 0 ? await resolve(host) : [host];
    if (addresses.length === 0 || !addresses.every(artifactAddressPublic)) return undefined;
    return addresses;
}

/** Resolve once, decide once, then pass only checked IP literals to the recorded network. */
export async function connectArtifactNetwork(
    recordedUrl: string,
    host: string,
    port: number,
    resolve: Resolve,
    connect: Connect,
): Promise<Duplex | undefined> {
    const addresses = await artifactNetworkDestinations(recordedUrl, host, port, resolve);
    if (addresses === undefined) return undefined;
    // WorkspaceProxy's one connection deadline wraps this whole sequence, not each attempt.
    const loopback = artifactAddressLoopback(addresses[0]!);
    let failure: unknown;
    for (const address of addresses) {
        try {
            return await connect(address, port);
        } catch (error) {
            if (loopback && !Value.Check(refusedConnection, error)) throw error;
            failure = error;
        }
    }
    throw failure;
}

/** Review text uses the same address classification, not a second network policy. */
export function describeArtifactNetworkExposure(url: string): string {
    const address = new URL(url);
    const host = artifactNetworkHost(address.hostname);
    const port = address.port || (address.protocol === "https:" ? "443" : "80");
    if (host === "localhost" || artifactAddressLoopback(host)) {
        return `This exposes ${address.hostname}:${port} on the agent's machine to the page.`;
    }
    if (isIP(host) !== 0 && !artifactAddressPublic(host)) {
        return `This URL names a non-public address; the artifact proxy will refuse it.`;
    }
    return "The artifact proxy permits only public destinations for this URL.";
}
