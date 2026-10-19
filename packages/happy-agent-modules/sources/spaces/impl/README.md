# Spaces implementation helpers

- `applySpaceChanges` — applies queued changes to a sidebar in memory and returns the stored
  updates and the from/to diff. Missing targets are dropped; empty new sections are not made.
- `composeSpaceBatchNote` — Happy's one-line note, built from the diff.
- `formatSpaceManagerInstructions` — the manager's whole system prompt, with the tidy rules and
  the icon slugs.
- `selectSpaceManagerRoute` — the model the manager runs on.
- `spaceIconSlugs` — the bundled icon library's slugs; clients ship the artwork.
- `spaceRefKey`, `spaceOrderKeyBetween` — row identity and fractional order keys.
