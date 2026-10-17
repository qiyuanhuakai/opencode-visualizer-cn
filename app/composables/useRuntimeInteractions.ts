// Task 22 — agent interaction responses on the qualified routing path.
//
// Permission requests and questions arrive from a native harness. When the user
// answers, the response must go back to exactly the session that asked. Two
// sources can expose the same native request id, so the response is routed by
// the full qualified SessionRef and the pending registry is keyed the same way.
// A response scoped to source A can never resolve, read or observe source B.
//
// The native driver reads `params.answer` (not `params.response`) and validates
// that answer against the pending interaction's native method, so the reply is
// encoded per interaction type instead of merely renamed.
import { requireValue } from '../../shared/runtime/capabilities.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { createSessionActionRouter } from './useRuntimeSessionActions';
import type { RuntimeActionContext, SessionMutation } from './useRuntimeSessionActions';

export type InteractionResponse = Readonly<Record<string, JsonValue>>;
export type PermissionDecision = Readonly<Record<string, JsonValue>>;

const APPROVAL_KEYS = ['decision', 'action', 'permissions', 'success'] as const;

function encodePermission(decision: PermissionDecision): InteractionResponse {
  if (APPROVAL_KEYS.some((key) => Object.hasOwn(decision, key))) return Object.freeze({ ...decision });
  if (typeof decision.allow === 'boolean') {
    return Object.freeze({ decision: decision.allow ? 'accept' : 'decline' });
  }
  return Object.freeze({ ...decision });
}

function encodeQuestion(answers: InteractionResponse): InteractionResponse {
  if (Object.hasOwn(answers, 'answers')) return Object.freeze({ ...answers });
  return Object.freeze({ answers });
}

export function useRuntimeInteractions(ctx: RuntimeActionContext) {
  const router = createSessionActionRouter(ctx);
  // Pending interaction ids, keyed by the qualified session key.
  const scoped = new Map<string, Set<string>>();

  function respond(session: SessionRef, interactionId: string, answer: InteractionResponse): SessionMutation {
    requireValue(typeof interactionId === 'string' && interactionId.length > 0 && interactionId.length <= 4096, 'action.interaction');
    requireValue(answer !== null && typeof answer === 'object' && !Array.isArray(answer), 'action.answer');
    const bound = router.bind(session);
    return router.mutate(bound, 'interaction.respond', router.call(bound, { interactionId, answer }));
  }

  function track(session: SessionRef, interactionId: string): void {
    requireValue(typeof interactionId === 'string' && interactionId.length > 0, 'action.interaction');
    const key = router.qualifiedKey(session);
    let ids = scoped.get(key);
    if (!ids) { ids = new Set<string>(); scoped.set(key, ids); }
    ids.add(interactionId);
  }

  return {
    router,
    respond,
    permission(session: SessionRef, interactionId: string, decision: PermissionDecision): SessionMutation {
      return respond(session, interactionId, encodePermission(decision));
    },
    question(session: SessionRef, interactionId: string, answers: InteractionResponse): SessionMutation {
      return respond(session, interactionId, encodeQuestion(answers));
    },
    track,
    resolveInteraction(session: SessionRef, interactionId: string): void {
      scoped.get(router.qualifiedKey(session))?.delete(interactionId);
    },
    pendingFor(session: SessionRef): readonly string[] {
      const ids = scoped.get(router.qualifiedKey(session));
      return ids ? Object.freeze([...ids]) : Object.freeze([] as string[]);
    },
  };
}

export type RuntimeInteractions = ReturnType<typeof useRuntimeInteractions>;
