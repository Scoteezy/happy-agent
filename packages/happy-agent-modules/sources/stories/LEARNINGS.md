# Stories — learnings

## Off means absent, byte for byte

Stories are experimental and off by default. A person without the setting must not be able to
tell the feature exists: no tool, no change to the system prompt or tool schemas, no events, and
`404 not_found` from every route, exactly as for an unknown route. Only the JSON value `true`
turns it on, so a stray string or number never does. Keeping the `story` artifact type out of
the artifact tools' schemas (`artifactToolTypeSchema`) is part of this: adding it there would
change every opted-out person's tool definitions.

## A story is an artifact no ordinary writer can touch

A story's content is versioned as a `story` artifact so it gets versions, uploads, content
storage, and tombstones for free. The artifact catalog, artifact tools, and artifact routes must
not become a side door around the story's own rules — author-only drafts, Post naming a version,
audience-scoped reads. So ordinary artifact writes refuse story artifacts, the catalog leaves
them out, and artifact `artifact.*` events are not emitted for them; readers learn of stories
through `story.*` events instead.

## Events are worked out after commit on their own context

Each `story.*` event carries every reader's own view (`seen`, `myReaction`, `viewCount`), so it
is computed per audience member after the write commits. Computing it inside the commit
callback with the writing context failed with "the agent storage transaction carried by this
context has ended". The module now detaches a named `stories-events` context with the agent
database in `beforeStart` and works events out there, chained one after another.

## The agent drafts; only the person posts

"Post it" means "make me a draft". The tool never posts and is not reviewed in Auto, because a
draft is visible only to its author. Read only refuses it. A revision names the `baseVersion`
it revises; if the person edited the draft since, the call fails and shows the current draft so
the agent can start from the person's edits rather than overwrite them.

## Frames reference assets, never copy them

Frames name chat media or an artifact file by ID. When the asset is gone, the frame stays and
reports `available: false`; a story with no available frame cannot be posted. Only media the
person uploads in the editor becomes a file of the story artifact itself.
