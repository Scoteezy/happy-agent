import { Type, type Static, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ArtifactInputError } from "./Artifact.js";

const idSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[^\\s\\x00-\\x1f\\x7f]+$",
});
const switchSchema = Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")]));
const empty = Type.Object({}, { additionalProperties: false });
/** Where a foldable row's fold ribbon sits: shown on hover only, or always at the far right. */
const foldRibbonSchema = Type.Optional(Type.Union([Type.Literal("hover"), Type.Literal("always")]));

/**
 * The sidebar is its own state: one `<nav>` of custom elements, every one of them an item the
 * person can drag. Spaces nest the sessions under them, as deep as the work goes.
 */
const attributes: Record<string, TObject> = {
    nav: Type.Object({ "fold-ribbon": foldRibbonSchema }, { additionalProperties: false }),
    "happy-search": empty,
    "happy-create": empty,
    "happy-section": Type.Object(
        {
            id: idSchema,
            label: Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" }),
            collapsed: switchSchema,
        },
        { additionalProperties: false },
    ),
    "happy-separator": Type.Object({ id: idSchema }, { additionalProperties: false }),
    "happy-space": Type.Object(
        { id: idSchema, expanded: switchSchema, "fold-ribbon": foldRibbonSchema },
        { additionalProperties: false },
    ),
};
const children: Record<string, readonly string[]> = {
    nav: ["happy-search", "happy-create", "happy-section", "happy-separator", "happy-space"],
    "happy-search": [],
    "happy-create": [],
    "happy-section": [],
    "happy-separator": [],
    "happy-space": ["happy-space"],
};

/** The first experimental grammar, read only to migrate a document written in it. */
const legacyFlag = Type.Optional(Type.Literal(""));
const legacyPlain = Type.Object(
    { class: Type.Optional(Type.String({ maxLength: 256 })) },
    { additionalProperties: false },
);
const legacyAttributes: Record<string, TObject> = {
    nav: legacyPlain,
    div: legacyPlain,
    ul: legacyPlain,
    li: legacyPlain,
    p: legacyPlain,
    span: legacyPlain,
    strong: legacyPlain,
    em: legacyPlain,
    hr: legacyPlain,
    "happy-space": Type.Object(
        {
            ref: Type.String({ minLength: 1, maxLength: 128 }),
            tree: legacyFlag,
            collapsed: legacyFlag,
        },
        { additionalProperties: false },
    ),
    "happy-section": Type.Object(
        {
            id: idSchema,
            label: Type.String({ minLength: 1, maxLength: 256 }),
            collapsed: legacyFlag,
        },
        { additionalProperties: false },
    ),
};

export const sidebarDiagnosticSchema = Type.Object({
    message: Type.String(),
    offset: Type.Integer({ minimum: 0 }),
});
export type SidebarDiagnostic = Static<typeof sidebarDiagnosticSchema>;
export class SidebarValidationError extends ArtifactInputError {
    readonly diagnostics: SidebarDiagnostic[];
    constructor(message: string, offset = 0) {
        super(message);
        this.diagnostics = [{ message, offset }];
    }
}

/** Source ranges point back into the authored text for diagnostics. */
export interface SidebarNode {
    tag: string;
    attrs: Record<string, string>;
    start: number;
    end: number;
    parent: SidebarNode | undefined;
    children: SidebarNode[];
}

/**
 * Strict well-formed markup: only the sidebar's elements, quoted attributes, explicit or
 * self-closing ends, and no text, so an HTML parser and an XML parser read the same tree.
 */
export function parseSidebar(html: string): SidebarNode {
    const root = parseMarkup(html, false);
    const seen = new Set<string>();
    const singles = new Map<string, number>();
    for (const node of sidebarNodes(root)) {
        const id = node.attrs["id"];
        if (id !== undefined) {
            if (seen.has(id)) throw new SidebarValidationError(`Duplicate ID ${id}.`, node.start);
            seen.add(id);
        }
        if (node.tag === "happy-search" || node.tag === "happy-create")
            singles.set(node.tag, (singles.get(node.tag) ?? 0) + 1);
    }
    for (const tag of ["happy-search", "happy-create"])
        if (singles.get(tag) !== 1)
            throw new SidebarValidationError(`The sidebar needs exactly one ${tag}.`);
    return root;
}

/** The first grammar's `<nav>`, or undefined when the text is not one. */
export function parseLegacySidebar(html: string): SidebarNode | undefined {
    try {
        return parseMarkup(html, true);
    } catch (error: unknown) {
        if (error instanceof SidebarValidationError) return undefined;
        throw error;
    }
}

function parseMarkup(html: string, legacy: boolean): SidebarNode {
    if (Buffer.from(html, "utf8").toString("utf8") !== html || html.includes("\0"))
        throw new SidebarValidationError(
            "The sidebar must contain valid Unicode text without null characters.",
        );
    if (Buffer.byteLength(html, "utf8") > 128 * 1024)
        throw new SidebarValidationError("The sidebar exceeds 128 KiB.");
    const grammar = legacy ? legacyAttributes : attributes;
    const stack: SidebarNode[] = [];
    let root: SidebarNode | undefined;
    let count = 0;
    let at = 0;
    const fail: (message: string, offset?: number) => never = (message, offset = at) => {
        throw new SidebarValidationError(message, offset);
    };
    while (at < html.length) {
        if (html[at] !== "<") {
            const end = html.indexOf("<", at);
            const next = end < 0 ? html.length : end;
            if (html.slice(at, next).trim() && (!legacy || stack.length === 0))
                fail(legacy ? "Text must be inside nav." : "The sidebar holds elements, not text.");
            at = next;
            continue;
        }
        const start = at;
        const close = /^<\/([a-z][a-z0-9-]*)\s*>/.exec(html.slice(at));
        if (close !== null) {
            const node = stack.pop();
            if (node === undefined || node.tag !== close[1])
                fail("Closing element does not match the open element.");
            at += close[0].length;
            node.end = at;
            continue;
        }
        const open = /^<([a-z][a-z0-9-]*)\b/.exec(html.slice(at));
        if (open === null) fail("Expected an allowed element.");
        const tag = open[1]!;
        const schema = grammar[tag];
        if (schema === undefined) fail(`Element ${tag} is not allowed.`);
        at += open[0].length;
        const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
        while (at < html.length) {
            const whitespace = /^\s+/.exec(html.slice(at));
            if (whitespace !== null) at += whitespace[0].length;
            if (html[at] === ">" || html.slice(at, at + 2) === "/>") break;
            if (whitespace === null) fail("Attributes must be separated by whitespace.");
            const attr = (
                legacy
                    ? /^([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/
                    : /^([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/
            ).exec(html.slice(at));
            if (attr === null) fail("Attribute values must be quoted.");
            const key = attr[1]!;
            if (Object.hasOwn(attrs, key)) fail(`Duplicate attribute ${key}.`);
            attrs[key] = decodeEntities(attr[2] ?? attr[3] ?? "");
            at += attr[0].length;
        }
        if (!Value.Check(schema, attrs)) fail(`Invalid attributes on ${tag}.`, start);
        const selfClosing = html.slice(at, at + 2) === "/>";
        if (selfClosing && (legacy ? tag !== "hr" : tag === "nav"))
            fail(legacy ? "Only hr may be self-closing." : "The nav cannot be self-closing.");
        if (html[at] !== ">" && !selfClosing) fail("The opening element is incomplete.");
        at += selfClosing ? 2 : 1;
        const parent = stack.at(-1);
        if (tag === "nav" && (parent !== undefined || root !== undefined))
            fail("The sidebar needs exactly one nav root.", start);
        if (parent === undefined && tag !== "nav") fail("The sidebar needs a nav root.", start);
        if (!legacy && parent !== undefined && !children[parent.tag]!.includes(tag))
            fail(
                parent.tag === "happy-space"
                    ? "A happy-space may contain only happy-space elements."
                    : `A ${parent.tag} cannot contain ${tag}.`,
                start,
            );
        if (++count > 1000 || stack.length >= 16)
            fail("The sidebar exceeds 1,000 elements or depth 16.", start);
        const node: SidebarNode = { tag, attrs, start, end: at, parent, children: [] };
        if (parent === undefined) root = node;
        else parent.children.push(node);
        if (!selfClosing && !(legacy && tag === "hr")) stack.push(node);
    }
    if (stack.length > 0 || root === undefined)
        fail("The sidebar has unclosed elements or no nav root.");
    return root;
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
                return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
            }
            return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
                named!.toLowerCase() as "amp"
            ];
        },
    );
}

export function sidebarNodes(root: SidebarNode): SidebarNode[] {
    return [root, ...root.children.flatMap(sidebarNodes)];
}
export function escapeSidebarText(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

/** One element a line, two spaces a level, empty elements self-closed. */
export function formatSidebar(root: SidebarNode): string {
    const line = (node: SidebarNode, depth: number): string[] => {
        const indent = "  ".repeat(depth);
        const attrs = Object.entries(node.attrs)
            .map(([key, value]) => ` ${key}="${escapeSidebarText(value)}"`)
            .join("");
        if (node.children.length === 0 && node.tag !== "nav")
            return [`${indent}<${node.tag}${attrs}/>`];
        return [
            `${indent}<${node.tag}${attrs}>`,
            ...node.children.flatMap((child) => line(child, depth + 1)),
            `${indent}</${node.tag}>`,
        ];
    };
    return `${line(root, 0).join("\n")}\n`;
}

export const SIDEBAR_STYLES = {
    version: 2,
    elements: Object.fromEntries(
        Object.entries(attributes).map(([tag, schema]) => [
            tag,
            { attributes: schema.properties, children: children[tag] },
        ]),
    ),
    rules: [
        "nav is the one root and holds a flat ordered list of items.",
        "happy-search and happy-create appear exactly once each.",
        "A top-level happy-space id is a space ID; a nested happy-space id is a session (agent) ID whose parent is the enclosing happy-space.",
        'A happy-space draws its nested sessions only when expanded="true".',
        'A happy-section is a titled heading item; collapsed="true" folds the items after it up to the next happy-section or happy-separator. Its label names a subject, never age or whether work is finished.',
        "A happy-separator is a purely visual rule with no title; it cannot fold and it ends a section's run.",
        'A row\'s change count sits flush right. fold-ribbon on nav sets where foldable rows show their fold ribbon: "hover" (the default) only while pointed at, "always" at the far right with the change count to its left. A happy-space may override it for itself.',
        "Anything absent from the document is not shown.",
        "No text, classes, styles, scripts, or other elements.",
    ],
};
