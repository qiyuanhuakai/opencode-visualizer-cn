import { METHODS, ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import type { ErrorCode } from '../../shared/runtime/capabilities.js';
import { createProtocolState, LIMITS } from '../../shared/runtime/protocol.js';
import type { Binding, Hello, Result, Snapshot } from '../../shared/runtime/protocol.js';
import type { FramePreflightDecision, RawFrameSummary } from '../../shared/runtime/rawFrame.js';
import { HISTORY_LIMITS } from '../../shared/runtime/historyPage.js';
import type { ProtocolState } from '../../shared/runtime/protocolState.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';
import type { NativeMutationResult, ObserverDelivery, RuntimeMethod, RuntimeParams, RuntimeResults, TargetGrant } from '../../shared/runtime/runtimeWire.js';
import { parseRuntimeParams, parseRuntimeResult } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeConnection, RuntimeConnectionEvent } from './connection';

export type MutationMethod = 'session.create' | 'session.send' | 'session.cancel' | 'interaction.respond';
export type RequestMethod = Exclude<RuntimeMethod, MutationMethod>;
export type RequestOptions = { readonly signal?: AbortSignal; readonly selectionCurrent?: () => boolean; readonly onDrained?: () => void };
export type RuntimeScope = { readonly binding: Binding; readonly generation: number; readonly isCurrent: () => boolean };
type Collection = RuntimeParams['runtime.snapshot']['collection'];
/** An index view this client minted, kept only to bound how many are outstanding. */
type IndexView = Readonly<{ token: string; expiresAt: number }>;
/**
 * The bridge bounds live snapshot views per environment (`LIMITS.snapshotTokens`) and exposes no
 * wire method to release one early, so a view lives for its whole TTL. `LIMITS.snapshotTokens`
 * counts EVERY live view for the environment — the state layer's observer view plus every index
 * view this client minted — so an index read may mint only while the target still has budget for
 * one after reserving the observer's slot. Minting on every `fresh` read instead exhausts the
 * budget and the store rejects the next mint with `snapshot_limit`.
 */
const INDEX_VIEW_BUDGET = LIMITS.snapshotTokens - 1;
type Target = { readonly hello: Hello; readonly state: ProtocolState; readonly generation: number; paging: boolean; indexSnapshot?: Readonly<{ token: string; revision: number; watermark: number; expiresAt: number }>; indexViews?: readonly IndexView[] };
type Pending = {
  readonly target: Target; readonly method: RuntimeMethod; readonly current: () => boolean;
  readonly slot: 'normal' | 'reserved';
  readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void;
  readonly accept?: (receipt: { readonly operationId: string }) => void;
  readonly clean: () => void; readonly drain: () => void; receipt?: string;
};
function bindingOf({ target, epoch, generation }: Binding): Binding { return { target, epoch, generation }; }
function reserved(method: RuntimeMethod) {
  return method === 'runtime.history.close' || method === 'session.cancel' || method === 'interaction.respond' || method === 'runtime.channel.ack' || method === 'runtime.channel.cancel' || method === 'runtime.observer.resume' || method === 'runtime.observer.close' || method === 'runtime.target.detach';
}

/**
 * Block until the target has live-view budget for one index view. The bridge bounds live views per
 * environment and exposes no wire method to release one early, so a slot opens only when a held view
 * lapses: the wait is bounded by that view's remaining TTL and is cancellable through `signal`.
 * `onWaiting` reports each wait so a caller can surface it instead of showing a stalled read.
 */
async function acquireIndexSlot(attached: Target, signal: AbortSignal | undefined, onWaiting: ((waitMs: number) => void) | undefined): Promise<void> {
  for (;;) {
    // AbortSignal never replays a past abort to a listener registered afterwards, so a caller
    // whose signal was already aborted when it queued behind another read would otherwise wait
    // out the full remaining TTL before the listener-free timer resolves. Checking the flag at
    // the top of every iteration settles both that case and an abort that lands mid-wait.
    if (signal?.aborted) throw new ProtocolError('cancelled', 'readIndex.slot');
    const now = Date.now();
    attached.indexViews = (attached.indexViews ?? []).filter((view) => view.expiresAt > now);
    const held = attached.indexViews ?? [];
    if (held.length < INDEX_VIEW_BUDGET) return;
    const waitMs = Math.max(0, Math.min(...held.map((view) => view.expiresAt)) - Date.now());
    onWaiting?.(waitMs);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

export class RuntimeRequestError extends ProtocolError {
  constructor(code: ErrorCode, readonly requestId: string, readonly uncertain: boolean, readonly receipt?: string) {
    super(code, uncertain ? 'request.uncertain' : 'request.failed');
  }
}

// allow: SIZE_OK — the frozen task19 ownership keeps this connection's correlation,
// attachment and ordered-observer state transitions together; no entity cache lives here.
export function createRuntimeClient({ connection }: { readonly connection: RuntimeConnection }) {
  const targets = new Map<EnvironmentId, Target>();
  const pending = new Map<string, Pending>();
  const grants = new Map<EnvironmentId, TargetGrant>();
  const attaching = new Set<EnvironmentId>();
  const detachListeners = new Set<(target: EnvironmentId) => void>();
  let management: EnvironmentId | undefined;
  let nextId = 0;
  let localGeneration = -1;
  let disposed = false;

  function current(target: Target) {
    return !disposed && connection.status.state === 'ready' && connection.status.generation === target.generation && targets.get(target.hello.target) === target;
  }
  function getTarget(target: EnvironmentId) {
    const value = targets.get(target);
    requireValue(value !== undefined && current(value), 'target.attachment', 'reconcile_required');
    return value;
  }
  function invalidate(target: EnvironmentId) {
    const value = targets.get(target);
    if (!value) return;
    targets.delete(target);
    value.state.close();
    for (const [id, entry] of pending) {
      if (entry.target !== value) continue;
      entry.clean();
      entry.reject(new RuntimeRequestError('reconcile_required', id, METHODS[entry.method] === 'mutation', entry.receipt));
      pending.delete(id); entry.drain();
    }
    for (const listener of detachListeners) listener(target);
  }
  function clear() {
    for (const target of targets.keys()) invalidate(target);
    grants.clear();
    attaching.clear();
    management = undefined;
  }
  function receiveResult(frame: Result) {
    const entry = pending.get(frame.id);
    if (!entry || !current(entry.target)) return;
    const binding = entry.target.hello;
    if (frame.target !== binding.target || frame.epoch !== binding.epoch || frame.generation !== binding.generation) return;
    try {
      if (frame.ok && frame.phase !== 'durable-accepted') {
        parseRuntimeResult(entry.method, frame.result);
        if (entry.method === 'runtime.snapshot' || entry.method === 'runtime.replay') {
          const nested = parseRuntimeResult(entry.method, frame.result);
          requireValue(nested.target === frame.target && nested.epoch === frame.epoch && nested.generation === frame.generation, 'result.binding', 'reconcile_required');
        }
      }
      entry.target.state.receive(frame);
      if (!entry.current()) {
        if (frame.ok && frame.phase === 'durable-accepted') { entry.receipt = frame.result.operationId; return; }
        entry.reject(new RuntimeRequestError('cancelled', frame.id, METHODS[entry.method] === 'mutation', entry.receipt));
        entry.clean(); pending.delete(frame.id); entry.drain(); return;
      }
      if (!frame.ok) throw new RuntimeRequestError(frame.typedError.code, frame.id, METHODS[entry.method] === 'mutation', entry.receipt);
      switch (frame.phase) {
        case 'durable-accepted':
          entry.receipt = frame.result.operationId;
          entry.accept?.(frame.result);
          return;
        case 'native-executed': {
          const result = parseRuntimeResult('session.send', frame.result);
          requireValue(result.operationId === entry.receipt, 'receipt.identity', 'reconcile_required');
          entry.resolve(result);
          break;
        }
        case 'read': entry.resolve(frame.result); break;
        default: frame satisfies never;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      entry.reject(error);
      if (!(error instanceof RuntimeRequestError)) { clear(); connection.disconnect(); }
    }
    entry.clean();
    pending.delete(frame.id); entry.drain();
  }
  function receive(event: RuntimeConnectionEvent) {
    if (disposed || event.generation !== connection.status.generation) return;
    switch (event.kind) {
      case 'hello':
        clear();
        localGeneration = event.generation;
        nextId = 0;
        management = event.hello.target;
        targets.set(event.hello.target, { hello: event.hello, state: createProtocolState(bindingOf(event.hello)), generation: event.generation, paging: false });
        break;
      case 'frame':
        if (event.frame.kind === 'result') receiveResult(event.frame);
        break;
      case 'disconnected':
      case 'error': clear(); break;
      case 'binary': break;
      default: event satisfies never;
    }
  }
  // The method is trusted from this client's pending map (never server-supplied),
  // so aborted/timed-out but physically pending history entries still classify as history.
  function classifyFrame(summary: RawFrameSummary): FramePreflightDecision {
    if (summary.kind !== 'result') return 'accept';
    const entry = pending.get(summary.id ?? '');
    if (!entry || !current(entry.target)) return 'drop';
    const binding = entry.target.hello;
    if (summary.target !== binding.target || summary.epoch !== binding.epoch || summary.generation !== binding.generation) return 'drop';
    if (entry.method.startsWith('runtime.history.') && summary.ok === true && summary.phase !== 'durable-accepted') {
      if (summary.unknownFields) throw new ProtocolError('invalid_request', 'history.fields');
      if (summary.result.nodes > HISTORY_LIMITS.nodes || summary.result.depth > HISTORY_LIMITS.depth || summary.result.utf8Bytes > HISTORY_LIMITS.encodedResultBytes) throw new ProtocolError('invalid_request', 'history.structure');
    }
    return 'accept';
  }
  const unregisterPreflight = connection.setFramePreflight(classifyFrame);
  const unsubscribe = connection.subscribe(receive);

  function start(input: { readonly target: EnvironmentId; readonly method: RuntimeMethod; readonly params: unknown; readonly options: RequestOptions; readonly idempotencyKey?: string; readonly accept?: Pending['accept'] }) {
    const target = getTarget(input.target);
    requireValue(target.hello.capabilities.methods.includes(input.method), 'method.capability', 'unsupported');
    requireValue(!input.options.signal?.aborted && (input.options.selectionCurrent?.() ?? true), 'request.selection', 'cancelled');
    const normalCount = [...pending.values()].filter((entry) => entry.slot === 'normal').length;
    const slot = normalCount < 496 ? 'normal' : 'reserved';
    const priorityControl = input.method === 'runtime.history.close' || input.method === 'session.cancel' || input.method === 'interaction.respond';
    if (slot === 'reserved') requireValue(reserved(input.method) && pending.size - normalCount < (priorityControl ? 16 : 12), 'request.capacity', 'source_unavailable');
    if (nextId === 65536) {
      clear();
      connection.disconnect();
      throw new ProtocolError('reconcile_required', 'request.retired');
    }
    const id = `${localGeneration}:${++nextId}`;
    const params = parseRuntimeParams(input.method, input.params);
    if ('session' in params && params.session) requireValue(params.session.environmentId === input.target, 'session.target', 'unauthorized');
    const frame = target.state.register({ version: 1, kind: 'request', ...bindingOf(target.hello), id, method: input.method, params, ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) });
    return new Promise<unknown>((resolve, reject) => {
      let abandoned = false;
      const abandon = (code: ErrorCode) => {
        abandoned = true;
        clean();
        reject(new RuntimeRequestError(code, id, METHODS[input.method] === 'mutation', pending.get(id)?.receipt));
      };
      const abort = () => abandon('cancelled');
      const timer = setTimeout(() => abandon('timeout'), 15000);
      const clean = () => { clearTimeout(timer); input.options.signal?.removeEventListener('abort', abort); };
      const entry: Pending = { target, method: input.method, slot, current: () => !abandoned && current(target) && (input.options.selectionCurrent?.() ?? true), resolve, reject, accept: input.accept, clean, drain: input.options.onDrained ?? (() => {}) };
      pending.set(id, entry);
      input.options.signal?.addEventListener('abort', abort, { once: true });
      try { connection.send(frame); }
      catch (error) {
        clean();
        // A transport may throw after enqueueing; retire its binding before releasing caller accounting.
        connection.disconnect(); clear();
        if (!(error instanceof Error)) throw error;
        reject(new RuntimeRequestError('reconcile_required', id, METHODS[input.method] === 'mutation'));
      }
    });
  }
  function request<M extends RequestMethod>(target: EnvironmentId, method: M, params: RuntimeParams[M], options: RequestOptions = {}): Promise<RuntimeResults[M]> {
    let drained = false;
    const drain = () => {
      if (drained) return;
      drained = true;
      try { options.onDrained?.(); }
      // The caller owns this notification; its exception cannot interrupt request retirement.
      catch { return; }
    };
    try {
      const attached = getTarget(target);
      requireValue(METHODS[method] !== 'mutation', 'request.mutation', 'invalid_request');
      return start({ target, method, params, options: { ...options, onDrained: drain } }).then((value) => {
        requireValue(current(attached) && (options.selectionCurrent?.() ?? true) && !options.signal?.aborted, 'request.selection', 'cancelled');
        if (method === 'runtime.entity.resolve') requireValue(!parseRuntimeResult('runtime.entity.resolve', value).chunked, 'entity.resnapshot', 'replay_required');
        return parseRuntimeResult(method, value);
      });
    } catch (error) { drain(); return Promise.reject(error); }
  }
  function mutate(target: EnvironmentId, method: MutationMethod, params: RuntimeParams[MutationMethod], options: { readonly idempotencyKey: string; readonly selectionCurrent?: () => boolean }) {
    let accept: (value: { readonly operationId: string }) => void = () => {};
    let rejectAcceptance: (error: unknown) => void = () => {};
    const accepted = new Promise<{ readonly operationId: string }>((resolve, reject) => { accept = resolve; rejectAcceptance = reject; });
    let executed: Promise<NativeMutationResult>;
    try {
      requireValue(METHODS[method] === 'mutation', 'mutate.read', 'invalid_request');
      executed = start({ target, method, params, options, idempotencyKey: options.idempotencyKey, accept }).then((value) => parseRuntimeResult(method, value));
    }
    catch (error) { executed = Promise.reject(error); }
    // Either phase can be awaited independently without creating an unhandled sibling rejection.
    void accepted.then(undefined, () => undefined);
    void executed.then(undefined, rejectAcceptance);
    return { accepted, executed };
  }
  function managementTarget() {
    requireValue(management !== undefined, 'connection.hello', 'reconcile_required');
    return management;
  }
  async function inspect() {
    const result = await request(managementTarget(), 'runtime.inspect', {});
    grants.clear();
    for (const grant of result.targets) grants.set(grant.target, grant);
    return result;
  }
  async function attach(target: EnvironmentId) {
    requireValue(grants.has(target), 'target.grant', 'unauthorized');
    requireValue(!targets.has(target) && !attaching.has(target), 'target.attached', 'conflict');
    attaching.add(target);
    try {
      const result = await request(managementTarget(), 'runtime.target.attach', { target });
      requireValue(result.hello.target === target && result.grant.target === target, 'target.attach', 'unauthorized');
      targets.set(target, { hello: result.hello, state: createProtocolState(bindingOf(result.hello)), generation: connection.status.generation, paging: false });
      return result;
    } finally { attaching.delete(target); }
  }
  async function detach(target: EnvironmentId) {
    getTarget(target);
    await request(managementTarget(), 'runtime.target.detach', { target });
    invalidate(target);
  }
  async function replay(target: EnvironmentId, after: number, options: RequestOptions = {}) {
    const attached = getTarget(target);
    requireValue(!attached.paging, 'snapshot.pending', 'conflict');
    const result = await request(target, 'runtime.replay', { after }, options);
    attached.state.receive(result);
    return result;
  }
  async function observe(target: EnvironmentId, options: RequestOptions & { readonly after: number; readonly onDelivery: (delivery: ObserverDelivery) => void | Promise<void> }) {
    const attached = getTarget(target);
    const { observerId } = await request(target, 'runtime.observer.open', { after: options.after }, options);
    let closed = false;
    let reading = false;
    const active = () => requireValue(!closed && current(attached) && (options.selectionCurrent?.() ?? true), 'observer.closed', 'reconcile_required');
    async function resume(after: number) {
      active();
      await request(target, 'runtime.observer.resume', { observerId, after }, options);
    }
    async function recover(through: number) {
      for (let attempt = 0; attempt < 8; attempt++) {
        let cursor = attached.state.snapshot().seq;
        do {
          const page = await replay(target, cursor, options);
          for (const frame of page.events) await options.onDelivery({ kind: 'event', frame });
          requireValue(page.through > cursor || cursor >= through, 'replay.progress', 'replay_required');
          cursor = page.through;
        } while (cursor < through);
        try { await resume(cursor); return; }
        catch (error) {
          if (!(error instanceof ProtocolError) || error.code !== 'replay_required') throw error;
          const hint = await request(target, 'runtime.observer.read', { observerId }, options);
          requireValue(hint?.kind === 'replay_required', 'observer.recovery', 'replay_required');
          through = hint.through;
        }
      }
      throw new ProtocolError('source_unavailable', 'observer.catchup');
    }
    return {
      async read(): Promise<ObserverDelivery> {
        active();
        requireValue(!reading && !attached.paging, 'observer.busy', 'conflict');
        reading = true;
        try {
          const delivery = await request(target, 'runtime.observer.read', { observerId }, options);
          active();
          if (delivery === null) return null;
          switch (delivery.kind) {
            case 'event': attached.state.receive(delivery.frame); break;
            case 'control':
              requireValue(delivery.frame.target === target && delivery.frame.epoch === attached.hello.epoch && delivery.frame.generation === attached.hello.generation, 'control.binding', 'reconcile_required');
              break;
            case 'replay_required': await recover(delivery.through); return delivery;
            case 'binary': break;
            default: delivery satisfies never;
          }
          await options.onDelivery(delivery);
          return delivery;
        } finally { reading = false; }
      },
      resume,
      async close() {
        if (closed) return;
        closed = true;
        if (current(attached)) await request(target, 'runtime.observer.close', { observerId });
      },
    };
  }
  async function snapshot(target: EnvironmentId, collections: Collection | readonly Collection[], options: RequestOptions & { readonly onPage: (collection: Collection, page: Snapshot) => void | Promise<void>; readonly onDelivery?: (delivery: ObserverDelivery) => void | Promise<void> }) {
    const attached = getTarget(target);
    requireValue(!attached.paging, 'snapshot.pending', 'conflict');
    const names = typeof collections === 'string' ? [collections] : collections;
    requireValue(names.length > 0 && names.length <= 5 && new Set(names).size === names.length, 'snapshot.collections');
    attached.paging = true;
    let first: Snapshot | undefined;
    let observer: Awaited<ReturnType<typeof observe>> | undefined;
    try {
      for (const collection of names) {
        let cursor: string | null = null;
        do {
          const page: Snapshot = await request(target, 'runtime.snapshot', { collection, ...(first ? { token: first.token } : {}), cursor, limit: 200 }, options);
          if (!first) {
            first = page;
            observer = await observe(target, { ...options, after: first.watermark, onDelivery: options.onDelivery ?? (() => {}) });
          }
          requireValue(page.token === first.token && page.revision === first.revision && page.watermark === first.watermark && page.target === attached.hello.target && page.epoch === attached.hello.epoch && page.generation === attached.hello.generation, 'snapshot.atomic', 'replay_required');
          requireValue(page.expiresAt > Date.now() && (page.cursor === null || page.cursor !== cursor), 'snapshot.expired', 'replay_required');
          await options.onPage(collection, page);
          requireValue(current(attached) && (options.selectionCurrent?.() ?? true), 'snapshot.selection', 'reconcile_required');
          cursor = page.cursor;
        } while (cursor !== null);
      }
      requireValue(first !== undefined && observer !== undefined, 'snapshot.empty');
      attached.state.acceptSnapshot(first, Date.now());
      attached.indexSnapshot = Object.freeze({ token: first.token, revision: first.revision, watermark: first.watermark, expiresAt: first.expiresAt });
      return { token: first.token, revision: first.revision, watermark: first.watermark, observer };
    } catch (error) {
      if (observer) await observer.close();
      throw error;
    } finally { attached.paging = false; }
  }
  /**
   * Page index collections WITHOUT opening an observer and WITHOUT taking the
   * per-target paging lock. `snapshot` above always opens an observer because
   * the task-20 state layer needs one bound at the snapshot watermark. A second
   * observer on the same attached target is rejected by the dispatcher
   * (`runtime.observer_duplicate`), and flipping `paging` mid-flight makes the
   * state's running `observer.read` reject with `observer.busy`. Callers that
   * only traverse the index (tree topology, full-index search, child
   * pagination) use this path: they neither contend for the single observer nor
   * disturb the live reader, and they never call `acceptSnapshot`, so the
   * state's contiguous event cursor is untouched.
   *
   * The bridge bounds live snapshot views per environment (LIMITS.snapshotTokens)
   * and exposes no wire method to release one early, so this path REUSES the
   * target's current index view instead of minting a token per read: the view
   * seeded by `snapshot` (which already covers every index collection) is reused
   * while it is valid, and a fresh view is minted only once the cached one is
   * near expiry. Steady state is one index view per target; repeated searches do
   * not exhaust the token budget. The reuse window is the snapshot TTL, so an
   * index read observes the index at the shared view's point in time.
   *
    * `fresh` bypasses that reuse for a caller that knows the cached view cannot
    * answer — a new user search, an explicit refresh, or an index update the
    * caller just performed. Pagination inside ONE traversal leaves it unset so
    * every page of that traversal stays on one consistent view.
    *
    * A `fresh` read always mints its own view: answering it from the cached one
    * would silently serve rows that predate the request for up to the whole TTL.
    * Because the bridge cannot release a view early and bounds live views per
    * environment, a fresh read whose budget is spent first WAITS for a held view
    * to lapse (bounded by that view's remaining TTL, reported through
    * `onWaiting`) instead of minting into `snapshot_limit` or reusing the stale
    * view. The near-expiry reuse bypass applies only while a replacement can
    * actually be minted — the bridge deletes only truly expired tokens, so a
    * cached view it still holds stays usable once the budget is spent.
    */
  async function readIndex(
    target: EnvironmentId,
    collections: Collection | readonly Collection[],
    options: RequestOptions & { readonly onPage: (collection: Collection, page: Snapshot) => void | Promise<void>; readonly fresh?: boolean; readonly onWaiting?: (waitMs: number) => void },
  ) {
    const attached = getTarget(target);
    const names = typeof collections === 'string' ? [collections] : collections;
    requireValue(names.length > 0 && names.length <= 5 && new Set(names).size === names.length, 'snapshot.collections');
    const now = Date.now();
    // Views whose TTL has lapsed are gone from the store, so they no longer hold budget.
    attached.indexViews = (attached.indexViews ?? []).filter((view) => view.expiresAt > now);
    const cached = attached.indexSnapshot;
    // A mint needs budget: the bridge bounds live views per environment and rejects a token-less
    // read past the budget with `snapshot_limit`, and it exposes no wire method to release a view
    // early, so a read that must mint first WAITS for a held view to lapse (bounded by that view's
    // remaining TTL, cancellable through `signal`) instead of failing. A `fresh` read may never
    // answer from the cached view — an explicit search/refresh would otherwise read rows that
    // predate the request for up to the whole TTL — so it waits rather than silently reusing.
    const budget = (attached.indexViews?.length ?? 0) < INDEX_VIEW_BUDGET;
    // `fresh` bypasses the reuse so the read observes rows the cached view predates. The
    // near-expiry bypass exists so a view that lapses mid-pagination is not reused past its death,
    // but only while a replacement can actually be minted: the bridge deletes only truly expired
    // tokens, so a cached view the bridge still holds stays reusable once the budget is spent.
    const mint = options.fresh === true || cached === undefined || (cached.expiresAt - now <= 2000 && budget);
    if (mint) await acquireIndexSlot(attached, options.signal, options.onWaiting);
    const reuse = mint ? undefined : cached.token;
    if (mint) attached.indexSnapshot = undefined;
    let first: Snapshot | undefined;
    for (const collection of names) {
      let cursor: string | null = null;
      do {
        const token = first ? first.token : (cursor === null && collection === names[0] ? reuse : undefined);
        let page: Snapshot;
        let minted: boolean;
        try {
          page = await request(target, 'runtime.snapshot', { collection, ...(token === undefined ? {} : { token }), cursor, limit: 200 }, options);
          minted = token === undefined;
        } catch (error) {
          if (first !== undefined || token === undefined || !(error instanceof ProtocolError) || error.code !== 'replay_required') throw error;
          attached.indexSnapshot = undefined;
          const retryNow = Date.now();
          attached.indexViews = (attached.indexViews ?? []).filter((view) => view.expiresAt > retryNow);
          await acquireIndexSlot(attached, options.signal, options.onWaiting);
          page = await request(target, 'runtime.snapshot', { collection, cursor, limit: 200 }, options);
          minted = true;
        }
        if (!first) {
          first = page;
          attached.indexSnapshot = Object.freeze({ token: page.token, revision: page.revision, watermark: page.watermark, expiresAt: page.expiresAt });
          if (minted) {
            attached.indexViews = [...(attached.indexViews ?? []), { token: page.token, expiresAt: page.expiresAt }];
          }
        }
        requireValue(page.token === first.token && page.revision === first.revision && page.watermark === first.watermark && page.target === attached.hello.target && page.epoch === attached.hello.epoch && page.generation === attached.hello.generation, 'snapshot.atomic', 'replay_required');
        requireValue(page.expiresAt > Date.now() && (page.cursor === null || page.cursor !== cursor), 'snapshot.expired', 'replay_required');
        await options.onPage(collection, page);
        requireValue(current(attached) && (options.selectionCurrent?.() ?? true), 'snapshot.selection', 'reconcile_required');
        cursor = page.cursor;
      } while (cursor !== null);
    }
    requireValue(first !== undefined, 'snapshot.empty');
    return { token: first.token, revision: first.revision, watermark: first.watermark };
  }
  return {
    inspect, attach, detach, request, mutate, snapshot, readIndex, replay, observe,
    scope(target: EnvironmentId): RuntimeScope {
      const attached = getTarget(target);
      return { binding: bindingOf(attached.hello), generation: attached.generation, isCurrent: () => current(attached) };
    },
    onDetach(listener: (target: EnvironmentId) => void) { detachListeners.add(listener); return () => { detachListeners.delete(listener); }; },
    dispose() { if (disposed) return; clear(); disposed = true; unregisterPreflight(); unsubscribe(); detachListeners.clear(); },
  };
}
export type RuntimeClient = ReturnType<typeof createRuntimeClient>;
