# Automatic task participation

`TaskAutoJoinModule` combines Tasks, Team, User Settings, and Durable Functions. It makes enrolled
team members join active tasks by default. Exported-bot guests and standalone installations do not
participate in this team policy.

```text
task creation / restoration ─┐
member enrollment ──────────┼─ transaction → preference check → ordinary task memberships
applied preference write ───┘
daemon startup → durable catch-up → bounded transactions using the same preference check
```

`tasks.autoJoin` is a per-user preference. Only boolean `false` disables participation. Clearing it
or enabling it joins missing active tasks while preserving order and explicit leaves. Disabling
does not remove any membership. Tasks owns leave exclusions and clears them on an explicit join.

Live changes and their memberships commit atomically. A stale preference write triggers no work.
Startup catch-up runs through Durable Functions and queries at most 100 missing task IDs per batch;
each batch reads the current preference inside the joining transaction. Joining emits the same
private membership events as a manual join, including the existing Happy connection projection.
