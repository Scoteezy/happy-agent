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
