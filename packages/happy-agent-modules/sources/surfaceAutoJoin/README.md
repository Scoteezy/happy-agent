# Default Surface participation

Enrolled team members join every catalog Surface unless their independent `surfaces.autoJoin`
preference is exactly false. Creation, enrollment, and enabling run in the triggering transaction;
startup catch-up is a Durable Function that releases the database between batches of 100 and
rechecks the preference each time. Guests and standalone installations do not run this policy.

```text
Surface creation / profile enrollment / preference write
    -> SurfaceAutoJoinModule -> SurfacesModule -> membership + ordered events
Daemon startup -> durable reconciliation -> bounded membership batches
```

Surfaces owns eligibility, persisted explicit leaves, and each person's append order. Withdrawn
types never qualify. Reference membership grants no target rights. Existing memberships retain
their order and join time, and opting out removes nothing. The creator still always joins.

Protocol 31 advertises this policy. Generic user-settings support alone cannot guarantee it:
older daemons accept the opaque key without interpreting it, so clients require 31 before
offering the preference. The published client already reads the integer health protocol.
