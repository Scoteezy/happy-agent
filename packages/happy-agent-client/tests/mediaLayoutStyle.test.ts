import { describe, expect, it } from "vitest";

import {
    mediaLayoutStyleKey,
    mediaLayoutStyleProperty,
    mediaLayoutStyleValue,
} from "../sources/protocol/mediaLayoutStyle.js";

describe("media layout style grammar", () => {
    it("maps CSS property names to their keys and back", () => {
        expect(mediaLayoutStyleKey("Grid-Template-Columns")).toBe("gridTemplateColumns");
        expect(mediaLayoutStyleKey("tone")).toBe("tone");
        expect(mediaLayoutStyleKey("position")).toBeUndefined();
        expect(mediaLayoutStyleKey("color")).toBeUndefined();
        expect(mediaLayoutStyleProperty("objectPosition")).toBe("object-position");
    });

    it.each([
        ["display", "Inline-Block", "inline-block"],
        ["display", "none", "none"],
        ["width", "AUTO", "auto"],
        ["width", "fit-content", "fit-content"],
        ["width", "fit-content( 300PX )", "fit-content(300px)"],
        ["maxWidth", "none", "none"],
        ["height", "12.5rem", "12.5rem"],
        ["aspectRatio", "16/9", "16 / 9"],
        ["aspectRatio", "auto 4 / 3", "auto 4 / 3"],
        ["aspectRatio", "auto", "auto"],
        ["objectFit", "scale-down", "scale-down"],
        ["objectPosition", "right 20%", "right 20%"],
        [
            "gridTemplateColumns",
            "repeat( auto-fill ,minmax(200px,1fr) )",
            "repeat(auto-fill, minmax(200px, 1fr))",
        ],
        ["gridTemplateColumns", "2fr 1fr auto 120px", "2fr 1fr auto 120px"],
        ["gridTemplateRows", "repeat(2, min-content)", "repeat(2, min-content)"],
        ["gridColumn", "1 / -1", "1 / -1"],
        ["gridColumn", "span 2", "span 2"],
        ["gridRow", "2 / span 3", "2 / span 3"],
        ["justifyContent", "flex-start", "flex-start"],
        ["alignItems", "last baseline", "last baseline"],
        ["placeItems", "center start", "center start"],
        ["placeContent", "space-between", "space-between"],
        ["flex", "1", "1"],
        ["flex", "1 0 200px", "1 0 200px"],
        ["flex", "none", "none"],
        ["flexFlow", "column wrap", "column wrap"],
        ["margin", "0 auto", "0 auto"],
        ["padding", "4px 8px 12px 16px", "4px 8px 12px 16px"],
        ["borderRadius", "8px", "8px"],
        ["gap", "8px 12px", "8px 12px"],
        ["textAlign", "justify", "justify"],
        ["fontWeight", "600", "600"],
        ["lineHeight", "1.4", "1.4"],
        ["lineHeight", "20px", "20px"],
        ["overflow", "hidden", "hidden"],
        ["tone", "muted", "muted"],
        ["fontSize", "title", "title"],
    ])("accepts %s: %s", (key, value, normalized) => {
        expect(mediaLayoutStyleValue(key, value)).toBe(normalized);
        // A normalized value checks again unchanged, as a client re-validates it.
        expect(mediaLayoutStyleValue(key, normalized)).toBe(normalized);
    });

    it.each([
        ["width", "url(x.png)"],
        ["width", "URL(x)"],
        ["width", "image-set(x 1x)"],
        ["width", "calc(100% - 2px)"],
        ["width", "var(--w)"],
        ["width", "u\\72l(x)"],
        ["width", "100% !important"],
        ["width", "red"],
        ["width", "50vw"],
        ["width", "-10px"],
        ["width", "101%"],
        ["width", "5000px"],
        ["objectFit", "auto"],
        ["display", "contents"],
        ["display", "table"],
        ["margin", "-4px"],
        ["margin", "1px 2px 3px 4px 5px"],
        ["padding", "auto"],
        ["gridTemplateColumns", "repeat(25, 1fr)"],
        ["gridTemplateColumns", "repeat(3, repeat(2, 1fr))"],
        ["gridTemplateColumns", "minmax(1fr, 2fr)"],
        ["gridTemplateColumns", "[a] 1fr"],
        ["gridColumn", "0"],
        ["gridColumn", "1 / 2 / 3"],
        ["gridColumn", "span 0"],
        ["fontWeight", "1001"],
        ["fontSize", "40px"],
        ["tone", "#ff0000"],
        ["borderRadius", "50%"],
        ["overflow", "scroll"],
        ["lineHeight", "-1"],
        ["aspectRatio", "0 / 1"],
        ["display", "block;position:fixed"],
        ["display", "'block'"],
        ["position", "relative"],
        ["constructor", "x"],
    ])("refuses %s: %s", (key, value) => {
        expect(mediaLayoutStyleValue(key, value)).toBeUndefined();
    });
});
