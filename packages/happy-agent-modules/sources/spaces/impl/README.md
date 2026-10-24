# Spaces implementation helpers

- `applySpaceChanges` — applies queued changes to a sidebar in memory and returns the stored
  updates and the from/to diff. Missing targets are dropped; empty new sections are not made.
- `composeSpaceBatchNote` — Happy's one-line note, built from the diff.
- `formatConversationBrief` — the short calm-brief notice of one message the person wrote in new
  work, with the agent's reply before it, or of a session under it that stopped.
- `formatPrioritizingInstructions` — Prioritizing's whole system prompt, with the tidy rules and
  the icon slugs.
- `selectPrioritizingRoute` — the model Prioritizing runs on: the default from Settings.
- `sidebarLayout` — the seed document, where new work goes, what is shown, where an item stands,
  and which items came to sit under another heading.
- `applyPrioritizingOperations` — applies Prioritizing's operations one by one through the shared
  rebase, dropping each one `reviewPrioritizingOperation` refuses, or that moves placed rows past
  the batch's move limit, with a note; also draws queued proposals into the document Prioritizing
  reads.
- `reviewPrioritizingOperation` — why one of Prioritizing's operations may not apply: it would
  override the person's authorship or move Happy, new work, or recent work.
- `recordSidebarAuthorship` — who last set each node's place, fold, label, fold ribbon, and
  widget content after a batch.
- `migrateLegacySidebar` — the one-time rewrite of a first-grammar document.
- `sidebarStyles` — the grammar as `get_sidebar_styles` returns it.
- `spaceIconSlugs` — the bundled icon library's slugs; clients ship the artwork.
- `spaceRefKey`, `spaceOrderKeyBetween` — row identity and fractional order keys.
