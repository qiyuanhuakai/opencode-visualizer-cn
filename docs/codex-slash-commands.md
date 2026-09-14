# Codex slash commands in vis

vis interprets Codex commands before sending ordinary chat input. Commands open existing controls or call App Server methods; unsupported commands remain in the composer with an error instead of being sent as model instructions. OpenCode and ACP keep their existing command paths.

## Commands

| Commands | vis behavior |
| --- | --- |
| `/model` | Open the composer model picker. |
| `/fast`, `/fast on`, `/fast off` | Select the current model's catalog-provided Fast tier and persist `service_tier`. The Fast on/off button between reasoning effort and Goal also toggles by click or keyboard without changing the draft. Untouched settings preserve the server default; explicit off sends `default` on subsequent turns. |
| `/permissions [read-only\|workspace-write\|full-access]` | Open the permission picker, or select a preset constrained by server requirements. Applies to subsequent turns in the current thread, not an already running command. |
| `/status` | Open the status monitor. |
| `/usage [daily\|weekly\|cumulative]` | Open **Status monitor → Token** and focus the requested activity view. Account Token activity and current conversation consumption are separate. Codex quota consumption remains in the **Codex** tab. |
| `/skills`, `/mcp`, `/plugins` | Open the corresponding status monitor tab. |
| `/init` | Expand the unchanged official Codex initialization prompt into a normal request. The upstream prompt instructs Codex not to overwrite an existing `AGENTS.md`. |
| `/plan [task]` | Without a task, toggle between Plan and Default for subsequent messages, including while a turn is running. Inline text enters Plan and sends the task when idle. |
| `/goal [objective\|edit\|pause\|resume\|clear]` | Open the goal editor or update the current thread's goal. |
| `/compact` | Request native thread compaction. |
| `/new [name]`, `/resume` | Create a thread or open the session picker. |
| `/fork` | Create and select a persistent conversation fork. |
| `/btw [question]`, `/side [question]` | Create an ephemeral fork and open an independent side-chat window. The main thread continues; closing interrupts/unsubscribes only the side thread. Approval and question dialogs retain the side thread's identity. Model, tier, and permission overrides are captured when opening the side chat; later main-thread changes do not alter them. |
| `/rename [name]` | Rename the current thread, prompting for a name when omitted. |
| `/archive` | Archive with native `thread/archive` and select a remaining thread. This is distinct from the existing session menu's local hiding behavior. |
| `/diff`, `/review [instructions]` | Open the existing worktree diff viewer or run a native review. |
| `/ps` | Show current-thread terminal activity observed since connection, including recent output. This is not a complete list of processes started before connection. |
| `/stop` | Ask Codex to clean up the current thread's background terminals. |
| `/copy` | Copy the latest completed assistant response. |

Appearance commands, `/mention`, `/agent`, `/subagent`, and `/subagents` are intentionally not registered. Local `/shell` and `/debug` remain available. Attachments are preserved when executing a local command.

Navigation commands (`/new`, `/fork`, `/archive`) consume and save the source session's command input before switching. Returning to that session restores an empty command input and preserves any attachments. A failed navigation restores the command if the source input is still empty; it never overwrites a newer draft or the destination session's draft.

## Compatibility and provenance

Protocol fields were checked against `codex-cli 0.154.0` using `codex app-server generate-ts`. Optional capabilities remain subject to server version, model catalog, configured requirements, and authentication. Account Token activity uses `account/usage/read`; an unsupported authentication mode or server displays an explicit unavailable state.

Card Undo, including review cards, uses native `thread/revert` with `beforeTurnId` for paginated history and `thread/rollback` for legacy history. It removes the selected turn and subsequent turns from the conversation, without reverting workspace files. Unsupported server methods surface an error and preserve the displayed history.

The official init asset is `app/assets/codex/prompt_for_init_command.md`, copied byte-for-byte from OpenAI Codex `rust-v0.154.0`. Its source, Git blob identity, and Apache-2.0 license are retained in `app/assets/codex/`. The normal composer trims surrounding whitespace when sending, without rewriting prompt content.

Official references:

- https://learn.chatgpt.com/docs/developer-commands?surface=cli
- https://learn.chatgpt.com/docs/app-server
- https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/assets/prompt_for_init_command.md

## Verification

`node scripts/qa/codex-slash.mjs` drives the full app in Chromium against a deterministic App Server fixture. It checks actual JSON-RPC requests, no-turn local commands, official init content, tier and permission parameters, side/main isolation, native archive, and responsive surfaces at 375/768/1280 pixels. Artifacts are written to `.omo/evidence/codex-slash/`.

This fixture does not spend real account quota or establish live account availability. Unit/adapter tests cover default-tier preservation, forbidden permissions, stale replies, side approvals, close races, unsupported commands, and nullable usage data.
