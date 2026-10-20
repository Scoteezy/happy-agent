/**
 * The CSS subset a media layout may use: the properties, and the grammar every value must match.
 *
 * Values travel as normalized CSS text, never as free text: the daemon emits only values this
 * grammar accepts, and a client checks each again with `mediaLayoutStyleValue` before using it.
 * The grammar admits lowercase keywords, non-negative numbers, the units `px`, `%`, `em`, `rem`,
 * and `fr`, and the functions `repeat`, `minmax`, and `fit-content`. Nothing it accepts can load a
 * resource, name a colour, or place anything outside the layout.
 */

import { type Static, Type } from "@sinclair/typebox";

type Component =
    | { readonly kind: "word"; readonly text: string }
    | { readonly kind: "slash" }
    | { readonly kind: "comma" }
    | { readonly kind: "function"; readonly name: string; readonly args: readonly Component[] };

type Grammar = (components: readonly Component[]) => boolean;

const FUNCTIONS = new Set(["repeat", "minmax", "fit-content"]);
const MAX_PX = 4000;
const MAX_EM = 100;
const MAX_FR = 100;
const MAX_GRID_LINE = 24;
const MAX_TRACKS = 24;

/** Split a value into words, slashes, commas, and the few functions the grammar knows. */
function parse(value: string): Component[] | undefined {
    if (!/^[a-z0-9 .,%()/+-]*$/u.test(value)) return undefined;
    let position = 0;
    const list = (depth: number): Component[] | undefined => {
        const components: Component[] = [];
        while (position < value.length) {
            const character = value[position]!;
            if (character === " ") {
                position += 1;
            } else if (character === "/") {
                components.push({ kind: "slash" });
                position += 1;
            } else if (character === ",") {
                components.push({ kind: "comma" });
                position += 1;
            } else if (character === ")") {
                if (depth === 0) return undefined;
                position += 1;
                return components;
            } else if (character === "(") {
                return undefined;
            } else {
                const word = /^[a-z0-9.%+-]+/u.exec(value.slice(position))![0];
                position += word.length;
                if (value[position] === "(") {
                    if (!FUNCTIONS.has(word) || depth >= 2) return undefined;
                    position += 1;
                    const args = list(depth + 1);
                    if (args === undefined) return undefined;
                    components.push({ kind: "function", name: word, args });
                } else {
                    components.push({ kind: "word", text: word });
                }
            }
        }
        return depth === 0 ? components : undefined;
    };
    return list(0);
}

function serialize(components: readonly Component[]): string {
    let text = "";
    for (const component of components) {
        if (component.kind === "comma") {
            text += ", ";
            continue;
        }
        if (text !== "" && !text.endsWith(", ")) text += " ";
        if (component.kind === "slash") text += "/";
        else if (component.kind === "word") text += component.text;
        else text += `${component.name}(${serialize(component.args)})`;
    }
    return text;
}

function words(components: readonly Component[]): string[] | undefined {
    const texts: string[] = [];
    for (const component of components) {
        if (component.kind !== "word") return undefined;
        texts.push(component.text);
    }
    return texts;
}

/** Split on commas, or on slashes, at the top level. */
function split(components: readonly Component[], kind: "comma" | "slash"): Component[][] {
    const parts: Component[][] = [[]];
    for (const component of components) {
        if (component.kind === kind) parts.push([]);
        else parts[parts.length - 1]!.push(component);
    }
    return parts;
}

function number(text: string): number | undefined {
    return /^(\d+(\.\d+)?|\.\d+)$/u.test(text) ? Number(text) : undefined;
}

function dimension(text: string): { readonly value: number; readonly unit: string } | undefined {
    const match = /^(\d+(?:\.\d+)?|\.\d+)(px|%|em|rem|fr)$/u.exec(text);
    return match === null ? undefined : { value: Number(match[1]), unit: match[2]! };
}

/** `0`, or a non-negative px, %, em, or rem length within bounds. */
function lengthPercentage(text: string): boolean {
    if (text === "0") return true;
    const found = dimension(text);
    if (found === undefined) return false;
    switch (found.unit) {
        case "px":
            return found.value <= MAX_PX;
        case "%":
            return found.value <= 100;
        case "em":
        case "rem":
            return found.value <= MAX_EM;
        default:
            return false;
    }
}

function keyword(...allowed: string[]): Grammar {
    const set = new Set(allowed);
    return (components) => {
        const texts = words(components);
        return texts !== undefined && texts.length > 0 && set.has(texts.join(" "));
    };
}

/** One to `most` words, each accepted by `accept`. */
function each(accept: (text: string) => boolean, most: number): Grammar {
    return (components) => {
        const texts = words(components);
        return (
            texts !== undefined && texts.length >= 1 && texts.length <= most && texts.every(accept)
        );
    };
}

/** One value, then optionally a second, as `place-*` and `flex-flow` take them. */
function pair(first: Grammar, second: Grammar): Grammar {
    return (components) => {
        if (first(components)) return true;
        // Keywords such as `first baseline` are two words, so try every split.
        for (let index = 1; index < components.length; index += 1) {
            if (first(components.slice(0, index)) && second(components.slice(index))) return true;
        }
        return false;
    };
}

function either(...grammars: Grammar[]): Grammar {
    return (components) => grammars.some((grammar) => grammar(components));
}

const sizeKeywords = ["auto", "min-content", "max-content", "fit-content"];
const size: Grammar = either(
    keyword(...sizeKeywords),
    (components) => each(lengthPercentage, 1)(components),
    (components) => fitContent(components),
);
const maxSize: Grammar = either(keyword("none"), size);

function fitContent(components: readonly Component[]): boolean {
    const [only] = components;
    if (components.length !== 1 || only?.kind !== "function" || only.name !== "fit-content") {
        return false;
    }
    return each(lengthPercentage, 1)(only.args);
}

const spacing: Grammar = each(lengthPercentage, 1);
const margin: Grammar = each((text) => text === "auto" || lengthPercentage(text), 1);

const contentPosition = ["normal", "start", "end", "center", "flex-start", "flex-end"];
const distribution = ["space-between", "space-around", "space-evenly", "stretch"];
const baseline = ["baseline", "first baseline", "last baseline"];
const selfPosition = ["self-start", "self-end"];

const justifyContent = keyword(...contentPosition, ...distribution, "left", "right");
const alignContent = keyword(...contentPosition, ...distribution, ...baseline);
const justifyItems = keyword(
    "normal",
    "stretch",
    "start",
    "end",
    "center",
    "flex-start",
    "flex-end",
    "left",
    "right",
    ...selfPosition,
    ...baseline,
);
const alignItems = keyword(
    "normal",
    "stretch",
    "start",
    "end",
    "center",
    "flex-start",
    "flex-end",
    ...selfPosition,
    ...baseline,
);
const justifySelf = either(keyword("auto"), justifyItems);
const alignSelf = either(keyword("auto"), alignItems);

/** A track breadth: a length, an `fr` share, or a content keyword. */
function trackBreadth(text: string, flexible: boolean): boolean {
    if (["auto", "min-content", "max-content"].includes(text)) return true;
    const found = dimension(text);
    if (flexible && found?.unit === "fr") return found.value > 0 && found.value <= MAX_FR;
    return lengthPercentage(text);
}

/** One track; returns how many tracks it is, or undefined when invalid. */
function trackSize(component: Component): number | undefined {
    if (component.kind === "word") return trackBreadth(component.text, true) ? 1 : undefined;
    if (component.kind !== "function") return undefined;
    if (component.name === "fit-content") return fitContent([component]) ? 1 : undefined;
    if (component.name !== "minmax") return undefined;
    const parts = split(component.args, "comma");
    const [min, max] = parts.map(words);
    return parts.length === 2 &&
        min?.length === 1 &&
        max?.length === 1 &&
        trackBreadth(min[0]!, false) &&
        trackBreadth(max[0]!, true)
        ? 1
        : undefined;
}

/** `none`, or up to 24 tracks, where `repeat(N | auto-fill | auto-fit, tracks…)` counts its tracks. */
const trackList: Grammar = (components) => {
    if (keyword("none")(components)) return true;
    if (components.length === 0) return false;
    let tracks = 0;
    for (const component of components) {
        if (component.kind === "function" && component.name === "repeat") {
            const parts = split(component.args, "comma");
            const count = words(parts[0] ?? []);
            if (parts.length !== 2 || count?.length !== 1) return false;
            const repeats =
                count[0] === "auto-fill" || count[0] === "auto-fit" ? 1 : Number(count[0]);
            if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_TRACKS) return false;
            const inner = parts[1]!;
            if (inner.length === 0) return false;
            for (const track of inner) {
                const counted = trackSize(track);
                if (counted === undefined) return false;
                tracks += counted * repeats;
            }
        } else {
            const counted = trackSize(component);
            if (counted === undefined) return false;
            tracks += counted;
        }
        if (tracks > MAX_TRACKS) return false;
    }
    return true;
};

const autoTracks: Grammar = (components) =>
    components.length >= 1 &&
    components.length <= MAX_TRACKS &&
    components.every((component) => trackSize(component) !== undefined);

/** `auto`, a line number from -24 to 24 other than 0, or `span N`. */
const gridLine: Grammar = (components) => {
    const texts = words(components);
    if (texts === undefined) return false;
    if (texts.length === 1) {
        if (texts[0] === "auto") return true;
        if (!/^-?\d+$/u.test(texts[0]!)) return false;
        const line = Number(texts[0]);
        return line !== 0 && Math.abs(line) <= MAX_GRID_LINE;
    }
    if (texts.length === 2 && texts[0] === "span" && /^\d+$/u.test(texts[1]!)) {
        const span = Number(texts[1]);
        return span >= 1 && span <= MAX_GRID_LINE;
    }
    return false;
};

const gridLines: Grammar = (components) => {
    const parts = split(components, "slash");
    return parts.length <= 2 && parts.every(gridLine);
};

const ratio: Grammar = (components) => {
    const parts = split(components, "slash");
    if (parts.length > 2) return false;
    const values = parts.map((part) => {
        const texts = words(part);
        return texts?.length === 1 ? number(texts[0]!) : undefined;
    });
    return values.every((value) => value !== undefined && value > 0 && value <= 10_000);
};

const aspectRatio: Grammar = (components) => {
    if (keyword("auto")(components)) return true;
    const [first] = components;
    if (first?.kind === "word" && first.text === "auto") return ratio(components.slice(1));
    const last = components[components.length - 1];
    if (last?.kind === "word" && last.text === "auto") return ratio(components.slice(0, -1));
    return ratio(components);
};

const flexFactor = (text: string) => {
    const value = number(text);
    return value !== undefined && value <= 100;
};

const flexBasis: Grammar = either(keyword("content"), size);

/** `none`, `auto`, a basis, or a grow factor followed by an optional shrink and basis. */
const flex: Grammar = (components) => {
    if (keyword("none", "auto")(components)) return true;
    const texts = words(components);
    if (texts !== undefined && texts.length >= 1 && texts.length <= 3 && flexFactor(texts[0]!)) {
        if (texts.length === 1) return true;
        if (texts.length === 2) {
            return flexFactor(texts[1]!) || flexBasis(components.slice(1));
        }
        return flexFactor(texts[1]!) && flexBasis(components.slice(2));
    }
    return flexBasis(components);
};

const position = ["left", "center", "right", "top", "bottom"];
const objectPosition = each((text) => position.includes(text) || lengthPercentage(text), 2);

const lineHeight: Grammar = either(keyword("normal"), (components) => {
    const texts = words(components);
    if (texts?.length !== 1) return false;
    const value = number(texts[0]!);
    if (value !== undefined) return value <= 10;
    return lengthPercentage(texts[0]!);
});

const fontWeight: Grammar = either(keyword("normal", "bold", "bolder", "lighter"), (components) => {
    const texts = words(components);
    if (texts?.length !== 1 || !/^\d+$/u.test(texts[0]!)) return false;
    const weight = Number(texts[0]);
    return weight >= 1 && weight <= 1000;
});

const borderRadius = each((text) => {
    if (text === "0") return true;
    const found = dimension(text);
    return found?.unit === "px" && found.value <= 999;
}, 4);

const overflow = keyword("visible", "hidden", "clip");

/**
 * Every property a layout may set: its CSS name, the key it is carried under, and its grammar.
 * Keys are the camelCase names a React style object uses. `tone` and `fontSize` are the two that
 * are not CSS: a theme text tone in place of a colour, and four named type steps.
 */
const PROPERTIES = {
    display: [
        "display",
        keyword(
            "block",
            "inline",
            "inline-block",
            "flex",
            "inline-flex",
            "grid",
            "inline-grid",
            "none",
        ),
    ],
    flexDirection: ["flex-direction", keyword("row", "row-reverse", "column", "column-reverse")],
    flexWrap: ["flex-wrap", keyword("nowrap", "wrap", "wrap-reverse")],
    flexFlow: [
        "flex-flow",
        pair(
            keyword(
                "row",
                "row-reverse",
                "column",
                "column-reverse",
                "nowrap",
                "wrap",
                "wrap-reverse",
            ),
            keyword("nowrap", "wrap", "wrap-reverse"),
        ),
    ],
    flex: ["flex", flex],
    flexGrow: ["flex-grow", each(flexFactor, 1)],
    flexShrink: ["flex-shrink", each(flexFactor, 1)],
    flexBasis: ["flex-basis", flexBasis],
    order: ["order", each((text) => /^-?\d+$/u.test(text) && Math.abs(Number(text)) <= 100, 1)],
    justifyContent: ["justify-content", justifyContent],
    alignContent: ["align-content", alignContent],
    placeContent: ["place-content", pair(alignContent, justifyContent)],
    justifyItems: ["justify-items", justifyItems],
    alignItems: ["align-items", alignItems],
    placeItems: ["place-items", pair(alignItems, justifyItems)],
    justifySelf: ["justify-self", justifySelf],
    alignSelf: ["align-self", alignSelf],
    placeSelf: ["place-self", pair(alignSelf, justifySelf)],
    gap: ["gap", each((text) => text === "normal" || lengthPercentage(text), 2)],
    rowGap: ["row-gap", each((text) => text === "normal" || lengthPercentage(text), 1)],
    columnGap: ["column-gap", each((text) => text === "normal" || lengthPercentage(text), 1)],
    gridTemplateColumns: ["grid-template-columns", trackList],
    gridTemplateRows: ["grid-template-rows", trackList],
    gridAutoColumns: ["grid-auto-columns", autoTracks],
    gridAutoRows: ["grid-auto-rows", autoTracks],
    gridAutoFlow: [
        "grid-auto-flow",
        keyword("row", "column", "dense", "row dense", "column dense", "dense row", "dense column"),
    ],
    gridColumn: ["grid-column", gridLines],
    gridRow: ["grid-row", gridLines],
    gridColumnStart: ["grid-column-start", gridLine],
    gridColumnEnd: ["grid-column-end", gridLine],
    gridRowStart: ["grid-row-start", gridLine],
    gridRowEnd: ["grid-row-end", gridLine],
    width: ["width", size],
    height: ["height", size],
    minWidth: ["min-width", size],
    minHeight: ["min-height", size],
    maxWidth: ["max-width", maxSize],
    maxHeight: ["max-height", maxSize],
    aspectRatio: ["aspect-ratio", aspectRatio],
    boxSizing: ["box-sizing", keyword("content-box", "border-box")],
    padding: ["padding", each(lengthPercentage, 4)],
    paddingTop: ["padding-top", spacing],
    paddingRight: ["padding-right", spacing],
    paddingBottom: ["padding-bottom", spacing],
    paddingLeft: ["padding-left", spacing],
    margin: ["margin", each((text) => text === "auto" || lengthPercentage(text), 4)],
    marginTop: ["margin-top", margin],
    marginRight: ["margin-right", margin],
    marginBottom: ["margin-bottom", margin],
    marginLeft: ["margin-left", margin],
    borderRadius: ["border-radius", borderRadius],
    overflow: ["overflow", pair(overflow, overflow)],
    overflowX: ["overflow-x", overflow],
    overflowY: ["overflow-y", overflow],
    objectFit: ["object-fit", keyword("fill", "contain", "cover", "none", "scale-down")],
    objectPosition: ["object-position", objectPosition],
    verticalAlign: [
        "vertical-align",
        keyword("baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super"),
    ],
    textAlign: ["text-align", keyword("left", "right", "center", "justify", "start", "end")],
    fontWeight: ["font-weight", fontWeight],
    fontStyle: ["font-style", keyword("normal", "italic", "oblique")],
    fontSize: ["font-size", keyword("small", "normal", "large", "title")],
    lineHeight: ["line-height", lineHeight],
    tone: ["tone", keyword("default", "muted", "accent")],
} as const satisfies Record<string, readonly [string, Grammar]>;

/** A key of `MediaLayoutStyle`. */
export type MediaLayoutStyleKey = keyof typeof PROPERTIES;

const STYLE_VALUE = Type.Optional(Type.String({ minLength: 1, maxLength: 512 }));

/**
 * Layout styling the daemon parsed from an agent's CSS: camelCase keys of the allowed subset,
 * each a normalized value `mediaLayoutStyleValue` accepts. Clients ignore keys they do not know
 * and drop any value the check refuses.
 */
export const mediaLayoutStyleSchema = Type.Object(
    Object.fromEntries(Object.keys(PROPERTIES).map((key) => [key, STYLE_VALUE])) as {
        [Key in MediaLayoutStyleKey]: typeof STYLE_VALUE;
    },
);

/** Layout styling the daemon parsed from an agent's CSS. */
export type MediaLayoutStyle = Static<typeof mediaLayoutStyleSchema>;

/** The key a CSS property name is carried under, or undefined when the subset lacks it. */
export function mediaLayoutStyleKey(property: string): MediaLayoutStyleKey | undefined {
    const name = property.trim().toLowerCase();
    for (const [key, [cssName]] of Object.entries(PROPERTIES)) {
        if (cssName === name) return key as MediaLayoutStyleKey;
    }
    return undefined;
}

/** The CSS property name a key stands for; `tone` is not CSS and names itself. */
export function mediaLayoutStyleProperty(key: MediaLayoutStyleKey): string {
    return PROPERTIES[key][0];
}

/**
 * The normalized form of one value, or undefined when it is outside the grammar of `key`.
 * Normalizing lowercases the value and spaces it canonically, so a value the daemon emits is
 * returned unchanged.
 */
export function mediaLayoutStyleValue(key: string, value: string): string | undefined {
    if (!Object.hasOwn(PROPERTIES, key) || value.length > 512) return undefined;
    const components = parse(value.trim().toLowerCase().replaceAll(/\s+/gu, " "));
    if (components === undefined || components.length === 0) return undefined;
    const [, grammar] = PROPERTIES[key as MediaLayoutStyleKey];
    return grammar(components) ? serialize(components) : undefined;
}
