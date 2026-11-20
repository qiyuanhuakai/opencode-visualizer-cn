import { METHODS, ProtocolError, requireValue, objectFields } from '../../shared/runtime/capabilities.js';
import type { ErrorCode } from '../../shared/runtime/capabilities.js';
import { createProtocolState, decodeBinary, encodeBinary } from '../../shared/runtime/protocol.js';
import type { BinaryChunk, BinaryInput } from '../../shared/runtime/protocol.js';
import type { Binding, Hello, Result, Snapshot } from '../../shared/runtime/protocol.js';
import type { FramePreflightDecision, RawFrameSummary } from '../../shared/runtime/rawFrame.js';
import { HISTORY_LIMITS } from '../../shared/runtime/historyPage.js';
import type { ProtocolState } from '../../shared/runtime/protocolState.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';
import type { NativeMutationResult, ObserverDelivery, RuntimeMethod, RuntimeParams, RuntimeResults, TargetGrant } from '../../shared/runtime/runtimeWire.js';
import { parseRuntimeParams, parseRuntimeResult } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeConnection, RuntimeConnectionEvent } from './connection';

export type MutationMethod = 'runtime.host.mutate' | 'native.extension' | 'session.create' | 'session.send' | 'session.cancel' | 'interaction.respond';
export type RequestMethod = Exclude<RuntimeMethod, MutationMethod>;
export type RequestOptions = { readonly signal?: AbortSignal; readonly selectionCurrent?: () => boolean; readonly onDrained?: () => void };
export type RuntimeScope = { readonly binding: Binding; readonly generation: number; readonly isCurrent: () => boolean };
type Collection = RuntimeParams['runtime.snapshot']['collection'];
type Target = { readonly hello: Hello; readonly state: ProtocolState; readonly generation: number; paging: boolean; observerResolution?: 'workspaces' | 'summaries' | 'legacy'; indexSnapshot?: Readonly<{ token: string; revision: number; watermark: number; expiresAt: number }> };
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

async function decodeStartupPayload(compressed: { readonly data: string; readonly bytes: number }) {
  const compressedBytes = Uint8Array.from(atob(compressed.data), byte => byte.charCodeAt(0));
  // Feed the decompressor in bounded increments even if the peer supplies
  // an invalid declared size smaller than the represented pages.
  let inputOffset = 0;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (inputOffset === compressedBytes.length) {
        controller.close();
        return;
      }
      const next = Math.min(inputOffset + 4096, compressedBytes.length);
      controller.enqueue(compressedBytes.subarray(inputOffset, next));
      inputOffset = next;
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const output = new Uint8Array(compressed.bytes);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      requireValue(size + value.length <= output.length, 'snapshot.bootstrap_size');
      output.set(value, size);
      size += value.length;
    }
    requireValue(size === output.length, 'snapshot.bootstrap_size');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class RuntimeRequestError extends ProtocolError {
  constructor(code: ErrorCode, readonly requestId: string, readonly uncertain: boolean, readonly receipt?: string, readonly serverMessage?: string) {
    const prefix = `${code}: `;
    const field = serverMessage?.startsWith(prefix) && /^[a-zA-Z0-9_.-]{1,128}$/.test(serverMessage.slice(prefix.length)) ? serverMessage.slice(prefix.length) : undefined;
    super(code, field ?? (uncertain ? 'request.uncertain' : 'request.failed'));
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
  const deliveryListeners = new Set<(target: EnvironmentId, delivery: ObserverDelivery) => void>();
  const binaryListeners = new Map<number, (chunk: BinaryChunk) => void>();
  const viewReaders = new WeakMap<Target, Map<string, number>>();
  const retiredViews = new WeakMap<Target, Set<string>>();
  function holdView(attached: Target, token: string) {
    let readers = viewReaders.get(attached);
    if (!readers) { readers = new Map(); viewReaders.set(attached, readers); }
    readers.set(token, (readers.get(token) ?? 0) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const count = (readers.get(token) ?? 1) - 1;
      if (count) readers.set(token, count); else readers.delete(token);
      await releaseRetiredView(attached, token);
    };
  }
  async function releaseRetiredView(attached: Target, token: string) {
    if (viewReaders.get(attached)?.has(token) || !retiredViews.get(attached)?.has(token)) return;
    retiredViews.get(attached)?.delete(token);
    if (!current(attached) || !attached.hello.capabilities.methods.includes('runtime.snapshot.release')) return;
    try { await request(attached.hello.target, 'runtime.snapshot.release', { token }); }
    catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== 'replay_required') throw error;
    }
  }
  async function retireView(attached: Target, token: string) {
    if (attached.indexSnapshot?.token === token) attached.indexSnapshot = undefined;
    let retired = retiredViews.get(attached);
    if (!retired) { retired = new Set(); retiredViews.set(attached, retired); }
    retired.add(token);
    await releaseRetiredView(attached, token);
  }
  async function publishView(attached: Target, page: Snapshot) {
    const previous = attached.indexSnapshot;
    attached.indexSnapshot = Object.freeze({ token: page.token, revision: page.revision, watermark: page.watermark, expiresAt: page.expiresAt });
    if (previous && previous.token !== page.token) await retireView(attached, previous.token);
  }
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
      if (!frame.ok) throw new RuntimeRequestError(frame.typedError.code, frame.id, METHODS[entry.method] === 'mutation', entry.receipt, frame.typedError.message);
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
      case 'binary': {
        const chunk = decodeBinary(event.bytes);
        binaryListeners.get(chunk.channelId)?.(chunk);
        break;
      }
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
    const capabilities = grants.get(input.target)?.capabilities ?? target.hello.capabilities;
    requireValue(capabilities.methods.includes(input.method), 'method.capability', 'unsupported');
    requireValue(!input.options.signal?.aborted && (input.options.selectionCurrent?.() ?? true), 'request.selection', 'cancelled');
    const normalCount = [...pending.values()].filter((entry) => entry.slot === 'normal').length;
    const slot = normalCount < 496 ? 'normal' : 'reserved';
    const priorityControl = input.method === 'runtime.history.close' || input.method === 'session.cancel' || input.method === 'interaction.respond';
    if (slot === 'reserved') requireValue(reserved(input.method) && pending.size - normalCount < (priorityControl ? 16 : 12), 'request.capacity', 'source_unavailable');
    if (nextId === 65536) {
      clear();
      connection.reconnect();
      throw new ProtocolError('reconcile_required', 'request.retired');
    }
    const id = `${localGeneration}:${++nextId}`;
    const params = parseRuntimeParams(input.method, input.params);
    if ('session' in params && params.session) requireValue(params.session.environmentId === input.target, 'session.target', 'unauthorized');
    const frame = target.state.register({ version: 1, kind: 'request', ...bindingOf(target.hello), id, method: input.method, params, ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) }, input.method === 'native.query' || input.method === 'native.extension' ? { capabilities, permissions: grants.get(input.target)?.permissions ?? [] } : undefined);
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
  const bootstrapPages = new WeakMap<ReturnType<typeof getTarget>, readonly Snapshot[]>();
  let inspectionSequence = 0, appliedInspectionSequence = 0;
  async function inspect(bootstrapTree = false) {
    const target = managementTarget();
    const attached = getTarget(target);
    const sequence = ++inspectionSequence;
    const requireCurrentInspection = () => requireValue(
      current(attached) && sequence === inspectionSequence, 'inspection.superseded', 'reconcile_required',
    );
    bootstrapTree &&= attached.hello.capabilities.methods.includes('runtime.snapshot');
    const result = await request(target, 'runtime.inspect', bootstrapTree ? { bootstrapTree: true, ...(typeof DecompressionStream === 'function' ? { bootstrapEncoding: 'gzip-inspection' } : {}) } : {}).catch(error => {
      if (!bootstrapTree || !(error instanceof RuntimeRequestError) || error.code !== 'invalid_request'
        || !['fields', 'wire.bootstrap_encoding'].includes(error.field)) throw error;
      requireCurrentInspection();
      return request(target, 'runtime.inspect', {});
    });
    let unpacked = result;
    if (result.treeBootstrapGzip) {
      try {
        const payload = await decodeStartupPayload(result.treeBootstrapGzip);
        const decoded = result.treeBootstrapGzip.includesInspection
          ? objectFields(payload, ['targets', 'harnesses', 'treeBootstrap'])
          : { treeBootstrap: payload };
        const { treeBootstrapGzip: _, ...metadata } = result;
        unpacked = parseRuntimeResult('runtime.inspect', { ...metadata, ...decoded });
      } catch {
        requireCurrentInspection();
        if (!bootstrapTree) throw new ProtocolError('reconcile_required', 'snapshot.bootstrap_encoding');
        return inspect(false);
      }
    }
    const { treeBootstrap, treeBootstrapGzip: _, ...inspection } = unpacked;
    if (treeBootstrap && current(attached) && sequence !== inspectionSequence) {
      void retireView(attached, treeBootstrap[0].token).catch(() => undefined);
    }
    if (bootstrapTree || treeBootstrap || result.treeBootstrapGzip) requireCurrentInspection();
    else requireValue(current(attached), 'inspection.superseded', 'reconcile_required');
    if (treeBootstrap) bootstrapPages.set(attached, treeBootstrap);
    // Plain inspections return independently, but an older reply cannot roll back applied grants.
    if (sequence > appliedInspectionSequence) {
      appliedInspectionSequence = sequence;
      grants.clear();
      for (const grant of inspection.targets) grants.set(grant.target, grant);
    }
    return inspection;
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
  async function observe(target: EnvironmentId, options: RequestOptions & { readonly after: number; readonly onDelivery: (delivery: ObserverDelivery) => void | Promise<void>; readonly onDeliveries?: (deliveries: readonly ObserverDelivery[]) => Promise<void> }) {
    const attached = getTarget(target);
    const selectionCurrent = () => !options.signal?.aborted && (options.selectionCurrent?.() ?? true);
    requireValue(selectionCurrent(), 'request.selection', 'cancelled');
    // Consume the server's allocation acknowledgement even if the view is cancelled.
    const { observerId } = await request(target, 'runtime.observer.open', { after: options.after }, { onDrained: options.onDrained }).catch(error => {
      if (error instanceof RuntimeRequestError && error.code === 'timeout' && current(attached)) connection.reconnect();
      throw error;
    });
    let closing: Promise<void> | undefined;
    let reading = false;
    async function release() {
      for (let attempt = 0; attempt < 2 && current(attached); attempt++) {
        try {
          await request(target, 'runtime.observer.close', { observerId });
          return;
        } catch (error) {
          if (!current(attached)) return;
          if (attempt === 0 && error instanceof ProtocolError && error.code === 'source_unavailable') continue;
          // A failed close can leave the server's observer slot occupied.
          connection.reconnect();
          throw error;
        }
      }
    }
    function close() {
      return closing ??= release();
    }
    if (!selectionCurrent()) {
      await close();
      throw new ProtocolError('cancelled', 'request.selection');
    }
    const active = () => requireValue(closing === undefined && current(attached) && selectionCurrent(), 'observer.closed', 'reconcile_required');
    async function resume(after: number) {
      active();
      await request(target, 'runtime.observer.resume', { observerId, after }, options);
    }
    async function recover(through: number) {
      for (let attempt = 0; attempt < 8; attempt++) {
        let cursor = attached.state.snapshot().seq;
        do {
          const page = await replay(target, cursor, options);
          for (let offset = 0; offset < page.events.length; offset += 4) {
            const deliveries = page.events.slice(offset, offset + 4).map(frame => ({ kind: 'event' as const, frame }));
            if (options.onDeliveries) await options.onDeliveries(deliveries);
            else for (const delivery of deliveries) await options.onDelivery(delivery);
            for (const delivery of deliveries) for (const listener of deliveryListeners) listener(target, delivery);
          }
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
          const fetchDelivery = async (): Promise<ObserverDelivery> => {
            const resolution = attached.observerResolution ?? 'workspaces';
            const params = {
              observerId,
              ...(resolution === 'legacy' ? {} : { resolveSummary: true as const }),
              ...(resolution === 'workspaces' ? { resolveWorkspace: true as const } : {}),
            };
            try { return await request(target, 'runtime.observer.read', params, options); }
            catch (error) {
              if (resolution === 'legacy' || !(error instanceof RuntimeRequestError)
                || error.code !== 'invalid_request' || error.field !== 'fields') throw error;
              // Older Bridges reject optional fields before advancing the observer.
              attached.observerResolution = resolution === 'workspaces' ? 'summaries' : 'legacy';
              return fetchDelivery();
            }
          };
          const delivery = await fetchDelivery();
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
          for (const listener of deliveryListeners) listener(target, delivery);
          return delivery;
        } finally { reading = false; }
      },
      resume,
      close,
    };
  }
  async function snapshot(target: EnvironmentId, collections: Collection | readonly Collection[], options: RequestOptions & { readonly initialSummaryLimit?: number; readonly onPage: (collection: Collection, page: Snapshot) => void | false | Promise<void | false>; readonly onDelivery?: (delivery: ObserverDelivery) => void | Promise<void>; readonly onDeliveries?: (deliveries: readonly ObserverDelivery[]) => Promise<void> }) {
    const attached = getTarget(target);
    requireValue(!attached.paging, 'snapshot.pending', 'conflict');
    const names = typeof collections === 'string' ? [collections] : collections;
    requireValue(names.length > 0 && names.length <= 5 && new Set(names).size === names.length, 'snapshot.collections');
    attached.paging = true;
    const limit = (collection: Collection, cursor: string | null) =>
      collection === 'session_summaries' && cursor === null ? options.initialSummaryLimit ?? 200 : 200;
    const readFirstPage = async (collection: Collection): Promise<Snapshot> => {
      // A replacement socket can become ready before the peer finishes
      // dropping the previous socket's view from the shared snapshot cap.
      const delays = [25, 50, 100];
      for (let attempt = 0; ; attempt++) {
        requireValue(current(attached), 'request.generation', 'reconcile_required');
        requireValue(!options.signal?.aborted && (options.selectionCurrent?.() ?? true), 'request.selection', 'cancelled');
        try {
          return await request(target, 'runtime.snapshot', { collection, cursor: null, limit: limit(collection, null) }, options);
        } catch (error) {
          if (!(error instanceof RuntimeRequestError) || error.code !== 'conflict' ||
            error.field !== 'runtime.store.snapshot_limit' || attempt === delays.length) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    };
    let first: Snapshot | undefined;
    let openingObserver: ReturnType<typeof observe> | undefined;
    const prefetched = new Map<Collection, Promise<Snapshot>>();
    let releaseView: (() => Promise<void>) | undefined;
    try {
      if (attached.indexSnapshot) await retireView(attached, attached.indexSnapshot.token);
      const bootstrap = bootstrapPages.get(attached);
      if (bootstrap && options.initialSummaryLimit === 32 && bootstrap[0].expiresAt > Date.now()
        && names.slice(0, 3).join(',') === 'harnesses,workspaces,session_summaries') {
        bootstrapPages.delete(attached);
        names.slice(0, 3).forEach((collection, index) => prefetched.set(collection, Promise.resolve(bootstrap[index])));
      }
      for (const collection of names) {
        let cursor: string | null = null;
        do {
          const ahead = cursor === null ? prefetched.get(collection) : undefined;
          const page: Snapshot = await (ahead ?? (first
            ? request(target, 'runtime.snapshot', { collection, token: first.token, cursor, limit: limit(collection, cursor) }, options)
            : readFirstPage(collection)));
          if (ahead) prefetched.delete(collection);
          if (!first) {
            first = page;
            releaseView = holdView(attached, page.token);
            await publishView(attached, page);
            // Register at the captured watermark while the remaining pages
            // are downloaded. Event reads still begin after snapshot commit.
            openingObserver = observe(target, { ...options, after: first.watermark, onDelivery: options.onDelivery ?? (() => {}) });
            void openingObserver.catch(() => undefined);
            if (names.length >= 3 && prefetched.size === 0) {
              // Queue at most two independent first pages on this same token.
              // Apply them in collection order so session rows see topology.
              for (const nextCollection of names.slice(1, 3)) {
                const pending = request(target, 'runtime.snapshot', { collection: nextCollection, token: page.token, cursor: null, limit: limit(nextCollection, null) }, options);
                prefetched.set(nextCollection, pending);
                void pending.catch(() => undefined);
              }
            }
          }
          requireValue(page.target === attached.hello.target && page.epoch === attached.hello.epoch
            && page.generation === attached.hello.generation, 'snapshot.binding', 'replay_required');
          requireValue(!first || (page.token === first.token && page.revision === first.revision
            && page.watermark === first.watermark), 'snapshot.atomic', 'replay_required');
          requireValue(page.expiresAt > Date.now() && (page.cursor === null || page.cursor !== cursor), 'snapshot.expired', 'replay_required');
          const keepPaging = await options.onPage(collection, page);
          requireValue(current(attached) && (options.selectionCurrent?.() ?? true), 'snapshot.selection', 'reconcile_required');
          cursor = keepPaging === false ? null : page.cursor;
        } while (cursor !== null);
      }
      requireValue(first !== undefined && openingObserver !== undefined, 'snapshot.empty');
      const observer = await openingObserver;
      requireValue(current(attached) && (options.selectionCurrent?.() ?? true), 'snapshot.selection', 'reconcile_required');
      attached.state.acceptSnapshot(first, Date.now());
      return { token: first.token, revision: first.revision, watermark: first.watermark, observer };
    } catch (error) {
      const observer = await openingObserver?.catch(() => undefined);
      if (observer) await observer.close().catch(() => undefined);
      throw error;
    } finally {
      await Promise.allSettled(prefetched.values());
      attached.paging = false;
      await releaseView?.();
    }
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
   * `fresh` bypasses that reuse for a caller that knows the cached view cannot
   * answer — a new user search, an explicit refresh, or an index update the
   * caller just performed. Pagination inside ONE traversal leaves it unset so
   * every page of that traversal stays on one consistent view.
   */
  async function readIndex(
    target: EnvironmentId,
    collections: Collection | readonly Collection[],
    options: RequestOptions & { readonly onPage: (collection: Collection, page: Snapshot) => void | Promise<void>; readonly fresh?: boolean; readonly onWaiting?: (waitMs: number) => void },
  ) {
    if (options.signal?.aborted) throw new ProtocolError('cancelled', 'readIndex.slot');
    const attached = getTarget(target);
    const names = typeof collections === 'string' ? [collections] : collections;
    requireValue(names.length > 0 && names.length <= 5 && new Set(names).size === names.length, 'snapshot.collections');
    const cached = attached.indexSnapshot;
    const reuse = options.fresh === true || cached === undefined || cached.expiresAt - Date.now() <= 2000
      ? undefined
      : cached.token;
    let releaseView = reuse ? holdView(attached, reuse) : undefined;
    let first: Snapshot | undefined;
    try {
    if (cached && reuse === undefined) await retireView(attached, cached.token);
    for (const collection of names) {
      let cursor: string | null = null;
      do {
        const token = first ? first.token : (cursor === null && collection === names[0] ? reuse : undefined);
        let page: Snapshot;
        try {
          page = await request(target, 'runtime.snapshot', { collection, ...(token === undefined ? {} : { token }), cursor, limit: 200 }, options);
        } catch (error) {
          if (first !== undefined || token === undefined || !(error instanceof ProtocolError) || error.code !== 'replay_required') throw error;
          attached.indexSnapshot = undefined;
          await releaseView?.(); releaseView = undefined;
          page = await request(target, 'runtime.snapshot', { collection, cursor, limit: 200 }, options);
        }
        if (!first) {
          first = page;
          releaseView ??= holdView(attached, page.token);
          if (reuse !== page.token) await publishView(attached, page);
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
    } finally { await releaseView?.(); }
  }
  return {
    inspect, attach, detach, request, mutate, snapshot, readIndex, replay, observe,
    subscribeChannel(channelId: number, listener: (chunk: BinaryChunk) => void) {
      requireValue(!binaryListeners.has(channelId), 'channel.duplicate', 'conflict');
      binaryListeners.set(channelId, listener);
      return () => { if (binaryListeners.get(channelId) === listener) binaryListeners.delete(channelId); };
    },
    sendBinary(chunk: BinaryInput) { connection.send(encodeBinary(chunk)); },
    onObserverDelivery(listener: (target: EnvironmentId, delivery: ObserverDelivery) => void) { deliveryListeners.add(listener); return () => { deliveryListeners.delete(listener); }; },
    scope(target: EnvironmentId): RuntimeScope {
      const attached = getTarget(target);
      return { binding: bindingOf(attached.hello), generation: attached.generation, isCurrent: () => current(attached) };
    },
    onDetach(listener: (target: EnvironmentId) => void) { detachListeners.add(listener); return () => { detachListeners.delete(listener); }; },
    dispose() { if (disposed) return; clear(); disposed = true; unregisterPreflight(); unsubscribe(); detachListeners.clear(); deliveryListeners.clear(); binaryListeners.clear(); },
  };
}
export type RuntimeClient = ReturnType<typeof createRuntimeClient>;
