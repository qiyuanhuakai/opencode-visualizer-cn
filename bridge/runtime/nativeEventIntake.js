import { parseSessionRef } from '../../shared/runtime/identity.js';
import { StoreError } from './storage/storeProtocol.js';
import { sameAuthority, sessionSummary, sourceAuthority } from './sessionSummaries.js';

export const INTAKE_LIMITS = Object.freeze({ bytes: 4194304, events: 256, frameBytes: 1048576 });
function normalize(source, event) {
  const type = event.type;
  if (typeof type !== 'string') throw new StoreError('invalid_request', 'index_event_type');
  if (/interaction|permission|approval|question|operation\.|turn\/completed|session\.idle/.test(type)) return { kind: 'control' };
  if (['source-error', 'replay_required', 'process.invalidated'].includes(type)) return { kind: 'recover' };
  if (['session.deleted', 'thread/deleted'].includes(type)) return { kind: 'delete', session: parseSessionRef(event.session) };
  if (source.kind === 'opencode' && ['session.created', 'session.updated'].includes(type)) return { kind: 'update', summary: sessionSummary(source, event) };
  if (type === 'catalog_changed' || type === 'native-emit' || type.startsWith('thread/') || type.startsWith('session.')) return { kind: 'dirty' };
  return { kind: 'ignore' };
}
export function createNativeEventIntake({ source, mutations, dirty, onControl, onFailure }) {
  const queue = [];
  let bytes = 0;
  let count = 0;
  let running = null;
  let closed = false;
  let subscription = null;
  let subscriptionWork = null;
  let timer = null;
  let wake = null;
  let sequence = 0;
  let sequenceAuthority = null;
  let failure = null;
  function fail(error) {
    const reason = String(error?.code ?? 'source_unavailable');
    const changed = failure !== reason;
    failure = reason;
    dirty();
    if (changed) onFailure(failure);
  }
  function startDrain() {
    if (!running && queue.length && !closed) running = drain().finally(() => { running = null; startDrain(); });
  }
  async function drain() {
    while (queue.length && !closed) {
      const entry = queue.shift();
      try {
        const assertCurrent = () => {
          source.assertCurrent();
          if (closed || !sameAuthority(entry.authority, sourceAuthority(source.authority()))) throw new StoreError('reconcile_required', 'index_event_generation');
        };
        assertCurrent();
        if (entry.value.kind === 'delete' || entry.value.kind === 'update') {
          await mutations.event({ source: source.identity, authority: entry.authority, summary: entry.value.summary, session: entry.value.session, deleted: entry.value.kind === 'delete', assertCurrent });
        }
      } catch (error) { fail(error); }
      finally { bytes -= entry.bytes; count--; }
    }
  }
  function publish(event) {
    if (closed) return false;
    try {
      source.assertCurrent();
      const authority = sourceAuthority(source.authority());
      if (event.epoch !== undefined && event.processGeneration !== undefined && !sameAuthority(authority, sourceAuthority(event))) throw new StoreError('reconcile_required', 'index_native_generation');
      const nativeSequence = source.identity.kind === 'acp' ? event.sequence : source.identity.kind === 'opencode' ? event.seq : undefined;
      if (nativeSequence !== undefined) {
        if (!Number.isSafeInteger(nativeSequence) || nativeSequence < 1) throw new StoreError('invalid_request', 'index_native_sequence');
        if (!sequenceAuthority || !sameAuthority(authority, sequenceAuthority)) { sequenceAuthority = authority; sequence = 0; }
        if (nativeSequence <= sequence) return false;
        sequence = nativeSequence;
      }
      const inputBytes = Buffer.byteLength(JSON.stringify(event));
      if (inputBytes > INTAKE_LIMITS.frameBytes) throw new StoreError('replay_required', 'index_native_frame_budget');
      const value = normalize(source.identity, event);
      if (value.kind === 'control') { onControl(); return true; }
      if (value.kind === 'ignore') return true;
      if (value.kind === 'recover') throw new StoreError('replay_required', 'index_native_recovery');
      dirty();
      if (value.kind === 'dirty') return true;
      const size = Buffer.byteLength(JSON.stringify(value));
      if (count >= INTAKE_LIMITS.events || bytes + size > INTAKE_LIMITS.bytes) throw new StoreError('replay_required', 'index_producer_overflow');
      queue.push({ value, authority, bytes: size });
      bytes += size;
      count++;
      startDrain();
      return true;
    } catch (error) { fail(error); return false; }
  }
  return {
    publish,
    async subscribe(open) {
      if (closed || subscription) throw new StoreError('conflict', 'index_native_subscription');
      const handle = await open();
      if (closed) { if (handle.detach) handle.detach(); else await handle.return(); return; }
      subscription = handle;
      subscriptionWork = (async () => {
        try {
          if (typeof handle.read === 'function' && typeof handle.detach === 'function') {
            while (!closed) {
              const page = await handle.read();
              if (page.status !== 'complete') fail(new StoreError('replay_required', 'index_acp_retention'));
              for (const event of page.events) publish(event);
              await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, 20); timer.unref?.(); });
            }
          } else {
            for await (const event of handle) { if (closed) break; publish(event); }
            if (!closed) fail(new StoreError('reconcile_required', 'index_subscription_ended'));
          }
        } catch (error) { if (!closed) fail(error); }
      })();
    },
    async flush() { while (running) await running; },
    async close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      wake?.();
      if (subscription?.detach) subscription.detach();
      else await subscription?.return();
      await subscriptionWork;
      await running;
      queue.length = 0;
      bytes = count = 0;
    },
    get state() { return { bytes, count, sequence, failure, subscribed: subscription !== null, closed }; },
  };
}
