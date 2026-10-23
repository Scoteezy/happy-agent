# Native Windows file-index library

FFF's upstream Windows library requires VCRUNTIME140.dll. Happy builds the C API
at the same release as the installed `@ff-labs/fff-node` (0.11.0) with the Windows
GNU toolchain and upstream's default `ripgrep` feature, its pure-Rust walker and
globset matcher. The optional Zig/zlob optimization is not enabled. No source
patch or API replacement is required. The build rejects external DLL imports and
embeds the result plus its MIT license only in the Windows standalone artifact.
Upstream pins no Rust version; the recorded 1.95.0 toolchain builds 0.11.0 with
its lockfile. Bump `source.json` together with the SDK; verification rejects a
library whose version differs from the installed SDK.

Run `pnpm --filter @slopus/happy-agent build:native:fff` with the recorded Rust
toolchain and GNU C compiler available. `HAPPY_FFF_SOURCE_DIR` can reuse a clean
checkout of the pinned commit. The upstream Cargo.lock is used with `--locked`.
The output is `native/target/win32-x64/fff_c.dll`.

Run `pnpm --filter @slopus/happy-agent test:native:fff` to exercise the installed
JavaScript SDK against this exact library under Node and Bun in isolated fixtures.
It covers scanning, Unicode filenames, fuzzy search, globbing, grep, changes and
handle cleanup. Only the fixture's copy of the SDK bundle has its binary resolver
rewritten, as the standalone builder does; node_modules and the running daemon
are untouched. macOS/Linux continue using their upstream assets.
