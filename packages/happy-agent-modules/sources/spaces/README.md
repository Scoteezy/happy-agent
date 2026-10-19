# Spaces

One flat sidebar per person, kept tidy by a hidden sidebar manager.

```text
person ── GET /v0/spaces ───────────────┐
        ── stem cell / drag / collapse ─┤  explicit actions apply at once
        ── attention: interacting|calm ─┤
                                        ▼
                               SpacesModule ── rows, sections, pending changes, batches
                                        ▲
manager (hidden child of Happy) ────────┘  place / visibility / section: queued
  list_sidebar, set_space_icon, ...        icon: applied at once
other agents ── request_space_placement ─► briefed to the manager
```

A **space** is one row: Happy (row one, always), the manager (never shown), or an item wrapping
content — a task, bot, Surface, artifact, conversation, or file. A row has a section or none
(directly under Happy, where unplaced work waits), an order key inside that place, a
placement (`pending` until the manager places it) and a visibility (`shown`, `folded` into
Older, or `hidden`; hidden is never deletion). Sections are flat labels with an optional
one-line context and an optional visible count.

Rows carry the owner's ID (`standalone` on a standalone installation), so the model already
fits several people even though only the owner's own sidebar is exposed.

## New work

A stem cell is a fresh unnamed task — its own folder, no project, no bot — wrapped in a row in
the same transaction. Without a section it waits under Happy as `pending`; from a section's `+`
it is settled at the top of that section. Its first human message briefs the manager, which
names an icon at once and queues the placement.

## The manager

One long-running hidden agent per person, a child of Happy, made on first use. It runs on the
cheapest model of Happy's account (or a configured one) and its whole tool array and system
prompt come from this module, so it can do nothing else. Briefs reach it through the
`spaces.briefManager` durable function, committed with whatever caused them.

## Calm batches

Every move, visibility change, and section change the manager makes is queued, one entry per
target, and the latest word wins. A batch applies in one transaction when the person is calm:
the client reports `calm` after a navigation gesture or when idle, or two minutes pass with no
sign of work. Nothing applies while the client reports `interacting`, or while the manager is
mid-turn. A tidy the person asked for applies as soon as the manager finishes. Each batch
records its diff (from and to per row), writes one line into Happy's chat built from that diff,
and is published as `batch_applied`. The person's own drag removes any queued move of that row.
