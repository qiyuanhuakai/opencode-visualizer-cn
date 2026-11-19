import { AsyncLocalStorage } from 'node:async_hooks';
import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { fingerprint } from './operationJournal.js';

const kinds = new Set(['operation', 'acp-operation', 'opencode-instance-operation', 'opencode-cancellation', 'codex-instance-operation', 'codex-cancel-operation', 'kimi-instance', 'kimi-control', 'dsh-operation']);
const methods = { 'session.create': ['createSession', 'thread/start', 'session/new', 'session/create'], 'session.send': ['send', 'turn/start', 'session/prompt'], 'session.cancel': ['cancel', 'turn/interrupt', 'session/cancel'], 'interaction.respond': ['respondInteraction', 'session/request_permission', 'interaction/respond'] };
function matches(scope, authority) {
  return scope && (scope.target ?? scope.environmentId) === authority.target
    && (scope.harnessInstanceId ?? scope.session?.harnessInstanceId) === authority.harnessInstanceId
    && scope.epoch === authority.epoch && scope.processGeneration === authority.processGeneration
    && fingerprint(scope.session ?? null) === fingerprint(authority.session ?? null);
}
function operation(change, context) {
  const value = change.value;
  if (!value || typeof value !== 'object' || !matches(value.scope, context.scope)) return false;
  if (change.collection === 'interactions') return context.method === 'interaction.respond'
    && change.key === context.interactionId && value.kind === 'interaction' && value.phase === 'replying'
    && value.answerRef && Number.isSafeInteger(change.expectedRevision) && change.expectedRevision > 0;
  return change.collection === 'operations' && kinds.has(value.kind) && value.phase === 'accepted'
    && (methods[context.method]?.includes(value.method) || (value.kind === 'opencode-cancellation' && context.method === 'session.cancel'))
    && Number.isSafeInteger(change.expectedRevision) && change.expectedRevision >= 0;
}
export function createRuntimeAcceptance({ store }) {
  const local = new AsyncLocalStorage();
  const watchers = new Map();
  let closed = false;
  function notify(context, receipt) {
    if (context.receipt) {
      if (receipt.collection === 'interactions' && context.receipt.collection === 'operations') return;
      if (context.receipt.operationId !== receipt.operationId || context.receipt.collection !== receipt.collection) context.invalid = true;
      return;
    }
    context.receipt = Object.freeze(receipt);
    try { context.onAccepted(context.receipt); }
    catch { context.notificationFailed = true; }
  }
  async function write(method, input) {
    const context = local.getStore();
    const accepted = [];
    if (context && !closed) for (const change of input.changes) {
      const candidate = change.collection === 'operations' && kinds.has(change.value?.kind) && change.value.phase === 'accepted'
        || change.collection === 'interactions' && change.value?.kind === 'interaction' && change.value.phase === 'replying';
      if (!candidate) continue;
      const prior = await store.getControl({ collection: change.collection, key: change.key });
      const expected = change.collection === 'interactions' ? 'pending' : 'intent';
      const transition = prior && prior.revision === change.expectedRevision && prior.value?.phase === expected;
      const cancellation = !prior && change.expectedRevision === 0 && change.value.kind === 'opencode-cancellation' && input.changes.length > 1;
      if (transition || cancellation) {
        requireValue(operation(change, context) && (!prior || matches(prior.value.scope, context.scope)), 'acceptance.scope', 'reconcile_required');
        accepted.push(change);
      }
    }
    const ack = await store[method](input);
    requireValue(ack.phase === 'durable-accepted' && ack.intentId === input.intentId, 'acceptance.ack', 'reconcile_required');
    if (context && !closed) {
      if (accepted.length > 1) context.invalid = true;
      else if (accepted.length === 1) {
        const change = accepted[0];
        notify(context, { operationId: change.key, collection: change.collection });
      }
    }
    for (const change of input.changes) {
      const key = JSON.stringify([change.collection, change.key]);
      const entries = watchers.get(key);
      if (!entries) continue;
      for (const entry of entries) if (matches(change.value?.scope, entry.scope)) entry.deliver(change.value);
    }
    return ack;
  }
  const observedStore = Object.freeze({ ...store, mutate: input => write('mutate', input), mutateControl: input => write('mutateControl', input),
    get queue() { return store.queue; } });
  async function awaitExecution(context) {
    requireValue(context.receipt, 'acceptance.missing', 'reconcile_required');
    requireValue(!context.signal?.aborted, 'acceptance.detached', 'cancelled');
    const { operationId, collection } = context.receipt;
    const key = JSON.stringify([collection, operationId]);
    return new Promise((resolve, reject) => {
      const entries = watchers.get(key) ?? new Set();
      function finish(error, value) {
        clearTimeout(timer); entries.delete(entry); if (!entries.size) watchers.delete(key);
        context.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      }
      const entry = { scope: context.scope, deliver(value) {
        if (value.phase === 'observed' || value.phase === 'replied' || (value.phase === 'terminal' && value.outcome === 'completed')) finish(null, { status: 'observed' });
        else if (['reconciling', 'invalidated'].includes(value.phase) || (value.phase === 'terminal' && value.outcome !== 'completed'))
          finish(new ProtocolError('reconcile_required', 'acceptance.native_uncertain'));
      }, stop() { finish(new ProtocolError('reconcile_required', 'acceptance.closed')); } };
      const timer = setTimeout(() => finish(new ProtocolError('timeout', 'acceptance.native_pending')), context.deadlineMs ?? 15000);
      const abort = () => finish(new ProtocolError('cancelled', 'acceptance.detached'));
      context.signal?.addEventListener('abort', abort, { once: true });
      timer.unref?.(); entries.add(entry); watchers.set(key, entries);
      store.getControl({ collection, key: operationId }).then(row => {
        if (!row || row.chunked || !matches(row.value?.scope, context.scope)) finish(new ProtocolError('reconcile_required', 'acceptance.record'));
        else entry.deliver(row.value);
      }, error => finish(error));
    });
  }
  return {
    store: observedStore,
    async run(input, invoke) {
      requireValue(!closed, 'acceptance.closed', 'source_unavailable');
      const context = { ...input, scope: structuredClone(input.scope), receipt: null, invalid: false };
      const value = await local.run(context, invoke);
      requireValue(!context.invalid, 'acceptance.multiple', 'reconcile_required');
      if (!context.receipt) throw new ProtocolError('reconcile_required', 'acceptance.unobserved');
      if (value?.phase === 'durable-accepted') return { receipt: context.receipt, value: await awaitExecution(context) };
      requireValue(value?.phase === 'native-executed' || value?.phase === 'already-completed', 'acceptance.execution', 'reconcile_required');
      return { receipt: context.receipt, value: Object.hasOwn(value, 'result') ? value.result : value.session ? { session: value.session } : { status: 'observed' } };
    },
    close() { closed = true; for (const entries of watchers.values()) for (const entry of entries) entry.stop(); watchers.clear(); },
  };
}

