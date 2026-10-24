# Spaces implementation helpers

- `applySpaceChanges` — applies queued changes to a sidebar in memory and returns the stored
  updates and the from/to diff. Missing targets are dropped; empty new sections are not made.
- `composeSpaceBatchNote` — the batch's one-line note in Prioritizing's conversation, built from the
  diff.
- `formatConversationBrief` — the short notice of one message the person wrote in new
  work, with the agent's reply before it, or of a session under it that stopped.
- `formatPrioritizingInstructions` — Prioritizing's whole system prompt, with the tidy rules and
  the icon slugs.
- `selectPrioritizingRoute` — the model Prioritizing runs on: the default from Settings.
- `sidebarLayout` — the seed document, where new work goes, what is shown, where an item stands,
  and which items came to sit under another heading.
- `formatConversationTurns` — what `read_conversations` returns for one conversation: its latest
  turns, oldest first, without tool calls, bounded.
- `applyPrioritizingOperations` — applies Prioritizing's operations one by one through the shared
  rebase, dropping each one `reviewPrioritizingOperation` refuses, or, without the person's words,
  `reviewDirectOperation`, with a note; also draws queued edits into the document Prioritizing
  reads.
- `reviewDirectOperation` — whether an operation is small enough to apply without a proposal: new
  work's first placement, the Distractions section, adding or moving Prioritizing's own row, or
  nested changes.
- `reviewProposalOperations` — Prioritizing's revision of a proposal, without changes to what the
  person set in it or archive offers that may not be archived; and the proposal's Archive block.
- `reviewPrioritizingOperation` — why one of Prioritizing's operations may not apply: it would
  override the person's authorship.
- `recordSidebarAuthorship` — who last set each node's place, fold, label, fold ribbon, and
  widget content after a batch; `affirmSidebarAuthorship` records the person's `set`s that changed
  nothing.
- `liftSidebarAttachments` — keeps attachments in the sidebar: a removed one moves to the top
  level after its row, and a leaving row's attachments move out before it goes.
- `migrateLegacySidebar` — the one-time rewrite of a first-grammar document.
- `sidebarStyles` — the grammar as `get_sidebar_styles` returns it.
- `spaceIconSlugs` — the bundled icon library's slugs; clients ship the artwork.
- `spaceRefKey`, `spaceOrderKeyBetween` — row identity and fractional order keys.
