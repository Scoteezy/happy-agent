# Spaces persistence

Five tables: rows (unique per owner and primary content), sections, pending changes (one per
owner and target, ordered by sequence), applied batches, and each owner's bookkeeping. Rows and
sections are compare-and-swap on their version.
