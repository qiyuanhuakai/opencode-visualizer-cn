import { requireValue } from '../../capabilities.js';
import { parseCodexThreadTokenUsage } from './normalize.js';
import { record, rejectSecretInput } from './boundaries.js';

const REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
]);
export function createCodexEvents({
  client,
  sessions,
  interactions,
  sessionFor,
  scopeFor,
  assertCurrent,
  emit,
  privacy,
  catalogChanged,
  resolveCredential,
}) {
  async function onMessage(message) {
    assertCurrent();
    const params = record(message.params ?? {});
    const nativeId = params.threadId ?? params.thread?.id;
    if (message.id !== undefined && !REQUESTS.has(message.method)) {
      client.reject(message.id, -32601);
      return;
    }
    // Instance notifications never forward account/auth/config payloads into renderer events.
    if (typeof nativeId !== 'string') return;
    const session = sessionFor(nativeId);
    if (message.id !== undefined) {
      await sessions.bind(session);
      assertCurrent();
      const payload = privacy({ method: message.method, params });
      const interactionId = await interactions.pending({
        scope: scopeFor(session),
        nativeRequestId: message.id,
        payload,
      });
      assertCurrent();
      emit({ type: 'interaction.pending', session, payload: { interactionId, ...payload } });
      return;
    }
    switch (message.method) {
      case 'thread/tokenUsage/updated': {
        const usage = parseCodexThreadTokenUsage(params, nativeId);
        if (usage) emit({ type: message.method, session, payload: usage });
        return;
      }
      case 'turn/started':
        requireValue(typeof params.turn?.id === 'string', 'codex.event.turn');
        sessions.started(session, params.turn.id);
        break;
      case 'turn/completed': {
        requireValue(typeof params.turn?.id === 'string', 'codex.event.turn');
        const outcome = { completed: 'completed', failed: 'failed', interrupted: 'interrupted' }[
          params.turn.status
        ];
        requireValue(outcome, 'codex.event.terminal', 'reconcile_required');
        await sessions.terminal({ session, turnId: params.turn.id, outcome });
        break;
      }
      case 'error':
        if (params.willRetry === false && typeof params.turnId === 'string')
          await sessions.terminal({ session, turnId: params.turnId, outcome: 'failed' });
        break;
      case 'thread/deleted':
      case 'thread/archived':
      case 'thread/unarchived':
      case 'thread/name/updated':
        await catalogChanged(session, message.method, params);
        break;
    }
    assertCurrent();
    const payload = params.turn
      ? {
          ...params,
          turn: {
            id: params.turn.id,
            status: params.turn.status,
            error: params.turn.error ?? null,
          },
        }
      : params;
    emit({ type: message.method, session, payload: privacy(payload) });
  }
  function validateAnswer(method, response) {
    record(response, 'codex.interaction.answer');
    if (method.endsWith('requestApproval') && method !== 'item/permissions/requestApproval')
      requireValue(response.decision !== undefined, 'codex.interaction.decision');
    if (method === 'mcpServer/elicitation/request')
      requireValue(
        ['accept', 'decline', 'cancel'].includes(response.action),
        'codex.interaction.action',
      );
    if (method === 'item/tool/requestUserInput')
      record(response.answers, 'codex.interaction.answers');
    if (method === 'item/tool/call')
      requireValue(
        typeof response.success === 'boolean' && Array.isArray(response.contentItems),
        'codex.interaction.result',
      );
  }
  async function respond({ session, interactionId, answer, credentialRef }) {
    assertCurrent();
    const pending = await interactions.get(interactionId);
    requireValue(
      pending.scope.session.nativeSessionId === session.nativeSessionId &&
        pending.scope.session.environmentId === session.environmentId &&
        pending.scope.session.harnessInstanceId === session.harnessInstanceId,
      'codex.interaction.scope',
      'unauthorized',
    );
    const method = pending.payload.method;
    requireValue(REQUESTS.has(method), 'codex.interaction.method', 'unsupported');
    if (!credentialRef) rejectSecretInput(answer);
    if (!credentialRef) validateAnswer(method, answer);
    const stored = credentialRef ? { credentialRef } : record(answer, 'codex.interaction.answer');
    return interactions.reply(
      interactionId,
      scopeFor(session),
      stored,
      async ({ nativeRequestId, answer: durable }) => {
        assertCurrent();
        const response = credentialRef
          ? await resolveCredential(credentialRef, { session, interactionId })
          : durable;
        assertCurrent();
        validateAnswer(method, response);
        client.reply(nativeRequestId, response);
      },
    );
  }
  return { onMessage, respond };
}
