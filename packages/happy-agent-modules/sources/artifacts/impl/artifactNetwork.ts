import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    artifactAddressLoopback,
    artifactAddressPublic,
    artifactNetworkHost,
} from "@slopus/happy-agent-client";

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
