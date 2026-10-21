# Automatic task participation — learnings

## Default participation belongs to each enrolled person

People previously saw only tasks they created or joined manually. Every enrolled team member now
joins active tasks by default, including existing tasks, unless their `tasks.autoJoin` setting is
boolean `false`. Guests never acquire shared task memberships. Disabling preserves the person's
list; re-enabling fills missing active tasks. Explicit leaves persist until a manual join so a
restart or preference change cannot undo a person's decision to close a task.

The coordination lives in its own module because Team already depends on Tasks. Making Tasks
depend on user settings would close that cycle. Transactional events keep enrollment, applied
preference changes, and task creation atomic with participation while the settings store stays
opaque. Startup catch-up uses Durable Functions and bounded batches that recheck the preference.
