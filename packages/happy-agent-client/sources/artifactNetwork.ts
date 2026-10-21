/** Address policy shared by artifact browsers and daemon proxies. No DNS or platform APIs. */

function ipv4Bytes(address: string): number[] | undefined {
    if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/u.test(address)) return undefined;
    const bytes = address.split(".").map(Number);
    return bytes.every((byte) => byte <= 255) ? bytes : undefined;
}

function ipv6Bytes(address: string): number[] | undefined {
    let text = address;
    const zone = text.indexOf("%");
    if (zone >= 0) {
        if (!/^[0-9A-Za-z.:-]+$/u.test(text.slice(zone + 1))) return undefined;
        text = text.slice(0, zone);
    }
    if (!text.includes(":")) return undefined;
    if (text.includes(".")) {
        const start = text.lastIndexOf(":") + 1;
        const quad = ipv4Bytes(text.slice(start));
        if (quad === undefined) return undefined;
        text = `${text.slice(0, start)}${((quad[0]! << 8) | quad[1]!).toString(16)}:${((quad[2]! << 8) | quad[3]!).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return undefined;
    const groupsOf = (part: string | undefined) => (part ? part.split(":") : []);
    const head = groupsOf(halves[0]);
    const tail = groupsOf(halves[1]);
    const count = head.length + tail.length;
    if (halves.length === 2 ? count >= 8 : count !== 8) return undefined;
    if (![...head, ...tail].every((group) => /^[0-9a-fA-F]{1,4}$/u.test(group))) return undefined;
    return [
        ...head,
        ...Array<string>(halves.length === 2 ? 8 - count : 0).fill("0"),
        ...tail,
    ].flatMap((group) => {
        const value = Number.parseInt(group, 16);
        return [value >> 8, value & 255];
    });
}

function ipv4Public(bytes: readonly number[]): boolean {
    const [a, b, c] = bytes;
    return !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a! >= 224 ||
        (a === 100 && b! >= 64 && b! <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b! >= 16 && b! <= 31) ||
        (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)
    );
}

/** Mapped and RFC 6145 translated IPv4, excluding compatible and transition addresses. */
function ipv6Mapped(bytes: readonly number[]): number[] | undefined {
    const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
    if (zero(0, 10) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12);
    if (zero(0, 8) && bytes[8] === 255 && bytes[9] === 255 && zero(10, 12)) return bytes.slice(12);
    return undefined;
}

/** Whether an IP literal is allowed as a public artifact destination. Invalid literals are refused. */
export function artifactAddressPublic(address: string): boolean {
    const v4 = ipv4Bytes(address);
    if (v4 !== undefined) return ipv4Public(v4);
    const bytes = ipv6Bytes(address);
    if (bytes === undefined) return false;
    const nat64 =
        bytes[0] === 0 &&
        bytes[1] === 0x64 &&
        bytes[2] === 0xff &&
        bytes[3] === 0x9b &&
        bytes.slice(4, 12).every((byte) => byte === 0);
    const embedded = ipv6Mapped(bytes) ?? (nat64 ? bytes.slice(12) : undefined);
    if (embedded !== undefined) return ipv4Public(embedded);
    // Exclude 2001::/23, 2001:db8::/32, 2002::/16, and 3fff::/20 from 2000::/3.
    const reserved =
        (bytes[0] === 0x20 && bytes[1] === 1 && bytes[2]! < 2) ||
        (bytes[0] === 0x20 && bytes[1] === 1 && bytes[2] === 0x0d && bytes[3] === 0xb8) ||
        (bytes[0] === 0x20 && bytes[1] === 2) ||
        (bytes[0] === 0x3f && bytes[1] === 0xff && bytes[2]! < 0x10);
    return (bytes[0]! & 0xe0) === 0x20 && !reserved;
}

/** Only 127/8, ::1, and mapped/translated 127/8 qualify for an exact-origin loopback exception. */
export function artifactAddressLoopback(address: string): boolean {
    const v4 = ipv4Bytes(address);
    if (v4 !== undefined) return v4[0] === 127;
    const bytes = ipv6Bytes(address);
    if (bytes === undefined) return false;
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
    return ipv6Mapped(bytes)?.[0] === 127;
}

/** Normalize numeric host spellings for classification, never for loopback-origin equality. */
export function artifactNetworkHost(host: string): string {
    const authority = ipv6Bytes(host) === undefined ? host : `[${host}]`;
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "");
}
