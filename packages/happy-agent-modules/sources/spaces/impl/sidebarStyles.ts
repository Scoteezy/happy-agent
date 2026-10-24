/** The sidebar grammar as Prioritizing reads it from `get_sidebar_styles`. */
export const SIDEBAR_STYLES = {
    version: 4,
    elements: {
        nav: {
            attributes: { "fold-ribbon": '"hover" (default) or "always"' },
            children: [
                "happy-search",
                "happy-create",
                "happy-section",
                "happy-separator",
                "happy-space",
                "happy-widget",
            ],
        },
        "happy-search": { attributes: {}, children: [] },
        "happy-create": { attributes: {}, children: [] },
        "happy-section": {
            attributes: {
                id: "required, unique, 1–128 characters without whitespace",
                label: "required, 1–256 characters",
                collapsed: '"true" or "false" (default)',
            },
            children: [],
        },
        "happy-separator": {
            attributes: { id: "required, unique, 1–128 characters without whitespace" },
            children: [],
        },
        "happy-space": {
            attributes: {
                id: "a space ID at the top level; when nested, a session's agent ID or an attached space ID",
                expanded: '"true" or "false" (default)',
                "fold-ribbon": '"hover" (default) or "always"',
            },
            children: ["happy-space"],
        },
        "happy-widget": {
            attributes: { id: "required, unique, 1–128 characters without whitespace" },
            children: "arbitrary HTML, at most 16 KiB, kept exactly as written",
        },
    },
    rules: [
        "nav is the one root and holds a flat ordered list of items.",
        "happy-search and happy-create appear exactly once each.",
        "Every node has a stable ID; happy-search, happy-create, and nav are reserved names, not id values. IDs are unique across the document.",
        "A top-level happy-space id is a space ID. A nested happy-space id is a session (agent) ID whose parent is the enclosing happy-space, or a space ID attached there; a session never stands under another row, and a space stands in one place only.",
        'A happy-space draws what is nested in it only when expanded="true".',
        'A happy-section is a titled heading item; collapsed="true" folds the items after it up to the next happy-section or happy-separator. Its label names a subject, never age or whether work is finished.',
        "A happy-separator is a purely visual rule with no title; it cannot fold and it ends a section's run.",
        "A happy-widget is a compact card of free-form HTML, drawn isolated with no access to the app. Use one rarely, only where a card says more than a row, such as a short status summary. It never nests and nothing nests in it; it folds inside a collapsed section and counts toward the visible budget while shown. Its content may not contain </happy-widget.",
        'A row\'s change count sits flush right. fold-ribbon on nav sets where foldable rows show their fold ribbon: "hover" (the default) only while pointed at, "always" at the far right with the change count to its left. A happy-space may override it for itself.',
        "Anything absent from the document is not shown.",
        "Outside widget content: no text, classes, styles, scripts, or other elements.",
    ],
};
