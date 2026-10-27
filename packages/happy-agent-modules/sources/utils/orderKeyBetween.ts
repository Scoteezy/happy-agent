const ORDER_DIGITS = "0123456789";

/**
 * Existing catalog decimal fractional keys, compared lexicographically; null means either end.
 *
 * Between two keys this is the shortest key near their middle. At an open end it steps one unit
 * past the neighbour instead, so placing work first or last again and again grows keys with the
 * logarithm of the count rather than by a digit every few placements.
 */
export function orderKeyBetween(before: string | null, after: string | null): string {
    if (after === null) return before === null ? "5" : orderKeyJustAfter(before);
    if (before === null) return orderKeyJustBefore(null, after);
    // Trailing zeros do not change a key's value: nothing lies between `1` and `10`.
    if (trimOrderKey(before) >= trimOrderKey(after))
        throw new Error("Order keys are out of order.");
    return orderKeyMidpoint(before, after);
}

/**
 * The shortest key near the middle of two keys, or of a key and the end of the list. At the end
 * it leaves room after `before` that later steps can use, as for the first row after a fixed one.
 */
export function orderKeyMidpoint(before: string, after: string | null): string {
    const lower = before;
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const low = index < lower.length ? lower.charCodeAt(index) - 48 : 0;
        const high = after !== null && index < after.length ? after.charCodeAt(index) - 48 : 10;
        if (high - low > 1) return `${prefix}${ORDER_DIGITS[low + Math.floor((high - low) / 2)]!}`;
        if (high - low === 1)
            return `${prefix}${ORDER_DIGITS[low]!}${orderKeyAbove(lower.slice(index + 1))}`;
        prefix += ORDER_DIGITS[low]!;
    }
}

/**
 * A key between `before` and `after`, as close below `after` as possible, so the room left above
 * `before` stays large when new work keeps going right after a fixed row.
 *
 * Steps are taken at the narrowest power-of-two width that fits. A key read back keeps stepping
 * at the width it was made at, and the width only doubles once every key of that width is used.
 * Trailing zeros do not change a key's value, so bounds equal once they are trimmed, such as `1`
 * and `10`, have nothing between them.
 */
export function orderKeyJustBefore(before: string | null, after: string): string {
    const floor = trimOrderKey(before ?? "");
    const ceiling = trimOrderKey(after);
    if (floor >= ceiling) throw new Error("Order keys are out of order.");
    for (let width = 1; ; width *= 2) {
        const truncated = orderKeyDigits(ceiling, width);
        const value = ceiling.length > width ? truncated : truncated - 1n;
        const key = orderKeyFromDigits(value, width);
        if (value > 0n && key > floor) return key;
    }
}

/** A key after `before`, one step past it at the narrowest power-of-two width that fits. */
function orderKeyJustAfter(before: string): string {
    const floor = trimOrderKey(before);
    for (let width = 1; ; width *= 2) {
        const value = orderKeyDigits(floor, width) + 1n;
        if (value < 10n ** BigInt(width)) return orderKeyFromDigits(value, width);
    }
}

/** The key's first `width` digits as an integer, zero-padded when it is shorter. */
function orderKeyDigits(key: string, width: number): bigint {
    return BigInt(key.slice(0, width).padEnd(width, "0"));
}

function orderKeyFromDigits(value: bigint, width: number): string {
    return trimOrderKey(value.toString().padStart(width, "0"));
}

function trimOrderKey(key: string): string {
    return key.replace(/0+$/, "");
}

function orderKeyAbove(rest: string): string {
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const digit = index < rest.length ? rest.charCodeAt(index) - 48 : 0;
        if (digit < 9) return `${prefix}${ORDER_DIGITS[digit + Math.floor((10 - digit) / 2)]!}`;
        prefix += "9";
    }
}
