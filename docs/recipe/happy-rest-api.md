# Drive a Happy Agent over its REST API

Use this recipe when a script or another agent should talk to Happy Agent directly: find a bot,
project, or task, send its agent a message, and read the reply. It covers the few requests that
job needs. The authoritative contract is the installed release's `API.md` (in the source checkout,
`packages/happy-agent/API.md`); read it for every field and status this page leaves out. When
the two disagree, `API.md` wins.

## Reach the daemon and authenticate

A standalone daemon serves HTTP/1.1 only on a Unix socket, `~/.happy/agent/server.sock`, created
owner-only (Windows uses a named pipe instead). There is no TCP port. Every request except
`GET /v0/authentication` needs `Authorization: Bearer <token>`, and the standalone token is the
43-character file `~/.happy/agent/token`. Both live under `$HAPPY_HOME_DIR/agent` when that
variable is set. The daemon ignores the `Host` header, so any authority such as `http://localhost`
works.

The token is the daemon's full credential. Never echo, print, log, or paste it, and keep it out of
command arguments, where other processes can read it. Write it once into a private header file
and hand curl that file:

```sh
HAPPY_DIR="${HAPPY_HOME_DIR:-$HOME/.happy}/agent"
HAPPY_SOCKET="$HAPPY_DIR/server.sock"
HAPPY_AUTH="$(mktemp)"   # created with mode 0600
trap 'rm -f "$HAPPY_AUTH"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$HAPPY_DIR/token")" > "$HAPPY_AUTH"

curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
    http://localhost/v0/health | jq '{ready, status, version}'
```

Poll health until `ready` is `true`; while it is `"starting"`, every other route fails. In
another language, read the file into a variable and set the header in the HTTP client the same
way, without logging the request headers.

**Team mode** listens on TCP at the deployment's host and port instead, and creates no socket or
token file. Its bearer token is a short-lived WorkOS access token for the team's organization
(or, with `authentication = "jwt"`, the organization's own access token). The unauthenticated
`GET /v0/authentication` lists the sign-in methods. From a script, the simpler route is the
standalone daemon's connection proxy below: it mints, caches, and refreshes the organization
token itself, so the script never handles WorkOS credentials. `POST /v0/cloud/access-token` is
no substitute: its token carries no organization, so a team daemon rejects it. A team member
who has not completed profile onboarding is refused on most routes.

**Remote daemons.** `GET /v0/connections` lists the remotes configured on the local daemon. The
prefix `/v0/connections/:id/api/*` exposes a remote's complete API: authenticate to the local
daemon as above and it substitutes the remote's credential.

```sh
curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
    http://localhost/v0/connections | jq '.connections[] | {id, name, authentication}'

curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
    http://localhost/v0/connections/build-mac/api/v0/health | jq '{ready, version}'
```

Every path below works the same way behind that prefix. Remote IDs and event cursors belong to
that remote: use them only through the same connection. `503 remote_unavailable` and
`504 remote_timeout` come from the proxy; other errors are the remote's own.

## Find bots, agents, projects, and tasks

There is no global agent list. Agents are found through what owns them: each bot and each task
embeds its one agent as `agent`, and each project and workspace embeds its active root agents in
`agents`. `GET /v0/bootstrap/desktop` returns all of these in one response.

The Chief of Staff is the bot whose `systemKey` is `"chief_of_staff"`:

```sh
curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" http://localhost/v0/bots |
    jq -r '.bots[] | select(.systemKey == "chief_of_staff" and .status == "active") | .agent.id'
```

`GET /v0/bots` includes archived bots, so filter on `status`. The other lists:

```sh
# Projects and their root agents. Archived projects are included.
curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" http://localhost/v0/projects |
    jq '.projects[] | select(.status == "active") | {id, name, agents: [.agents[] | {id, title, status}]}'

# A project's workspaces and their agents; add &includeArchived=true for history.
curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" "http://localhost/v0/workspaces?projectId=$PROJECT_ID" |
    jq '.workspaces[] | {id, name, parentId, agents: [.agents[].id]}'

# Tasks; scope=joined lists only the caller's own, in their order.
curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" "http://localhost/v0/tasks?scope=all" |
    jq '.tasks[] | select(.status == "active") | {id, name, agentId: .agent.id}'

# One agent, including its recursive subtasks.
curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" "http://localhost/v0/agents/$AGENT_ID" |
    jq '.agent | {id, title, status, canSendMessages, pendingQuestionId}'
```

Bot and task workspaces never appear in `GET /v0/workspaces` or in project lists. Reach them
through their bot or task.

## Send a message

`POST /v0/agents/:agentId/send` takes `text` and a complete `mode`. `delivery` is optional:
`"queue"`, the default, waits for the current run, while `"steer"` is taken at the next inference
boundary. On an idle agent the two are the same. `id` is optional too, but supply one: it becomes
the message ID, and sending the same `id` again creates nothing and returns the existing message,
so a send whose response was lost is safe to retry. An `id` is 2–96 lowercase letters and digits
starting with a letter, such as a CUID2; a UUID is rejected.

`mode` has five required fields: `providerId`, `modelId`, `effort`, `serviceTier` (`null` for the
default), and `permissionMode` (`read_only`, `workspace_write`, `auto`, or `full_access`). Reuse
the agent's last mode, or fall back to the daemon's defaults:

```sh
MODE=$(curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
    "http://localhost/v0/agents/$AGENT_ID/mode" | jq -c '.mode')
if [ "$MODE" = null ]; then
    MODE=$(curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
        http://localhost/v0/config | jq -c '.config.defaults + {serviceTier: null}')
fi

MSG_ID="m$(openssl rand -hex 12)"
jq -n --arg id "$MSG_ID" --arg text "Summarize today's open work in three bullets." \
    --argjson mode "$MODE" '{id: $id, text: $text, delivery: "queue", mode: $mode}' |
    curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
        -H 'content-type: application/json' --data-binary @- \
        "http://localhost/v0/agents/$AGENT_ID/send" > sent.json
jq '{id: .message.id, status: .message.status, cursor}' sent.json
CURSOR=$(jq -r .cursor sent.json)
```

The response is `202` with the message, `"pending"` or already `"accepted"`, and the event
`cursor` at send. Everything the message causes, from acceptance to the end of its run, follows
that cursor.

## Read the reply

Follow events from the send cursor until the run that accepted the message finishes.
`run.started` and `run.boundary` list the accepted message IDs; `run.finished` (or a later
`run.boundary` whose `finishedRun` is that run) ends it:

```sh
RUN_ID=""
while :; do
    PAGE=$(curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
        "http://localhost/v0/events?after=$CURSOR")
    CURSOR=$(jq -r .cursor <<<"$PAGE")
    [ -z "$RUN_ID" ] && RUN_ID=$(jq -r --arg m "$MSG_ID" '[.events[].payload
        | select((.acceptedMessageIds // []) | index($m)) | (.run // .startedRun).id][0] // empty' <<<"$PAGE")
    [ -n "$RUN_ID" ] && jq -e --arg r "$RUN_ID" 'any(.events[];
        (.type == "run.finished" and .payload.run.id == $r) or
        (.type == "run.boundary" and .payload.finishedRun.id == $r))' <<<"$PAGE" >/dev/null && break
    sleep 2
done
```

Give the loop a deadline in real scripts. If a page answers `409 cursor_unavailable`, events
were lost: check the agent's `status` and history instead. Then read that run.
`omitToolData=true` keeps pages small:

```sh
curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
    "http://localhost/v0/agents/$AGENT_ID/messages?limit=20&omitToolData=true" |
    jq -r --arg r "$RUN_ID" '.runs[] | select(.id == $r) | .messages[]
        | select(.role == "agent") | .content[] | select(.type == "text") | .text'
```

History is grouped by run, oldest first. `before=<runId>` pages back and `after=<messageId>`
extends an unfinished newest run. For a live view, hold the Server-Sent Events stream open
instead of polling; it resumes from `Last-Event-ID` or `after`, opens with a `hello` frame, and
streams `message.delta` text as the model writes:

```sh
curl -sSN --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" \
    "http://localhost/v0/events/stream?after=$CURSOR" | grep --line-buffered '^event:'
```

## Pitfalls

- **`mode` is required and checked.** A missing or unrecognized field, an unknown or disabled
  provider and model pair, an effort outside the model's `efforts`, or a `serviceTier` the model
  does not list is `400 invalid_request`. Take values from `GET /v0/config` (`models` and
  `providers.<id>.models[].enabled`) rather than guessing. `permissionMode` decides what the run
  may do; choose it deliberately.
- **Retry a send with the same `id`.** A retry returns the stored message, including its original
  text and mode, without sending again, even if that model has since been disabled; it still
  fails once the agent is archived. A new `id` sends a second message. Other mutations take an
  optional `mutationId`, which only echoes into events and does not deduplicate retries.
- **Not every agent accepts messages.** Check `canSendMessages` first. Hidden subagents and
  archived agents answer `409 conflict` on `send`; subtasks accept messages while active.
- **Pending messages are not history.** A queued message is absent from `/messages` until a run
  accepts it. `GET /v0/agents/:agentId/bootstrap` lists the pending ones.
- **A run can stop to ask.** When `pendingQuestionId` is set, the run waits for an answer. Read
  it with `GET /v0/agents/:agentId/question` and answer through
  `POST /v0/agents/:agentId/question/:questionId/answer`, or the run stays paused.
- **`limit` on `/messages` is a lower bound.** Whole runs are always returned, so one long run
  can far exceed it.
- **The event journal is bounded.** A cursor that fell out of the window gives
  `409 cursor_unavailable` on `/v0/events`, or `"gap": true` in the stream's `hello`. Re-read the
  snapshots you rely on, then continue from the cursor the daemon returned.
- **Some mutations need `If-Match`.** Changes to projects, workspaces, bots, tasks, artifacts,
  secrets, todos, calendar events, and the profile need `If-Match: <version>` from your latest
  copy; `API.md` lists the rest. A missing header is `400`; a stale one is `409 conflict` with
  `currentVersion` and the current resource. Agent routes, `send` included, take no `If-Match`.
- **Branch on `code`, not `error`.** Errors are `{ "error": "...", "code": "..." }`. `error` is
  display text and may change; `code` is stable. A draining daemon answers mutations with
  `503 draining`.
- **Check the protocol for newer features.** `version.protocol` in health is the compatibility
  number. Protocols from 22 onward are additive, so tolerate unknown fields and event types, and
  treat `404` from a newer feature's route as the feature being unavailable.
- **Archive, do not delete.** There are no delete routes for projects, workspaces, agents, bots,
  or tasks. When verifying a deployed node, follow
  [Testing a deployed node](README.md#testing-a-deployed-node) rather than messaging real agents.
