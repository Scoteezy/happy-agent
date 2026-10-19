# Spaces

One flat sidebar per person, kept tidy by Prioritizing, a subtask of Happy.

```text
person ── GET /v0/spaces ───────────────┐
        ── stem cell / PATCH row, section┤  explicit actions apply at once
        ── attention: interacting|calm ─┤
                                        ▼
                               SpacesModule ── rows, sections, pending changes, batches
                                        ▲
Prioritizing (subtask of Happy) ────────┘  place / visibility / section: queued
  list_sidebar, set_space_icon, ...        icon: applied at once
other agents ── request_space_placement ─► briefed to Prioritizing
tidy ── "Tidy the sidebar now." ─────────► briefed to Prioritizing
```

A **space** is one row: Happy (first, and never moved by Prioritizing) or an item wrapping a task,
bot, or Surface. The API shows Happy as an ordinary bot row; the internal `happy` role only finds
it. A row has a section or none (directly under Happy, where unplaced work waits), an order key
inside that place, a placement (`pending` until Prioritizing places it) and a visibility
(`shown`, `folded` into the Older part at the end, or `hidden`). Sections are flat labels with a
unique name and an optional visible count. The HTTP contract is the Spaces chapter of
`packages/happy-agent/API.md`.

Rows carry the owner's ID (`standalone` on a standalone installation), so the model already
fits several people even though only the owner's own sidebar is exposed.

## New work

A stem cell is a fresh unnamed task — its own folder, no project, no bot — wrapped in a row in
the same transaction. Without a section it waits under Happy as `pending`; from a section's `+`
it is settled at the top of that section. Its first human message briefs Prioritizing, which
names an icon at once and queues the placement. Removing a stem cell nobody wrote in archives its
task.

## Prioritizing

One long-running conversation subtask of Happy per person, made through
`SubtasksModule.createConversation` on first use and made again if the person archived it. It
appears in Happy's subtasks like any other. It runs on the cheapest model of Happy's account and
its whole tool array and system prompt come from this module, so it can do nothing else. Briefs
reach it through the `spaces.briefPrioritizing` durable function, committed with whatever caused
them. Tidy is one such brief and nothing more.

## Calm batches

Every move, visibility change, and section change Prioritizing makes is queued, one entry per
target, and the latest word wins. A batch applies in one transaction when the person is calm:
the client reports `calm` after a navigation gesture or when idle, or two minutes pass with no
sign of work. Nothing applies while the client reports `interacting`, or while Prioritizing is
mid-turn. A move the person asked another agent for in their own words applies as soon as
Prioritizing finishes. Each batch
records its diff (from and to per row), writes one line into Happy's chat built from that diff,
and is published as `batch_applied`. The person's own `PATCH` removes any queued change of that row.
