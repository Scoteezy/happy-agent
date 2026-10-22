/** How far a density may sit from an exact multiple of 72 DPI and still name that scale. */
const TOLERANCE = 0.02;
/** The scales a density may name: Retina 2× and 3×. */
const SCALES = [2, 3] as const;
const POINTS_PER_INCH = 72;
/** How far into a JPEG its density is looked for; it is always in the first segments. */
const MAX_JPEG_SCAN = 256 * 1024;

/**
 * The pixels-per-point scale a picture's own density says it was made at, such as 2 for a 144 DPI
 * macOS screenshot, or undefined for 1×, an unusual density, or none at all.
 *
 * PNG keeps its density in the `pHYs` chunk, JPEG in its JFIF header or EXIF resolution tags.
 * Both axes must agree, and only densities within 2% of 144 or 216 DPI count, so a 300 DPI scan or
 * a 72 DPI default never shrinks a picture.
 */
export function readImageScale(bytes: Uint8Array, mimeType: string): number | undefined {
    const density =
        mimeType === "image/png"
            ? pngDensity(bytes)
            : mimeType === "image/jpeg"
              ? jpegDensity(bytes)
              : undefined;
    if (density === undefined) return undefined;
    const [x, y] = density;
    if (!(x > 0 && y > 0) || Math.abs(x - y) > x * TOLERANCE) return undefined;
    const ratio = x / POINTS_PER_INCH;
    return SCALES.find((scale) => Math.abs(ratio - scale) <= scale * TOLERANCE);
}

/** Dots per inch on each axis, from the `pHYs` chunk when it is in metres. */
function pngDensity(bytes: Uint8Array): readonly [number, number] | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset + 8 <= bytes.byteLength) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (type === "IDAT" || type === "IEND") return undefined;
        if (type === "pHYs" && length === 9 && offset + 17 <= bytes.byteLength) {
            if (bytes[offset + 16] !== 1) return undefined;
            const perMetre = (index: number) => view.getUint32(offset + 8 + index * 4) * 0.0254;
            return [perMetre(0), perMetre(1)];
        }
        offset += 12 + length;
    }
    return undefined;
}

/** Dots per inch on each axis, from EXIF resolution tags or else the JFIF header. */
function jpegDensity(bytes: Uint8Array): readonly [number, number] | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return undefined;
    let jfif: readonly [number, number] | undefined;
    let offset = 2;
    const end = Math.min(bytes.byteLength, MAX_JPEG_SCAN);
    while (offset + 4 <= end) {
        const marker = view.getUint16(offset);
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
        const length = view.getUint16(offset + 2);
        const start = offset + 4;
        if (length < 2 || start + length - 2 > bytes.byteLength) break;
        const segment = bytes.subarray(start, start + length - 2);
        if (marker === 0xffe0 && ascii(segment, 0, 5) === "JFIF\0" && segment.byteLength >= 12) {
            const units = segment[7];
            const segmentView = new DataView(segment.buffer, segment.byteOffset);
            const factor = units === 1 ? 1 : units === 2 ? 2.54 : undefined;
            if (factor !== undefined) {
                jfif = [segmentView.getUint16(8) * factor, segmentView.getUint16(10) * factor];
            }
        } else if (marker === 0xffe1 && ascii(segment, 0, 6) === "Exif\0\0") {
            const exif = exifDensity(segment.subarray(6));
            if (exif !== undefined) return exif;
        }
        offset = start + length - 2;
    }
    return jfif;
}

/** XResolution and YResolution from a TIFF header's first directory, in dots per inch. */
function exifDensity(tiff: Uint8Array): readonly [number, number] | undefined {
    if (tiff.byteLength < 8) return undefined;
    const order = ascii(tiff, 0, 2);
    if (order !== "II" && order !== "MM") return undefined;
    const little = order === "II";
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const u16 = (at: number) => view.getUint16(at, little);
    const u32 = (at: number) => view.getUint32(at, little);
    const directory = u32(4);
    if (directory + 2 > tiff.byteLength) return undefined;
    const entries = u16(directory);
    let x: number | undefined;
    let y: number | undefined;
    let unit = 2;
    for (let index = 0; index < entries; index += 1) {
        const entry = directory + 2 + index * 12;
        if (entry + 12 > tiff.byteLength) return undefined;
        const tag = u16(entry);
        if (tag === 0x0128) unit = u16(entry + 8);
        if (tag === 0x011a || tag === 0x011b) {
            const at = u32(entry + 8);
            if (at + 8 > tiff.byteLength) return undefined;
            const denominator = u32(at + 4);
            const value = denominator === 0 ? undefined : u32(at) / denominator;
            if (tag === 0x011a) x = value;
            else y = value;
        }
    }
    const factor = unit === 2 ? 1 : unit === 3 ? 2.54 : undefined;
    if (x === undefined || y === undefined || factor === undefined) return undefined;
    return [x * factor, y * factor];
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(start, start + length));
}
