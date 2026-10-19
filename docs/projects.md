# Projects & Sessions

## Runtime v0.9 identity

Under the v0.9.0-alpha unified runtime, the directory-first model above is
carried by stable keys instead of raw paths. `WorkspaceKey` combines the
target `environmentId` (a persistent UUID) with the remote canonical path and
volume policy; `RepoKey` uses the canonical Git common-dir. Sources are never
merged by remote URL, branch, native projectID, or a temporary tunnel port,
and case, symlink, and Windows volume rules are decided by the target probe,
not by the client's local path library. Sessions are addressed by
`SessionRef = { environmentId, harnessInstanceId, nativeSessionId }`. See
[runtime.md](./runtime.md) for the connection model and the per-source
capability matrix.

## Data Model

The session graph uses a **directory-first tree model**:

```
Worktree (project root)
 └─ Sandbox (directory)
     ├─ projectID (session namespace, assigned from session.created)
     ├─ branch (VCS branch name)
     └─ Sessions
         ├─ Session (root)
         │   └─ Session (child)  ← subagent sessions
         └─ Session (root)
```

### Tree Structure

The primary data structure is a nested map:

```typescript
tree: Map<worktree, Map<sandbox, SandboxEntry>>;

type SandboxEntry = {
  worktree: string; // parent worktree directory
  sandbox: string; // this sandbox's directory
  projectID?: string; // session namespace (set only by session.created)
  branch?: string; // VCS branch name
};
```

**Key insight**: Directory is the first-class citizen. ProjectID is just a session namespace.

### Worktree

The project root directory, selected via the top-left dropdown. Typically the root of a git repository.

- Example: `/home/user/prog/vis`
- The API exposes this as `ProjectInfo.worktree`.
- Maps to `tree[worktree]` in the session graph.

### Sandbox

A directory under a worktree. Can be:

- The worktree itself (`sandbox == worktree`)
- A git worktree (`/path/to/.git/worktrees/...`)
- A sandbox directory (`ProjectInfo.sandboxes[]`)

- Example: `/home/user/prog/vis`, `/home/user/.local/share/opencode/worktree/.../neon-canyon`
- Passed to the API as `?directory=` query parameter or `x-opencode-directory` header.
- Maps to `tree[worktree][sandbox]` in the session graph.

### ProjectID

An identifier assigned by OpenCode to each project (SHA hash string). **Only assigned from `session.created` SSE events.**

- Example: `95c06a8380e966d762e14efc434b1111b7169ab7`
- Stored on the sandbox entry: `tree[worktree][sandbox].projectID`
- Acts as a session namespace: all sessions under that sandbox share the same projectID.
- Multiple sandboxes under the same worktree can have different projectIDs.

### Session

A conversation session belonging to a specific sandbox (and thus a specific projectID).

- Sessions without a `parentID` are **root sessions**, shown in the top-right session list.
- Sessions with a `parentID` are **child sessions**, created by subagents.

## API and Directory

Most API calls require a `?directory=` parameter or `x-opencode-directory` header to specify the directory. Without it, the server defaults to its startup working directory, which is not robust.

### Building the Tree from APIs

The session graph is built from two primary APIs:

| API                        | Purpose                                            | Tree Update                                                                        |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /project`             | List all projects with worktrees and sandboxes     | Create `tree[worktree][sandbox]` entries for each project's worktree and sandboxes |
| `GET /session?directory=X` | List sessions for a directory with their projectID | Set `tree[worktree][sandbox].projectID` from session data                          |

**Important**: The `/project` API returns `projectID`, but this is **unreliable** for tree building. Only use the `worktree` and `sandboxes` fields. ProjectID is assigned only from `session.created` SSE events.

### Enumerating Sandboxes

A single worktree may have multiple sandboxes:

- The worktree itself (`ProjectInfo.worktree`)
- Git worktrees (`GET /experimental/worktree?directory=X`)
- Sandboxes (`ProjectInfo.sandboxes[]`)

These lists come from the `/project` and `/experimental/worktree` APIs and are synced into `tree[worktree]`.

## SSE Events

`GET /global/event` delivers events across all projects in a single stream.

Session-related events:

| Event             | Key Fields                                                               | Tree Update                                                                                                      |
| ----------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `session.created` | `info.id`, `info.projectID`, `info.directory`                            | **ONLY source of projectID**: Set `tree[worktree][directory].projectID = info.projectID`                         |
| `session.updated` | `info.id`, `info.projectID`, `info.directory`, `info.title`, `info.time` | Update session metadata                                                                                          |
| `session.status`  | `sessionID`, `status.type` (`busy` / `idle` / `retry`)                   | Update session status                                                                                            |
| `session.deleted` | `sessionID`                                                              | Remove session                                                                                                   |
| `project.updated` | `id`, `worktree`, `sandboxes[]`                                          | Sync sandboxes: ensure all `sandboxes[]` exist under `tree[worktree]`, remove stale ones. **Ignore `id` field.** |
| `worktree.ready`  | `directory`, `branch`                                                    | Set `tree[worktree][directory].branch = branch`                                                                  |

**Critical**: Only `session.created` carries a reliable `projectID`. Use it to assign the projectID to the sandbox. Other events should not attempt to resolve or assign projectID.

## Session Graph (sessionGraph)

`app/utils/sessionGraph.ts` is the **single source of truth (SSOT)** for:

- The directory-first tree: `tree[worktree][sandbox]` with projectID and branch
- All known sessions and their hierarchy
- Session status (busy/idle/retry)

### Tree Structure

The primary data structure:

```typescript
tree: Map<worktree, Map<sandbox, SandboxEntry>>;

type SandboxEntry = {
  worktree: string;
  sandbox: string;
  projectID?: string; // Only set from session.created
  branch?: string; // From worktree.ready or /meta
};
```

### Sessions

Each session is stored as a `SessionNode`:

| Field       | Description                                                        |
| ----------- | ------------------------------------------------------------------ |
| `sessionID` | Session ID (`ses_...`)                                             |
| `projectID` | Owning projectID (from sandbox entry)                              |
| `directory` | Owning directory (sandbox)                                         |
| `parentID`  | Parent session ID (`undefined` for root sessions)                  |
| `retention` | `persistent` (normal) or `ephemeral` (temporary subagent sessions) |

Sessions are keyed by `projectID:sessionID` in `nodesByKey`. A reverse index `sessionIndex: Map<sessionID, sandboxDir>` enables O(1) lookup by sessionID alone.

### Public API

Key methods for tree and session management:

**Tree operations:**

- `ensureSandbox(worktree, sandbox)` → creates tree entries if missing
- `getSandbox(worktree, sandbox)` → returns SandboxEntry or undefined
- `getWorktreeList()` → returns all worktree roots
- `getSandboxList(worktree)` → returns all sandboxes under worktree
- `setSandboxProjectID(sandbox, projectID)` → assigns projectID to sandbox
- `setSandboxBranch(sandbox, branch)` → sets branch on sandbox
- `syncSandboxes(worktree, sandboxDirs)` → from project.updated: sync sandbox list

**Session operations:**

- `upsertSession(info, options)` → adds/updates session, auto-creates sandbox if needed
- `removeSession(sessionID, projectID?)` → removes session
- `getSession(sessionID, projectID?)` → retrieves session (uses sessionIndex for O(1) lookup)
- `getRootSessions(query)` → filters by directory
- `getProjectIDForSession(sessionID)` → looks up projectID via sessionIndex

### Computed State in App.vue

The following are **computed from the graph** and update reactively:

| Computed            | Source                                                                      | Purpose                               |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| `projects`          | `sessionGraphStore.getWorktreeList()`                                       | All known worktree roots              |
| `worktrees`         | `sessionGraphStore.getSandboxList(projectDirectory)`                        | Sandbox list for selected worktree    |
| `worktreeMetaByDir` | `sessionGraphStore.getSandbox(pd, dir).branch` for each sandbox             | VCS branch info per directory         |
| `selectedProjectId` | `sessionGraphStore.getSandbox(projectDirectory, activeDirectory).projectID` | **Computed** from tree (not writable) |

### Writable Refs in App.vue

These remain **writable refs** for UI state:

| Ref                 | Purpose                           |
| ------------------- | --------------------------------- |
| `projectDirectory`  | User's selected worktree root     |
| `activeDirectory`   | User's selected sandbox/directory |
| `selectedSessionId` | User's selected session           |

### Session Fetching Flow

```
1. Bootstrap from /project API
   a. For each project: syncSandboxes(worktree, sandboxes)
   b. For each worktree: fetchSessions(worktree)
   c. For each session: upsertSession + setSandboxProjectID
2. SSE events (real-time updates)
   a. project.updated → syncSandboxes(worktree, sandboxes)
   b. session.created → setSandboxProjectID + upsertSession
   c. worktree.ready → setSandboxBranch
   d. session.status → status update
```

### Watcher Architecture

Focused atomic watchers:

- `watch(projectDirectory)` → fetch worktrees, refresh sessions
- `watch(activeDirectory)` → fetch worktree metadata, reload todos
- `watch(selectedSessionId)` → restore composer draft, reload todos
- `watch(sessionGraphVersion)` → trigger computed updates (projects, worktrees, etc.)

Each watcher is independent and handles a single concern. No circular dependencies.
