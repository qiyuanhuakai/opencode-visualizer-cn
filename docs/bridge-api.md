# Bridge API

Draft REST API reference for `vis-bridge`.

This document describes the **bridge-facing contract** that the Electron app / Web UI should consume.
It is intentionally narrower than the full OpenCode server API: the bridge normalizes provider and plugin differences before data reaches the UI.

Base URL is implementation-defined. Examples in this document use `http://127.0.0.1:4097`.

---

## Common Conventions

### Headers

| Header                 | Required            | Description                                                           |
| ---------------------- | ------------------- | --------------------------------------------------------------------- |
| `Content-Type`         | POST with JSON body | `application/json`                                                    |
| `Authorization`        | No                  | `Bearer <token>` when the bridge is protected for remote access       |
| `x-opencode-directory` | No                  | Optional project directory scope. May also be supplied in JSON bodies |

### Error Responses

All endpoints may return standard HTTP errors.

Structured error shape:

```json
{
  "name": "BridgeError",
  "data": {
    "code": "binary-not-found",
    "message": "Claude CLI is not installed.",
    "providerID": "claude"
  }
}
```

Recommended `data.code` values:

- `binary-not-found`
- `version-unsupported`
- `auth-missing`
- `bad-request`
- `session-not-found`
- `approval-not-found`
- `plugin-missing`
- `plugin-runtime-error`
- `session-crashed`

### Model References

Bridge APIs should use the existing `provider/model` string shape whenever possible.

Examples:

- `openai/gpt-5.4`
- `anthropic/claude-sonnet-4`
- `google/gemini-2.5-pro`

---

## Global

### GET /bridge/health

Bridge health check.

- Response `200`:

```json
{
  "healthy": true,
  "version": "0.1.0",
  "startedAt": 1760000000000,
  "uptimeMs": 8123,
  "providers": { "available": 2, "total": 3 },
  "plugins": { "available": 1, "total": 4 },
  "degraded": false,
  "notes": []
}
```

### GET /bridge/providers

List all known providers and their availability.

- Response `200`: [ProviderInfo](#providerinfo)[]

### GET /bridge/plugins

List discovered plugins and their current status.

- Query:
  - `directory?` (string) — evaluate project-scoped plugins for a specific project
  - `providerID?` (string) — filter plugins relevant to a provider
- Response `200`: [PluginInfo](#plugininfo)[]

### GET /bridge/events

Subscribe to the global bridge SSE stream. See [bridge-events.md](./bridge-events.md).

- Query:
  - `sessionID?` (string) — optionally scope to a single session
  - `providerID?` (string)
  - `directory?` (string)
- Response `200`: `text/event-stream`

---

## Session

### GET /bridge/session

List bridge-managed sessions.

- Query:
  - `directory?` (string)
  - `providerID?` (string)
  - `status?` (string)
- Response `200`: [SessionInfo](#sessioninfo)[]

### POST /bridge/session

Create a new bridge-managed session.

- Body: [CreateSessionRequest](#createsessionrequest)
- Response `200`: [SessionInfo](#sessioninfo)
- Response `400`: BridgeError

Example body:

```json
{
  "providerID": "codex",
  "directory": "/home/user/project",
  "model": "openai/gpt-5.4",
  "pluginIDs": ["opencode-magic-context"],
  "metadata": {
    "source": "vis"
  }
}
```

### GET /bridge/session/{sessionID}

Get current session state.

- Path: `sessionID` (string, required)
- Response `200`: [SessionInfo](#sessioninfo)
- Response `404`: BridgeError

### POST /bridge/session/{sessionID}/prompt

Send a prompt to an existing session.

- Path: `sessionID` (string, required)
- Body: [SendPromptRequest](#sendpromptrequest)
- Response `200`:

```json
{
  "accepted": true,
  "sessionID": "ses_123",
  "turnID": "turn_456"
}
```

### POST /bridge/session/{sessionID}/approval

Resolve a pending approval request.

- Path: `sessionID` (string, required)
- Body: [ApprovalResponse](#approvalresponse)
- Response `200`:

```json
{
  "accepted": true,
  "sessionID": "ses_123",
  "requestID": "apr_456"
}
```

### POST /bridge/session/{sessionID}/cancel

Cancel the current in-flight turn, if supported by the provider.

- Path: `sessionID` (string, required)
- Response `200`:

```json
{
  "accepted": true,
  "sessionID": "ses_123"
}
```

### DELETE /bridge/session/{sessionID}

Dispose a session and release provider runtime resources.

- Path: `sessionID` (string, required)
- Response `200`: `boolean`

---

## Shapes

### BridgeHealth

- `healthy`: boolean
- `version`: string
- `startedAt`: number
- `uptimeMs`: number
- `providers`: `{ available: number; total: number }`
- `plugins`: `{ available: number; total: number }`
- `degraded`: boolean
- `notes`: string[]

### ProviderInfo

- `id`: string
- `label`: string
- `available`: boolean
- `version?`: string
- `reason?`: string
- `capabilities`: [ProviderCapabilities](#providercapabilities)

### ProviderCapabilities

- `streaming`: boolean
- `resume`: boolean
- `approval`: boolean
- `tools`: boolean
- `structuredOutput`: boolean

### PluginInfo

- `id`: string
- `label`: string
- `source`: `bridge-config` | `project-config` | `discovery`
- `available`: boolean
- `loaded`: boolean
- `path?`: string
- `reason?`: string
- `contributes`: (`"tool"` | `"command"` | `"context"` | `"status"` | `"metrics"`)[]

### SessionInfo

- `id`: string
- `providerID`: string
- `directory?`: string
- `title?`: string
- `model?`: string
- `status`: `idle` | `running` | `awaiting-approval` | `completed` | `error` | `cancelled`
- `createdAt`: number
- `updatedAt`: number
- `pluginIDs`: string[]
- `lastError?`: [BridgeErrorData](#bridgeerrordata)
- `metadata`: Record<string, unknown>

### CreateSessionRequest

- `providerID`: string (**required**)
- `directory?`: string
- `title?`: string
- `model?`: string — `provider/model` format recommended
- `pluginIDs?`: string[]
- `metadata?`: Record<string, unknown>

### SendPromptRequest

- `prompt`: string (**required**)
- `attachments?`: `{ type: string; name?: string; path?: string; content?: string }[]`
- `metadata?`: Record<string, unknown>

### ApprovalResponse

- `requestID`: string (**required**)
- `decision`: `once` | `always` | `reject`

### BridgeErrorData

- `code`: string
- `message`: string
- `providerID?`: string
- `pluginID?`: string
- `sessionID?`: string
- `details?`: Record<string, unknown>

---

## Notes for Implementation

1. The bridge should remain the source of truth for **session state**, even when underlying providers have their own native session IDs.
2. `GET /bridge/providers` and `GET /bridge/plugins` should be cheap and should not fully boot every provider runtime.
3. Plugin absence must be represented as state (`available: false`), not as a fatal bridge startup error.
4. The global SSE stream should emit normalized bridge events only. Provider-native raw events may be logged internally, but should not be exposed as the primary UI contract.
