# Spaces persistence

Five tables: rows (unique per owner and primary content), sections, pending changes (one per
owner and target, ordered by sequence), applied batches, and each owner's bookkeeping. Rows and
sections are compare-and-swap on their version.

Owner bookkeeping also holds the sidebar artifact ID, manual and first-placement guards, and
bounded pending exact-edit versions. The artifact ID has a unique lookup index. Viewport
observations stay in memory; coalesced delivery intents use the existing durable brief path.
