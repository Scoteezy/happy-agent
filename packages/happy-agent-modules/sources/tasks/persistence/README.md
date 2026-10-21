# Automatic task membership persistence

These queries select missing active memberships in bounded batches and maintain explicit leave
exclusions. Tasks combines them with membership events inside the caller's transaction. Explicit
joins clear exclusions; automatic joins never clear them.
