# Native skill extraction

This directory owns the installed copy of the skills Happy Agent ships with. The repository-level
`skills/` directory is copied into the npm package at build time and embedded into standalone Bun
binaries. Daemon startup then synchronizes those shipped files into the configured Happy home,
where skill discovery finds them as `builtin` skills on the daemon's own machine.

```text
repository skills/ --> package dist/skills/ --+
                                               +--> <happy home>/skills/
repository skills/ --> standalone binary -----+
```

The destination is managed by the product. Files are replaced atomically and made read-only, and
anything the running release does not ship is removed, so a renamed or retired native skill does
not linger from an earlier release. The generic replace-and-prune logic lives in `managedFiles/`
and is shared with the documentation extraction.
