# Spaces

The experimental sidebar is a `sidebar` artifact, and the artifact is the sidebar's state: one
`<nav>` holding a flat, ordered list of `<happy-search/>`, `<happy-create/>`,
`<happy-section id label collapsed?/>`, `<happy-separator id/>`, `<happy-space id expanded?>`, and
`<happy-widget id>…</happy-widget>`, every one of which the person can drag. A top-level
`happy-space` names a row; a nested one names a session (subtask or collaborator) by agent ID,
under the conversation that is its parent and nowhere else, or an attachment: another of the
person's rows, such as a Surface's, standing there instead of at the top level. A section is a titled heading over the rows after it,
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
updates are diffed into operations queued until its turn ends, one version per edit. Each
version records who set each node's place, fold, label, fold ribbon, and widget content, and is
announced with its operations. New rows go right below Happy (or after the section or separator
they were made under, or after Create when Happy is gone or folded away); archived rows and
sessions leave with their sessions, after their attachments move out to the top level right after
them; an attachment someone takes out goes back there too, as a move. `attach_to_my_row`, offered
to conversations of a person with Stem Cells, attaches a row, a Surface, or a new todo, document,
calendar, or chat Surface under the caller's own row at once, as Prioritizing's write.

Prioritizing reads `list_sidebar` (the document, row facts, every session under the rows, and the
shown count against the visible budget of ten, and its open proposal), reads several threads by
turn with `read_conversations`, writes `edit_sidebar` or `update_artifact`, proposes larger changes
with `propose_sidebar`, reads the grammar with `get_sidebar_styles`, and sets row and session icons
with `set_space_icon`. Where things go is its decision, made from its prompt; the daemon only
keeps it from overriding anything the person last set, and a section it moves carries its rows
under the same rule. Without the person's words, its batches apply only new work's first
placement, the folded Distractions section, adding or moving its own row, and what is nested under
a row; anything else is proposed. An operation that breaks a rule is dropped with a note and the
rest still applies. Its prompt keeps its own row right under Happy, makes topic sections the layout, with one folded Distractions section for
work outside the person's focus, and prefers inserting new work over moving anything. Sessions
stay hidden unless one needs the person, such as for a review, and a shown session counts toward
the budget.
One applied batch records one factual note in Prioritizing's own conversation.

## Proposals

A proposal is a `sidebar_proposal` artifact: version 1 is the sidebar it was drafted from, later
versions are Prioritizing's drafts and the person's edits, and it is shown inline in Prioritizing's
conversation through the tool result's artifact presentation. The person's edits go through the
proposal operations route, rebased like a sidebar batch, and the aspects they set are kept from
Prioritizing's revisions. Accepting applies the difference from version 1 to the latest version as
the person's batch and archives the tasks offered in its Archive block; declining changes nothing.
At most one proposal is open, and the last few decided ones are listed for Prioritizing.

One flat sidebar per person, kept tidy by Prioritizing, a subtask of Happy.

```text
person ── GET /v0/spaces ───────────────┐
        ── stem cell / PATCH row, section┤  explicit actions apply at once, and wake it
        ── proposal edit / accept ───────┤
                                        ▼
                               SpacesModule ── rows, sections, pending changes, batches
                                        ▲
Prioritizing (subtask of Happy) ────────┘  small edits: queued until its turn ends
  list_sidebar, read_conversations,        larger ones: propose_sidebar
  set_space_icon, ...                      icon: applied at once
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
briefed, and its icon, moves, and folds are refused. That message wakes Prioritizing, which names
an icon and places the row when its subject is clear; so does the first message of work another
agent created, whose row also wakes it on arrival. Every later message the person writes in work
that started as a stem cell, or in a session under it, waits for the next brief with the agent's
last text before it, waking Prioritizing only while the row still waits for its first placement (`formatConversationBrief`, the latest three per row), as
does a session under it that stops, so Prioritizing can place the row once there is signal
without reading the thread. Stem-cell origin is the subject-naming mark `createStemCell` sets. Removing a stem cell nobody wrote in archives its
task.

## Prioritizing

One long-running subtask of Happy per person, made through `SubtasksModule.create` — the path
every subtask takes — with the person's first stem cell, and made again with the next one if the
person archived it. Until then there is none, and briefs and tidy requests are dropped; its
opening task adds its own row and gives icons. It appears in Happy's subtasks like any other, but
is created `unreported`, and its notes go to its own conversation, which has a row of its own
(role `focus`) that Prioritizing inserts itself: Happy hears nothing from it. It is recognised by
the agent ID stored
in the person's bookkeeping, not by metadata. It runs on the default model from Settings at that
model's default effort, and
its whole tool array and system prompt come from this module, so it can do nothing else. Briefs
reach it through the `spaces.briefPrioritizing` durable function, committed with whatever caused
them. Tidy is one such brief and nothing more.

## Voice

Live owns the person's Voice; Spaces gives it a row and read-only tools. `ensureVoiceRow` makes one
settled row (role `voice`) for Voice's conversation inside Live's transaction, and with Stem Cells
inserts it into the document once, as the daemon, below Happy, or below Prioritizing's row when
that directly follows Happy. A newer Voice's row replaces the old one; archiving Voice removes it,
and a row the person removed is never put back. The row is never work: Prioritizing is not briefed
about it and it does not count toward the visible rows. `voiceSidebarTools` is Voice's fixed array:
`list_sidebar`, `read_conversations` with the `machine` scope, `get_sidebar_styles`,
`request_space_placement` and `request_sidebar_tidy`; Voice never writes the sidebar. The
`machine` scope also reads any live conversation on a standalone installation; with a team it stays
the person's own. `sidebarOutline` gives Live the sidebar as names in document order (sections,
separators, rows, and sessions under expanded rows with folded counts), or the classic list without
Stem Cells.

## Wakes and batches

Notices collect in the owner state. Events — the person's committed changes, new work and
sessions, new work's first message, proposal edits and decisions, placement requests, Tidy — also
set `sidebarWakeAt` and wake Prioritizing two seconds after commit with every waiting notice in one
brief; a wake during a turn waits for the turn to end. Prioritizing's own writes never wake it.
Briefed notices stay in `sidebarBriefSent` until a run ends well; a failed run puts them back for
the next wake. A fifteen-second check picks up wakes and batches a restart left behind.

Every edit Prioritizing makes is queued and applies in one transaction when its turn ends, one
version per edit. Each batch records its diff (from and to per row), writes one line built from
that diff into Prioritizing's conversation, and is published as `batch_applied`. The person's own
`PATCH` removes any queued change of that row. `POST /v0/spaces/attention` is still accepted and
changes nothing a turn's end would not.
