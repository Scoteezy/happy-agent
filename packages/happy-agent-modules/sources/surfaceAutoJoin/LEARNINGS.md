# Surface autojoin learnings

## Sidebar participation follows its own preference

Surface lists previously required manual joins. Team members now join existing and new catalog
Surfaces by default, independently of task participation, unless `surfaces.autoJoin` is exactly
false. Explicit leaves persist across restarts and toggles until a manual join. Disabling keeps
memberships, and creators always join. Guests, standalone mode, and withdrawn types stay outside
the policy; joining a reference never grants access to its target.

Clients require advertised protocol 31 before offering the switch: an older daemon's opaque
settings support accepts the key without implementing participation. The health protocol is
already an integer, so this guarantee needs no new wire field or client schema.

## Catch-up composes with its trigger

Creation, enrollment, and preference changes commit with their derived memberships. Startup uses
durable batches of 100, selecting missing non-excluded heads in SQL before decoding, and checks
the setting between batches. Surface creation reserves its notification before derived updates
so clients can replay a valid version chain.
