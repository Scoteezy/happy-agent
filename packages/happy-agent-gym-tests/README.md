# Happy Agent gym scenarios

This package holds the end-to-end scenarios for the Happy Agent daemon. Every scenario starts the
real daemon through `createAgentGym` from [`@slopus/happy-agent-gym`](../happy-agent-gym/README.md)
and drives it over the daemon's own socket with `@slopus/happy-agent-client`. Only model inference
is scripted and the machine is emulated; the daemon, routes, agent loop, tools, permissions,
persistence and event journal are the product.

Read the `@slopus/happy-agent-gym` README for the harness API: `createAgentGym` options, scripting
the model, fixtures, waiting for state, and disposal.

## Layout

```text
packages/happy-agent-gym-tests/
├── runGym.ts                   Runs every scenario on Bun, then the Node lane
├── nodeLane.ts                 The scenarios and unit tests that must also pass under Node
├── scripts/runHappyApiSuite.ts Runs the exhaustive Happy Agent API gate
└── tests/                      One behavior per file, named after the behavior
```

Files named `happy_api_*` cover the Happy Agent API contract in
[`packages/happy-agent/API.md`](../happy-agent/API.md). The `happy_api_chaos_*` files replay
deterministic chaos seeds; each seed runs in its own process.

## Running scenarios

The gym consumes three built packages, so build them first:

```sh
pnpm --filter @slopus/happy-agent-modules build
pnpm --filter @slopus/happy-agent-compute build
pnpm --filter @slopus/happy-agent build
```

The gym runs on Bun, the runtime Happy Agent ships on, at the version `mise.toml` pins. Every
Vitest worker checks its runtime before a scenario starts and fails when it is Node or another Bun,
so a launcher that silently falls back to Node cannot pass for a Bun run. The `vitest:bun` script
starts Vitest on the pinned Bun with `--bun`.

Run one file while developing:

```sh
pnpm --filter @slopus/happy-agent-gym-tests vitest:bun run tests/happy_api_subtasks.test.ts
```

Run one chaos seed:

```sh
API_CHAOS_SEED=S007 pnpm --filter @slopus/happy-agent-gym-tests vitest:bun run tests/happy_api_chaos_sync.test.ts
```

`cli_reload_reports_its_phases_and_releases_a_waiting_read.test.ts` runs the real CLI and daemon
as separate processes in a throwaway Happy home, with inference served over the daemon's gym HTTP
seam. It uses `HAPPY_AGENT_RELOAD_GYM_BINARY` when set, else the binary from
`pnpm --filter @slopus/happy-agent build:bun` when present, else the built CLI on the gym's runtime.

Run every scenario with `pnpm test:gym`. It runs every scenario on Bun, then the Node lane;
`pnpm test:gym:node` runs the Node lane alone. The exhaustive API gate, `pnpm test:gym:api`, also
verifies the minimum scenario count and every chaos seed; it takes a long time and runs only when a
human asks for it or a release or API-contract milestone closes.

## The Node lane

Source-mode daemons and some tools still run the daemon's code under Node, whose streams behave
differently from Bun's; Node may flush a blocked write without emitting `drain`, for example.
[`nodeLane.ts`](nodeLane.ts) names the scenarios that must also pass under Node — transport and
streaming, the event stream, the run lifecycle, and a representative core sample — together with
the `@slopus/happy-agent-modules` transport unit tests. Terminals open only under Bun, so no
scenario in the lane opens one; `terminals_are_unsupported_without_bun.test.ts` instead proves
that Node answers `501 unsupported`, and runs only in the Node lane.

Run one file under Node by declaring the runtime, so the worker check holds it to Node:

```sh
HAPPY_GYM_RUNTIME=node pnpm --filter @slopus/happy-agent-gym-tests exec vitest run tests/happy_api_platform.test.ts
```

Add a scenario to the lane when it proves stream, event, or run-lifecycle behavior that Node could
break differently from Bun.

## Writing a scenario

- Name the file after the behavior it proves, for example
  `happy_api_tasks_follow_per_user_order.test.ts`.
- Register each gym for disposal immediately after creating it.
- Wait for observable state instead of sleeping.
- Assert on API responses, events, files and inference requests rather than daemon internals.
- When fixing a bug, reproduce it here first, then make the same scenario pass unchanged.
