# MCP servers

Happy Agent can connect to local MCP processes over stdio and to remote MCP services over
Streamable HTTP. Every model uses the same Happy-owned server catalog, connection lifecycle, and
permission model.

## Configuration files

Configure user-wide servers in `mcp.toml` in your user configuration directory:
`~/Happy/Config` on macOS, `~/happy/config` on Linux, or
`%USERPROFILE%\happy\config` on Windows. If the private Happy home is customized,
the configuration directory stays beside it; the configuration tools show the resolved file path.

Happy Agent creates this file with commented examples when it initializes the user configuration
directory. Any session's folder may add servers of its own in `mcp.toml` at its root: a project
workspace, a bot's folder (`~/Happy/Bots/<bot>`), or a task's folder (`~/Happy/Tasks/<task>`).
Entries in `happy.toml`, Codex configuration, Claude configuration, or another provider's files are
intentionally ignored.

User-wide servers are available in every session: project workspaces, bots, tasks, subtasks,
collaborators, and exported-bot conversations alike. A folder's servers are available to every
agent working in that folder, while at least one unarchived session does. A bot's folder servers
therefore reach the bot, its subtasks and collaborators that share its folder, and its exported-bot
conversations, but not other bots or a subtask given a project workspace of its own. A task's folder
servers reach the task and its subtasks that share its folder. A user-wide server wins when both
catalogs use the same name.

A folder's `mcp.toml` is read when the first session in that folder starts, including after Happy
Agent restarts. Edits made while sessions are running take effect after a reload, described below.

Each table below `[mcp_servers]` defines one server. The table name is the server's display name and
may be quoted when it contains spaces.

## Local stdio server

Use `command` for a process that speaks MCP over stdin and stdout:

```toml
[mcp_servers.local_docs]
command = "node"
args = ["/absolute/path/to/docs-server.mjs", "--stdio"]
cwd = "/absolute/working/directory"
env = { DOCS_ROOT = "/absolute/path/to/docs" }
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 30
```

`command` may be an absolute executable path or a command available in Happy Agent's environment.
Use absolute paths for script arguments and `cwd` when the daemon's working directory should not
matter. Matching normalized configurations share one live process across user and workspace
catalogs. The process stops only after its final catalog reference disappears or the daemon shuts
down.

## Remote HTTP server

Use `url` for a Streamable HTTP endpoint:

```toml
[mcp_servers.remote_docs]
url = "https://mcp.example.com/mcp"
http_headers = { "X-Client" = "Happy Agent" }
bearer_token_env_var = "MCP_BEARER_TOKEN"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 30
```

`bearer_token_env_var` names an environment variable; its value is read by Happy Agent and sent as
an `Authorization: Bearer ...` header. This keeps the token itself out of `mcp.toml`. Static headers
belong in `http_headers`.

Interactive MCP OAuth is not currently supported. Configure static headers or a bearer-token
environment variable for authenticated HTTP servers.

## Available settings

| Setting                | Applies to | Meaning                                                                              |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `command`              | stdio      | Executable to start. A server must have exactly one of `command` or `url`.           |
| `args`                 | stdio      | Arguments passed to the executable.                                                  |
| `cwd`                  | stdio      | Working directory inherited by the server process.                                   |
| `env`                  | stdio      | Additional environment variables for the process.                                    |
| `url`                  | HTTP       | Streamable HTTP MCP endpoint.                                                        |
| `http_headers`         | HTTP       | Static request headers.                                                              |
| `bearer_token_env_var` | HTTP       | Environment variable containing a bearer token.                                      |
| `enabled`              | both       | Set to `false` to retain the entry without connecting it. Defaults to enabled.       |
| `startup_timeout_sec`  | both       | Connection timeout in seconds, greater than zero and at most 600. Defaults to 10.    |
| `tool_timeout_sec`     | both       | Per-operation timeout in seconds, greater than zero and at most 600. Defaults to 60. |
| `enabled_tools`        | both       | When present, only these named tools are available.                                  |
| `disabled_tools`       | both       | Tools to hide. A disabled tool remains hidden even if it is also enabled.            |

## Reloading without restarting

After editing `mcp.toml`, ask the agent to reload the MCP servers. Models can call
`reload_mcp_servers`, which reconciles the current session's folder file by default: its project
workspace, bot folder, or task folder. Pass `global = true` to reconcile
the user-wide `mcp.toml`. Unchanged shared connections remain live;
only added or changed connections start, and only connections with no remaining owner stop. The
next model inference sees the updated tool list.

Models can also call `configure_mcp_server` to add, replace, or remove one named entry. By default
it changes the user-wide `mcp.toml`; with `scope = "folder"` it changes `mcp.toml` at the root of
the current session's folder, so a bot or task can be given servers of its own without editing the
file by hand. The update preserves unrelated servers, rewrites the file from its parsed entries, so
comments in it are not kept, and performs the same online reload of that catalog. A folder entry
whose name the user-wide catalog already uses is refused, because the user-wide server would win.

Both operations require Auto or Full access. In Auto they are reviewed and receive temporary Full
access because they may update configuration, start local processes, or connect to remote services.
The root `mcp.toml` is protected project configuration, like `happy.toml` and
`AGENTS_SECURITY.md`.

## Using MCP capabilities

Connected server tools appear as:

```text
mcp__<normalized-server-name>__<tool-name>
```

Happy Agent also exposes protocol tools for discovering resources, resource templates, and prompts.
MCP operations are available only in Auto or Full access because an MCP server can act outside the
local filesystem sandbox. Every MCP tool call and prompt load is reviewed in Auto; server-provided
annotations such as `readOnlyHint` are metadata, not authorization.

A server that fails to connect is reported as failed without preventing other servers from loading.
Common causes are an unavailable command, a relative script path resolved from the wrong directory,
a missing bearer-token environment variable, an unreachable URL, or a startup timeout that is too
short.

When troubleshooting, first confirm the entry is in the current session's folder `mcp.toml` or in
the user-wide `mcp.toml` in the platform's configuration directory, then ask the agent to reload the
corresponding scope and list the MCP servers. The resulting server status includes an isolated
connection error for each failed entry.
