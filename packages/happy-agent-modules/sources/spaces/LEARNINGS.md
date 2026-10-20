# Spaces — learnings

## Notes in Happy's chat are one factual line

Kirill and the UX review asked for terse notes such as "Moved Preview viewer release to Older."
with no narration. Prioritizing no longer writes free text: the note is composed from the batch's
own diff, so it can only describe what moved; a batch of several moves names two and counts the
rest. Prioritizing gives no reasons: a cheap model's clause ("Hid Quick Sanity Check finished
one-off check.") broke the line, and nothing else read them.

## The client decides when the person is calm

Applying a batch on every focus change moved rows while the person was still navigating, so
there is no focus report. The client signals `interacting` (hold everything) and
`calm` (a gesture finished, or idle); only `calm`, idle, or a move the person asked for in their own words
apply a batch, and never while `interacting` or mid-Prioritizing-turn. Applying a batch never changes what
the person has selected.

## One row per piece of work, enforced by the store

A stem cell made before the sidebar was ever read collided with its own seeded row: the seed saw
the new task, the stem cell took that row over, but the emptied row kept its content key and the
insert failed. Every write now recomputes the key from the row's contents, and seeding is an
insert-if-absent on `(owner, content key)`, so concurrent or repeated seeds can never make a
second row for the same work. Rows that merely share a title are different conversations and are
never merged.

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

Removing untouched work archives its task, so owning a sidebar row is insufficient authority.
The API checks the same task-owner or team-owner policy as task archival inside the transaction
that removes the row, before any row or task changes.

## The API is only what the desktop uses

Kirill reviewed the contract before it was specified. Everything the desktop did not read was
removed rather than kept "in case": the organiser's row, a row's own name, section context lines,
batch reasons and section diffs, revisions, the pending-batch count, focus reports, single-row
reads, and the organiser-model setting. Space events carry whole objects, so they need no
`previousVersion`.

## Happy is an ordinary row

A `role` field and Happy-specific IDs made clients special-case Happy. The API now shows Happy as
an ordinary row whose target is Happy's bot, first by `orderKey`; new work goes right after it.
Prioritizing never moves or hides it, but the person may drag it. Task trees (subtasks and
worktrees) are not part of a space: clients build them from the agent's `subtasks` and the
workspaces' `creatorAgentId`/`subtaskAgentId`, which they already hold.

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
came back to life meanwhile. Untouched new work has no activity, so it may still be hidden.
