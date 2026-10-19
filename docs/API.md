# API

OpenCode server REST API reference. Base URL: `http://localhost:4096` (default).

## Runtime v0.9 (`/runtime` v1)

v0.9.0-alpha adds a separate `/runtime` WebSocket surface served by `vis_bridge`
(protocol generation `v090-runtime`, frame `version` = `1`). It is not the
OpenCode REST API above and shares no frame format with it. Frame contract,
error codes, limits, and the version-rejection rule for legacy
`v070-legacy` bridges are specified in [runtime.md](./runtime.md) and
[migration-v090.md](./migration-v090.md); remote SSH/Slurm behavior is in
[remote.md](./remote.md).

Registered method families (from `shared/runtime/capabilities.js` `METHODS`):
`runtime.history.*`, `runtime.target.attach/detach`, `runtime.snapshot*`,
`runtime.entity.resolve`, `runtime.observer.*`, `runtime.channel.*`,
`runtime.pty.*`, `session.*`, `interaction.respond`, `harness.*`, and
`native.extension`. Optional native capabilities are granted per source; an
undeclared call returns the typed error `unsupported`.

## Common Conventions

### Headers

| Header                 | Required                        | Description                                         |
| ---------------------- | ------------------------------- | --------------------------------------------------- |
| `Content-Type`         | POST/PUT/PATCH/DELETE with body | `application/json`                                  |
| `x-opencode-directory` | No                              | Scopes the request to a specific instance directory |
| `x-opencode-workspace` | No                              | Scopes the request to a specific workspace          |
| `Authorization`        | No                              | `Basic <base64(username:password)>`                 |

### Instance Scope

Most project-scoped endpoints accept optional scope parameters:

- `query.directory?` (string) — Scope to a specific project directory. Can also be provided via `x-opencode-directory`.
- `query.workspace?` (string) — Scope to a specific workspace ID. Can also be provided via `x-opencode-workspace`.

Workspace IDs use the pattern `^wrk.*`.

### Error Responses

All endpoints may return standard HTTP errors. Structured error bodies:

**400 Bad Request** — `BadRequestError`

```json
{ "success": false, "data": null, "errors": [{ ... }] }
```

**404 Not Found** — `NotFoundError`

```json
{ "name": "NotFoundError", "data": { "message": "..." } }
```

---

## Global

### GET /global/health

Server health check.

- Response `200`:

```json
{ "healthy": true, "version": "0.0.3" }
```

### GET /global/event

Subscribe to global SSE events. See [SSE.md](./SSE.md) for event types.

- Response `200`: `text/event-stream`

### GET /global/config

Get global configuration.

- Response `200`: [Config](#config)

### PATCH /global/config

Update global configuration.

- Body: [Config](#config) (partial)
- Response `200`: [Config](#config)
- Response `400`: BadRequestError

### POST /global/dispose

Dispose all instances, releasing all resources.

- Response `200`: `boolean`

---

## Auth

### PUT /auth/{providerID}

Store auth credentials for a provider.

- Path: `providerID` (string, required)
- Body: [Auth](#auth) (required)
- Response `200`: `boolean`
- Response `400`: BadRequestError

### DELETE /auth/{providerID}

Remove auth credentials for a provider.

- Path: `providerID` (string, required)
- Response `200`: `boolean`
- Response `400`: BadRequestError

---

## Project

### GET /project

List all projects.

- Query: `directory?` (string)
- Response `200`: [Project](#project)[]

### GET /project/current

Get the current project.

- Query: `directory?` (string)
- Response `200`: [Project](#project)

### PATCH /project/{projectID}

Update project metadata.

- Path: `projectID` (string, required)
- Query: `directory?` (string)
- Body:
  - `name?`: string
  - `icon?`: `{ url?: string, override?: string, color?: string }`
  - `commands?`: `{ start?: string }`
- Response `200`: [Project](#project)
- Response `400` / `404`

---

## PTY

### GET /pty

List PTY sessions.

- Query: `directory?` (string)
- Response `200`: [Pty](#pty)[]

### POST /pty

Create a PTY session.

- Query: `directory?` (string)
- Body:
  - `command?`: string
  - `args?`: string[]
  - `cwd?`: string
  - `title?`: string
  - `env?`: Record\<string, string\>
- Response `200`: [Pty](#pty)
- Response `400`: BadRequestError

### GET /pty/{ptyID}

Get a PTY session.

- Path: `ptyID` (string, required)
- Query: `directory?` (string)
- Response `200`: [Pty](#pty)
- Response `404`

### PUT /pty/{ptyID}

Update a PTY session (title or terminal size).

- Path: `ptyID` (string, required)
- Query: `directory?` (string)
- Body:
  - `title?`: string
  - `size?`: `{ rows: number, cols: number }`
- Response `200`: [Pty](#pty)
- Response `400`

### DELETE /pty/{ptyID}

Remove a PTY session.

- Path: `ptyID` (string, required)
- Query: `directory?` (string)
- Response `200`: `boolean`
- Response `404`

### GET /pty/{ptyID}/connect

Connect to a PTY session (WebSocket upgrade).

- Path: `ptyID` (string, required)
- Query: `directory?` (string)
- Response `200`: `boolean`
- Response `404`

---

## Config

### GET /config

Get project-level configuration.

- Query: `directory?` (string)
- Response `200`: [Config](#config)

### PATCH /config

Update project-level configuration.

- Query: `directory?` (string)
- Body: [Config](#config) (partial)
- Response `200`: [Config](#config)
- Response `400`

### GET /config/providers

List configured providers with their models.

- Query: `directory?` (string)
- Response `200`: Record\<string, [Provider](#provider)\>

---

## Experimental

### GET /experimental/tool/ids

List available tool IDs.

- Query: `directory?` (string)
- Response `200`: string[]
- Response `400`

### GET /experimental/tool

List tools with parameter schemas (requires a provider+model to resolve availability).

- Query:
  - `directory?` (string)
  - `workspace?` (string)
  - `provider` (string, **required**)
  - `model` (string, **required**)
- Response `200`: [ToolListItem](#toollistitem)[]
- Response `400`

### POST /experimental/workspace

Create a workspace for the current project.

- Query:
  - `directory?` (string)
  - `workspace?` (string)
- Body:
  - `id?`: string (pattern `^wrk.*`)
  - `type`: string (**required**)
  - `branch`: string | null (**required**)
  - `extra`: unknown | null (**required**)
- Response `200`: [Workspace](#workspace)
- Response `400`

### GET /experimental/workspace

List all workspaces for the current project.

- Query:
  - `directory?` (string)
  - `workspace?` (string)
- Response `200`: [Workspace](#workspace)[]

### DELETE /experimental/workspace/{id}

Remove an existing workspace.

- Path: `id` (string, required — pattern `^wrk.*`)
- Query:
  - `directory?` (string)
  - `workspace?` (string)
- Response `200`: [Workspace](#workspace)
- Response `400`

### POST /experimental/worktree

Create a worktree and run startup.

- Query: `directory?` (string)
- Body:
  - `name?`: string
  - `startCommand?`: string — Additional startup script
- Response `200`: [Worktree](#worktree)
- Response `400`

### GET /experimental/worktree

List worktrees.

- Query: `directory?` (string)
- Response `200`: `string[]` — List of sandbox directory paths

### DELETE /experimental/worktree

Remove a worktree.

- Query: `directory?` (string)
- Body:
  - `directory` (string, **required**) — The worktree directory to remove
- Response `200`: `boolean`
- Response `400`

### POST /experimental/worktree/reset

Reset a worktree to the default branch.

- Query: `directory?` (string)
- Body:
  - `directory` (string, **required**)
- Response `200`: `boolean`
- Response `400`

### GET /experimental/resource

List MCP resources.

- Query: `directory?` (string)
- Response `200`: `object`

---

## Session

### GET /session

List sessions.

- Query:
  - `directory?` (string)
  - `roots?` (boolean) — Only return root sessions (no children)
  - `start?` (number) — Pagination cursor (timestamp)
  - `search?` (string) — Search sessions by title
  - `limit?` (number) — Max results to return
- Response `200`: [Session](#session-1)[]

### POST /session

Create a session.

- Query: `directory?` (string)
- Body:
  - `title?`: string
  - `parentID?`: string
  - `permission?`: [PermissionRule](#permissionrule)[]
- Response `200`: [Session](#session-1)
- Response `400`

### GET /session/status

Get status of all sessions as a map.

- Query: `directory?` (string)
- Response `200`: Record\<string, [SessionStatus](#sessionstatus)\>
- Response `400`

### GET /session/{sessionID}

Get a session by ID.

- Path: `sessionID` (string, required — pattern `^ses.*`)
- Query: `directory?` (string)
- Response `200`: [Session](#session-1)
- Response `400` / `404`

### DELETE /session/{sessionID}

Delete a session.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Response `200`: `boolean`
- Response `400` / `404`

### PATCH /session/{sessionID}

Update session metadata.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `title?`: string
  - `time?`: `{ archived?: number }`
- Response `200`: [Session](#session-1)
- Response `400` / `404`

### GET /session/{sessionID}/children

List child sessions.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Response `200`: [Session](#session-1)[]
- Response `400` / `404`

### GET /session/{sessionID}/todo

List todos for the session.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Response `200`: [Todo](#todo)[]
- Response `400` / `404`

### POST /session/{sessionID}/init

Initialize a session with a model assignment.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `providerID` (string, **required**)
  - `modelID` (string, **required**)
  - `messageID` (string, **required** — pattern `^msg.*`)
- Response `200`: `boolean`
- Response `400` / `404`

### POST /session/{sessionID}/fork

Fork a session at a given message.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `messageID?`: string
- Response `200`: [Session](#session-1)

### POST /session/{sessionID}/abort

Abort a running session.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Response `200`: `boolean`
- Response `400` / `404`

### POST /session/{sessionID}/share

Create a share link for the session.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Response `200`: [Session](#session-1)
- Response `400` / `404`

### DELETE /session/{sessionID}/share

Remove a share link for the session.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Response `200`: [Session](#session-1)
- Response `400` / `404`

### GET /session/{sessionID}/diff

Get file diffs for the session (or a specific message).

- Path: `sessionID` (string, required)
- Query:
  - `directory?` (string)
  - `messageID?` (string)
- Response `200`: [FileDiff](#filediff)[]

### POST /session/{sessionID}/summarize

Generate a session summary.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `providerID` (string, **required**)
  - `modelID` (string, **required**)
  - `auto?`: boolean (default `false`)
- Response `200`: `boolean`
- Response `400` / `404`

### POST /session/{sessionID}/revert

Revert a message (or a specific part).

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `messageID` (string, **required** — pattern `^msg.*`)
  - `partID?`: string (pattern `^prt.*`)
- Response `200`: [Session](#session-1)
- Response `400` / `404`

### POST /session/{sessionID}/unrevert

Restore previously reverted messages.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Response `200`: [Session](#session-1)
- Response `400` / `404`

---

## Message

### GET /session/{sessionID}/message

List messages in a session.

- Path: `sessionID` (string, required)
- Query:
  - `directory?` (string)
  - `limit?` (number) — Max messages to return
- Response `200`: `{ info:` [UserMessage](#usermessage) `|` [AssistantMessage](#assistantmessage)`,` `parts:` [Part](#part)[] `}`[]
- Response `400` / `404`

### POST /session/{sessionID}/message

Send a message (synchronous — blocks until response).

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `parts` ([PartInput](#partinput)[], **required**) — Message content
  - `messageID?`: string (pattern `^msg.*`) — Edit an existing message
  - `agent?`: string
  - `model?`: `{ providerID: string, modelID: string }`
  - `variant?`: string — Thinking mode variant
  - `system?`: string — System prompt override
  - `noReply?`: boolean — Skip assistant response
  - `format?`: [OutputFormat](#outputformat)
  - `tools?`: Record\<string, boolean\> (deprecated — use session permissions)
- Response `200`: `object`
- Response `400` / `404`

### POST /session/{sessionID}/prompt_async

Send a message (asynchronous — returns immediately, response via SSE).

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body: Same as POST `/session/{sessionID}/message`
- Response `204`: (no body)
- Response `400` / `404`

### GET /session/{sessionID}/message/{messageID}

Get a single message.

- Path: `sessionID` (string, required), `messageID` (string, required)
- Query: `directory?` (string)
- Response `200`: `{ info:` [UserMessage](#usermessage) `|` [AssistantMessage](#assistantmessage)`,` `parts:` [Part](#part)[] `}`
- Response `400` / `404`

### DELETE /session/{sessionID}/message/{messageID}/part/{partID}

Delete a message part.

- Path: `sessionID`, `messageID`, `partID` (all string, required)
- Query: `directory?` (string)
- Response `200`: `boolean`
- Response `400` / `404`

### PATCH /session/{sessionID}/message/{messageID}/part/{partID}

Update a message part.

- Path: `sessionID`, `messageID`, `partID` (all string, required)
- Query: `directory?` (string)
- Body: [Part](#part-types) (the full part object)
- Response `200`: [Part](#part-types)
- Response `400` / `404`

---

## Command

### POST /session/{sessionID}/command

Execute a slash command in a session.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `command` (string, **required**) — Command name
  - `arguments` (string, **required**) — Command arguments
  - `messageID?`: string (pattern `^msg.*`)
  - `agent?`: string
  - `model?`: string — Format: `provider/model`
  - `variant?`: string
  - `parts?`: [FilePartInput](#filepartinput)[] — Attachments
- Response `200`: `object`
- Response `400` / `404`

### POST /session/{sessionID}/shell

Run a shell command in a session context.

- Path: `sessionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `command` (string, **required**)
  - `agent` (string, **required**)
  - `model?`: `{ providerID: string, modelID: string }`
- Response `200`: [AssistantMessage](#assistantmessage)
- Response `400` / `404`

---

## Permission

### POST /session/{sessionID}/permissions/{permissionID} _(deprecated)_

Respond to a permission request (legacy endpoint — use [POST /permission/{requestID}/reply](#post-permissionrequestidreply) instead).

- Path: `sessionID` (string, required), `permissionID` (string, required)
- Query: `directory?` (string)
- Body:
  - `response` (string, **required**) — `"once"` | `"always"` | `"reject"`
- Response `200`: `boolean`
- Response `400` / `404`

### POST /permission/{requestID}/reply

Reply to a permission request by request ID.

- Path: `requestID` (string, required — pattern `^per.*`)
- Query: `directory?` (string)
- Body:
  - `reply` (string, **required**) — `"once"` | `"always"` | `"reject"`
  - `message?`: string
- Response `200`: `boolean`
- Response `400` / `404`

### GET /permission

List pending permission requests.

- Query: `directory?` (string)
- Response `200`: [PermissionRequest](#permissionrequest)[]

---

## Question

### GET /question

List pending questions.

- Query: `directory?` (string)
- Response `200`: [QuestionRequest](#questionrequest)[]

### POST /question/{requestID}/reply

Reply to a question.

- Path: `requestID` (string, required — pattern `^que.*`)
- Query: `directory?` (string)
- Body:
  - `answers` (string[][], **required**) — One answer array per question
- Response `200`: `boolean`
- Response `400` / `404`

### POST /question/{requestID}/reject

Reject a question.

- Path: `requestID` (string, required)
- Query: `directory?` (string)
- Response `200`: `boolean`
- Response `400` / `404`

---

## Provider

### GET /provider

List providers with their models.

- Query: `directory?` (string)
- Response `200`: Record\<string, [Provider](#provider)\>

### GET /provider/auth

List provider auth methods.

- Query: `directory?` (string)
- Response `200`: Record\<string, [ProviderAuthMethod](#providerauthmethod)[]\>

### POST /provider/{providerID}/oauth/authorize

Start OAuth authorization flow.

- Path: `providerID` (string, required)
- Query: `directory?` (string)
- Body:
  - `method` (number, **required**) — Index of the auth method
- Response `200`: [ProviderAuthAuthorization](#providerauthauthorization)
- Response `400`

### POST /provider/{providerID}/oauth/callback

Handle OAuth callback.

- Path: `providerID` (string, required)
- Query: `directory?` (string)
- Body:
  - `method` (number, **required**)
  - `code?`: string — Authorization code
- Response `200`: `boolean`
- Response `400`

---

## Find

### GET /find

Search text with a regex pattern.

- Query:
  - `directory?` (string)
  - `pattern` (string, **required**) — Regex pattern
- Response `200`: `array`

### GET /find/file

Search files and directories by name using fuzzy matching ([fuzzysort](https://github.com/farzher/fuzzysort) 3.x).

- Query:
  - `directory?` (string)
  - `query` (string, **required**) — Search term. Can be empty.
  - `type?`: `"file"` | `"directory"` — Filter results by type. When omitted, returns both (unless `dirs=false`).
  - `dirs?`: `"true"` | `"false"` — Include directories in results. Default `"true"`. Ignored when `type` is set.
  - `limit?`: integer (1–200) — Max results. Default: 10.
- Response `200`: `string[]` — Relative paths within the instance directory. Directory paths end with `/`.

#### Behavior

The search operates on a **cached index** of the project's file tree, not the live filesystem. The index is built in the background on startup and refreshed lazily.

**When `query` is empty:**

Returns entries sorted alphabetically. For `type=directory`, hidden directories (names starting with `.`) are sorted to the end.

**When `query` is non-empty:**

Uses fuzzysort for fuzzy matching against the cached paths. Results are sorted by match score (best first). For `type=directory`, the search internally over-fetches (`limit × 20`), sorts hidden directories to the end, then slices to `limit`. If `query` starts with `.` or contains `/.`, hidden entries are **not** deprioritized.

#### Index building

How the index is built depends on the scoped instance:

- **Home instance** (`directory` = home path, project = `"global"`): Only directories are indexed. Scans **2 levels deep** from home. Skips hidden directories, platform-specific directories (`Library` on macOS, `AppData` on Windows), and common build artifacts (`node_modules`, `dist`, `build`, `target`, `vendor`) at the second level. **No files are indexed.**
- **Normal project instances**: Uses `rg --files` (ripgrep) to enumerate all non-ignored files, then extracts directory paths from the file paths. Both files and directories are indexed.

### GET /find/symbol

Search workspace symbols (functions, classes, variables, etc.) using LSP.

> **Note**: This endpoint is currently **stubbed** — it always returns `[]`. The implementation is commented out on the server side. When enabled, it would use the LSP `workspace/symbol` request.

- Query:
  - `directory?` (string)
  - `query` (string, **required**) — Symbol name to search for
- Response `200`: [Symbol](#symbol)[]

#### Intended Behavior (when enabled)

Sends a `workspace/symbol` LSP request to **all** connected LSP clients in the project. Results are filtered to include only the following symbol kinds:

| Kind      | Value |
| --------- | ----- |
| Class     | 5     |
| Function  | 12    |
| Method    | 6     |
| Interface | 11    |
| Variable  | 13    |
| Constant  | 14    |
| Struct    | 23    |
| Enum      | 10    |

Results are limited to **10 per LSP client**, then flattened into a single array across all clients.

---

## File

### GET /file

List files under a path.

- Query:
  - `directory?` (string)
  - `path` (string, **required**)
- Response `200`: [FileNode](#filenode)[]

### GET /file/content

Read file content.

- Query:
  - `directory?` (string)
  - `path` (string, **required**)
- Response `200`: [FileContent](#filecontent)

### GET /file/status

Get file status (git status).

- Query: `directory?` (string)
- Response `200`: `array`

---

## MCP

### GET /mcp

Get MCP server status.

- Query: `directory?` (string)
- Response `200`: Record\<string, [MCPStatus](#mcpstatus)\>

### POST /mcp

Add an MCP server.

- Query: `directory?` (string)
- Body:
  - `name` (string, **required**)
  - `config` (object, **required**) — MCP server configuration
- Response `200`: `object`
- Response `400`

### POST /mcp/{name}/auth

Start MCP OAuth.

- Path: `name` (string, required)
- Query: `directory?` (string)
- Response `200`: `object`
- Response `400` / `404`

### DELETE /mcp/{name}/auth

Remove MCP OAuth credentials.

- Path: `name` (string, required)
- Query: `directory?` (string)
- Response `200`: `object`
- Response `404`

### POST /mcp/{name}/auth/callback

Complete MCP OAuth with authorization code.

- Path: `name` (string, required)
- Query: `directory?` (string)
- Body:
  - `code` (string, **required**)
- Response `200`: [MCPStatus](#mcpstatus)
- Response `400` / `404`

### POST /mcp/{name}/auth/authenticate

Start MCP auth flow and wait for callback.

- Path: `name` (string, required)
- Query: `directory?` (string)
- Response `200`: [MCPStatus](#mcpstatus)
- Response `400` / `404`

### POST /mcp/{name}/connect

Connect to an MCP server.

- Path: `name` (string, required)
- Query: `directory?` (string)
- Response `200`: `boolean`

### POST /mcp/{name}/disconnect

Disconnect from an MCP server.

- Path: `name` (string, required)
- Query: `directory?` (string)
- Response `200`: `boolean`

---

## TUI

These endpoints control the TUI (terminal UI) instance.

### POST /tui/append-prompt

Append text to the TUI prompt.

- Query: `directory?` (string)
- Body:
  - `text` (string, **required**)
- Response `200`: `boolean`

### POST /tui/submit-prompt

Submit the current prompt.

- Query: `directory?` (string)
- Response `200`: `boolean`

### POST /tui/clear-prompt

Clear the current prompt.

- Query: `directory?` (string)
- Response `200`: `boolean`

### POST /tui/execute-command

Execute a TUI command.

- Query: `directory?` (string)
- Body:
  - `command` (string, **required**)
- Response `200`: `boolean`
- Response `400`

### POST /tui/show-toast

Show a toast notification in the TUI.

- Query: `directory?` (string)
- Body:
  - `message` (string, **required**)
  - `variant` (string, **required**) — `"info"` | `"success"` | `"warning"` | `"error"`
  - `title?`: string
  - `duration?`: number (milliseconds)
- Response `200`: `boolean`

### POST /tui/publish

Publish a TUI event.

- Query: `directory?` (string)
- Body: One of `Event.tui.prompt.append`, `Event.tui.command.execute`, `Event.tui.toast.show`, `Event.tui.session.select`
- Response `200`: `boolean`
- Response `400`

### POST /tui/select-session

Select a session in the TUI.

- Query: `directory?` (string)
- Body:
  - `sessionID` (string, **required**)
- Response `200`: `boolean`
- Response `400` / `404`

### POST /tui/open-help

Open the help dialog.

- Query: `directory?` (string)
- Response `200`: `boolean`

### POST /tui/open-sessions

Open the sessions dialog.

- Query: `directory?` (string)
- Response `200`: `boolean`

### POST /tui/open-themes

Open the themes dialog.

- Query: `directory?` (string)
- Response `200`: `boolean`

### POST /tui/open-models

Open the models dialog.

- Query: `directory?` (string)
- Response `200`: `boolean`

### GET /tui/control/next

Get the next TUI control request (long-polling).

- Query: `directory?` (string)
- Response `200`: `object`

### POST /tui/control/response

Submit a TUI control response.

- Query: `directory?` (string)
- Body: `object`
- Response `200`: `boolean`

---

## Instance

### POST /instance/dispose

Dispose the current instance.

- Query: `directory?` (string)
- Response `200`: `boolean`

---

## Metadata

### GET /path

Get path information for the server.

- Query: `directory?` (string)
- Response `200`: [Path](#path)

### GET /vcs

Get VCS (git) information.

- Query: `directory?` (string)
- Response `200`: [VcsInfo](#vcsinfo)

### GET /command

List available slash commands.

- Query: `directory?` (string)
- Response `200`: [Command](#command)[]

### POST /log

Write a log entry.

- Query: `directory?` (string)
- Body:
  - `service` (string, **required**)
  - `level` (`"debug"` | `"info"` | `"warn"` | `"error"`, **required**)
  - `message` (string, **required**)
  - `extra?`: object
- Response `200`: `boolean`
- Response `400`

### GET /agent

List agents.

- Query: `directory?` (string)
- Response `200`: [Agent](#agent)[]

### GET /skill

List skills.

- Query: `directory?` (string)
- Response `200`: `array`

### GET /lsp

Get LSP server status.

- Query: `directory?` (string)
- Response `200`: [LSPStatus](#lspstatus)[]

### GET /formatter

Get formatter status.

- Query: `directory?` (string)
- Response `200`: [FormatterStatus](#formatterstatus)[]

### GET /event

Subscribe to project-scoped SSE events. See [SSE.md](./SSE.md) for event types.

- Query: `directory?` (string)
- Response `200`: `text/event-stream`

---

## Type Definitions

### PartInput

Discriminated union on `type`. Used in the `parts` field of message/prompt requests.

**TextPartInput**

- `type`: `"text"` (required)
- `text`: string (required)
- `id?`: string
- `synthetic?`: boolean
- `ignored?`: boolean
- `time?`: `{ start: number, end?: number }`
- `metadata?`: Record\<string, unknown\>

**FilePartInput**

- `type`: `"file"` (required)
- `mime`: string (required)
- `url`: string (required) — Data URL or file URL
- `id?`: string
- `filename?`: string
- `source?`: [FilePartSource](#filepartsource)

**AgentPartInput**

- `type`: `"agent"` (required)
- `name`: string (required) — Agent name
- `id?`: string
- `source?`: `{ value: string, start: number, end: number }`

**SubtaskPartInput**

- `type`: `"subtask"` (required)
- `prompt`: string (required)
- `description`: string (required)
- `agent`: string (required)
- `id?`: string
- `model?`: `{ providerID: string, modelID: string }`
- `command?`: string

### OutputFormat

Discriminated union on `type`.

**OutputFormatText**

- `type`: `"text"`

**OutputFormatJsonSchema**

- `type`: `"json_schema"`
- `schema`: JSONSchema (required)
- `retryCount?`: integer (default `2`, min `0`)

### Session

- `id`: string (pattern `^ses.*`)
- `slug`: string
- `projectID`: string
- `directory`: string
- `title`: string
- `version`: string
- `time`: `{ created: number, updated: number, compacting?: number, archived?: number }`
- `parentID?`: string (pattern `^ses.*`)
- `summary?`: `{ additions: number, deletions: number, files: number, diffs?: FileDiff[] }`
- `share?`: `{ url: string }`
- `permission?`: [PermissionRule](#permissionrule)[]
- `revert?`: `{ messageID: string, partID?: string, snapshot?: string, diff?: string }`

### SessionStatus

Discriminated union on `type`.

- `{ type: "idle" }`
- `{ type: "busy" }`
- `{ type: "retry", attempt: number, message: string, next: number }`

### UserMessage

- `id`: string
- `sessionID`: string
- `role`: `"user"`
- `time`: `{ created: number }`
- `agent`: string
- `model`: `{ providerID: string, modelID: string }`
- `format?`: [OutputFormat](#outputformat)
- `summary?`: `{ title?: string, body?: string, diffs: FileDiff[] }`
- `system?`: string
- `tools?`: Record\<string, boolean\>
- `variant?`: string

### AssistantMessage

- `id`: string
- `sessionID`: string
- `role`: `"assistant"`
- `time`: `{ created: number, completed?: number }`
- `parentID`: string
- `modelID`: string
- `providerID`: string
- `agent`: string
- `path`: `{ cwd: string, root: string }`
- `cost`: number
- `tokens`: `{ total?: number, input: number, output: number, reasoning: number, cache: { read: number, write: number } }`
- `mode`: string (deprecated)
- `error?`: [MessageError](#messageerror)
- `summary?`: boolean
- `structured?`: unknown
- `variant?`: string
- `finish?`: string

### Part Types

All parts include base fields: `id`, `sessionID`, `messageID` (all string, required).

**TextPart** — `type: "text"`

- `text`: string
- `synthetic?`: boolean
- `ignored?`: boolean
- `time?`: `{ start: number, end?: number }`
- `metadata?`: Record\<string, unknown\>

**ReasoningPart** — `type: "reasoning"`

- `text`: string
- `time`: `{ start: number, end?: number }`
- `metadata?`: Record\<string, unknown\>

**ToolPart** — `type: "tool"`

- `callID`: string
- `tool`: string
- `state`: [ToolState](#toolstate)
- `metadata?`: Record\<string, unknown\>

**FilePart** — `type: "file"`

- `mime`: string
- `url`: string
- `filename?`: string
- `source?`: [FilePartSource](#filepartsource)

**StepStartPart** — `type: "step-start"`

- `snapshot?`: string

**StepFinishPart** — `type: "step-finish"`

- `reason`: string
- `snapshot?`: string
- `cost`: number
- `tokens`: `{ total?: number, input: number, output: number, reasoning: number, cache: { read: number, write: number } }`

**SnapshotPart** — `type: "snapshot"`

- `snapshot`: string

**PatchPart** — `type: "patch"`

- `hash`: string
- `files`: string[]

**AgentPart** — `type: "agent"`

- `name`: string
- `source?`: `{ value: string, start: number, end: number }`

**RetryPart** — `type: "retry"`

- `attempt`: number
- `error`: [APIError](#apierror)
- `time`: `{ created: number }`

**CompactionPart** — `type: "compaction"`

- `auto`: boolean

**SubtaskPart** — `type: "subtask"`

- `prompt`: string
- `description`: string
- `agent`: string
- `model?`: `{ providerID: string, modelID: string }`
- `command?`: string

### ToolState

Discriminated union on `status`.

**ToolStatePending** — `status: "pending"`

- `input`: Record\<string, unknown\>
- `raw`: string

**ToolStateRunning** — `status: "running"`

- `input`: Record\<string, unknown\>
- `time`: `{ start: number }`
- `title?`: string
- `metadata?`: Record\<string, unknown\>

**ToolStateCompleted** — `status: "completed"`

- `input`: Record\<string, unknown\>
- `output`: string
- `title`: string
- `metadata`: Record\<string, unknown\>
- `time`: `{ start: number, end: number, compacted?: number }`
- `attachments?`: FilePart[]

**ToolStateError** — `status: "error"`

- `input`: Record\<string, unknown\>
- `error`: string
- `time`: `{ start: number, end: number }`
- `metadata?`: Record\<string, unknown\>

### FilePartSource

Discriminated union on `type`.

**FileSource** — `type: "file"`

- `path`: string
- `text`: `{ value: string, start: number, end: number }`

**SymbolSource** — `type: "symbol"`

- `path`: string
- `name`: string
- `kind`: number
- `range`: `{ start: { line: number, character: number }, end: { line: number, character: number } }`
- `text`: `{ value: string, start: number, end: number }`

**ResourceSource** — `type: "resource"`

- `clientName`: string
- `uri`: string
- `text`: `{ value: string, start: number, end: number }`

### FileDiff

- `file`: string
- `before`: string
- `after`: string
- `additions`: number
- `deletions`: number
- `status?`: `"added"` | `"deleted"` | `"modified"`

### Todo

- `content`: string
- `status`: `"pending"` | `"in_progress"` | `"completed"` | `"cancelled"`
- `priority`: `"high"` | `"medium"` | `"low"`

### Pty

- `id`: string (pattern `^pty.*`)
- `title`: string
- `command`: string
- `args`: string[]
- `cwd`: string
- `status`: `"running"` | `"exited"`
- `pid`: number

### Project

- `id`: string
- `worktree`: string
- `time`: `{ created: number, updated: number, initialized?: number }`
- `sandboxes`: string[]
- `vcs?`: `"git"`
- `name?`: string
- `icon?`: `{ url?: string, override?: string, color?: string }`
- `commands?`: `{ start?: string }`

### Worktree

- `name`: string
- `branch`: string
- `directory`: string

### Workspace

- `id`: string (pattern `^wrk.*`)
- `type`: string
- `branch`: string | null
- `name`: string | null
- `directory`: string | null
- `extra`: unknown | null
- `projectID`: string

### Path

- `home`: string
- `state`: string
- `config`: string
- `worktree`: string
- `directory`: string

### VcsInfo

- `branch`: string

### FileNode

- `name`: string
- `path`: string
- `absolute`: string
- `type`: `"file"` | `"directory"`
- `ignored`: boolean

### FileContent

- `type`: `"text"` | `"binary"`
- `content`: string
- `diff?`: string
- `patch?`: `{ oldFileName: string, newFileName: string, hunks: Hunk[], oldHeader?: string, newHeader?: string, index?: string }`
- `encoding?`: `"base64"` (present when type is `"binary"`)
- `mimeType?`: string

### PermissionRule

- `permission`: string — Permission type (e.g. `"read"`, `"edit"`, `"bash"`, `"glob"`, `"grep"`, `"list"`, `"task"`, `"lsp"`, `"skill"`, `"external_directory"`)
- `pattern`: string — Glob pattern
- `action`: `"allow"` | `"deny"` | `"ask"`

### PermissionRequest

- `id`: string (pattern `^per.*`)
- `sessionID`: string (pattern `^ses.*`)
- `permission`: string
- `patterns`: string[]
- `metadata`: Record\<string, unknown\>
- `always`: string[]
- `tool?`: `{ messageID: string, callID: string }`

### QuestionRequest

- `id`: string (pattern `^que.*`)
- `sessionID`: string (pattern `^ses.*`)
- `questions`: [QuestionInfo](#questioninfo)[]
- `tool?`: `{ messageID: string, callID: string }`

### QuestionInfo

- `question`: string
- `header`: string (max 30 chars)
- `options`: [QuestionOption](#questionoption)[]
- `multiple?`: boolean
- `custom?`: boolean (default `true` — allow typing custom answer)

### QuestionOption

- `label`: string (1–5 words)
- `description`: string

### Auth

Discriminated union on `type`.

**OAuth** — `type: "oauth"`

- `refresh`: string (required)
- `access`: string (required)
- `expires`: number (required)
- `accountId?`: string
- `enterpriseUrl?`: string

**ApiAuth** — `type: "api"`

- `key`: string (required)

**WellKnownAuth** — `type: "wellknown"`

- `key`: string (required)
- `token`: string (required)

### Provider

- `id`: string
- `name`: string
- `source`: `"env"` | `"config"` | `"custom"` | `"api"`
- `env`: string[]
- `options`: Record\<string, unknown\>
- `models`: Record\<string, [Model](#model)\>
- `key?`: string

### ProviderAuthMethod

- `type`: `"oauth"` | `"api"`
- `label`: string

### ProviderAuthAuthorization

- `url`: string
- `method`: `"auto"` | `"code"`
- `instructions`: string

### Model

- `id`: string
- `providerID`: string
- `name`: string
- `api`: `{ id: string, url: string, npm: string }`
- `capabilities`: `{ temperature: boolean, reasoning: boolean, attachment: boolean, toolcall: boolean, input: MediaCaps, output: MediaCaps, interleaved: boolean | { field: string } }`
- `cost`: `{ input: number, output: number, cache: { read: number, write: number } }`
- `limit`: `{ context: number, output: number, input?: number }`
- `status`: `"alpha"` | `"beta"` | `"deprecated"` | `"active"`
- `options`: Record\<string, unknown\>
- `headers`: Record\<string, string\>
- `release_date`: string
- `family?`: string
- `variants?`: Record\<string, Record\<string, unknown\>\>

MediaCaps = `{ text: boolean, audio: boolean, image: boolean, video: boolean, pdf: boolean }`

### Agent

- `name`: string
- `mode`: `"subagent"` | `"primary"` | `"all"`
- `permission`: [PermissionRule](#permissionrule)[]
- `options`: Record\<string, unknown\>
- `description?`: string
- `native?`: boolean
- `hidden?`: boolean
- `topP?`: number
- `temperature?`: number
- `color?`: string
- `model?`: `{ providerID: string, modelID: string }`
- `variant?`: string
- `prompt?`: string
- `steps?`: integer (> 0)

### Command

- `name`: string
- `template`: string
- `hints`: string[]
- `description?`: string
- `agent?`: string
- `model?`: string
- `source?`: `"command"` | `"mcp"` | `"skill"`
- `subtask?`: boolean

### ToolListItem

- `id`: string
- `description`: string
- `parameters`: JSONSchema

### MCPStatus

Discriminated union on `status`.

- `{ status: "connected" }`
- `{ status: "disabled" }`
- `{ status: "failed", error: string }`
- `{ status: "needs_auth" }`
- `{ status: "needs_client_registration", error: string }`

### Symbol

Workspace symbol returned by LSP `workspace/symbol`.

- `name`: string — Symbol name
- `kind`: number — [LSP SymbolKind](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind) (e.g. 5 = Class, 12 = Function)
- `location`: `{ uri: string, range:` [Range](#range) `}`

### Range

- `start`: `{ line: number, character: number }`
- `end`: `{ line: number, character: number }`

### LSPStatus

- `id`: string
- `name`: string
- `root`: string
- `status`: `"connected"` | `"error"`

### FormatterStatus

- `name`: string
- `extensions`: string[]
- `enabled`: boolean

### MessageError

Any of:

**ProviderAuthError** — `name: "ProviderAuthError"`

- `data`: `{ providerID: string, message: string }`

**UnknownError** — `name: "UnknownError"`

- `data`: `{ message: string }`

**MessageOutputLengthError** — `name: "MessageOutputLengthError"`

- `data`: object

**MessageAbortedError** — `name: "MessageAbortedError"`

- `data`: `{ message: string }`

**StructuredOutputError** — `name: "StructuredOutputError"`

- `data`: `{ message: string, retries: number }`

**ContextOverflowError** — `name: "ContextOverflowError"`

- `data`: `{ message: string, responseBody?: string }`

### APIError

- `name`: `"APIError"`
- `data`: `{ message: string, isRetryable: boolean, statusCode?: number, responseHeaders?: Record<string, string>, responseBody?: string, metadata?: Record<string, string> }`

---

## Config

The `Config` object is used by `GET /global/config`, `PATCH /global/config`, `GET /config`, and `PATCH /config`. All fields are optional (partial updates for PATCH).

- `theme?`: string — Theme name
- `model?`: string — Default model (`provider/model` format, e.g. `"anthropic/claude-sonnet-4-20250514"`)
- `small_model?`: string — Small model for tasks like title generation (`provider/model` format)
- `default_agent?`: string — Default agent name (must be a primary agent, falls back to `"build"`)
- `username?`: string — Custom username for conversations
- `snapshot?`: boolean — Enable snapshots
- `share?`: `"manual"` | `"auto"` | `"disabled"` — Sharing behavior
- `autoupdate?`: boolean | `"notify"` — Auto-update behavior
- `instructions?`: string[] — Additional instruction file paths/patterns
- `disabled_providers?`: string[] — Providers to disable
- `enabled_providers?`: string[] — When set, only these providers are enabled
- `plugin?`: string[] — Plugin paths
- `agent?`: Record\<string, [AgentConfig](#agentconfig)\> — Agent configurations (keys: `"build"`, `"plan"`, `"general"`, `"explore"`, `"title"`, `"summary"`, `"compaction"`, or custom)
- `command?`: Record\<string, CommandConfig\> — Slash command definitions
  - CommandConfig: `{ template: string, description?: string, agent?: string, model?: string, subtask?: boolean }`
- `provider?`: Record\<string, ProviderConfig\> — Custom provider configurations
- `mcp?`: Record\<string, McpConfig\> — MCP server configurations
- `server?`: [ServerConfig](#serverconfig)
- `permission?`: PermissionConfig — Permission rules
- `tools?`: Record\<string, boolean\> — Tool enable/disable overrides
- `compaction?`: `{ auto?: boolean, prune?: boolean, reserved?: integer }` — Compaction settings
- `skills?`: `{ paths?: string[], urls?: string[] }` — Additional skill sources
- `watcher?`: `{ ignore?: string[] }` — File watcher ignore patterns
- `formatter?`: false | Record\<string, FormatterConfig\> — Formatter configuration
  - FormatterConfig: `{ disabled?: boolean, command?: string[], environment?: Record<string, string>, extensions?: string[] }`
- `lsp?`: false | Record\<string, LspConfig\> — LSP server configuration
  - LspConfig: `{ command: string[], extensions?: string[], disabled?: boolean, env?: Record<string, string>, initialization?: Record<string, unknown> }`
- `experimental?`: `{ hook?: HookConfig, batch_tool?: boolean, primary_tools?: string[], continue_loop_on_deny?: boolean, mcp_timeout?: integer }`

### AgentConfig

Used inside `Config.agent`.

- `model?`: string — Model in `provider/model` format
- `variant?`: string — Default model variant
- `temperature?`: number
- `top_p?`: number
- `prompt?`: string — System prompt
- `description?`: string — When to use this agent
- `mode?`: `"subagent"` | `"primary"` | `"all"`
- `hidden?`: boolean — Hide from autocomplete (subagent only)
- `disable?`: boolean
- `color?`: string — Hex (`#FF5733`) or theme color (`"primary"`, `"secondary"`, `"accent"`, `"success"`, `"warning"`, `"error"`, `"info"`)
- `steps?`: integer (> 0) — Max agentic iterations
- `options?`: Record\<string, unknown\>

### ServerConfig

Used inside `Config.server`.

- `port?`: integer (> 0) — Listen port
- `hostname?`: string — Listen hostname
- `mdns?`: boolean — Enable mDNS discovery
- `mdnsDomain?`: string — Custom mDNS domain (default: `opencode.local`)
- `cors?`: string[] — Additional CORS domains
