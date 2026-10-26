/**
 * The sidebar document: one `<nav>` of custom elements, every one of them an item the person can
 * drag, parsed into a typed tree and written back in one canonical form. The daemon and every
 * client use this one parser and serializer, so they read the same skeleton from the same text.
 *
 * The skeleton is strict well-formed markup — only the sidebar's elements, quoted attributes,
 * explicit or self-closing ends, and no text — so an HTML parser and an XML parser read the same
 * tree. A widget's content is the one exception: arbitrary HTML, kept verbatim and never
 * interpreted.
 */

import { type TObject, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    spaceSidebarFoldRibbonSchema,
    spaceSidebarIdSchema,
    spaceSidebarLabelSchema,
    spaceSidebarSeparatorPinSchema,
    type SidebarDiagnostic,
    type SpaceSidebarDocument,
    type SpaceSidebarItem,
    type SpaceSidebarSpaceNode,
} from "./protocol/spaces.js";

/** The bounds every document stays within, as the daemon enforces them. */
export const SPACE_SIDEBAR_LIMITS = {
    /** The whole document, in UTF-8 bytes. */
    bytes: 128 * 1024,
    /** Elements, `nav` included. */
    elements: 1000,
    /** Element nesting, `nav` included. */
    depth: 16,
    /** One widget's content, in UTF-8 bytes. */
    widgetBytes: 16 * 1024,
} as const;

/** The IDs of the nodes named by their tags; no other node may use them. */
export const SPACE_SIDEBAR_RESERVED_IDS: readonly string[] = [
    "nav",
    "happy-search",
    "happy-create",
];

/** Why a document or an operation was refused, with where in the text it went wrong. */
export class SpaceSidebarError extends Error {
    readonly diagnostics: SidebarDiagnostic[];

    constructor(message: string, offset = 0) {
        super(message);
        this.name = "SpaceSidebarError";
        this.diagnostics = [{ message, offset }];
    }
}

const switchSchema = Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")]));
const empty = Type.Object({}, { additionalProperties: false });
const foldRibbonAttribute = Type.Optional(spaceSidebarFoldRibbonSchema);
const ATTRIBUTES: Record<string, TObject> = {
    nav: Type.Object({ "fold-ribbon": foldRibbonAttribute }, { additionalProperties: false }),
    "happy-search": empty,
    "happy-create": empty,
    "happy-section": Type.Object(
        { id: spaceSidebarIdSchema, label: spaceSidebarLabelSchema, collapsed: switchSchema },
        { additionalProperties: false },
    ),
    "happy-separator": Type.Object(
        { id: spaceSidebarIdSchema, pin: Type.Optional(spaceSidebarSeparatorPinSchema) },
        { additionalProperties: false },
    ),
    "happy-space": Type.Object(
        { id: spaceSidebarIdSchema, expanded: switchSchema, "fold-ribbon": foldRibbonAttribute },
        { additionalProperties: false },
    ),
    "happy-widget": Type.Object({ id: spaceSidebarIdSchema }, { additionalProperties: false }),
};
const CHILDREN: Record<string, readonly string[]> = {
    nav: [
        "happy-search",
        "happy-create",
        "happy-section",
        "happy-separator",
        "happy-space",
        "happy-widget",
    ],
    "happy-search": [],
    "happy-create": [],
    "happy-section": [],
    "happy-separator": [],
    "happy-space": ["happy-space"],
    "happy-widget": [],
};
const WIDGET_CLOSE = "</happy-widget";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface Element {
    tag: string;
    attrs: Record<string, string>;
    start: number;
    children: Element[];
    /** A widget's verbatim content. */
    content: string;
}

/** Parses and validates a whole document; throws `SpaceSidebarError` with a diagnostic. */
export function parseSpaceSidebar(html: string): SpaceSidebarDocument {
    if (html.includes("\0") || LONE_SURROGATE.test(html))
        throw new SpaceSidebarError(
            "The sidebar must contain valid Unicode text without null characters.",
        );
    if (utf8Length(html) > SPACE_SIDEBAR_LIMITS.bytes)
        throw new SpaceSidebarError("The sidebar exceeds 128 KiB.");
    const stack: Element[] = [];
    let root: Element | undefined;
    let count = 0;
    let at = 0;
    const fail: (message: string, offset?: number) => never = (message, offset = at) => {
        throw new SpaceSidebarError(message, offset);
    };
    // Sticky patterns match exactly at `at`, so the text is never copied while it is read.
    const match = (pattern: RegExp): RegExpExecArray | null => {
        pattern.lastIndex = at;
        return pattern.exec(html);
    };
    const CLOSE = /<\/([a-z][a-z0-9-]*)\s*>/y;
    const OPEN = /<([a-z][a-z0-9-]*)\b/y;
    const WHITESPACE = /\s+/y;
    const ATTRIBUTE = /([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    const WIDGET_END = /<\/happy-widget\s*>/y;
    while (at < html.length) {
        if (html[at] !== "<") {
            const end = html.indexOf("<", at);
            const next = end < 0 ? html.length : end;
            if (html.slice(at, next).trim()) fail("The sidebar holds elements, not text.");
            at = next;
            continue;
        }
        const start = at;
        const close = match(CLOSE);
        if (close !== null) {
            const node = stack.pop();
            if (node === undefined || node.tag !== close[1])
                fail("Closing element does not match the open element.");
            at += close[0].length;
            continue;
        }
        const open = match(OPEN);
        if (open === null) fail("Expected an allowed element.");
        const tag = open[1]!;
        const schema = ATTRIBUTES[tag];
        if (schema === undefined) fail(`Element ${tag} is not allowed.`);
        at += open[0].length;
        const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
        while (at < html.length) {
            const whitespace = match(WHITESPACE);
            if (whitespace !== null) at += whitespace[0].length;
            if (html[at] === ">" || html.startsWith("/>", at)) break;
            if (whitespace === null) fail("Attributes must be separated by whitespace.");
            const attr = match(ATTRIBUTE);
            if (attr === null) fail("Attribute values must be quoted.");
            const key = attr[1]!;
            if (Object.hasOwn(attrs, key)) fail(`Duplicate attribute ${key}.`);
            attrs[key] = decodeEntities(attr[2] ?? attr[3] ?? "");
            at += attr[0].length;
        }
        if (!Value.Check(schema, { ...attrs })) fail(`Invalid attributes on ${tag}.`, start);
        const selfClosing = html.startsWith("/>", at);
        if (selfClosing && tag === "nav") fail("The nav cannot be self-closing.");
        if (html[at] !== ">" && !selfClosing) fail("The opening element is incomplete.");
        at += selfClosing ? 2 : 1;
        const parent = stack.at(-1);
        if (tag === "nav" && (parent !== undefined || root !== undefined))
            fail("The sidebar needs exactly one nav root.", start);
        if (parent === undefined && tag !== "nav") fail("The sidebar needs a nav root.", start);
        if (parent !== undefined && !CHILDREN[parent.tag]!.includes(tag))
            fail(
                parent.tag === "happy-space"
                    ? "A happy-space may contain only happy-space elements."
                    : `A ${parent.tag} cannot contain ${tag}.`,
                start,
            );
        if (++count > SPACE_SIDEBAR_LIMITS.elements || stack.length >= SPACE_SIDEBAR_LIMITS.depth)
            fail("The sidebar exceeds 1,000 elements or depth 16.", start);
        const node: Element = { tag, attrs, start, children: [], content: "" };
        if (parent === undefined) root = node;
        else parent.children.push(node);
        if (tag === "happy-widget" && !selfClosing) {
            // A widget's content runs verbatim to its closing tag, which it may never contain.
            const search = new RegExp(WIDGET_CLOSE, "gi");
            search.lastIndex = at;
            const end = search.exec(html)?.index ?? -1;
            const contentStart = at;
            at = end < 0 ? start : end;
            const closing = end < 0 ? null : match(WIDGET_END);
            if (closing === null)
                fail(
                    `A widget's content may not contain ${WIDGET_CLOSE} other than its own closing tag.`,
                );
            node.content = html.slice(contentStart, end);
            widgetCheck(node.content, contentStart);
            at = end + closing[0].length;
            continue;
        }
        if (!selfClosing) stack.push(node);
    }
    if (stack.length > 0 || root === undefined)
        fail("The sidebar has unclosed elements or no nav root.");
    return documentOf(root);
}

/** Checks a widget's content, as parsing and every operation do. */
export function widgetCheck(html: string, offset = 0): void {
    if (html.includes("\0") || LONE_SURROGATE.test(html))
        throw new SpaceSidebarError(
            "A widget must contain valid Unicode text without null characters.",
            offset,
        );
    if (utf8Length(html) > SPACE_SIDEBAR_LIMITS.widgetBytes)
        throw new SpaceSidebarError("A widget's content exceeds 16 KiB.", offset);
    if (new RegExp(WIDGET_CLOSE, "i").test(html))
        throw new SpaceSidebarError(`A widget's content may not contain ${WIDGET_CLOSE}.`, offset);
}

function documentOf(root: Element): SpaceSidebarDocument {
    const seen = new Set<string>(SPACE_SIDEBAR_RESERVED_IDS);
    const singles = { "happy-search": 0, "happy-create": 0 };
    const identify = (node: Element): string => {
        const id = node.attrs["id"]!;
        if (seen.has(id))
            throw new SpaceSidebarError(
                SPACE_SIDEBAR_RESERVED_IDS.includes(id)
                    ? `The ID ${id} is reserved.`
                    : `Duplicate ID ${id}.`,
                node.start,
            );
        seen.add(id);
        return id;
    };
    const space = (node: Element): SpaceSidebarSpaceNode => {
        const foldRibbon = node.attrs["fold-ribbon"];
        return {
            type: "space",
            id: identify(node),
            expanded: node.attrs["expanded"] === "true",
            ...(foldRibbon === "hover" || foldRibbon === "always" ? { foldRibbon } : {}),
            children: node.children.map(space),
        };
    };
    const items = root.children.map((node): SpaceSidebarItem => {
        switch (node.tag) {
            case "happy-search":
            case "happy-create":
                singles[node.tag]++;
                return node.tag === "happy-search"
                    ? { type: "search", id: "happy-search" }
                    : { type: "create", id: "happy-create" };
            case "happy-section":
                return {
                    type: "section",
                    id: identify(node),
                    label: node.attrs["label"]!,
                    collapsed: node.attrs["collapsed"] === "true",
                };
            case "happy-separator": {
                const pin = node.attrs["pin"];
                return {
                    type: "separator",
                    id: identify(node),
                    ...(pin === "top" || pin === "bottom" ? { pin } : {}),
                };
            }
            case "happy-widget":
                return { type: "widget", id: identify(node), html: node.content };
            default:
                return space(node);
        }
    });
    for (const tag of ["happy-search", "happy-create"] as const)
        if (singles[tag] !== 1)
            throw new SpaceSidebarError(`The sidebar needs exactly one ${tag}.`);
    const foldRibbon = root.attrs["fold-ribbon"];
    return {
        ...(foldRibbon === "hover" || foldRibbon === "always" ? { foldRibbon } : {}),
        items,
    };
}

function decodeEntities(value: string): string {
    return value.replace(
        /&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos));/gi,
        (_match, numeric: string | undefined, named: string | undefined) => {
            if (numeric !== undefined) {
                const code =
                    numeric[0]?.toLowerCase() === "x"
                        ? Number.parseInt(numeric.slice(1), 16)
                        : Number.parseInt(numeric, 10);
                // A surrogate on its own would not survive the next read, so it decodes like any
                // other unusable code point.
                return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
                    ? String.fromCodePoint(code)
                    : "\ufffd";
            }
            return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
                named!.toLowerCase() as "amp"
            ];
        },
    );
}

function escapeAttribute(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

/**
 * The canonical text: one element a line, two spaces a level, attributes in grammar order, false
 * switches and defaults left out, empty elements self-closed, widget content verbatim. With
 * `widgets: false` widgets are left out, for clients that predate them.
 */
export function formatSpaceSidebar(
    document: SpaceSidebarDocument,
    options: { readonly widgets?: boolean } = {},
): string {
    const attribute = (name: string, value: string) => ` ${name}="${escapeAttribute(value)}"`;
    const ribbon = (value: string | undefined) =>
        value === undefined ? "" : attribute("fold-ribbon", value);
    const space = (node: SpaceSidebarSpaceNode, indent: string): string => {
        const open = `${indent}<happy-space${attribute("id", node.id)}${
            node.expanded ? attribute("expanded", "true") : ""
        }${ribbon(node.foldRibbon)}`;
        if (node.children.length === 0) return `${open}/>\n`;
        return `${open}>\n${node.children
            .map((child) => space(child, `${indent}  `))
            .join("")}${indent}</happy-space>\n`;
    };
    const item = (node: SpaceSidebarItem): string => {
        switch (node.type) {
            case "search":
                return "  <happy-search/>\n";
            case "create":
                return "  <happy-create/>\n";
            case "section":
                return `  <happy-section${attribute("id", node.id)}${attribute("label", node.label)}${
                    node.collapsed ? attribute("collapsed", "true") : ""
                }/>\n`;
            case "separator":
                return `  <happy-separator${attribute("id", node.id)}${
                    node.pin === undefined ? "" : attribute("pin", node.pin)
                }/>\n`;
            case "widget":
                if (options.widgets === false) return "";
                return node.html === ""
                    ? `  <happy-widget${attribute("id", node.id)}/>\n`
                    : `  <happy-widget${attribute("id", node.id)}>${node.html}</happy-widget>\n`;
            case "space":
                return space(node, "  ");
        }
    };
    return `<nav${ribbon(document.foldRibbon)}>\n${document.items.map(item).join("")}</nav>\n`;
}

/** UTF-8 length without allocating the encoding. */
export function utf8Length(text: string): number {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
            bytes += 4;
            index++;
        } else bytes += 3;
    }
    return bytes;
}
