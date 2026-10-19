# Spaces — learnings

## Notes in Happy's chat are one factual line

Kirill and the UX review asked for terse notes such as "Moved Preview viewer release to Older."
with no narration. The manager no longer writes free text: the note is composed from the batch's
own diff, so it can only describe what moved; a batch of several moves names two and counts the
rest. Reasons the manager gives stay on each change in the diff and never reach the note: a
cheap model's clause ("Hid Quick Sanity Check finished one-off check.") broke the line.

## The client decides when the person is calm

Applying a batch on every focus change moved rows while the person was still navigating. Focus
reports now only defer the idle rule. The client signals `interacting` (hold everything) and
`calm` (a gesture finished, or idle); only `calm`, idle, or a tidy the person asked for apply a
batch, and never while `interacting` or mid-manager-turn. Applying a batch never changes what
the person has selected.

## One row per piece of work, enforced by the store

A stem cell made before the sidebar was ever read collided with its own seeded row: the seed saw
the new task, the stem cell took that row over, but the emptied row kept its content key and the
insert failed. Every write now recomputes the key from the row's contents, and seeding is an
insert-if-absent on `(owner, content key)`, so concurrent or repeated seeds can never make a
second row for the same work. Rows that merely share a title are different conversations and are
never merged.

## Unnamed work has no title, and untouched work can be discarded

The desktop labels a row "New" itself, so a task still carrying its placeholder name is served
with `named: false` and an empty title instead of "New Task"; notes call it "a new chat". Rows
are otherwise never deleted, but a stem cell the person left without writing anything is not
work: discard removes the row and archives its task, and refuses (409) as soon as the
conversation holds any message.
