import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    applySpaceSidebarOperations,
    diffSpaceSidebar,
    formatSpaceSidebar,
    parseSpaceSidebar,
    SpaceSidebarError,
    SpaceSidebarOperationError,
    spaceSidebarChangedPayloadSchema,
    spaceSidebarOperationsRequestSchema,
    type SpaceSidebarDocument,
    type SpaceSidebarItem,
    type SpaceSidebarOperation,
    type SpaceSidebarSpaceNode,
} from "../sources/index.js";

const canonical = [
    '<nav fold-ribbon="always">',
    "  <happy-search/>",
    "  <happy-create/>",
    '  <happy-space id="happy" expanded="true">',
    '    <happy-space id="session1" fold-ribbon="hover"/>',
    "  </happy-space>",
    '  <happy-separator id="divider"/>',
    '  <happy-section id="releases" label="Releases &amp; &quot;ships&quot;" collapsed="true"/>',
    '  <happy-space id="android"/>',
    '  <happy-widget id="status"><div class="card">Build <b>green</b><br>\n  "quoted" & raw</div></happy-widget>',
    '  <happy-widget id="empty"/>',
    '  <happy-section id="tasks" label="Tasks"/>',
    '  <happy-space id="pricing"/>',
    "</nav>",
    "",
].join("\n");

const read = (html: string) => parseSpaceSidebar(html);
const ids = (document: SpaceSidebarDocument) => document.items.map((item) => item.id);

describe("parseSpaceSidebar and formatSpaceSidebar", () => {
    it("round-trips the canonical form exactly, widget content verbatim", () => {
        const document = read(canonical);
        expect(formatSpaceSidebar(document)).toBe(canonical);
        expect(document.items[6]).toEqual({
            type: "widget",
            id: "status",
            html: '<div class="card">Build <b>green</b><br>\n  "quoted" & raw</div>',
        });
        expect(document.items[7]).toEqual({ type: "widget", id: "empty", html: "" });
        expect(document.items[4]).toEqual({
            type: "section",
            id: "releases",
            label: 'Releases & "ships"',
            collapsed: true,
        });
        expect(read(formatSpaceSidebar(document))).toEqual(document);
    });

    it("reads any valid spelling as the tree of its canonical form", () => {
        const loose = `<nav>
<happy-create></happy-create><happy-search />
<happy-section label='Bots' collapsed="false" id="bots"/>
<happy-space expanded="false" id="bot1"></happy-space>
<happy-widget id="w"></happy-widget >
</nav>`;
        const document = read(loose);
        expect(formatSpaceSidebar(document)).toBe(
            [
                "<nav>",
                "  <happy-create/>",
                "  <happy-search/>",
                '  <happy-section id="bots" label="Bots"/>',
                '  <happy-space id="bot1"/>',
                '  <happy-widget id="w"/>',
                "</nav>",
                "",
            ].join("\n"),
        );
    });

    it("leaves widgets out for clients that predate them", () => {
        expect(formatSpaceSidebar(read(canonical), { widgets: false })).not.toContain("widget");
    });

    it.each([
        ["text", "<nav><happy-search/><happy-create/>hello</nav>"],
        ["reserved ID", '<nav><happy-search/><happy-create/><happy-separator id="nav"/></nav>'],
        [
            "duplicate ID",
            '<nav><happy-search/><happy-create/><happy-separator id="a"/><happy-space id="a"/></nav>',
        ],
        ["missing Create", "<nav><happy-search/></nav>"],
        [
            "nested widget",
            '<nav><happy-search/><happy-create/><happy-space id="a"><happy-widget id="w"/></happy-space></nav>',
        ],
        [
            "widget attribute",
            '<nav><happy-search/><happy-create/><happy-widget id="w" collapsed="true"/></nav>',
        ],
        [
            "unclosed widget",
            '<nav><happy-search/><happy-create/><happy-widget id="w"><p>never closed</p></nav>',
        ],
        [
            "widget closing tag in other case",
            '<nav><happy-search/><happy-create/><happy-widget id="w">a</HAPPY-WIDGET></happy-widget></nav>',
        ],
        [
            "oversized widget",
            `<nav><happy-search/><happy-create/><happy-widget id="w">${"x".repeat(16 * 1024 + 1)}</happy-widget></nav>`,
        ],
        ["unquoted attribute", "<nav><happy-search/><happy-create/><happy-separator id=a/></nav>"],
    ])("refuses %s", (_name, html) => {
        expect(() => read(html)).toThrow(SpaceSidebarError);
    });

    it("points diagnostics at the offending element", () => {
        try {
            read('<nav><happy-search/><happy-create/><happy-separator id="a b"/></nav>');
            expect.unreachable();
        } catch (error) {
            expect((error as SpaceSidebarError).diagnostics).toEqual([
                { message: "Invalid attributes on happy-separator.", offset: 35 },
            ]);
        }
    });
});

describe("applySpaceSidebarOperations", () => {
    const base = read(canonical);
    const apply = (
        operations: SpaceSidebarOperation[],
        document = base,
        from?: SpaceSidebarDocument,
    ) =>
        applySpaceSidebarOperations(document, operations, from === undefined ? {} : { base: from });

    it("inserts, moves, sets, and removes by ID without touching its input", () => {
        const before = structuredClone(base);
        const result = apply([
            { type: "insert", node: { type: "space", id: "new" }, to: { after: "happy" } },
            { type: "move", id: "pricing", to: { parent: null } },
            { type: "set", id: "releases", collapsed: false, label: "Ships" },
            { type: "set", id: "status", html: "<p>Red</p>" },
            {
                type: "insert",
                node: { type: "space", id: "session2", expanded: true },
                to: { parent: "happy" },
            },
            { type: "remove", id: "divider" },
            { type: "set", id: "nav", foldRibbon: null },
        ]);
        expect(base).toEqual(before);
        expect(ids(result.document)).toEqual([
            "pricing",
            "happy-search",
            "happy-create",
            "happy",
            "new",
            "releases",
            "android",
            "status",
            "empty",
            "tasks",
        ]);
        expect(
            (result.document.items[3] as SpaceSidebarSpaceNode).children.map((c) => c.id),
        ).toEqual(["session2", "session1"]);
        expect(result.document.foldRibbon).toBeUndefined();
        expect(result.operations).toHaveLength(7);
        expect(formatSpaceSidebar(result.document)).toContain(
            '<happy-widget id="status"><p>Red</p></happy-widget>',
        );
    });

    it("moves a section with its block and removes only its heading", () => {
        const moved = apply([{ type: "move", id: "releases", to: { after: "pricing" } }]).document;
        expect(ids(moved)).toEqual([
            "happy-search",
            "happy-create",
            "happy",
            "divider",
            "tasks",
            "pricing",
            "releases",
            "android",
            "status",
            "empty",
        ]);
        const removed = apply([{ type: "remove", id: "releases" }]).document;
        expect(ids(removed)).toEqual([
            "happy-search",
            "happy-create",
            "happy",
            "divider",
            "android",
            "status",
            "empty",
            "tasks",
            "pricing",
        ]);
    });

    it("leaves out what changed nothing, and replays what applied to the same result", () => {
        const result = apply([
            { type: "move", id: "android", to: { after: "releases" } },
            { type: "set", id: "tasks", label: "Tasks" },
            { type: "remove", id: "gone" },
            { type: "move", id: "android", to: { after: "pricing" } },
        ]);
        expect(result.operations).toEqual([
            { type: "move", id: "android", to: { after: "pricing" } },
        ]);
        expect(applySpaceSidebarOperations(base, result.operations).document).toEqual(
            result.document,
        );
    });

    it("falls back to the nearest surviving earlier sibling when an anchor left", () => {
        // Since the client's base, someone removed `android` and `releases`.
        const now = apply([
            { type: "remove", id: "android" },
            { type: "remove", id: "releases" },
        ]).document;
        const result = apply(
            [{ type: "move", id: "pricing", to: { after: "android" } }],
            now,
            base,
        );
        expect(result.operations).toEqual([
            { type: "move", id: "pricing", to: { after: "divider" } },
        ]);
        expect(ids(result.document).slice(3, 5)).toEqual(["divider", "pricing"]);
        // Without a surviving sibling, first under the anchor's parent.
        const sessionGone = apply([{ type: "remove", id: "session1" }]).document;
        const nested = apply(
            [{ type: "insert", node: { type: "space", id: "s3" }, to: { after: "session1" } }],
            sessionGone,
            base,
        );
        expect(nested.operations[0]).toMatchObject({ to: { parent: "happy" } });
    });

    it("refuses what cannot apply and names the operation", () => {
        const refuse = (
            operations: SpaceSidebarOperation[],
            index: number,
            from?: SpaceSidebarDocument,
        ) => {
            try {
                apply(operations, base, from);
                expect.unreachable();
            } catch (error) {
                expect(error).toBeInstanceOf(SpaceSidebarOperationError);
                expect((error as SpaceSidebarOperationError).operationIndex).toBe(index);
                return (error as Error).message;
            }
        };
        expect(refuse([{ type: "move", id: "missing", to: { parent: null } }], 0)).toContain(
            "move missing",
        );
        refuse(
            [
                { type: "set", id: "tasks", collapsed: false },
                { type: "set", id: "missing", expanded: true },
            ],
            1,
        );
        refuse(
            [{ type: "insert", node: { type: "separator", id: "android" }, to: { parent: null } }],
            0,
        );
        refuse([{ type: "move", id: "happy", to: { parent: "session1" } }], 0);
        refuse([{ type: "move", id: "releases", to: { after: "status" } }], 0);
        refuse([{ type: "move", id: "android", to: { after: "gone" } }], 0);
        refuse(
            [
                {
                    type: "insert",
                    node: { type: "widget", id: "w", html: "" },
                    to: { parent: "happy" },
                },
            ],
            0,
        );
        refuse(
            [
                {
                    type: "insert",
                    node: { type: "widget", id: "w", html: "</happy-widget>" },
                    to: { parent: null },
                },
            ],
            0,
        );
        refuse([{ type: "remove", id: "happy-search" }], 0);
        refuse([{ type: "set", id: "divider", collapsed: true }], 0);
        refuse([{ type: "set", id: "releases", expanded: true }], 0);
        refuse([{ type: "set", id: "releases" } as SpaceSidebarOperation], 0);
        refuse(
            [{ type: "insert", node: { type: "space", id: "x" }, to: { parent: "gone" } }],
            0,
            base,
        );
        refuse([{ type: "insert", node: { type: "space", id: "nav" }, to: { parent: null } }], 0);
    });

    it("keeps the document within its limits", () => {
        let document = read("<nav><happy-search/><happy-create/></nav>");
        const deep: SpaceSidebarOperation[] = [
            { type: "insert", node: { type: "space", id: "d2" }, to: { parent: null } },
        ];
        for (let depth = 3; depth <= 16; depth++)
            deep.push({
                type: "insert",
                node: { type: "space", id: `d${depth}` },
                to: { parent: `d${depth - 1}` },
            });
        document = applySpaceSidebarOperations(document, deep).document;
        expect(() =>
            applySpaceSidebarOperations(document, [
                { type: "insert", node: { type: "space", id: "d17" }, to: { parent: "d16" } },
            ]),
        ).toThrow("deeper than 16");
        const widgets: SpaceSidebarOperation[] = Array.from({ length: 9 }, (_, index) => ({
            type: "insert",
            node: { type: "widget", id: `w${index}`, html: "x".repeat(16 * 1024 - 64) },
            to: { parent: null },
        }));
        try {
            applySpaceSidebarOperations(document, widgets);
            expect.unreachable();
        } catch (error) {
            expect((error as SpaceSidebarOperationError).operationIndex).toBe(7);
        }
    });
});

describe("diffSpaceSidebar", () => {
    const base = read(canonical);
    const roundTrip = (current: SpaceSidebarDocument, proposed: SpaceSidebarDocument) => {
        const operations = diffSpaceSidebar(current, proposed);
        expect(formatSpaceSidebar(applySpaceSidebarOperations(current, operations).document)).toBe(
            formatSpaceSidebar(proposed),
        );
        return operations;
    };

    it("describes one drag as one move and one section drag as one block move", () => {
        const dragged = structuredClone(base);
        const [pricing] = dragged.items.splice(9, 1);
        dragged.items.splice(4, 0, pricing!);
        expect(roundTrip(base, dragged)).toEqual([
            { type: "move", id: "pricing", to: { after: "divider" } },
        ]);
        const block = structuredClone(base);
        const releases = block.items.splice(4, 4);
        block.items.push(...releases);
        expect(roundTrip(base, block)).toEqual([
            { type: "move", id: "releases", to: { after: "pricing" } },
        ]);
    });

    it("sets only what changed and removes only what left", () => {
        const changed = structuredClone(base);
        (changed.items[4] as Extract<SpaceSidebarItem, { type: "section" }>).collapsed = false;
        changed.items.splice(5, 1);
        (changed.items[2] as SpaceSidebarSpaceNode).children = [];
        expect(roundTrip(base, changed)).toEqual([
            { type: "set", id: "releases", collapsed: false },
            { type: "remove", id: "session1" },
            { type: "remove", id: "android" },
        ]);
    });

    it("keeps widgets a writer cannot see where they are", () => {
        const visible = read(formatSpaceSidebar(base, { widgets: false }));
        const [pricing] = visible.items.splice(-1, 1);
        visible.items.splice(0, 0, pricing!);
        const operations = diffSpaceSidebar(base, visible, { widgets: false });
        expect(operations).toEqual([{ type: "move", id: "pricing", to: { parent: null } }]);
        const after = applySpaceSidebarOperations(base, operations).document;
        expect(after.items.filter((item) => item.type === "widget").map((item) => item.id)).toEqual(
            ["status", "empty"],
        );
        expect(() => diffSpaceSidebar(base, base, { widgets: false })).toThrow("widgets");
    });

    it("expresses any proposal exactly", () => {
        let seed = 7;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
        const document = (): SpaceSidebarDocument => {
            const items: SpaceSidebarItem[] = [
                { type: "search", id: "happy-search" },
                { type: "create", id: "happy-create" },
            ];
            for (let index = 0; index < 14; index++) {
                const kind = pick(["space", "space", "space", "section", "separator", "widget"]);
                const id = `${kind[0]}${index}`;
                if (kind === "section")
                    items.push({
                        type: "section",
                        id,
                        label: pick(["A", "B"]),
                        collapsed: random() < 0.5,
                    });
                else if (kind === "separator") items.push({ type: "separator", id });
                else if (kind === "widget")
                    items.push({ type: "widget", id, html: pick(["<p>a</p>", ""]) });
                else
                    items.push({
                        type: "space",
                        id,
                        expanded: random() < 0.5,
                        children: Array.from({ length: Math.floor(random() * 3) }, (_, child) => ({
                            type: "space" as const,
                            id: `${id}c${child}`,
                            expanded: false,
                            children: [],
                        })),
                    });
            }
            return { items: items.sort(() => random() - 0.5) };
        };
        const mutate = (from: SpaceSidebarDocument): SpaceSidebarDocument => {
            const next = structuredClone(from);
            for (let step = 0; step < 1 + Math.floor(random() * 6); step++) {
                const choice = random();
                const at = Math.floor(random() * next.items.length);
                const item = next.items[at]!;
                if (choice < 0.35) {
                    // Drag a section with its block, or one item.
                    const length =
                        item.type === "section"
                            ? 1 +
                              next.items
                                  .slice(at + 1)
                                  .findIndex(
                                      (other) =>
                                          other.type === "section" || other.type === "separator",
                                  )
                            : 1;
                    const taken = next.items.splice(
                        at,
                        length > 0 ? length : next.items.length - at,
                    );
                    next.items.splice(Math.floor(random() * (next.items.length + 1)), 0, ...taken);
                } else if (choice < 0.5 && item.type !== "search" && item.type !== "create") {
                    next.items.splice(at, 1);
                } else if (choice < 0.6) {
                    next.items.splice(at, 0, {
                        type: "space",
                        id: `n${Math.floor(random() * 1e9)}`,
                        expanded: false,
                        children: [],
                    });
                } else if (choice < 0.7 && item.type === "space") {
                    item.children.reverse();
                    item.expanded = !item.expanded;
                } else if (choice < 0.8 && item.type === "section") {
                    item.label = `${item.label}!`;
                } else if (choice < 0.9 && item.type === "widget") {
                    item.html = `${item.html}<i>x</i>`;
                } else {
                    // Nest one top-level row under another.
                    const other = next.items.find(
                        (candidate) => candidate.type === "space" && candidate !== item,
                    );
                    if (item.type === "space" && other?.type === "space") {
                        next.items.splice(next.items.indexOf(item), 1);
                        other.children.push(item);
                    }
                }
            }
            if (random() < 0.3) next.foldRibbon = "always";
            else delete next.foldRibbon;
            return read(formatSpaceSidebar(next));
        };
        for (let trial = 0; trial < 300; trial++) {
            const current = read(formatSpaceSidebar(document()));
            roundTrip(current, mutate(current));
            const visible = read(formatSpaceSidebar(current, { widgets: false }));
            const proposal = read(formatSpaceSidebar(mutate(visible), { widgets: false }));
            const operations = diffSpaceSidebar(current, proposal, { widgets: false });
            expect(
                formatSpaceSidebar(applySpaceSidebarOperations(current, operations).document, {
                    widgets: false,
                }),
            ).toBe(formatSpaceSidebar(proposal));
        }
    });
});

describe("sidebar operation wire schemas and route", () => {
    it("validates batches and change events", () => {
        const request = {
            mutationId: "drag-1",
            baseVersion: 3,
            operations: [
                { type: "move", id: "android", to: { after: "releases" } },
                { type: "set", id: "nav", foldRibbon: null },
                {
                    type: "insert",
                    node: { type: "widget", id: "w", html: "<p>hi</p>" },
                    to: { parent: null },
                },
            ],
        };
        expect(Value.Check(spaceSidebarOperationsRequestSchema, request)).toBe(true);
        expect(
            Value.Check(spaceSidebarOperationsRequestSchema, { ...request, operations: [] }),
        ).toBe(false);
        expect(
            Value.Check(spaceSidebarOperationsRequestSchema, {
                ...request,
                operations: [{ type: "move", id: "a", to: { after: "b", parent: null } }],
            }),
        ).toBe(false);
        expect(
            Value.Check(spaceSidebarOperationsRequestSchema, {
                ...request,
                operations: [{ type: "remove", id: "a", extra: true }],
            }),
        ).toBe(false);
        expect(
            Value.Check(spaceSidebarChangedPayloadSchema, {
                artifactId: "k2n4b6v8m0q1w3e5r7t9y1u3",
                author: "prioritizing",
                operations: request.operations,
                previousVersion: 3,
                version: 4,
            }),
        ).toBe(true);
    });

    it("posts operations and asks for widgets only when told to", async () => {
        const seen: { method: string; url: string; body: unknown }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                seen.push({
                    method: init?.method ?? "GET",
                    url: input.toString(),
                    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                });
                return Response.json({
                    artifactId: "a1",
                    version: 2,
                    html: "<nav></nav>",
                    operations: [],
                    spaces: [],
                });
            },
        });
        await client.getSpaceSidebar();
        await client.getSpaceSidebar({ widgets: true });
        const request = {
            mutationId: "m1",
            baseVersion: 1,
            operations: [{ type: "remove", id: "a" } as const],
        };
        await client.applySpaceSidebarOperations(request);
        expect(
            seen.map(
                ({ method, url }) => `${method} ${new URL(url).pathname}${new URL(url).search}`,
            ),
        ).toEqual([
            "GET /v0/spaces/sidebar",
            "GET /v0/spaces/sidebar?widgets=true",
            "POST /v0/spaces/sidebar/operations",
        ]);
        expect(seen[2]!.body).toEqual(request);
    });
});
