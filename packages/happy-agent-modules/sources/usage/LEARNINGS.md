# Usage learnings

## Publish context after every measured inference

A turn may contain several provider inferences separated by tool execution and compaction. The
current context therefore updates inside the turn, not only when the turn settles. Each inference
completion durably stores and publishes its exact input-plus-output measurement in the same
transaction as the inference usage record. The turn record remains a final reconciliation point,
and successful compaction still clears the measurement until the replacement is measured.

## Agent usage tools are structurally self-scoped

The agent-scoped `get_usage` schema omits `target`; rejecting another agent only after execution
advertises a capability the caller does not have and invites guaranteed failures. The host-neutral
tool keeps its target field for collection administration, while an agent tool can read only the
agent identity captured when it was constructed.

## Service tiers are opaque provider identifiers

Usage preserves a concrete tier ID reported by the agent context without interpreting it. Ordinary
provider service has no tier and is omitted; clearing a tier happens before the usage boundary.

## Installation windows read hourly totals, not history

`GET /v0/usage` summed its hour, day, week, and month windows by parsing every record in the last
30 days. On a long-lived installation with 130,000 such records, that took over 600 ms. It blocked
the daemon's only thread, so every concurrent request waited, including health checks. The desktop
asks for usage whenever a conversation opens or a run finishes. Hourly provider/model totals now
answer each window's whole hours, and a start-time index answers the partial hour at each window's
start. The result is exact and costs a few milliseconds, whatever the history length. Record
triggers keep the totals so no insert, delete, reset, or rewrite can bypass them. Each bucket counts
records whose duration contradicts their span, so the integrity check runs once at write time
instead of on every read.

## Page-sized run reads are one query

A history page asked for each run's usage separately, adding one query and span per run.
`readRuns` answers up to one history page of runs with a single grouped query and returns
exactly what `readRun` would for each, in the given order, including empty usage for unknown
runs. The same duration-integrity check and agent-access rule apply.
