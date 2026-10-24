# Spaces

The experimental sidebar is a `sidebar` artifact, and the artifact is the sidebar's state: one
`<nav>` holding a flat, ordered list of `<happy-search/>`, `<happy-create/>`,
`<happy-section id label collapsed?/>`, `<happy-separator id/>`, `<happy-space id expanded?>`, and
`<happy-widget id>…</happy-widget>`, every one of which the person can drag. A top-level
`happy-space` names a row; a nested one names a session (subtask or collaborator) by agent ID,
under the conversation that is its parent. A section is a titled heading over the rows after it,
up to the next section or separator, folds them, and moves with them as one block; a separator is
an untitled rule that cannot fold; a widget is a leaf of opaque HTML that clients draw isolated.
Anything absent is not shown. `fold-ribbon` on the nav or a row chooses whether a foldable row's
ribbon shows on hover or always. The grammar, the canonical form, the operations, and the differ
are the client's (`parseSpaceSidebar`, `formatSpaceSidebar`, `applySpaceSidebarOperations`,
`diffSpaceSidebar`), so the daemon and clients compute identical documents.

`sidebar` lazily creates it with Prioritizing as a mirror of the classic sidebar (Happy, Surfaces,
a separator, then the default Bots and Tasks sections, rows only) and marks it `seed`
until the person's first write or Prioritizing's next notice; Prioritizing may not change the seed.
A document in the first grammar is migrated once on read. Every write is a batch of operations by
node ID: `applySidebarOperations` commits the person's batch, rebased onto the current version and
answered once per mutation ID; `updateSidebar` (the older whole-document route) and the person's
ordinary artifact updates are diffed into the same batch; `editSidebar` and Prioritizing's artifact
updates are diffed into operations queued for the calm batch, one version per proposal. Each
version records who set each node's place, fold, label, fold ribbon, and widget content, and is
announced with its operations. New rows go right below Happy (or after the section or separator
they were made under, or after Create when Happy is gone or folded away); archived rows and
sessions leave with everything nested under them.

Prioritizing reads `list_sidebar` (the document, row facts, every session under the rows, and the
shown count against the visible budget of ten), reads threads with `read_row_conversation`,
writes `edit_sidebar` or `update_artifact`, reads the grammar with `get_sidebar_styles`, and sets
row and session icons with `set_space_icon`. It may not move Happy, Search, or Create, override
anything the person last set, or move work active in the last two hours, and it may not touch a
stem cell before its first message; a section it moves carries its rows under the same rules. An
operation that breaks a rule is dropped with a note and the rest still applies. Its section
labels name subjects, never age or doneness, and are unique, and it keeps the Bots and Tasks
sections. Sessions stay hidden unless it has a strong reason to show one, and a shown session
counts toward the budget.
One applied batch records one factual note.

One flat sidebar per person, kept tidy by Prioritizing, a subtask of Happy.

```text
person ── GET /v0/spaces ───────────────┐
        ── stem cell / PATCH row, section┤  explicit actions apply at once
        ── attention: interacting|calm ─┤
                                        ▼
                               SpacesModule ── rows, sections, pending changes, batches
                                        ▲
Prioritizing (subtask of Happy) ────────┘  place / visibility / section: queued
  list_sidebar, read_row_conversation,     icon: applied at once
  set_space_icon, ...
other agents ── request_space_placement ─► briefed to Prioritizing
tidy ── "Tidy the sidebar now." ─────────► briefed to Prioritizing
```

A **space** is one row: Happy (first, and never moved by Prioritizing) or an item wrapping a task,
bot, or Surface. The API shows Happy as an ordinary bot row; the internal `happy` role only finds
it. Its legacy fields (for `GET /v0/spaces`) are a section or none, an order key inside that
place, a placement (`pending` until Prioritizing places it) and a visibility (`shown`,
`folded`, or `hidden`). Sections are flat labels with a
unique name and an optional visible count. The HTTP contract is the Spaces chapter of
`packages/happy-agent/API.md`.

Rows carry the owner's ID (`standalone` on a standalone installation), so the model already
fits several people even though only the owner's own sidebar is exposed.

## New work

A stem cell is a fresh unnamed task — its own folder, no project, no bot — wrapped in a row in
the same transaction. The client may choose the row's ID and the task, workspace, and agent IDs,
so it can show the conversation before the daemon answers; the row's ID is the retry key. Without a section it waits right below Happy as `pending`; made under a section or
separator it is settled right after it. Nothing touches it before its first human message: Prioritizing is not
briefed, and its icon, moves, and folds are refused. That message briefs Prioritizing, which
names an icon at once and queues the placement. Removing a stem cell nobody wrote in archives its
task.

## Prioritizing

One long-running subtask of Happy per person, made through `SubtasksModule.create` — the path
every subtask takes — with the person's first stem cell, and made again with the next one if the
person archived it. Until then there is none, and briefs and tidy requests are dropped; its
opening task places whatever was seeded before it existed. It appears in Happy's subtasks like any
other, but is created `unreported`: Happy hears from it only through the batch note, exactly one
line per applied batch. It is recognised by the agent ID stored
in the person's bookkeeping, not by metadata. It runs on the default model from Settings at that
model's default effort, and
its whole tool array and system prompt come from this module, so it can do nothing else. Briefs
reach it through the `spaces.briefPrioritizing` durable function, committed with whatever caused
them. Tidy is one such brief and nothing more.

## Calm batches

Every move, visibility change, and section change Prioritizing makes is queued, one entry per
target, and the latest word wins. A batch applies in one transaction when the person is calm:
the client reports `calm` after five minutes without input or while the app or sidebar is out of
sight (never for a click or navigation), or five minutes pass with no sign of work. Nothing applies while the client reports `interacting`, or while Prioritizing is
mid-turn. A move the person asked another agent for in their own words applies as soon as
Prioritizing finishes. Each batch
records its diff (from and to per row), writes one line into Happy's chat built from that diff,
and is published as `batch_applied`. The person's own `PATCH` removes any queued change of that row.
