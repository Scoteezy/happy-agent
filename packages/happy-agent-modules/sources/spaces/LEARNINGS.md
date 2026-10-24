# Spaces — learnings

## Prioritizing decides from its prompt; the daemon keeps integrity

Evaluation replays kept finding proposals that did something unwanted (folded recent work, put
bots into Stale, moved a row the person kept at the top, moved the separator to the end), and each
was answered with a daemon rule that dropped such edits. The rules piled up, fought each other, and
cost Prioritizing revision after revision of refused edits; the row anchor and its startup repair
moved its own row for it. Kirill: "its ITS decision - just a prompt - no hardcoded rules - THATS
ONE OF THE CORE PRINCIPLES across the board", unless it is a direct user action. Where work goes,
which sections exist and what they are called, what is folded, what is offered for Stale or
Archive, and where Prioritizing's own row stands are now only in `formatPrioritizingInstructions`.
When a run gets one wrong, fix the prompt, not the review.

The daemon still enforces only integrity, each for one reason:

- the document is valid and every ID is unique and known, or clients cannot draw it;
- a session stands only under its own parent, because a subtask never changes parent;
- what the person last set (place, fold, name, fold ribbon, widget, a revealed session) is never
  overridden, in the sidebar or in their edits of a proposal, because that is their direct action;
- larger changes need the person's consent (`reviewDirectOperation`), and nothing is archived
  unless they accept a proposal, and then only task rows under the `Archive` heading, whose label
  is fixed because accepting acts on it.

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
`happy-separator` is a plain rule with an ID only, cannot fold, and ends a section's run. The prompt
says a label names a subject, never age or status, and is unique; the person may name sections
freely. First-grammar documents are rewritten
once on read, keeping order: sections become sections with their labels and folds, the old "Older"
bucket becomes a plain separator, and plain markup is dropped.

Validation runs through ordinary artifact tools too. A nested node must be a session of the
conversation it sits under. The person may move anything. Prioritizing may not undo the
person's moves or folds. An item that now sits under another
section or separator has moved even if its order among the other items did not; otherwise
inserting one above a row the person placed would regroup it unnoticed.

A section is its heading plus the rows after it, up to the next section or separator, and Kirill
asked that it always move as one block. A row-level diff blamed whichever side of a swap had fewer
rows, so dragging a big section past a small one marked the small section's rows as hand-placed.
A `move` of a section now carries its block, and the client's `diffSpaceSidebar` turns a whole
document into the fewest moves, moving a block whole when it travelled whole. Only the heading
becomes the mover's, its rows are carried, and the batch note names the section ("Moved
Research."). Carried rows still count as moving, so Prioritizing cannot carry off a row the
person placed by moving the section around it.

## Writes are operations by node ID

Whole-document writes with compare-and-swap made every concurrent change a conflict: a person's
drag while Prioritizing's batch waited discarded the batch, and a drag racing the apply was
refused. Kirill approved moving to operations ("lets make these changes"). Every node has a stable
ID, and every write is a batch of `insert`, `move`, `remove`, and `set` by ID, applied with the
client's `applySpaceSidebarOperations` — the same function clients use for optimistic updates, so
both sides compute identical documents. A batch applies to the current version, rebased from the
one it was made against: an anchor that still exists is used where it is now; an `after` anchor
that is gone falls back to the nearest node that preceded it in the base and is still under the
same parent, else first under that parent; removing what is gone is a no-op. Only an operation on
a node that is gone, or an insert of an ID that exists now, is a conflict, named by its index.
Removing a section removes its heading only, so its rows join the block above instead of
vanishing.

Authorship is recorded per node and aspect (place, fold, label, fold ribbon, widget content), so
"Prioritizing never overrides the person" is a lookup. Inserting sets every aspect the new node
starts with: a section the person added keeps its label. Prioritizing's operation that touches a
person-set aspect, or breaks its other rules, is dropped with a note and the rest still applies.
At queue time the notes come back in `edit_sidebar`'s result (an edit with nothing left is an
error); when the batch applies the queued operations are reviewed again against the current version and
drops go into the next brief. Daemon lifecycle changes record nobody, and their removals take the
authorship along. Authorship keeps the 2,000 most recently set nodes.

Prioritizing still reads and writes HTML: `list_sidebar` shows the current version with its queued
proposals drawn in, at the current version plus one per proposal, and each edit is diffed by ID
against that view into operations. A stale `edit_sidebar` still applies when every old text occurs
exactly once; a stale whole-document artifact update is a conflict. Each queued proposal applies
as its own version, rebased from the version it was queued against with the earlier proposals
drawn in, and a person's change no longer discards them.

The person's batches are recorded by mutation ID with a digest of the request (the latest 500 per
person), so a retry answers with the first result without applying again, also when retries race.
The document rules (known space IDs, sessions under their parent) are checked only on the nodes a
batch places, so a stale node nobody touched never blocks the person. Every version is announced
with `space.sidebar.changed` carrying its operations; `artifact.updated` is still emitted for
older clients.

Older clients keep working unchanged, which was the simpler choice over refusing them: `PUT
/v0/spaces/sidebar` stays, with CAS and no rebase, and is diffed into the person's operations so
authorship and events match. Widgets are invisible to them: `GET` leaves widgets out unless
`widgets=true`, a `PUT` may not contain one, and widgets it leaves out stay where they are.

`happy-widget` is the one escape hatch: a leaf of opaque HTML (16 KiB, never nested, ending at the
first `</happy-widget` in any case) that moves, folds, and counts toward the budget like a row and
is drawn isolated by clients. Prioritizing may add or update widgets, rarely, for a compact card
that says more than rows can.

New rows go right below Happy, after everything nested under it, where the person expects new
work; or after the section or separator they were made under. When Happy is gone, nested, or
inside a collapsed section, they go right after Create instead, so new work is never hidden.
Archived rows and sessions leave the document with everything nested under them. Demo and daemon
setup must use manager placement, not the person-only legacy PATCH route, which records
`manual_at`.

Maintenance notes have durable runs without provider events. Live API delivery must announce the
terminal run as well as its message so an open chat can render exactly the note found after reload.

## Work carries its lists, and its subtasks only show

Kirill wanted a task's own agent, and Prioritizing, to "add stuff to the sidebar as subsections",
such as a todo list or a chat with another person under the work it belongs to. A nested
`happy-space` may now also name one of the person's rows, an attachment. IDs are unique, so a
space stands in one place only and attaching moves it. Taking an attachment out never deletes it:
the daemon rewrites that `remove` into a move to the top level right after its row, for the
person, Prioritizing, and whole-document writes alike, and a leaving row lifts its attachments
out before its sessions go with it. An attached todo, document, or calendar Surface keeps its row
while empty (`attachedSurfaceIds`) until the person leaves it; chat Surfaces have rows on
membership. `attach_to_my_row` is the conversation's tool, offered only when its person has Stem
Cells on; it applies at once as Prioritizing's write, so the person's placements still win and a
dragged-out attachment is never put back. People outside the installation cannot be invited, so a
chat with someone is a chat Surface they are a member of.

Steve likes reviewing the code a subtask changes, so subtasks must be easy to see, but a subtask
must never move to another row. Sessions still stand only under their own parent on every write
path. Prioritizing now shows a session the person likely wants (one changing code, or one waiting
for review), not only one blocked on them. The person reveals a row's sessions with an ordinary
insert batch; that records the sessions' place as theirs, and Prioritizing may not take them out,
fold the row, or fold a section over them.

## Turning Spaces on moves nothing

Kirill asked that new people start from the sidebar they already know, with Prioritizing proposing
changes only afterwards. The first document is Search, Create, Happy, the joined Surfaces in
member order, a `divider` separator, a `bots` section labelled Bots with the other active bots, and
a `tasks` section labelled Tasks with joined tasks in membership order, each row with its active
subtasks nested and shown. Kirill moved Happy out of Bots so new work lands right below it. Bots
and Tasks are default sections, present even when empty and kept stable: Prioritizing is told to
keep them, and Bots especially stable (long-term responsibilities). The fixed IDs let the desktop apply the
person's classic folds, which live only on the desktop, with one write. The owner state carries `sidebarSeed` until that write or Prioritizing's
next notice, and Prioritizing's writes are refused while it is set; its opening turn only gives
icons.

## A stem cell stays one until the person speaks

Kirill saw new work turn into something before saying what it was. The row was briefed to
Prioritizing on insertion, and its opening and later briefs let it give an icon and place the row.
Now insertion of untouched new work briefs nothing, an icon for a stem cell whose first message
has not arrived is refused (`briefedAt` marks that message), and the prompt says it waits for that
message.

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
puts quiet work into Distractions one row per batch, then removes what the rules allow.

## Rows mirrored from the classic sidebar start placed

The first document mirrors rows the person already knows, but they kept the `pending` placement
of new rows. A pending row's move counts as a first placement, which applies without a proposal,
so Prioritizing could have reshuffled the whole mirrored sidebar, and `list_sidebar` called every
row "not placed yet". Creating the document now records every mirrored row, except untouched new
work, as placed.

## Prioritizing hears the person, and reads threads by turn

Placing by title and timestamps alone misjudged what work was about and whether it was done.
Reading one row at a time, newest message first, made tidying slow and drowned it in replies.
Kirill asked for a reader that is "easier to filter, remove the tool calls, and limit to only the
last X assistant messages per turn". `read_conversations {ids, turns, replies}` reads up to twelve
rows or sessions at once: each with its title and last activity, then its latest turns oldest
first, a turn being one message from the person or another agent and the agent's last text
replies to it. Tool calls, reasoning, and hidden messages are left out, and each message (1,200
characters), conversation (about 4,000), and answer (about 24,000) is bounded
(`formatConversationTurns`).

Reading every thread made each turn long, and the first message alone often said too little to
place new work. Kirill: send every message the person writes in stem-cell chats to the focus
agent, "and the last text message before", so it has enough context. Each later message the person
writes in work that started as a stem cell, or in a session under it, is now a short
notice quoting the agent's last text reply (400 characters) and the message (900), without tool
calls; a session under such work that stops is one too, with its last reply. Only the latest three
notices per row wait, so a busy chat never crowds the rest out. They wait for the next wake rather
than causing one, except while the work still waits for its first placement, when a message may
make its subject clear. Stem-cell origin is read from the subject-naming mark, which only
`createStemCell` sets and which covers chats under it.

## Sections are the layout, and Prioritizing inserts rather than reshuffles

Prioritizing barely used sections and treated new work as something to rank among the rest.
Kirill: sections are "one of the core components"; keep "a bucket for distractions" folded by
default; place a stem cell "when there's enough signal"; and "we want minimal reordering. We just
want insertion usually", with no major reorganisation unless the person asks. The prompt now makes
topic sections the layout, keeps one `distractions` section labelled Distractions and collapsed for
work outside the person's focus, places new work once its messages make the subject clear, adds a
new section where no existing row changes section, and moves a placed row only for a strong reason.
A session that needs the person (review, approval, an answer) is nested under its row, expanded,
and taken out again afterwards. A move limit per batch came first; it is replaced by consent (see
below). In the first live run Prioritizing still filed related work beside a row in the default
Tasks section instead of making a topic section; the prompt now says Bots and Tasks are defaults,
not topics. The prompt was rewritten shorter, from about 9,600 to about 5,000 characters.

## Larger changes are proposals the person accepts

Kirill: "We should not just completely replace the sidebar without the consent of the person.
Similar style to Arc." Prioritizing's own batches now apply only small changes
(`reviewDirectOperation`): new work's first placement, the folded Distractions section, its own
row, and what is nested under a row (sessions, attachments, `expanded`). Everything else is dropped
with a note naming `propose_sidebar`, unless the person asked in their own words. A proposal is a
`sidebar_proposal` artifact whose version 1 is the sidebar it was drafted from, shown inline at
full height in Prioritizing's conversation. The person edits it live through the proposal
operations route, and the aspects they set are recorded on the proposal so Prioritizing's
revisions keep them (`reviewProposalOperations`). Accepting applies the difference between its
first and latest version as the person's batch, rebased one operation at a time, so what the person
accepted is theirs; declining changes nothing. At most one is open.

Kirill also asked it to "offer to completely archive the stuff that looks completed based off the
agents' history" and to put unfinished quiet work "in a new section called Stale". A proposal may
carry a `<happy-section id="archive" label="Archive"/>` block of top-level task rows that are
neither new nor active in the last two hours; accepting archives those tasks with the person's own
archive authority and leaves the block out of the sidebar. `Stale`, exactly, is the one age label
Prioritizing may use, and never a required one. The heuristics (finished means the last reply
reports it done, the person acknowledged or never followed up, and nothing waited for two days)
live in the prompt. Kirill also suggested a recipe for the prompt; this repository has no recipe
runtime that carries a system prompt and tool set, so the prompt stays in
`formatPrioritizingInstructions`, and the example arrangement in it is advice, never a rule the
daemon enforces.

## What evaluation replays taught the prompt

Replays on real sidebars (Opus, 21 and then 18 runs) showed proposals that folded work active
minutes earlier, put bots, shared lists, and finished tasks into Stale, kept a 17-row "Active"
catch-all, moved rows the person kept above the separator, moved the separator to the end, left 16
to 19 rows shown, and pasted the proposal's tag into replies; none offered clearly finished tasks
for archiving, because the prompt said never to touch rows the person placed, which mirroring made
nearly all of them. Each of these was first enforced by the daemon, and the rules fought: guarding
a kept row's section blocked renaming the catch-all over it, and one run took 7 revisions and 31
dropped edits. They are all prompt guidance now (see the first learning). The prompt lets a
proposal regroup and fold rows the person placed, since accepting is their consent; keeps what
they put above a separator and rows below every separator; asks it to section an unsectioned
sidebar or a catch-all (Kirill: "if it's not sectioned, probably should offer to section it") and
fold quiet sections until within budget; sends finished work to Archive and only unfinished tasks
to Stale; and asks for a one-sentence reply saying what changed, since replies ran 80 to 250 words.
`propose_sidebar` returns the proposal's ID without its reference tag, and `list_sidebar` marks
rows with nothing to read.

## Prioritizing shows its own row, once

Notes in Happy's chat interrupted the main agent: "the focus agent normally should never bother the
main Happy agent". Prioritizing has a row of its own (role `focus`, target kind `agent`), which is
how the person learns a proposal exists. The daemon makes the space but never puts it in the
document; Prioritizing inserts it, even during the seed, whenever it finds it missing, unless the
person removed it. Inserting it twice is a duplicate ID. A Prioritizing from before its row gets
the space on the first start of a newer daemon, and one upgrade notice; what to do from there it
decides from its own conversation. Archiving Prioritizing removes its row.

On Kirill's install new work kept going in right after Happy, so the row slid down to third and
further: "why the focus agent does not show up under my happy agent". A daemon anchor and a startup
repair that moved the row back were tried and removed, since where the row stands is
Prioritizing's call (Kirill: "it should move ITSELF"). The prompt keeps the row right under Happy
unless the person put it elsewhere, moving its own row applies without a proposal and is never
capped, and a row the person placed is theirs. Raising `PRIORITIZING_REVISION` when the
instructions change tells each running Prioritizing once, on the next start, to check the sidebar
against them, starting with its row.

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

## Batch notes are one factual line in Prioritizing's conversation

Kirill and the UX review asked for terse notes such as "Put Preview viewer release in Releases."
with no narration; folded work is "tucked away", never "Older", because quiet is not done. Prioritizing no longer writes free text: the note is composed from the batch's
own diff, so it can only describe what moved; a batch of several moves names two and counts the
rest. Prioritizing gives no reasons: a cheap model's clause ("Hid Quick Sanity Check finished
one-off check.") broke the line, and nothing else read them.

## Events wake Prioritizing; attention does not

Batches once waited for a calm moment: the client reported `interacting` and `calm`, and the daemon
fell back to five idle minutes. Rows still moved under a person reading between clicks, and work
sat unplaced while they kept typing. Once larger changes needed consent, the hover gate protected
nothing, and Kirill asked for it to go: Prioritizing is now woken by events and its changes apply
when its turn ends. The person's committed sidebar changes, new work or sessions appearing, new
work's first message, proposal edits and decisions, placement requests, and Tidy wake it; other
notices wait for the next wake. Its own writes never wake it, so it cannot loop. A wake waits two
seconds for the rest of its burst, a wake during a turn waits for that turn to end, and the
fifteen-second check only picks up what a restart or a lost timer left. `POST /v0/spaces/attention`
is still accepted so older desktops keep working: `calm` applies a waiting batch, `interacting`
does nothing. Every row a batch folds out of view is named in its note, because that is the change
the person can no longer see.

## Notices stay owed until a run succeeds

Live, a Prioritizing whose model had no credentials failed nine runs in a row, and every notice
from that time was lost: a brief cleared its notices when the delivery was enqueued. A brief now
moves them to `sidebarBriefSent`; a run that ends well clears them, and a failed run puts them
back for the next wake. A failure never wakes it by itself, so a broken model cannot spin.

## Work another agent creates is placed too

Tasks made with `create_task` sat under Happy forever: only the person's messages were briefed, a
task's first message arrived before its row existed, and the prompt said to wait for a first
message. A new row's notice now carries its title and wakes Prioritizing, the first message of the
conversation counts whoever wrote it (a later report from a subtask does not), a row made after its
first message is told that message at once, and the prompt says pending work is placeable once its
subject is clear.

## A set that changes nothing is still the person's

The desktop sends `set {expanded: true}` for "Show subtasks" on a row that may already be open. The
client drops an operation that changes no value, so the person was never recorded as the fold's
author and Prioritizing could fold the row later. The person's requested `set`s now record their
named aspects as the person's even when nothing changed (`affirmSidebarAuthorship`).

## A row's `working` follows its conversation

`working` was computed only when something else about the row changed, so a row kept shimmering
after its conversation stopped, aborted runs above all. The module now listens for `loop.started`
and `loop.settled` and, 300 ms after the first of a burst, publishes every row whose target is that
conversation with a greater version and `working` read then, after the settled run has left the
journal's active runs. It publishes even when it last published the same value, because every row
event carries `working` live: the naming update during a run, for one, already showed the row
working. The row's `updatedAt` stays, so folded rows keep their order.

## People who never opted in are untouched

Spaces is an experiment, and a person who has not turned it on must see the daemon behave exactly
as before. The first sidebar read or write, or the first stem cell creates
the person's owner state and sidebar document; Prioritizing additionally requires the person's
Stem Cells setting as described below. Everything else (lifecycle
inserts, new-session and new-work briefs, the wake check, batch notes) works from that
state and so does nothing without it. The `request_space_placement` tool is offered only to
conversations whose person has a live Prioritizing, and asking for a placement never creates an
owner.

Naming follows the same line. Short subject names (one to three words from the chat's own model)
were first made the naming for every chat, and that changed every person's task, bot and workspace
names. Now only a stem cell is named that way: `createStemCell` marks its agent through
`TitlesModule.nameBySubject` in the same transaction, and every other chat keeps the standard
naming it always had.

## Prioritizing follows each person's Stem Cells setting

Reading the sidebar used to activate Prioritizing, and switching Stem Cells off in the desktop
left that helper running. Prioritizing now requires the literal boolean `true` in the person's
`happy-desktop.experiments.stemCells` user setting. Missing, cleared, false, or malformed values
leave it off. A sidebar document can still exist without the helper. Team lookups resolve the
row owner's settings, never whichever caller happens to be processing an event.

Disabling atomically clears pending layout edits and notices and aborts that person's helper.
A persisted generation invalidates already queued durable notices even if the person enables it
again. Creation, briefing, tools, artifact writes, and batch application all check the setting;
restart also stops disabled helpers. Ordinary task, bot, and chat naming remains independent, and
existing names are never changed by the toggle.

## The sidebar format is marked by a migration

`006-sidebar-document-format` changes no data a reader depends on (it drops the old visibility
reports), but its key is what an older build that knows Spaces sees as unknown, so it refuses the
database cleanly instead of failing on the flat document. Any later change older builds cannot
read needs its own marker migration. `007-sidebar-operations` is the next: it adds the mutation
log and turns each person's manual lists into authorship (a placed or named item keeps place and
label, a set switch keeps its fold). Queued Prioritizing proposals were whole documents and are
dropped with a note rather than converted, since converting would need the version each was
written against; Prioritizing reads the sidebar again at its next notice.

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

## New work is named by the client, so it appears in the click's frame

The daemon answered in about 20 ms, yet the desktop could select the new chat and focus its
composer only after the reply, because the daemon chose the task, workspace, and agent IDs. Kirill:
"must be instant - so must happen on the client i guess? hmmm we need optimistic writes". New work
now also takes `taskId`, `workspaceId`, and `agentId`, checked exactly as task creation checks
them, and health advertises `stemCellIdentities`. The space ID stays the only retry key: a replay
must name the same conversation or is a conflict, and a child ID arriving under a new space ID is
always a conflict, never a second row over an existing task.

## Unnamed work has no title, and untouched work can be removed

The desktop labels a row "New" itself, so a task still carrying its placeholder name is served
with `title: null` instead of "New Task"; notes call it "a new chat". Rows
are otherwise never deleted, but a stem cell the person left without writing anything is not
work: removing it (`PATCH` with `removed: true`) deletes the row and archives its task, and is
refused (409) as soon as the conversation holds any message.

## Section names are unique by the prompt

On clean data a cheap model created a "Movies" section for each of two new rows in one turn. The
daemon once refused a section label that repeated another's; it now only refuses duplicate IDs,
and the prompt says labels are unique.

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
an ordinary row whose target is Happy's bot. The prompt keeps Prioritizing off it, and the person
may drag it. Sessions under a row are part of the document, not drawn by clients from `subtasks`;
worktrees are still drawn by clients under the session that works in them.

## The person's changes are PATCHes; tidy is one message

Separate move, discard, and collapse routes were replaced by `PATCH /v0/spaces/:id` (`sectionId`,
`afterId`, `visibility`, or `removed`) and `PATCH /v0/spaces/sections/:id`, like other resources.
Tidy had its own apply-at-once machinery; it is now only the automatic message "Tidy the sidebar
now." in Prioritizing's conversation, and its changes apply when that turn ends like any other
batch.

## The organiser is Prioritizing, a real subtask of Happy

The organiser was a hidden child agent called "Sidebar manager", invisible in Happy's tree. It
then became a conversation subtask (`createConversation`, with its own metadata), which Kirill
still saw as not a true subtask. It is now made through `SubtasksModule.create`, exactly as Happy
makes any subtask, with an opening task and nothing special-cased; it is found by the agent ID in
the person's bookkeeping. It is created lazily with the person's first stem cell — not on seed or
the first read — and before that briefs and tidy do nothing. As an ordinary subtask it reported every reply into
Happy's chat, so it is created `unreported`, and batch notes go to its own conversation: Happy's
chat hears nothing from it.

## Recent work stays in view by the prompt

Six tidy requests in a row led a cheap model to hide every row but Happy, including a task that
was running. The daemon then refused to fold or hide work active in the last two hours; that rule
is gone, and the prompt says never to fold away recent work. Folding is a proposal the person
accepts, so a bad fold reaches the sidebar only with their consent.
