# Durable Functions learnings

## Equal timestamps retain insertion order

Random call IDs broke ties between calls created in the same millisecond. A blocked Surface
notification could therefore deliver a membership update before its creation, both live and after
restart. Dispatch and recovery now use SQLite's existing row ID as the insertion sequence, held
only in internal stored-call metadata. Invoke requests, results, executor envelopes, and table
schemas are unchanged. Post-commit dispatch rereads the stored call to obtain its sequence and
skips a call that cancellation already removed.

Recovery carries the numeric sequence rather than looking up the previous call ID. An incompatible
last row of a full page may already be deleted before the next read; its captured sequence still
selects the next page without skipping work or replaying earlier calls.
