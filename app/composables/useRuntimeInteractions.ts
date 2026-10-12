// Task 22 — agent interaction responses on the qualified routing path.
//
// Permission requests and questions arrive from a native harness. When the user
// answers, the response must go back to exactly the session that asked. Two
// sources can expose the same native request id, so the response is routed by
// the full qualified SessionRef and the pending registry is keyed the same way.
// A response scoped to source A can never resolve, read or observe source B.
import { requireValue } from '../../shared/runtime/capabilities.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { createSessionActionRouter } from './useRuntimeSessionActions';
import type { RuntimeActionContext, SessionMutation } from './useRuntimeSessionActions';

export type InteractionResponse = Readonly<Record<string, JsonValue>>;
export type PermissionDecision = Readonly<Record<string, JsonValue>>;

export function useRuntimeInteractions(ctx: RuntimeActionContext) {
  const router = createSessionActionRouter(ctx);
  // Pending interaction ids, keyed by the qualified session key.
  const scoped = new Map<string, Set<string>>();

  function respond(session: SessionRef, interactionId: string, response: InteractionResponse): SessionMutation {
    requireValue(typeof interactionId === 'string' && interactionId.length > 0 && interactionId.length <= 4096, 'action.interaction');
    requireValue(response !== null && typeof response === 'object' && !Array.isArray(response), 'action.response');
    const bound = router.bind(session);
    return router.mutate(bound, 'interaction.respond', router.call(bound, { interactionId, response }));
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
      return respond(session, interactionId, { type: 'permission', ...decision });
    },
    question(session: SessionRef, interactionId: string, answers: InteractionResponse): SessionMutation {
      return respond(session, interactionId, { type: 'question', answers });
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
