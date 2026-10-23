# Native Python worker

Happy builds the Monty source revision pinned in `source.json`. Its Node native addon and worker
protocol remain at the published `@pydantic/monty` version. Source-mode modules and standalone
Agent binaries use the same built worker, in
`packages/happy-agent-modules/native/target/<platform>-<architecture>/`.

On macOS and Linux, `owner.patch` installs the thread in `owner.rs` before the synchronous IPC
request loop begins. The thread observes the existing stdin pipe without reading protocol bytes.
macOS uses `EVFILT_READ | EV_CLEAR` and `EV_EOF`; Linux blocks in `poll` for hang-up without asking
for input readiness. When the native pool's writer closes, including after SIGKILL of the daemon
or test harness, the worker exits even if the interpreter is busy. The watcher does not set a CPU
budget, recycle workers, or signal a remembered process ID. Ordinary interpreter limits and pool
recycling remain the callers' policies. This does not change in-flight session cancellation, which
still settles under the native pool's existing request watchdog.

Windows retains the existing GNU-built worker that avoids `VCRUNTIME140.dll`; the Unix owner
watcher does not apply there. The build verifies that the Windows worker imports only system DLLs.

Build once before source workflows, Monty Code Mode, or tests that execute Python:

```sh
pnpm --filter @slopus/happy-agent build:native:monty
pnpm --filter @slopus/happy-agent test:native:monty
```

The opt-in long-call check spends at least 65 worker CPU seconds across OS callbacks in one
continuous Python call, with the existing six-second request watchdog and no cumulative execution
limit. Run it when the machine can spare one core; it is not part of routine tests:

```sh
node packages/happy-agent/scripts/verify-native-monty-long-run.mjs
```

Build machines need Git, the pinned Rust toolchain, and the platform linker. Windows additionally
needs the GNU toolchain described in the scripts README. `HAPPY_MONTY_SOURCE_DIR` can select an
existing checkout at the exact pinned commit; only the exact tracked owner patch is accepted.
Build output and source caches are ignored by Git. End users of standalone Agent binaries need
no compiler. Missing source-mode output fails with the build command instead of using an upstream
worker without owner cleanup. An explicit `binaryPath` or `MONTY_BIN` remains a caller-selected
override and is responsible for its own lifecycle behavior.
