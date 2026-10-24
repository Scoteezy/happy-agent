import {
    formatSpaceSidebar,
    parseSpaceSidebar,
    SpaceSidebarError,
    type SpaceSidebarItem,
} from "@slopus/happy-agent-client";
import { Type, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The first experimental grammar, read only to rewrite a document written in it. */
const flag = Type.Optional(Type.Literal(""));
const plain = Type.Object(
    { class: Type.Optional(Type.String({ maxLength: 256 })) },
    { additionalProperties: false },
);
const LEGACY: Record<string, TObject> = {
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

interface LegacyNode {
    tag: string;
    attrs: Record<string, string>;
    children: LegacyNode[];
}

/**
 * A document in the first grammar, rewritten once: its sections flatten into section headings,
 * except the old "older" bucket, which marked age rather than a subject and becomes a plain
 * separator. Rows keep their order, plain HTML is dropped, and Search and Create lead. Rows whose
 * space `known` does not hold are left out. Undefined when the document is current or unreadable.
 */
export function migrateLegacySidebar(
    html: string,
    known: (spaceId: string) => boolean,
): string | undefined {
    try {
        parseSpaceSidebar(html);
        return undefined;
    } catch (error: unknown) {
        if (!(error instanceof SpaceSidebarError)) throw error;
    }
    const legacy = parseLegacy(html);
    if (legacy === undefined) return undefined;
    const items: SpaceSidebarItem[] = [
        { type: "search", id: "happy-search" },
        { type: "create", id: "happy-create" },
    ];
    const walk = (node: LegacyNode): void => {
        if (node.tag === "happy-space") {
            const id = node.attrs["ref"]!;
            if (known(id)) items.push({ type: "space", id, expanded: false, children: [] });
            return;
        }
        if (node.tag === "happy-section") {
            const id = node.attrs["id"]!;
            items.push(
                id === "older"
                    ? { type: "separator", id }
                    : {
                          type: "section",
                          id,
                          label: node.attrs["label"]!,
                          collapsed: Object.hasOwn(node.attrs, "collapsed"),
                      },
            );
        }
        node.children.forEach(walk);
    };
    legacy.children.forEach(walk);
    return formatSpaceSidebar({ items });
}

/** The first grammar's `<nav>`, or undefined when the text is not one. */
function parseLegacy(html: string): LegacyNode | undefined {
    if (html.includes("\0") || new TextEncoder().encode(html).byteLength > 128 * 1024)
        return undefined;
    const stack: LegacyNode[] = [];
    let root: LegacyNode | undefined;
    let count = 0;
    let at = 0;
    while (at < html.length) {
        if (html[at] !== "<") {
            const end = html.indexOf("<", at);
            const next = end < 0 ? html.length : end;
            if (html.slice(at, next).trim() && stack.length === 0) return undefined;
            at = next;
            continue;
        }
        const close = /^<\/([a-z][a-z0-9-]*)\s*>/.exec(html.slice(at));
        if (close !== null) {
            if (stack.pop()?.tag !== close[1]) return undefined;
            at += close[0].length;
            continue;
        }
        const open = /^<([a-z][a-z0-9-]*)\b/.exec(html.slice(at));
        const tag = open?.[1];
        const schema = tag === undefined ? undefined : LEGACY[tag];
        if (open === null || tag === undefined || schema === undefined) return undefined;
        at += open[0].length;
        const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
        while (at < html.length) {
            const whitespace = /^\s+/.exec(html.slice(at));
            if (whitespace !== null) at += whitespace[0].length;
            if (html[at] === ">" || html.slice(at, at + 2) === "/>") break;
            const attr =
                whitespace === null
                    ? null
                    : /^([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/.exec(html.slice(at));
            if (attr === null || Object.hasOwn(attrs, attr[1]!)) return undefined;
            attrs[attr[1]!] = (attr[2] ?? attr[3] ?? "")
                .replaceAll("&quot;", '"')
                .replaceAll("&lt;", "<")
                .replaceAll("&gt;", ">")
                .replaceAll("&amp;", "&");
            at += attr[0].length;
        }
        if (!Value.Check(schema, { ...attrs })) return undefined;
        const selfClosing = html.slice(at, at + 2) === "/>";
        if ((selfClosing && tag !== "hr") || (html[at] !== ">" && !selfClosing)) return undefined;
        at += selfClosing ? 2 : 1;
        const parent = stack.at(-1);
        if (tag === "nav" ? parent !== undefined || root !== undefined : parent === undefined)
            return undefined;
        if (++count > 1000 || stack.length >= 16) return undefined;
        const node: LegacyNode = { tag, attrs, children: [] };
        if (parent === undefined) root = node;
        else parent.children.push(node);
        if (!selfClosing && tag !== "hr") stack.push(node);
    }
    return stack.length > 0 ? undefined : root;
}
