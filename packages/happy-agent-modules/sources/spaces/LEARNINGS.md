# Spaces — learnings

## The document is the sidebar, and everything in it is an item

The first experimental document was HTML with sections that walled rows off, plain markup, a
`tree` flag for live subtasks, and an "Older" section that read as "done". Kirill: the sidebar is
"kinda literally HTML, that's the state"; everything must be draggable, separators included, and
Search and Create too; a separator is a visual cue, not a hint. The document is now one `<nav>` of
`happy-search`, `happy-create`, `happy-section`, `happy-separator`, and `happy-space` items in one
flat order. Nested `happy-space` elements are sessions (subtasks and collaborators) by agent ID, so
what Prioritizing writes is exactly what is shown: absent means hidden, `expanded` shows a row's
sessions. Attributes are quoted and switches are `"true"`, so HTML and XML parsers read the same
tree. `fold-ribbon` lets Prioritizing choose whether a foldable row's ribbon shows on hover or
always.

Sections and separators are different things. Folding the titled sections into untitled separators
lost what Kirill liked about them, so both exist: a `happy-section` has an ID and a required label,
heads the rows after it up to the next section or separator, and folds them with `collapsed`; a
`happy-separator` is a plain rule with an ID only, cannot fold, and ends a section's run. A label
names a subject: the daemon refuses Prioritizing a new or renamed section whose label names age or
doneness ("Older", "Done", "Archive", "Stale"), or whose label matches another section's ignoring
case and spacing, while the person may name sections freely. First-grammar documents are rewritten
once on read, keeping order: sections become sections with their labels and folds, the old "Older"
bucket becomes a plain separator, and plain markup is dropped.

Every writer uses CAS, and validation runs through ordinary artifact tools too. A nested node must
be a session of the conversation it sits under. The person may move anything. Prioritizing may not
move Search, Create, or Happy, undo the person's moves or folds, or move or tuck away work active in
the last two hours (new pending work may receive its first placement). Moves and folds are tracked
separately: a dragged row stays where the person put it, yet Prioritizing may still open it to show
a session waiting on the person. An item that now sits under another section or separator has
moved even if its order among the other items did not; otherwise inserting one above a row the
person placed would regroup it unnoticed.

A section is its heading plus the rows after it, up to the next section or separator, and Kirill
asked that it always move as one block. A row-level diff blamed whichever side of a swap had fewer
rows, so dragging a big section past a small one marked the small section's rows as hand-placed.
The diff now compares heading order first, then each block's rows, then each parent's sessions,
each with a longest common subsequence. A moved section is one move: only its heading becomes
hand-placed, its rows are `carried`, and the batch note names the section ("Moved Research.").
Carried rows still count as moving for Prioritizing's guards, so it cannot move a section that
holds Happy, untouched new work, or work active in the last two hours. A full replacement cannot
tell which of two swapped items was dragged; ties keep the earliest subsequence.

New rows go right below Happy, after everything nested under it, where the person expects new
work; or after the section or separator they were made under. When Happy is gone, nested, or
inside a collapsed section, they go right after Create instead, so new work is never hidden.
Archived rows and sessions leave the document with everything nested under them. Demo and daemon
setup must use manager placement, not the person-only legacy PATCH route, which records
`manual_at`.

Maintenance notes have durable runs without provider events. Live API delivery must announce the
terminal run as well as its message so an open chat can render exactly the note found after reload.

## Turning Spaces on moves nothing

Kirill asked that new people start from the sidebar they already know, with Prioritizing proposing
changes only afterwards. The first document is Search, Create, Happy, the joined Surfaces in
member order, a `divider` separator, a `bots` section labelled Bots with the other active bots, and
a `tasks` section labelled Tasks with joined tasks in membership order, each row with its active
subtasks nested and shown. Kirill moved Happy out of Bots so new work lands right below it. Bots
and Tasks are default sections, present even when empty and kept stable: Prioritizing is told to
keep Bots especially stable (long-term responsibilities), and the daemon refuses it removing or
renaming either; only the person reorganizes them. The fixed IDs let the desktop apply the
person's classic folds, which live only on the desktop, with one write. The owner state carries `sidebarSeed` until that write or Prioritizing's
next notice, and Prioritizing's writes are refused while it is set; its opening turn only gives
icons.

## A stem cell stays one until the person speaks

Kirill saw new work turn into something before saying what it was. The row was briefed to
Prioritizing on insertion, and its opening and calm briefs let it give an icon and place the row.
Now insertion of untouched new work briefs nothing, and an icon, move, or fold of a stem cell whose
first message has not arrived is refused (`briefedAt` marks that message).

## Sessions are hidden by default, and every one gets an icon

Showing working subtasks under their rows, and seeding every row with its subtasks expanded, made
the sidebar long. Kirill: give every session an icon, but don't show sessions. Subtasks and
collaborators are still created as before. The seed shows rows only, and Prioritizing leaves
sessions out of the document unless there is a strong reason to show one, such as a session
waiting on the person; a shown session counts toward the visible budget. The grammar keeps nested
sessions, so the person or Prioritizing can still show one. Session icons live in the owner state
by agent ID, are served as `agentIcons` beside the document, and Prioritizing is briefed when a
session starts under one of the person's rows.

## About ten rows are shown

A sidebar that showed everything was not prioritized. Prioritizing aims for at most ten shown rows
as a hard target: rows outside collapsed sections plus shown sessions, not counting Search,
Create, Happy, headings, separators, or new work waiting for its first message. `list_sidebar`
reports `visibleRows: {shown, budget}` for the document including pending edits. The daemon does
not refuse a batch over budget: work waiting on the person, recent work, and the person's own
moves and folds may alone exceed it, and refusing would leave Prioritizing no valid edit.

In a live run Prioritizing stopped at 14 and called it the floor, though folding Releases and Bots
would have reached 9. It had read "placed by the person" as "must stay shown", and treated quiet
rows whose last reply offered more help as waiting on the person. The prompt now says placing
protects position, not visibility; that waiting means the work cannot go on without the person,
and still counts; and that over budget it folds whole quiet sections first, Bots included, then
moves quiet rows into folded sections, then removes what the rules allow.

## Rows mirrored from the classic sidebar start placed

The first document mirrors rows the person already knows, but they kept the `pending` placement
of new rows. A pending row counts as a first placement, which the two-hour rule exempts, so the
daemon would have let Prioritizing move work active minutes ago, and `list_sidebar` called every
row "not placed yet". Creating the document now records every mirrored row, except untouched new
work, as placed.

## Prioritizing reads the threads before it decides

Placing by title and timestamps alone misjudged what work was about and whether it was done.
`read_row_conversation` takes a row's space ID or a session's agent ID and returns what the person
and the agent said, and what other agents wrote to it (a subtask's task, a report back), newest
first, without tool calls or reasoning, capped at 40 messages and about 16,000 characters, through
History's public page read. The prompt tells Prioritizing to read the conversations a decision
rests on before placing, ranking, folding, or removing anything.

## Prioritizing runs on the default model from Settings

Prioritizing ran on the cheapest model at the lowest effort, and its grouping and choices were
poor. It now runs on `happy-desktop.model.default`, the model a new chat starts with, at that
model's own default effort, read through the person's own context in team mode; without a chosen
model still served, the installation's default model. Titles likewise no longer uses a cheap
route; it writes names with the chat's own model (see the Titles learnings).

## Clients report nothing about what the person sees

`POST /v0/spaces/sidebar/observations` sent which rows were in the viewport. Visibility was never
permission to move anything, folds already live in the document, and the reports only woke
Prioritizing, so the route, its schema, and its brief were removed. An older desktop that still
sends it gets a 404 and ignores it.

## Notes in Happy's chat are one factual line

Kirill and the UX review asked for terse notes such as "Put Preview viewer release in Releases."
with no narration; folded work is "tucked away", never "Older", because quiet is not done. Prioritizing no longer writes free text: the note is composed from the batch's
own diff, so it can only describe what moved; a batch of several moves names two and counts the
rest. Prioritizing gives no reasons: a cheap model's clause ("Hid Quick Sanity Check finished
one-off check.") broke the line, and nothing else read them.

## The client decides when the person is calm

Applying a batch on every focus change moved rows while the person was still navigating, so
there is no focus report. The client signals `interacting` (hold everything) and `calm`; only
`calm`, idle, or a move the person asked for in their own words apply a batch, and never while
`interacting` or mid-Prioritizing-turn. Applying a batch never changes what the person has
selected.

`calm` once also meant "a navigation gesture just finished". That let a click on one row fold
others away into new collapsed sections, which reads as rows vanishing because of the click.
`calm` now means the person is not using the app: five minutes without input, or the window or
sidebar out of sight. A client never sends it for a gesture. The daemon's own fallback is also
five minutes: two still landed while the person was reading between clicks. Every row a batch
folds out of view is named in its note, because that is the change the person can no longer see.

## People who never opted in are untouched

Spaces is an experiment, and a person who has not turned it on must see the daemon behave exactly
as before. Opting in is the first sidebar read or write, or the first stem cell: only those create
the person's owner state, Prioritizing, and the sidebar document. Everything else (lifecycle
inserts, new-session and new-work briefs, the calm check, notes in Happy's chat) works from that
state and so does nothing without it. The `request_space_placement` tool is offered only to
conversations whose person has a live Prioritizing, and asking for a placement never creates an
owner.

## The sidebar format is marked by a migration

`006-sidebar-document-format` changes no data a reader depends on (it drops the old visibility
reports), but its key is what an older build that knows Spaces sees as unknown, so it refuses the
database cleanly instead of failing on the flat document. Any later change older builds cannot
read needs its own marker migration.

## Stored state survives a rollback

A desktop swapped a database written by a newer build to release 0.4.104, whose strict read of
each person's state rejected the new fields; the throw ran at startup and the supervisor restarted
it forever. Reading stored owner state now drops fields this build does not know, so a newer build
that only adds fields stays readable. State that still does not fit makes Spaces unavailable for
that one person: it is logged, skipped by the background work, and every route for them answers
with a plain error the desktop can show. It never stops the daemon. Releases up to 0.4.104 cannot
be fixed this way; protecting them belongs to whatever installs daemon releases.

## One row per piece of work, enforced by the store

A stem cell made before the sidebar was ever read collided with its own seeded row: the seed saw
the new task, the stem cell took that row over, but the emptied row kept its content key and the
insert failed. Every write now recomputes the key from the row's contents, and seeding is an
insert-if-absent on `(owner, content key)`, so concurrent or repeated seeds can never make a
second row for the same work. Rows that merely share a title are different conversations and are
never merged.

A stem-cell ID reserves both its row and conversation inside one database transaction. Replays
check ownership before creating work and return the stored task's agent; an existing ID never
creates a second task or discloses another person's row.

## Unnamed work has no title, and untouched work can be removed

The desktop labels a row "New" itself, so a task still carrying its placeholder name is served
with `title: null` instead of "New Task"; notes call it "a new chat". Rows
are otherwise never deleted, but a stem cell the person left without writing anything is not
work: removing it (`PATCH` with `removed: true`) deletes the row and archives its task, and is
refused (409) as soon as the conversation holds any message.

## Section names are unique per person

On clean data a cheap model created a "Movies" section for each of two new rows in one turn,
and the batch put them in two sections with the same name. The daemon now owns the rule rather
than the prompt: creating a section whose name (ignoring case and surrounding spaces) matches an
existing or queued section returns that section's ID instead, carrying over any count it was
given, and renaming a section onto another's name is refused.

## Archived work leaves the sidebar

Archiving a task only hid its row, which still came back from `GET /v0/spaces` and looked like a
leftover to clients. Archiving (or leaving) work now removes its rows and anything queued for
them, with `space.removed`; unarchiving adds a fresh pending row for each member. `hidden`
remains Prioritizing's choice for live work it tucks away.

Bots follow the same restoration rule: a transition from archived to active adds one pending row
for each already-seeded owner. The content-key constraint makes repeated notifications harmless;
system bots remain outside the ordinary bot listener.

Removing untouched work archives its task, so owning a sidebar row is insufficient authority.
The API checks the same task-owner or team-owner policy as task archival inside the transaction
that removes the row, before any row or task changes.

## Surfaces keep following membership after the first read

Seeding only once left newly created or joined Surfaces absent and left stale rows after leaving.
Spaces now owns a Surfaces event subscription and reconciles each seeded owner's membership in
one transaction, emitting private row events and refreshing names and pictures. Durable events
read current membership so a delayed join cannot undo a later leave; closing Spaces unsubscribes.

Todo lists, documents, and calendars contribute rows once populated; other supported kinds,
including existing reference Surfaces, keep their membership-based seeding. Content events reconcile
current membership and current content, removing empty rows and restoring populated ones without
moving rows that remain eligible. Startup reconciles already seeded owners too. Document edits
have a durable internal notification independent of editor subscriptions; completed todos count
as content, deleted records do not, and calendar existence does not depend on a displayed range.
System monitors remain outside Spaces.

## The API is only what the desktop uses

Kirill reviewed the contract before it was specified. Everything the desktop did not read was
removed rather than kept "in case": the organiser's row, a row's own name, section context lines,
batch reasons and section diffs, revisions, the pending-batch count, focus reports, single-row
reads, and the organiser-model setting. Space events carry whole objects, so they need no
`previousVersion`.

## Happy is an ordinary row

A `role` field and Happy-specific IDs made clients special-case Happy. The API now shows Happy as
an ordinary row whose target is Happy's bot. Prioritizing never moves or hides it, but the person
may drag it. Sessions under a row are part of the document, not drawn by clients from `subtasks`;
worktrees are still drawn by clients under the session that works in them.

## The person's changes are PATCHes; tidy is one message

Separate move, discard, and collapse routes were replaced by `PATCH /v0/spaces/:id` (`sectionId`,
`afterId`, `visibility`, or `removed`) and `PATCH /v0/spaces/sections/:id`, like other resources.
Tidy had its own apply-at-once machinery; it is now only the automatic message "Tidy the sidebar
now." in Prioritizing's conversation, and its changes wait for calm like any other batch.

## The organiser is Prioritizing, a real subtask of Happy

The organiser was a hidden child agent called "Sidebar manager", invisible in Happy's tree. It
then became a conversation subtask (`createConversation`, with its own metadata), which Kirill
still saw as not a true subtask. It is now made through `SubtasksModule.create`, exactly as Happy
makes any subtask, with an opening task and nothing special-cased; it is found by the agent ID in
the person's bookkeeping. It is created lazily with the person's first stem cell — not on seed or
the first read — and before that briefs and tidy do nothing. As an ordinary subtask it reported every reply into
Happy's chat beside the batch note, so it is created `unreported`: Happy's chat gains exactly one
message per applied batch, and turns that change nothing say nothing.

## Recent work is never tucked away

Six tidy requests in a row led a cheap model to hide every row but Happy, including a task that
was running. The prompt already said working rows stay shown; the daemon now enforces it. A fold
or hide of a row whose work is running, or was active in the last two hours, is answered with
"…so it stays shown. Nothing was queued.", and a queued one is dropped at apply time if the work
came back to life meanwhile. A stem cell nobody has written in is not touched at all.

The apply-time guard checks the composed batch, including section removal. Removing a section
evacuates its protected shown rows to the unsectioned shown list, while quiet rows may fold;
intermediate changes cannot bypass the guard. Existing manual visibility is preserved.
Evacuated shown rows receive fresh destination keys after Happy, preserving section and row
order; carrying an old section's key could otherwise place protected work above Happy.
