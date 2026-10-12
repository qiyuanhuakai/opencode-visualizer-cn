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
import type { SessionRef } from '../../shared/runtime/identity.js';
import { createSessionActionRouter } from './useRuntimeSessionActions';
import type { RuntimeActionContext, RuntimeSendInput, SessionMutation } from './useRuntimeSessionActions';
import type { SelectionCapture } from '../runtime/selectionScope';

export type { RuntimeSendInput } from './useRuntimeSessionActions';

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

export function useRuntimeMessageSend(ctx: RuntimeActionContext) {
  const router = createSessionActionRouter(ctx);
  // Model selection is per qualified session, never global — a source switch
  // must not leak the previous source's model.
  const models = new Map<string, string>();

  function sendWith(session: SessionRef, args: Readonly<Record<string, JsonValue>>, capture: SelectionCapture | null = null): SessionMutation {
    const bound = router.bind(session, capture);
    return router.mutate(bound, 'session.send', router.call(bound, args));
  }

  function slashWith(session: SessionRef, name: string, args?: Readonly<Record<string, JsonValue>>): SessionMutation {
    const bound = router.bind(session);
    return router.mutate(bound, 'session.send', router.call(bound, router.commandArgs(name, args)));
  }

  function send(session: SessionRef, input: RuntimeSendInput): SessionMutation {
    return sendWith(session, sendArgs(input));
  }

  function sendCaptured(input: RuntimeSendInput): SessionMutation {
    const capture = ctx.capture();
    requireValue(capture !== null, 'action.selection', 'cancelled');
    return sendWith(capture.selection.session, sendArgs(input), capture);
  }

  function cancelTurn(session: SessionRef): SessionMutation {
    const bound = router.bind(session);
    return router.mutate(bound, 'session.cancel', router.call(bound, {}));
  }

  return {
    router,
    send,
    sendCaptured,
    queue(session: SessionRef, input: RuntimeSendInput): SessionMutation {
      return sendWith(session, sendArgs({ ...input, queue: true }));
    },
    slash: slashWith,
    attach(session: SessionRef, attachments: readonly JsonValue[], input: RuntimeSendInput = {}): SessionMutation {
      return sendWith(session, sendArgs({ ...input, attachments }));
    },
    cancelTurn,
    compact(session: SessionRef): SessionMutation { return slashWith(session, 'compact'); },
    revert(session: SessionRef, payload: Readonly<Record<string, JsonValue>> = {}): SessionMutation {
      return slashWith(session, 'revert', payload);
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
