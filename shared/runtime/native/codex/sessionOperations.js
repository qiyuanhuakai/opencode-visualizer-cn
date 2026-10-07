import { encodeSessionKey } from '../../identity.js';
import { ProtocolError, requireValue } from '../../capabilities.js';
import { createCodexCancellation } from './cancelOperations.js';

/** Session sends retain ownership until native terminal; queued intents never execute on an acknowledgement. */
export function createCodexSessionOperations({
  store,
  fingerprint,
  newId,
  journal,
  interactions,
  request,
  scopeFor,
  assertCurrent,
  emit,
  authorizeSession,
}) {
  const handles = new Map();
  const cancelActive = createCodexCancellation({
    store,
    fingerprint,
    newId,
    request,
    assertCurrent,
  });
  function handleFor(session) {
    assertCurrent();
    const key = encodeSessionKey(session);
    if (!handles.has(key)) {
      requireValue(handles.size < 512, 'codex.loaded_sessions', 'source_unavailable');
      handles.set(key, {
        scope: scopeFor(session),
        binding: null,
        active: null,
        queue: [],
        resumed: false,
        resumePromise: null,
      });
    }
    return handles.get(key);
  }
  async function bind(session) {
    const handle = handleFor(session);
    handle.binding ??= interactions.bindProcess(handle.scope);
    await handle.binding;
    assertCurrent();
    return handle;
  }
  async function resume(session) {
    const handle = await bind(session);
    if (!handle.resumed) {
      handle.resumePromise ??= (async () => {
        await authorizeSession(session);
        await request('thread/resume', { threadId: session.nativeSessionId, excludeTurns: true });
        assertCurrent();
        handle.resumed = true;
      })();
      await handle.resumePromise;
    }
    return handle;
  }
  function failure(handle, job, error) {
    emit({
      type: 'operation.reconciling',
      session: handle.scope.session,
      payload: {
        operationId: job.operationId,
        code: error instanceof ProtocolError ? error.code : 'source_unavailable',
      },
    });
  }
  async function execute(handle, job) {
    assertCurrent();
    requireValue(!handle.active, 'codex.session_busy', 'conflict');
    const active = { operationId: job.operationId, turnId: null, method: job.method };
    handle.active = active;
    try {
      const result = await journal.execute(job.operationId, handle.scope, async ({ payload }) => {
        assertCurrent();
        return request(job.method, { ...payload, threadId: handle.scope.session.nativeSessionId });
      });
      assertCurrent();
      if (job.turn === 'compact') {
        // Native compaction acknowledges before its turn notifications complete.
      } else if (job.turn) {
        requireValue(
          typeof result.result?.turn?.id === 'string',
          'codex.send.turn',
          'reconcile_required',
        );
        if (handle.active === active) {
          requireValue(
            !active.turnId || active.turnId === result.result.turn.id,
            'codex.send.turn_mismatch',
            'reconcile_required',
          );
          active.turnId = result.result.turn.id;
        }
      } else {
        await journal.terminal(job.operationId, handle.scope, 'completed');
        if (handle.active === active) handle.active = null;
      }
      emit({
        type: 'operation.observed',
        session: handle.scope.session,
        payload: { operationId: job.operationId },
      });
      return result;
    } catch (error) {
      failure(handle, job, error);
      throw error;
    }
  }
  async function dispatchNext(handle) {
    if (handle.active || !handle.queue.length) return;
    const job = handle.queue.shift();
    try {
      assertCurrent();
      const record = await journal.get(job.operationId);
      if (record.phase === 'terminal') return dispatchNext(handle);
      await execute(handle, job);
    } catch (error) {
      failure(handle, job, error);
    }
  }
  async function mutate({ session, method, payload, idempotencyKey, turn = false, queue = false }) {
    await authorizeSession(session);
    const handle = turn ? await resume(session) : await bind(session);
    requireValue(!handle.active || queue, 'codex.session_busy', 'conflict');
    requireValue(handle.queue.length < 32, 'codex.session_queue', 'conflict');
    const accepted = await journal.accept({ scope: handle.scope, method, payload, idempotencyKey });
    assertCurrent();
    const prior = await journal.get(accepted.operationId);
    if (prior.phase !== 'accepted') return accepted;
    const job = { method, operationId: accepted.operationId, turn };
    if (handle.active) {
      requireValue(
        !handle.queue.some((entry) => entry.operationId === job.operationId),
        'codex.queue.duplicate',
        'conflict',
      );
      handle.queue.push(job);
      return accepted;
    }
    return { accepted, ...(await execute(handle, job)) };
  }
  async function terminal({ session, turnId, outcome }) {
    const handle = handles.get(encodeSessionKey(session));
    if (!handle?.active || handle.active.turnId !== turnId) return;
    const active = handle.active;
    await journal.terminal(active.operationId, handle.scope, outcome);
    assertCurrent();
    if (handle.active !== active) return;
    handle.active = null;
    emit({
      type: 'operation.terminal',
      session,
      payload: { operationId: active.operationId, outcome },
    });
    void dispatchNext(handle);
  }
  async function cancel({ session, operationId }) {
    const handle = handleFor(session);
    const queued = handle.queue.find((entry) => entry.operationId === operationId);
    if (queued) {
      const result = await journal.cancel(operationId, handle.scope);
      assertCurrent();
      handle.queue = handle.queue.filter((entry) => entry !== queued);
      return result;
    }
    const active = handle.active;
    requireValue(
      active && active.operationId === operationId && active.turnId,
      'codex.cancel.owner',
      'conflict',
    );
    const expectedTurnId = active.turnId;
    return cancelActive({
      scope: handle.scope,
      parentOperationId: operationId,
      expectedTurnId,
      assertActive() {
        requireValue(
          handle.active === active && active.turnId === expectedTurnId,
          'codex.cancel.owner',
          'reconcile_required',
        );
      },
    });
  }
  return {
    bind,
    async loaded(session) {
      const handle = await bind(session);
      handle.resumed = true;
    },
    resume,
    mutate,
    terminal,
    cancel,
    activeFor(session) {
      return handles.get(encodeSessionKey(session))?.active ?? null;
    },
    started(session, turnId) {
      const active = handles.get(encodeSessionKey(session))?.active;
      if (active && !active.turnId) active.turnId = turnId;
    },
    async close() {
      const errors = [];
      for (const handle of handles.values()) {
        if (handle.binding) {
          try {
            await interactions.processExited(handle.scope);
          } catch (error) {
            errors.push(error);
          }
        }
        if (handle.active) {
          try {
            await journal.reconcile(handle.active.operationId, handle.scope);
          } catch (error) {
            errors.push(error);
          }
        }
      }
      handles.clear();
      if (errors.length) throw new AggregateError(errors, 'Codex process reconciliation failed');
    },
  };
}
