// Task 22 — message send / turn control on the qualified routing path.
//
// `useRuntimeMessageSend` is the new-path replacement for the backend-specific
// `useBackendMessageSend` send/abort pipeline. It routes every send, queue,
// slash command, attachment upload and cancel through the full qualified
// SessionRef (see useRuntimeSessionActions.ts), and it owns the per-source
// model selection so two sources with a colliding native id can never share a
// selected model.
//
// The critical invariant this module must uphold (GAP-1): a send that is
// already in flight is bound to its CAPTURED TARGET scope, so changing the UI
// selection while a busy session is running must NOT cancel that session's
// turn. `sendCaptured()` therefore fences on the captured `clientScope` (a
// target-level check), never on `SelectionCapture.isCurrent()` or
// `SelectionCapture.signal` (both of which `selectionScope.ts` flips on the
// next `select()`).
import { requireValue } from '../../shared/runtime/capabilities.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import type { HarnessKind } from '../../shared/runtime/harnessContract.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { createSessionActionRouter } from './useRuntimeSessionActions';
import type { RuntimeActionContext, RuntimeSendInput, SessionMutation } from './useRuntimeSessionActions';
import type { SelectionCapture } from '../runtime/selectionScope';

export type { RuntimeSendInput } from './useRuntimeSessionActions';

/**
 * A real per-harness send/lifecycle adapter (finding B). It maps a generic
 * composer input onto the payload the harness driver's `send` actually accepts,
 * and maps a lifecycle command name onto the native operation that supports it
 * (or `null` when the harness has no generic command entry — an unsupported
 * action is then rejected instead of being padded into `session.send`).
 */
export type RuntimeSendAdapter = Readonly<{
  kind: HarnessKind;
  send(input: RuntimeSendInput): Readonly<Record<string, JsonValue>>;
  command(name: string, args?: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> | null;
}>;

/**
 * Codex `core.send` requires `params.native.input` (an array of turn input
 * items) plus optional model/effort and queue; `params.text`/`params.attachments`
 * are rejected with `invalid_request: codex.params.field`. Lifecycle commands on
 * the codex driver are native extensions that the qualified client cannot
 * address, so they are reported unsupported rather than mis-sent.
 */
export function codexSendAdapter(): RuntimeSendAdapter {
  return {
    kind: 'codex',
    send(input) {
      const content: JsonValue[] = [];
      if (typeof input.text === 'string' && input.text.length > 0) {
        content.push({ type: 'text', text: input.text });
      }
      for (const attachment of input.attachments ?? []) content.push(attachment);
      requireValue(content.length > 0, 'codex.send.input');
      const native: Record<string, JsonValue> = { input: content };
      if (typeof input.model === 'string' && input.model.length > 0) native.model = input.model;
      if (typeof input.thinking === 'string' && input.thinking.length > 0) native.effort = input.thinking;
      const args: Record<string, JsonValue> = { native };
      if (input.queue === true) args.queue = true;
      return Object.freeze(args);
    },
    command() {
      return null;
    },
  };
}

function sendArgs(input: RuntimeSendInput): Readonly<Record<string, JsonValue>> {
  const args: Record<string, JsonValue> = { ...input.args };
  if (input.text !== undefined) args.text = input.text;
  if (input.attachments !== undefined) args.attachments = input.attachments;
  if (input.model !== undefined && input.model !== null) args.model = input.model;
  if (input.mode !== undefined && input.mode !== null) args.mode = input.mode;
  if (input.thinking !== undefined && input.thinking !== null) args.thinking = input.thinking;
  if (input.queue === true) args.queue = true;
  return args;
}

/** The context plus the optional harness kind that selects a real adapter (finding B). */

/**
 * The turn-lifecycle seam a harness adapter supplies. A send RPC's ACKNOWLEDGMENT is not the turn's
 * END: the real Codex session (`shared/runtime/native/codex/sessionOperations.js`) returns the
 * execution result as soon as `turn/start` is acknowledged and keeps the operation ACTIVE until a
 * later terminal notification, and `cancel` still requires the matching active operationId. An owner
 * retired on the acknowledgment therefore leaves `cancelTurn` with no id to send, and the real cancel
 * refuses it as `codex.cancel.owner`. Without this seam the owner is retired only when superseded,
 * which is still sound: it is never dropped on an acknowledgment.
 */
export type RuntimeTurnLifecycle = Readonly<{
  onTerminal(listener: (terminal: Readonly<{ operationId: string }>) => void): () => void;
}>;

export type RuntimeSendContext = RuntimeActionContext & Readonly<{
  harnessKind?: HarnessKind;
  turnLifecycle?: RuntimeTurnLifecycle | null;
}>;

export function useRuntimeMessageSend(ctx: RuntimeSendContext, adapter?: RuntimeSendAdapter | null) {
  const router = createSessionActionRouter(ctx);
  // Model selection is per qualified session, never global — a source switch
  // must not leak the previous source's model.
  const models = new Map<string, string>();
  // The native parent operationId of the turn that is actually EXECUTING, per qualified
  // session; a cancel must target the active turn's owner, not an empty id.
  const parents = new Map<string, string>();
  const harness: RuntimeSendAdapter | null =
    adapter ?? (ctx.harnessKind === 'codex' ? codexSendAdapter() : null);

  function encodeSend(input: RuntimeSendInput): Readonly<Record<string, JsonValue>> {
    return harness ? harness.send(input) : sendArgs(input);
  }

  function sendWith(session: SessionRef, args: Readonly<Record<string, JsonValue>>, capture: SelectionCapture | null = null): SessionMutation {
    const bound = router.bind(session, capture);
    const mutation = router.mutate(bound, 'session.send', router.call(bound, args));
    const key = router.qualifiedKey(session);
    const lifecycle = ctx.turnLifecycle ?? null;
    mutation.accepted.then(
      (receipt) => {
        const operationId = receipt?.operationId;
        if (typeof operationId !== 'string' || operationId.length === 0) return;
        // A queued receipt is NOT the active turn: it is a message waiting behind whatever is
        // running. Recording it as the turn owner would make cancelTurn() cancel the QUEUE instead
        // of stopping the turn the user is waiting on, so only a non-queued send becomes the owner.
        // A queued send claims the owner only once the queue PROMOTES it, which is when its own send
        // RPC is finally issued and the operation becomes the session's active turn.
        const claim = () => {
          parents.set(key, operationId);
          let unsubscribe: (() => void) | null = null;
          // The owner is retired by the turn's own terminal notification, so a later cancel never
          // carries a stale operationId into a session that is no longer running anything. The send
          // RPC's acknowledgment is NOT that notification: it only means the request was accepted.
          const retire = () => {
            if (parents.get(key) === operationId) parents.delete(key);
            unsubscribe?.();
          };
          unsubscribe = lifecycle?.onTerminal((terminal) => {
            if (terminal.operationId === operationId) retire();
          }) ?? null;
        };
        if (args.queue === true) void mutation.executed.then(claim, () => {});
        else claim();
      },
      () => {},
    );
    return mutation;
  }

  function commandWith(session: SessionRef, name: string, args?: Readonly<Record<string, JsonValue>>): SessionMutation {
    if (!harness) {
      const bound = router.bind(session);
      return router.mutate(bound, 'session.send', router.call(bound, router.commandArgs(name, args)));
    }
    const encoded = harness.command(name, args);
    requireValue(encoded !== null, `harness.command.${name}`, 'unsupported');
    return sendWith(session, encoded);
  }

  function send(session: SessionRef, input: RuntimeSendInput): SessionMutation {
    return sendWith(session, encodeSend(input));
  }

  function sendCaptured(input: RuntimeSendInput): SessionMutation {
    const capture = ctx.capture();
    requireValue(capture !== null, 'action.selection', 'cancelled');
    return sendWith(capture.selection.session, encodeSend(input), capture);
  }

  function cancelTurn(session: SessionRef, parentOperationId?: string): SessionMutation {
    const bound = router.bind(session);
    const operationId = parentOperationId ?? parents.get(router.qualifiedKey(session));
    const args: Record<string, JsonValue> = {};
    if (typeof operationId === 'string' && operationId.length > 0) args.operationId = operationId;
    return router.mutate(bound, 'session.cancel', router.call(bound, args));
  }

  return {
    router,
    send,
    sendCaptured,
    queue(session: SessionRef, input: RuntimeSendInput): SessionMutation {
      return sendWith(session, encodeSend({ ...input, queue: true }));
    },
    slash: commandWith,
    attach(session: SessionRef, attachments: readonly JsonValue[], input: RuntimeSendInput = {}): SessionMutation {
      return sendWith(session, encodeSend({ ...input, attachments }));
    },
    cancelTurn,
    compact(session: SessionRef): SessionMutation { return commandWith(session, 'compact'); },
    revert(session: SessionRef, payload: Readonly<Record<string, JsonValue>> = {}): SessionMutation {
      return commandWith(session, 'revert', payload);
    },
    modelFor(session: SessionRef): string | null { return models.get(router.qualifiedKey(session)) ?? null; },
    setModel(session: SessionRef, model: string): void {
      requireValue(typeof model === 'string' && model.length > 0, 'action.model');
      models.set(router.qualifiedKey(session), model);
    },
    clearModel(session: SessionRef): void { models.delete(router.qualifiedKey(session)); },
  };
}

export type RuntimeMessageSend = ReturnType<typeof useRuntimeMessageSend>;
