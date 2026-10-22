import type {
    MediaLayout,
    MediaLayoutNode,
    MediaLayoutStyle,
    MediaLayoutTag,
} from "@slopus/happy-agent-client";
import { html as htmlSpec, parse, type DefaultTreeAdapterTypes } from "parse5";

import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import { parseMediaLayoutStyle } from "./parseMediaLayoutStyle.js";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** The most layout HTML that is read, in UTF-16 code units; a longer layout is not used. */
export const MAX_MEDIA_LAYOUT_LENGTH = 32 * 1024;
const MAX_DEPTH = 12;
const MAX_NODES = 500;
const MAX_TEXT = 8000;
const MAX_ALT = 1000;

const ELEMENT_TAGS: Readonly<Record<string, MediaLayoutTag>> = {
    div: "div",
    section: "section",
    figure: "figure",
    figcaption: "figcaption",
    p: "p",
    span: "span",
    strong: "strong",
    em: "em",
    code: "code",
};
const BLOCK_TAGS: ReadonlySet<string> = new Set(["div", "section", "figure", "figcaption", "p"]);

/**
 * Tags left out together with everything inside them: they run code, load or embed something,
 * take input, or hold styling and metadata rather than content.
 */
const DROPPED_TAGS: ReadonlySet<string> = new Set([
    "applet",
    "area",
    "audio",
    "base",
    "button",
    "canvas",
    "dialog",
    "embed",
    "form",
    "frame",
    "frameset",
    "head",
    "iframe",
    "input",
    "link",
    "map",
    "math",
    "meta",
    "noscript",
    "object",
    "option",
    "portal",
    "script",
    "select",
    "slot",
    "source",
    "style",
    "svg",
    "template",
    "textarea",
    "title",
    "track",
    "video",
]);

/** What a layout became: the tree, when it was usable, and what was ignored or added. */
export interface ParsedMediaLayout {
    readonly layout: MediaLayout | undefined;
    /** Short descriptions of what was left out, such as `position on <div>`. */
    readonly ignored: readonly string[];
    /** The files the layout did not place, added after it in order. */
    readonly appended: readonly string[];
}

interface LayoutWalk {
    readonly filepaths: readonly string[];
    readonly placed: boolean[];
    readonly ignored: string[];
    nodes: number;
    text: number;
}

/**
 * Turn layout HTML an agent wrote for `present_files` into the typed tree a client renders.
 *
 * The HTML is parsed by parse5, a spec-compliant parser, so tags, attributes, and entities mean
 * what a browser would take them to mean, and malformed markup is repaired the way a browser
 * repairs it. The tree is then rebuilt from what the subset allows, and nothing fails: a tag the
 * subset lacks is unwrapped and its content kept, a tag that runs, loads, or embeds something is
 * left out with its content, other attributes and declarations are left out, and an image whose
 * `src` is not exactly one of `filepaths`, or names a file already placed, is left out. Files the
 * layout did not place are added after it. A layout that places none of the files is not used, so
 * the client's automatic layout applies. Everything left out is reported for the model.
 */
export function parseMediaLayout(source: string, filepaths: readonly string[]): ParsedMediaLayout {
    const unused = (reason: string): ParsedMediaLayout => ({
        layout: undefined,
        ignored: [reason],
        appended: [],
    });
    if (source.length > MAX_MEDIA_LAYOUT_LENGTH) {
        return unused(
            `the whole layout, which is longer than ${String(MAX_MEDIA_LAYOUT_LENGTH)} characters`,
        );
    }
    const document = parse(source);
    const walk: LayoutWalk = {
        filepaths,
        placed: filepaths.map(() => false),
        ignored: [],
        nodes: 0,
        text: 0,
    };
    for (const node of document.childNodes) {
        if (node.nodeName === "#comment") note(walk, "comments");
    }
    const html = document.childNodes.find(
        (node): node is Element => "tagName" in node && node.tagName === "html",
    );
    const body = html?.childNodes.find(
        (node): node is Element => "tagName" in node && node.tagName === "body",
    );
    for (const part of html?.childNodes ?? []) {
        if (part.nodeName === "#comment") note(walk, "comments");
        if ("tagName" in part && part.tagName === "head") {
            for (const child of part.childNodes) {
                if ("tagName" in child) note(walk, `<${child.tagName}> and its contents`);
            }
        }
    }
    const root = body === undefined ? [] : children(body.childNodes, false, 0, walk);
    if (!walk.placed.some(Boolean)) {
        return {
            layout: undefined,
            ignored: [...walk.ignored, "the whole layout, which placed none of the files"],
            appended: [],
        };
    }
    const appended: string[] = [];
    walk.placed.forEach((placed, index) => {
        if (placed) return;
        root.push({ type: "item", index });
        appended.push(filepaths[index]!);
    });
    return { layout: { type: "tree", root }, ignored: walk.ignored, appended };
}

function children(
    nodes: readonly ChildNode[],
    ignoresWhitespace: boolean,
    depth: number,
    walk: LayoutWalk,
): MediaLayoutNode[] {
    const converted: MediaLayoutNode[] = [];
    for (const node of nodes) convert(node, depth, walk, converted);
    return tidyWhitespace(converted, ignoresWhitespace);
}

function convert(node: ChildNode, depth: number, walk: LayoutWalk, into: MediaLayoutNode[]): void {
    if (node.nodeName === "#text" && "value" in node) {
        const text = node.value.replaceAll(/[\t\n\f\r ]+/gu, " ");
        const room = MAX_TEXT - walk.text;
        if (room <= 0 || !count(walk)) {
            note(walk, `text beyond ${String(MAX_TEXT)} characters`);
            return;
        }
        if (text.length > room) note(walk, `text beyond ${String(MAX_TEXT)} characters`);
        const kept = text.slice(0, room);
        walk.text += kept.length;
        into.push({ type: "text", text: kept });
        return;
    }
    if (node.nodeName === "#comment") {
        note(walk, "comments");
        return;
    }
    if (!("tagName" in node)) return;
    const element = node;
    const tag = element.tagName;
    if (element.namespaceURI !== htmlSpec.NS.HTML || DROPPED_TAGS.has(tag)) {
        note(walk, `<${tag}> and its contents`);
        return;
    }
    if (tag === "img") {
        const item = imageItem(element, walk);
        if (item !== undefined && count(walk)) into.push(item);
        return;
    }
    if (tag === "br") {
        attributes(element, [], walk);
        if (count(walk)) into.push({ type: "break" });
        return;
    }
    const elementTag = ELEMENT_TAGS[tag];
    if (elementTag === undefined || depth >= MAX_DEPTH) {
        if (elementTag === undefined) {
            if (tag !== "html" && tag !== "body") note(walk, `<${tag}> (its content is kept)`);
        } else {
            note(
                walk,
                `elements nested more than ${String(MAX_DEPTH)} deep (their content is kept)`,
            );
        }
        for (const child of element.childNodes) convert(child, depth, walk, into);
        return;
    }
    if (!count(walk)) return;
    const style = elementStyle(element, [], walk);
    const display = style?.display ?? "";
    const flowIgnoresWhitespace = /flex|grid/u.test(display);
    into.push({
        type: "element",
        tag: elementTag,
        ...(style === undefined ? {} : { style }),
        children: children(element.childNodes, flowIgnoresWhitespace, depth + 1, walk),
    });
}

function imageItem(element: Element, walk: LayoutWalk): MediaLayoutNode | undefined {
    const src = element.attrs.find((attribute) => attribute.name === "src")?.value;
    const index = src === undefined ? -1 : walk.filepaths.indexOf(src);
    if (src === undefined || index < 0) {
        note(
            walk,
            src === undefined
                ? "<img> without src"
                : `<img src=${quoteVisibleExact(shorten(src))}>, which is not one of filepaths`,
        );
        return undefined;
    }
    if (walk.placed[index] === true) {
        note(walk, `a second <img src=${quoteVisibleExact(shorten(src))}>`);
        return undefined;
    }
    walk.placed[index] = true;
    const style = elementStyle(element, ["src", "alt"], walk);
    const alt = element.attrs
        .find((attribute) => attribute.name === "alt")
        ?.value.replaceAll(/[\t\n\f\r ]+/gu, " ")
        .trim()
        .slice(0, Math.max(0, Math.min(MAX_ALT, MAX_TEXT - walk.text)));
    walk.text += alt?.length ?? 0;
    return {
        type: "item",
        index,
        ...(alt === undefined || alt === "" ? {} : { alt }),
        ...(style === undefined ? {} : { style }),
    };
}

/** The element's parsed style; every other attribute but `kept` is noted and left out. */
function elementStyle(
    element: Element,
    kept: readonly string[],
    walk: LayoutWalk,
): MediaLayoutStyle | undefined {
    attributes(element, ["style", ...kept], walk);
    const source = element.attrs.find((attribute) => attribute.name === "style")?.value;
    if (source === undefined) return undefined;
    const parsed = parseMediaLayoutStyle(source, element.tagName);
    for (const ignored of parsed.ignored) note(walk, ignored);
    return parsed.style;
}

function attributes(element: Element, kept: readonly string[], walk: LayoutWalk): void {
    for (const attribute of element.attrs) {
        if (kept.includes(attribute.name) && attribute.namespace === undefined) continue;
        note(walk, `the attribute ${shorten(attribute.name)} on <${element.tagName}>`);
    }
}

/**
 * Join neighbouring text, and drop whitespace that only separates blocks, starts or ends a list,
 * or sits between the items of a flex or grid container, where a browser would not show it.
 */
function tidyWhitespace(nodes: MediaLayoutNode[], ignoresWhitespace: boolean): MediaLayoutNode[] {
    const joined: MediaLayoutNode[] = [];
    for (const node of nodes) {
        const last = joined[joined.length - 1];
        if (node.type === "text" && last?.type === "text") {
            joined[joined.length - 1] = {
                type: "text",
                text: `${last.text}${node.text}`.replaceAll(/ {2,}/gu, " "),
            };
        } else {
            joined.push(node);
        }
    }
    return joined.filter((node, position) => {
        if (node.type !== "text") return true;
        if (node.text !== " ") return true;
        return !(
            ignoresWhitespace ||
            position === 0 ||
            position === joined.length - 1 ||
            isBlock(joined[position - 1]) ||
            isBlock(joined[position + 1])
        );
    });
}

function isBlock(node: MediaLayoutNode | undefined): boolean {
    return node?.type === "element" && BLOCK_TAGS.has(node.tag);
}

/** Count one more node, or say there is no room for it. */
function count(walk: LayoutWalk): boolean {
    if (walk.nodes >= MAX_NODES) {
        note(walk, `nodes beyond ${String(MAX_NODES)}`);
        return false;
    }
    walk.nodes += 1;
    return true;
}

function note(walk: LayoutWalk, ignored: string): void {
    if (!walk.ignored.includes(ignored)) walk.ignored.push(ignored);
}

function shorten(text: string): string {
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
