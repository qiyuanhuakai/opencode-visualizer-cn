import { performance } from 'node:perf_hooks';
import { parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import { StoreError } from './storage/storeProtocol.js';

export const DISCOVERY_LIMITS = Object.freeze({ background: 4, perSource: 2, interactive: 1, queued: 256, native: 8, deadlineMs: 15000 });
const priorities = ['selected', 'expanded', 'recent', 'background'];

export function createDiscoveryScheduler() {
  const entries = new Map();
  const running = new Set();
  const lastSource = new Map();
  let background = 0;
  let interactive = 0;
  let closed = false;
  let pumping = false;
  function identity(input) {
    const source = JSON.stringify([parseEnvironmentId(input.environmentId), parseHarnessInstanceId(input.harnessInstanceId)]);
    if (typeof input.scope !== 'string' || input.scope.length === 0 || Buffer.byteLength(input.scope) > 4096) throw new StoreError('invalid_request', 'discovery_scope');
    return { source, key: JSON.stringify([source, input.scope]) };
  }
  function release(entry) {
    if (!entry.active) return;
    entry.active = false;
    if (entry.interactive) interactive--; else background--;
  }
  function settle(entry, error, value) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entries.delete(entry.key);
    release(entry);
    if (error) { entry.controller.abort(error); entry.reject(error); }
    else entry.resolve(value);
    pumpSoon();
  }
  function available(entry) {
    const native = [...running];
    if (native.some((item) => item.source === entry.source && item.settled)) return false;
    if (entry.interactive) return interactive < 1 && !native.some((item) => item.interactive);
    return background < 4 && native.filter((item) => !item.interactive).length < 8 && native.filter((item) => !item.interactive && item.source === entry.source).length < 2;
  }
  function start(entry) {
    entry.started = true;
    entry.active = true;
    running.add(entry);
    if (entry.interactive) interactive++; else background++;
    const lease = {
      signal: entry.controller.signal,
      deadlineAt: entry.deadlineAt,
      isCurrent: () => !closed && !entry.settled && performance.now() < entry.deadlineAt,
      assertCurrent() { if (!this.isCurrent()) throw new StoreError('timeout', 'discovery_deadline'); },
    };
    Promise.resolve().then(() => { lease.assertCurrent(); return entry.action(lease); }).then(
      (value) => settle(entry, null, value),
      (error) => settle(entry, error),
    ).finally(() => { running.delete(entry); pumpSoon(); });
  }
  function pump() {
    pumping = false;
    if (closed) return;
    while (true) {
      const ready = [...entries.values()].filter((entry) => !entry.started && !entry.settled && available(entry));
      if (!ready.length) return;
      const rank = Math.min(...ready.map((entry) => entry.rank));
      const candidates = ready.filter((entry) => entry.rank === rank);
      const sources = [...new Set(candidates.map((entry) => entry.source))].sort();
      const previous = lastSource.get(rank) ?? '';
      const source = sources.find((item) => item > previous) ?? sources[0];
      const entry = candidates.find((item) => item.source === source);
      lastSource.set(rank, source);
      if (performance.now() >= entry.deadlineAt) settle(entry, new StoreError('timeout', 'discovery_deadline'));
      else start(entry);
    }
  }
  function pumpSoon() {
    if (pumping || closed) return;
    pumping = true;
    queueMicrotask(pump);
  }
  function schedule(input, action) {
    try {
      if (closed) throw new StoreError('source_unavailable', 'discovery_closed');
      const { source, key } = identity(input);
      const rank = priorities.indexOf(input.priority ?? 'background');
      const deadlineMs = input.deadlineMs ?? 15000;
      if (rank < 0 || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 15000 || typeof action !== 'function' || (input.interactive !== undefined && typeof input.interactive !== 'boolean')) throw new StoreError('invalid_request', 'discovery_demand');
      const previous = entries.get(key);
      if (previous) {
        previous.rank = Math.min(previous.rank, rank);
        if (!previous.started && input.interactive) previous.interactive = true;
        pumpSoon();
        return previous.promise;
      }
      if ([...entries.values()].filter((entry) => !entry.started).length >= 256) throw new StoreError('source_unavailable', 'discovery_queue_full');
      if ([...running].some((entry) => entry.source === source && entry.settled)) throw new StoreError('source_unavailable', 'discovery_source_draining');
      let resolve, reject;
      const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
      const entry = { source, key, rank, interactive: input.interactive === true, action, resolve, reject, promise, controller: new AbortController(), deadlineAt: performance.now() + deadlineMs, started: false, active: false, settled: false };
      entry.timer = setTimeout(() => settle(entry, new StoreError('timeout', 'discovery_deadline')), deadlineMs);
      entries.set(key, entry);
      pumpSoon();
      return promise;
    } catch (error) { return Promise.reject(error); }
  }
  return {
    schedule,
    cancel(input) {
      const entry = entries.get(identity(input).key);
      if (!entry) return false;
      settle(entry, new StoreError('cancelled', 'discovery_cancelled'));
      return true;
    },
    close() {
      closed = true;
      for (const entry of entries.values()) settle(entry, new StoreError('cancelled', 'discovery_closed'));
    },
    get state() {
      return { background, interactive, queued: [...entries.values()].filter((entry) => !entry.started).length, native: running.size, abandoned: [...running].filter((entry) => entry.settled).length, closed };
    },
  };
}
