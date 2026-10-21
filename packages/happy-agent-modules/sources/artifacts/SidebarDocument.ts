import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ArtifactInputError } from "./Artifact.js";

const classSchema = Type.Optional(
    Type.String({ pattern: "^(?:note|muted|divider)(?: (?:note|muted|divider))*$" }),
);
const flag = Type.Optional(Type.Literal(""));
const plain = Type.Object({ class: classSchema }, { additionalProperties: false });
const attributes = {
    nav: plain,
    div: plain,
    ul: plain,
    li: plain,
    p: plain,
    span: plain,
    strong: plain,
    em: plain,
    hr: plain,
    "happy-space": Type.Object(
        { ref: Type.String({ minLength: 1, maxLength: 128 }), tree: flag, collapsed: flag },
        { additionalProperties: false },
    ),
    "happy-section": Type.Object(
        {
            id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\s\\x00-\\x1f\\x7f]+$" }),
            label: Type.String({ minLength: 1, maxLength: 256 }),
            collapsed: flag,
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

/** Source ranges retain the authored tree and whitespace during lifecycle edits. */
export interface SidebarNode {
    tag: string;
    attrs: Record<string, string>;
    start: number;
    openEnd: number;
    closeStart: number;
    end: number;
    parent: SidebarNode | undefined;
    children: SidebarNode[];
}

/** Strict HTML subset: no recovery, executable content, URLs, or resource loads. */
export function parseSidebar(html: string, knownRefs?: ReadonlySet<string>): SidebarNode {
    if (Buffer.from(html, "utf8").toString("utf8") !== html || html.includes("\0"))
        throw new SidebarValidationError(
            "The sidebar must contain valid Unicode text without null characters.",
        );
    if (Buffer.byteLength(html, "utf8") > 128 * 1024)
        throw new SidebarValidationError("The sidebar exceeds 128 KiB.");
    const stack: SidebarNode[] = [];
    const refs = new Set<string>();
    const ids = new Set<string>();
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
            if (stack.length === 0 && html.slice(at, next).trim()) fail("Text must be inside nav.");
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
            node.closeStart = start;
            node.end = at;
            continue;
        }
        const open = /^<([a-z][a-z0-9-]*)\b/.exec(html.slice(at));
        if (open === null) fail("Expected an allowed HTML element.");
        const tag = open[1]!;
        const schema = attributes[tag as keyof typeof attributes];
        if (schema === undefined) fail(`Element ${tag} is not allowed.`);
        at += open[0].length;
        const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
        while (at < html.length) {
            const whitespace = /^\s+/.exec(html.slice(at));
            if (whitespace !== null) at += whitespace[0].length;
            if (html[at] === ">" || html.slice(at, at + 2) === "/>") break;
            if (whitespace === null) fail("Attributes must be separated by whitespace.");
            const attr = /^([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/.exec(
                html.slice(at),
            );
            if (attr === null) fail("Attribute values must be quoted.");
            const key = attr[1]!;
            if (Object.hasOwn(attrs, key)) fail(`Duplicate attribute ${key}.`);
            attrs[key] = decodeEntities(attr[2] ?? attr[3] ?? "");
            at += attr[0].length;
        }
        const valid: boolean = Value.Check(schema, attrs);
        if (!valid) fail(`Invalid attributes on ${tag}.`, start);
        const selfClosing = html.slice(at, at + 2) === "/>";
        if (selfClosing && tag !== "hr") fail("Only hr may be self-closing.");
        if (html[at] !== ">" && !selfClosing) fail("The opening element is incomplete.");
        at += selfClosing ? 2 : 1;
        const parent = stack.at(-1);
        if (tag === "nav" && (parent !== undefined || root !== undefined))
            fail("The sidebar needs exactly one nav root.", start);
        if (parent === undefined && tag !== "nav") fail("The sidebar needs a nav root.", start);
        // Avoid HTML parser repair changing the tree between the daemon and DOMParser.
        if (parent?.tag === "ul" && tag !== "li") fail("A ul may contain only li elements.", start);
        if (
            parent !== undefined &&
            ["p", "span", "strong", "em"].includes(parent.tag) &&
            !["span", "strong", "em"].includes(tag)
        )
            fail("A text element may contain only inline text elements.", start);
        if (++count > 1000 || stack.length >= 16)
            fail("The sidebar exceeds 1,000 elements or depth 16.", start);
        if (tag === "happy-space") {
            const ref = attrs["ref"]!;
            if (refs.has(ref)) fail(`Duplicate space reference ${ref}.`, start);
            if (knownRefs !== undefined && !knownRefs.has(ref))
                fail(`Unknown space reference ${ref}.`, start);
            if (stack.some((node) => node.tag === "happy-space"))
                fail("A space cannot be nested inside another space.", start);
            refs.add(ref);
        }
        if (tag === "happy-section") {
            const id = attrs["id"]!;
            if (ids.has(id)) fail(`Duplicate section ID ${id}.`, start);
            ids.add(id);
        }
        const node: SidebarNode = {
            tag,
            attrs,
            start,
            openEnd: at,
            closeStart: at,
            end: at,
            parent,
            children: [],
        };
        if (parent === undefined) root = node;
        else parent.children.push(node);
        if (tag !== "hr") stack.push(node);
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

export const SIDEBAR_STYLES = {
    version: 1,
    elements: Object.fromEntries(
        Object.entries(attributes).map(([tag, schema]) => [tag, schema.properties]),
    ),
    classes: ["note", "muted", "divider"],
    tokens: {
        light: {
            "--text": "#000000",
            "--text-secondary": "#49454f",
            "--surface": "#ffffff",
            "--divider": "#eaeaea",
            "--groupped-background": "#f5f5f5",
        },
        dark: {
            "--text": "#ffffff",
            "--text-secondary": "#cac4d0",
            "--surface": "#212121",
            "--divider": "#292929",
            "--groupped-background": "#1e1e1e",
        },
    },
};
