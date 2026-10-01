/**
 * dsh sessionSend — guarded prompt sending and cancellation (plan Todo 25).
 *
 * Live wire contract (dsh@0.2.0-rc.2, verified against a REAL server spawned
 * on 127.0.0.1:3080 — evidence `.omo/evidence/dsh-web-adapt/task-25/`):
 *   - `session/prompt` unary args are `{request:{requestId, sessionId, mode,
 *     content, clientTimeZone?}}` — the `request:` WRAPPER is mandatory; the
 *     flat form answers `gateway/arguments-invalid` (the smoke ran both).
 *   - the outer client-request envelope's `rpcId` MUST equal the inner
 *     `requestId` (Todo 20's binding): `user/message.source.rpcId` echoes the
 *     envelope rpcId, so a divergence makes outputs unbindable.
 *   - `session/cancel` args are `{request:{sessionId}}` (Todo 21 `abortSession`).
 *   - `{accepted:true}` is fire-and-forget; `turn/end.reason.kind` is the
 *     completion authority, so an ack is NEVER a turn-success signal.
 *
 * Guarantees this module owns:
 *   - NO session is ever created implicitly: a send with no available session
 *     pads the pending text with an EMPTY identity (projectID/sessionID/agent/
 *     inbox) and stops there — nothing is invented, nothing is sent.
 *   - the send's cwd is the SELECTED worktree: the session is resolved for the
 *     passed worktree path, never the session's original cwd.
 *   - the first user message writes `model.presetName` as an EXPLICIT empty
 *     string (key present, never omitted) — see {@link DshPromptModel}.
 *   - cancel routes through Todo 21's `abortSession` and produces a TERMINAL
 *     result, so a send racing a cancel can never leave a stuck "sending" or
 *     a phantom "sent".
 */
import type {
  BackendMessageSendParams,
  RequestGuard,
  SendPreflight,
} from '../../composables/backendMessageSend.types';
import type {
  DshClientRequest,
  DshJsonValue,
  DshPromptContentPart,
  DshSessionPromptResult,
} from './types';
import { createDshPromptSend, type DshPromptIdFactory, type DshPromptSend } from './promptEntries';
import { buildDshClientRequest } from '../../utils/dshRpc';

/** Delivery mode dsh admits (docs/dsh.md §7: queue appends, steer interrupts). */
export type DshSendMode = 'queue' | 'steer';

/**
 * The padded record for a pending (unsent) send with no available session.
 * Every identity field is EMPTY — dsh reports no pid, a missing session is
 * never invented, and a consumer's `field.startsWith(...)` must not throw
 * (the pid empty-string contract from `dshSessionEvents.ts`).
 */
export type DshPendingSendRecord = {
  /** The pending text, preserved for the composer (never dropped). */
  readonly text: string;
  /** '' — no project existed when the send was attempted. */
  readonly projectID: string;
  /** '' — no session existed: none was created and none was invented. */
  readonly sessionID: string;
  /** '' — no agent resolves without a session. */
  readonly agent: string;
  /** [] — the local inbox accepted nothing. */
  readonly inbox: readonly DshPromptContentPart[];
};

/** Pad a pending (unsent) text with the empty dsh identity. */
export function padDshPendingSend(text: string): DshPendingSendRecord {
  return { text, projectID: '', sessionID: '', agent: '', inbox: [] };
}

/**
 * The model selection the first user message carries. `provider` is EMPTY when
 * no route is selected (clamp-off / blank session) and `presetName` is written
 * EXPLICITLY as `''` — the key is present, never omitted:
 * when clamp is off, dsh reads a round with a missing presetName back as
 * `__none__` plus the endpoint/cli defaults and only re-explicitizes the value
 * at resume time; that 200-300ms window plus a slow first packet (2s) renders
 * a WRONG local badge for the round. Writing `presetName: ''` keeps the round
 * explicit from the first frame. (0.2.0-rc.2 strips the key at the strict
 * codec boundary — the live smoke proves the ack still succeeds.)
 */
export type DshPromptModel = {
  readonly provider: string;
  readonly presetName: string;
};

/** The first user message's model: provider explicitly empty, presetName ''. */
const FIRST_MESSAGE_MODEL: DshPromptModel = { provider: '', presetName: '' };

export type DshPromptRequestInput = {
  readonly sessionId: string;
  readonly content: readonly DshPromptContentPart[];
  readonly mode?: DshSendMode;
  readonly clientTimeZone?: string;
  /** True for the first user message of a blank session (writes the model). */
  readonly firstUserMessage?: boolean;
  readonly newRequestId?: DshPromptIdFactory;
};

export type DshPromptSendPlan = {
  /** Generated requestId; equals the outer rpcId AND the inner requestId. */
  readonly requestId: string;
  /** Todo 20 send (flat args): the identity the prompt-entries tracker binds. */
  readonly send: DshPromptSend;
  /** 0.2.0-rc.2 wire request: same rpcId, args wrapped under `request`. */
  readonly request: DshClientRequest;
};

/**
 * Build one guarded `session/prompt` plan. Todo 20's `createDshPromptSend`
 * generates the requestId and binds it to the envelope rpcId; this builder
 * re-wraps the flat args under the mandatory `request` key (the 0.2.0-rc.2
 * gateway rejects flat args with `gateway/arguments-invalid`) and adds the
 * explicit empty `model.presetName` on the first user message.
 */
export function buildDshPromptRequest(input: DshPromptRequestInput): DshPromptSendPlan {
  const send = createDshPromptSend(
    {
      sessionId: input.sessionId,
      content: input.content,
      mode: input.mode,
      clientTimeZone: input.clientTimeZone,
    },
    input.newRequestId,
  );
  const request: Record<string, DshJsonValue> = { ...send.request.payload.args };
  if (input.firstUserMessage) request.model = { ...FIRST_MESSAGE_MODEL };
  return {
    requestId: send.requestId,
    send,
    request: buildDshClientRequest('session/prompt', { request }, send.requestId),
  };
}

/** The send boundary seam (Todo 33 wires the real client behind it). */
export type DshSendApi = {
  /** Send one built `session/prompt` envelope (rpcId already bound). */
  prompt(request: DshClientRequest): Promise<DshSessionPromptResult>;
  /** Todo 21's `session/cancel` seam (`abortSession`). */
  abortSession(sessionId: string): Promise<unknown>;
  /** Resolve the session id whose workspace cwd is `cwd` (the selected worktree). */
  sessionIdForCwd?(cwd: string): Promise<string | null>;
  /** True once the follow stream / server connection has terminated. */
  isServerTerminal?(): boolean;
  /** True when the session has no user turn yet (drives the first message). */
  isBlankSession?(sessionId: string): Promise<boolean> | boolean;
};

export type DshSendOptions = {
  readonly mode?: DshSendMode;
  readonly clientTimeZone?: string;
  /** Overrides the api's blank-session probe when the caller already knows. */
  readonly firstUserMessage?: boolean;
  readonly newRequestId?: DshPromptIdFactory;
  /** Overrides `api.isServerTerminal` (tests / injected connection state). */
  readonly isServerTerminal?: () => boolean;
};

export type DshSendExecutionResult =
  | { readonly kind: 'stale' }
  | { readonly kind: 'pending'; readonly record: DshPendingSendRecord }
  | {
      readonly kind: 'server-terminal';
      readonly phase: 'before-send' | 'after-ack';
      readonly message: string;
    }
  | { readonly kind: 'accepted'; readonly requestId: string; readonly sessionId: string };

const SERVER_TERMINAL_BEFORE_SEND =
  'The dsh stream is no longer connected; the message was not sent.';
const SERVER_TERMINAL_AFTER_ACK =
  'The dsh stream terminated while the message was being sent; the turn outcome cannot be followed.';

/**
 * dsh prompts are TEXT-ONLY: attachments are explicitly OUT (Metis #13 — the
 * Beta surface exposes no attachment button and `uploadFileBinary`
 * pass-through is not a product promise).
 */
function dshTextParts(preflight: SendPreflight): DshPromptContentPart[] {
  const text = preflight.transformText(preflight.text);
  return text ? [{ type: 'text', text }] : [];
}

/** The selected worktree directory — the cwd the send targets. */
function selectedWorktreeCwd(params: BackendMessageSendParams): string {
  return params.activeDirectory.value.trim();
}

export async function runDshSend(
  params: BackendMessageSendParams,
  preflight: SendPreflight,
  guard: RequestGuard,
  api: DshSendApi,
  options: DshSendOptions = {},
): Promise<DshSendExecutionResult> {
  if (!guard.isCurrent()) return { kind: 'stale' };

  // A text-less send (attachments are OUT) has nothing to deliver.
  const parts = dshTextParts(preflight);
  if (!parts.length) return { kind: 'pending', record: padDshPendingSend(preflight.text) };

  const isTerminal = options.isServerTerminal ?? api.isServerTerminal;
  if (isTerminal?.()) {
    return { kind: 'server-terminal', phase: 'before-send', message: SERVER_TERMINAL_BEFORE_SEND };
  }

  // The send's cwd is the SELECTED worktree; the session's original cwd never
  // wins when a worktree path is passed.
  let sessionId = preflight.sessionId.trim();
  const worktreeCwd = selectedWorktreeCwd(params);
  if (worktreeCwd && api.sessionIdForCwd) {
    const resolved = await api.sessionIdForCwd(worktreeCwd);
    if (!guard.isCurrent()) return { kind: 'stale' };
    if (!resolved?.trim()) {
      // No session in the selected worktree: pad the pending text. NO session
      // is created and NOTHING is sent.
      return { kind: 'pending', record: padDshPendingSend(preflight.text) };
    }
    sessionId = resolved.trim();
  }
  if (!sessionId) {
    return { kind: 'pending', record: padDshPendingSend(preflight.text) };
  }

  const firstUserMessage =
    options.firstUserMessage ?? ((await api.isBlankSession?.(sessionId)) ?? false);
  if (!guard.isCurrent()) return { kind: 'stale' };

  const plan = buildDshPromptRequest({
    sessionId,
    content: parts,
    mode: options.mode ?? 'queue',
    clientTimeZone: options.clientTimeZone,
    firstUserMessage,
    newRequestId: options.newRequestId,
  });
  await api.prompt(plan.request);
  if (!guard.isCurrent()) return { kind: 'stale' };
  if (isTerminal?.()) {
    // The ack landed as the stream died: the turn outcome can no longer be
    // followed, so this is NOT a success — never a phantom "sent".
    return { kind: 'server-terminal', phase: 'after-ack', message: SERVER_TERMINAL_AFTER_ACK };
  }
  return { kind: 'accepted', requestId: plan.requestId, sessionId };
}

export type DshAbortResult =
  | { readonly kind: 'aborted'; readonly sessionId: string }
  | { readonly kind: 'stale' };

/**
 * Cancel the in-flight turn through Todo 21's `abortSession`. The result is
 * TERMINAL: the caller syncs the stopped state and invalidates the send fence
 * so a racing in-flight prompt can never commit a phantom success.
 */
export async function abortDshSend(options: {
  readonly api: DshSendApi;
  readonly sessionId: string;
  readonly guard?: RequestGuard;
}): Promise<DshAbortResult> {
  const { api, sessionId, guard } = options;
  const id = sessionId.trim();
  if (!id || (guard && !guard.isCurrent())) return { kind: 'stale' };
  await api.abortSession(id);
  if (guard && !guard.isCurrent()) return { kind: 'stale' };
  return { kind: 'aborted', sessionId: id };
}
