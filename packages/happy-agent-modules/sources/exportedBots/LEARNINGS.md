# Exported bots learnings

## "Exported bot" is the one name; Telegram stays built in beside bridges

The feature started as Telegram "channels", then grew a "custom" kind. The user renamed it to
exported bots, because what the user does is export a Happy bot to another service, and wanted
one consistent vocabulary: `exportedBots`, `ExportedBotsModule`, `*_exported_bot*` tools and
tables, `GET /v0/exported-bots/connect`, and the `telegram` and `bridge` kinds. "Bridge" names
only the outside program. Moving Telegram into a bundled bridge was considered and dropped: the
user kept Telegram built in, because a built-in kind needs no extra process to run.

## Exports go on a bot of their own; the Chief of Staff only manages them

The first walkthrough connected the Chief of Staff itself to Telegram. The user wants a separate
bot made for the job, with the Chief of Staff holding only the extra tools: exporting other bots,
and approving or denying people. Everyone an export lets in works in that bot's folder, so the bot
they reach should have only the folder and purpose chosen for them, and the Chief of Staff's own
conversation stays the user's. Every tool that changes an export requires `botId`, with no
default to the calling bot, so a forgotten argument cannot export the Chief of Staff. Only
`get_exported_bot_status` keeps it optional, as a filter, because the Chief of Staff needs to see
requests waiting on every bot.

## People let in are guests, not the user

Allowlisted people first carried the trusted user origin, so they directed the bot with the
user's authority, including as authorization in Auto review. The user wanted them attributed but
not trusted: each becomes a guest, a Team user who can never sign in, made through Team's public
`createGuest`. Their messages carry the guest origin and their user ID, so history shows them as
theirs, while every trust check, which asks for the user origin, treats them as untrusted. Every
guest message runs in `auto`, so a mode the owner picked for their own message never carries over.
Telegram user IDs are global, so one person is one guest on every bot exported to Telegram; a
bridge's IDs mean something only to it, so its guests are its own. The adapter's `guestScope`
decides which. Guests outlive allowlist changes, refusals, and removal, so authorship never
changes after the fact.

## Exports live in the database and change on the fly

Exports first lived in `happy.toml`, which meant editing a file outside the workspace and
reloading the daemon for every allowlist change. The user wanted the Chief of Staff to create a
connector and walk them through it instead. Exports now live in this module's table, managed by
admin-only tools, and every change is reconciled into the running connections at once. Only the
Telegram Bot API server URL stays in configuration, so a tool cannot redirect tokens.

## One seam for every service, with a setup tool per kind

Everything shared — storage, allowlists, guests, access requests, conversations, durable replies,
typing, status — lives in the module, and an `ExportedBotAdapter` holds only what is particular to
one service. Every service ID is an opaque string, because Telegram's numbers do not fit Slack's
or anyone else's IDs. Credentials differ too much to share a setup tool, so each kind brings its
own, while removal, status, and access decisions are generic and take a `kind`.

## A bridge export is a token, a WebSocket, and file paths

The user wanted a simple protocol for anything beyond Telegram: an agent-made token, a WebSocket
on the daemon for messages and simple operations, and no file transfer over it. The outside
program is called a bridge, because Happy already has plugins. Its token is written to a `0600`
file the admin bot names rather than returned, since a tool result is stored in history; only a
SHA-256 digest is kept, and rotation keeps the account so conversations survive. Files cross as
absolute paths on the daemon's machine, so the bridge must run there. Replies wait in an outbox
until the bridge acknowledges them, because a bridge may be offline when the bot answers. The
protocol is specified in `docs/exported-bot-protocol.md` and announced in `API.md`.

The released daemon runs on Bun, whose native transport accepts WebSocket upgrades itself instead
of passing them to the Node handler the gym exercises. The bridge route was first wired only into
the Node path, so the released binary answered bridges with `404` while every gym test passed.
`ApiModule.prepareExportedBotSocket` is now the one admission both transports call, and
`tests/bun/exportedBotTransport.bun.mjs` covers the Bun side.

## A Telegram token is checked before it is saved

Saving whatever token was pasted would leave an export that fails quietly in the background. A
new token is checked with `getMe` first: a token Telegram rejects is refused with Telegram's
reason. If Telegram is only unreachable, the export is saved and keeps trying. Telegram lets one
program read a bot's messages, so one Telegram bot serves only one Happy bot.

## The allowlist names stable IDs

Usernames change and can be reused, so the allowlist holds the service's user IDs. Every change
that lets someone in is reviewed in Auto, and the review names the people. Routing reads the
allowlist inside the transaction that takes in each message, so a change applies to the very
next one.

## Strangers ask through the Chief of Staff, and only their identity travels

The user wanted people to be able to ask for access instead of being silently ignored, with every
request handled by the Chief of Staff rather than by the bot they wrote to, which has no say in
who may use it. A stranger's first message is held, the Chief of Staff is told who is asking —
never what they wrote, which would open a prompt-injection path before approval — and the
stranger gets one fixed notice written in source, not by a model. Approval delivers the held
message in the same transaction that updates the allowlist. The Chief of Staff must ask the user
unless the user already decided, and never approves on its own judgment. Approving is reviewed in
Auto; denying is not, since it only removes access. `unknownSenders = "ignore"` restores the
silent behavior per export.

## One subtask per person, not one per message or one shared conversation

Each guest's conversation is a subtask of the bot, flagged by `exportedBot` metadata and mapped in
the module's own table. The subtask is created without an opening task and does not report its
runs to the bot, since its answers belong to the person in the chat. Archiving the subtask ends
that conversation; the person's next message starts a new one.

## Every text block goes to the chat; the media goes with the answer

Only the text after the last tool call used to be delivered, once the run settled, on the theory
that earlier text was working commentary that would flood the chat. In practice the person stared
at silence through every long tool call. The user asked for every text block to be sent, for
Telegram and bridges alike. Each block is now owed as soon as the next block or a tool call
follows it, which is before that tool runs, and the conversation is told that everything it writes
is sent, so it keeps progress notes short and written for the person. The run's last block is its
answer and waits for settlement, so it can carry the images the run generated or read and the
files it showed with `present_files`, in order and without their layout: a captioned picture reads
better than a picture followed by a separate line, and bridges already promise a reply with text
and attachments together. The agent is told that reading an image shares it. Media is found
through the run's tool call IDs, noted as each call ends, because tool-call hooks see only
call-scoped stores that are erased when the call commits. A run that fails without an answer and
without media sends a short apology instead of silence. A block that is exactly `NO_REPLY` is never
sent, and an answer of `NO_REPLY` holds back the media too, so the agent can deliberately stay
quiet.

## Layout blocks are dropped before a reply leaves

An agent may arrange images it already showed with an HTML layout block in its reply. Chat
services cannot show those, and the raw HTML would only be noise, so every text block loses its
complete layout blocks, through the client package's `stripMediaLayoutBlocks`, before it is owed.
The service still receives the run's media as attachments, as before. A block that was only a
layout leaves nothing to send, so the text before it stays the answer.

## "Typing…" lasts as long as the run

Typing was shown only before each inference, so a tool call longer than Telegram's five-second
indicator left the chat looking idle. The user wanted it kept up the whole time. Each working
conversation now has a typing loop of its own, started with the run's loop, renewed at the
adapter's `intervalMs`, renewed again right after each reply because Telegram hides the indicator
once the bot speaks, and stopped when the run settles or the module closes. It lives in its own
named context because it belongs to the run, not to the hook that started it, and it gives up
after an hour so a run whose settlement never arrives cannot keep it alive forever.

## The cursor and the message move together

Telegram's `update_id` may jump after a quiet week, so updates are processed in the order
returned rather than compared with the cursor. Queuing a message and advancing the cursor commit
in one transaction, and the queued message's ID is derived from the service's message ID, so
neither a crash nor a repeated message produces a dropped or duplicate one. A message that keeps
failing is logged and skipped after a few attempts instead of blocking the export.
