import { METHODS, ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import type { ErrorCode } from '../../shared/runtime/capabilities.js';
import { createProtocolState } from '../../shared/runtime/protocol.js';
import type { Binding, Hello, Result, Snapshot } from '../../shared/runtime/protocol.js';
import type { ProtocolState } from '../../shared/runtime/protocolState.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';
import type { NativeMutationResult, ObserverDelivery, RuntimeMethod, RuntimeParams, RuntimeResults, TargetGrant } from '../../shared/runtime/runtimeWire.js';
import { parseRuntimeParams, parseRuntimeResult } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeConnection, RuntimeConnectionEvent } from './connection';

export type MutationMethod = 'session.create' | 'session.send' | 'session.cancel' | 'interaction.respond';
export type RequestMethod = Exclude<RuntimeMethod, MutationMethod>;
export type RequestOptions = { readonly signal?: AbortSignal; readonly selectionCurrent?: () => boolean };
export type RuntimeScope = { readonly binding: Binding; readonly generation: number; readonly isCurrent: () => boolean };
type Collection = RuntimeParams['runtime.snapshot']['collection'];
type Target = { readonly hello: Hello; readonly state: ProtocolState; readonly generation: number; paging: boolean };
type Pending = {
  readonly target: Target; readonly method: RuntimeMethod; readonly current: () => boolean;
  readonly slot: 'normal' | 'reserved';
  readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void;
  readonly accept?: (receipt: { readonly operationId: string }) => void;
  readonly clean: () => void; receipt?: string;
};
function bindingOf({ target, epoch, generation }: Binding): Binding { return { target, epoch, generation }; }
function reserved(method: RuntimeMethod) {
  return method === 'session.cancel' || method === 'interaction.respond' || method === 'runtime.channel.ack' || method === 'runtime.channel.cancel' || method === 'runtime.observer.resume' || method === 'runtime.observer.close' || method === 'runtime.target.detach';
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
      pending.delete(id);
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
        entry.clean(); pending.delete(frame.id); return;
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
    pending.delete(frame.id);
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
  const unsubscribe = connection.subscribe(receive);

  function start(input: { readonly target: EnvironmentId; readonly method: RuntimeMethod; readonly params: unknown; readonly options: RequestOptions; readonly idempotencyKey?: string; readonly accept?: Pending['accept'] }) {
    const target = getTarget(input.target);
    requireValue(target.hello.capabilities.methods.includes(input.method), 'method.capability', 'unsupported');
    requireValue(!input.options.signal?.aborted && (input.options.selectionCurrent?.() ?? true), 'request.selection', 'cancelled');
    const normalCount = [...pending.values()].filter((entry) => entry.slot === 'normal').length;
    const slot = normalCount < 496 ? 'normal' : 'reserved';
    const priorityMutation = input.method === 'session.cancel' || input.method === 'interaction.respond';
    if (slot === 'reserved') requireValue(reserved(input.method) && pending.size - normalCount < (priorityMutation ? 16 : 12), 'request.capacity', 'source_unavailable');
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
      const entry: Pending = { target, method: input.method, slot, current: () => !abandoned && current(target) && (input.options.selectionCurrent?.() ?? true), resolve, reject, accept: input.accept, clean };
      pending.set(id, entry);
      input.options.signal?.addEventListener('abort', abort, { once: true });
      try { connection.send(frame); }
      catch (error) {
        clean();
        if (!(error instanceof Error)) throw error;
        reject(new RuntimeRequestError('reconcile_required', id, METHODS[input.method] === 'mutation'));
      }
    });
  }
  function request<M extends RequestMethod>(target: EnvironmentId, method: M, params: RuntimeParams[M], options: RequestOptions = {}): Promise<RuntimeResults[M]> {
    try {
      const attached = getTarget(target);
      requireValue(METHODS[method] !== 'mutation', 'request.mutation', 'invalid_request');
      return start({ target, method, params, options }).then((value) => {
        requireValue(current(attached) && (options.selectionCurrent?.() ?? true) && !options.signal?.aborted, 'request.selection', 'cancelled');
        if (method === 'runtime.entity.resolve') requireValue(!parseRuntimeResult('runtime.entity.resolve', value).chunked, 'entity.resnapshot', 'replay_required');
        return parseRuntimeResult(method, value);
      });
    } catch (error) { return Promise.reject(error); }
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
      return { token: first.token, revision: first.revision, watermark: first.watermark, observer };
    } catch (error) {
      if (observer) await observer.close();
      throw error;
    } finally { attached.paging = false; }
  }
  return {
    inspect, attach, detach, request, mutate, snapshot, replay, observe,
    scope(target: EnvironmentId): RuntimeScope {
      const attached = getTarget(target);
      return { binding: bindingOf(attached.hello), generation: attached.generation, isCurrent: () => current(attached) };
    },
    onDetach(listener: (target: EnvironmentId) => void) { detachListeners.add(listener); return () => { detachListeners.delete(listener); }; },
    dispose() { if (disposed) return; clear(); disposed = true; unsubscribe(); detachListeners.clear(); },
  };
}
export type RuntimeClient = ReturnType<typeof createRuntimeClient>;
