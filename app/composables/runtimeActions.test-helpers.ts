// Task 22 test boundary: a recording `RuntimeClient` double.
//
// The new-path composables (useRuntimeSessionActions / useRuntimeMessageSend /
// useRuntimeInteractions) are a QUALIFIED routing layer over the frozen runtime
// client. These helpers let a test observe exactly which target + method +
// NativeCall a UI operation produces, and let the test settle a pending
// mutation only when it chooses — which is what makes the two key invariants
// (busy-session switch does not cancel; no cross-source leakage) provable.
import { ProtocolError } from '../../shared/runtime/capabilities.js';
import type { EnvironmentId, ConnectionProfileId, SessionRef } from '../../shared/runtime/identity.js';
import type { NativeCall, NativeMutationResult } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeClient, RuntimeScope } from '../runtime/client';
import type { SelectionCapture } from '../runtime/selectionScope';

export type MutationCall = Readonly<{
  kind: 'mutate';
  target: EnvironmentId;
  method: string;
  params: NativeCall;
  idempotencyKey: string;
  selectionCurrent: (() => boolean) | undefined;
}>;
export type RequestCall = Readonly<{
  kind: 'request';
  target: EnvironmentId;
  method: string;
  params: NativeCall;
  selectionCurrent: (() => boolean) | undefined;
}>;
export type RecordedCall = MutationCall | RequestCall;

type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function createFakeRuntimeActionClient(targets: readonly EnvironmentId[]) {
  const live = new Map<EnvironmentId, boolean>();
  for (const target of targets) live.set(target, true);
  const calls: RecordedCall[] = [];
  const pending: { readonly selectionCurrent: (() => boolean) | undefined; readonly deferred: Deferred<NativeMutationResult> }[] = [];
  const requestResults = new Map<string, unknown>();
  let ids = 0;

  const client = {
    scope(target: EnvironmentId): RuntimeScope {
      if (!live.has(target)) throw new ProtocolError('reconcile_required', 'fake.scope');
      return Object.freeze({
        binding: Object.freeze({ target, epoch: 'fake-epoch', generation: 0 }),
        generation: 0,
        isCurrent: () => live.get(target) === true,
      });
    },
    mutate(target: EnvironmentId, method: string, params: NativeCall, options: Readonly<{ idempotencyKey: string; selectionCurrent?: () => boolean }>) {
      const deferred = defer<NativeMutationResult>();
      calls.push({ kind: 'mutate', target, method, params, idempotencyKey: options.idempotencyKey, selectionCurrent: options.selectionCurrent });
      pending.push({ selectionCurrent: options.selectionCurrent, deferred });
      return { accepted: Promise.resolve({ operationId: `op-${++ids}` }), executed: deferred.promise };
    },
    request(target: EnvironmentId, method: string, params: NativeCall, options: Readonly<{ selectionCurrent?: () => boolean }> = {}) {
      calls.push({ kind: 'request', target, method, params, selectionCurrent: options.selectionCurrent });
      return Promise.resolve(requestResults.get(method) ?? { method, params });
    },
  };

  /** Detach a target, exactly like the runtime client does on `runtime.target.detach`. */
  function detach(target: EnvironmentId) { live.set(target, false); }
  /** Settle the oldest pending mutation using the SAME fence the real client applies. */
  function settle(success = true): boolean {
    const next = pending.shift();
    if (!next) return false;
    const current = next.selectionCurrent ? next.selectionCurrent() : true;
    if (current && success) next.deferred.resolve({ operationId: 'op', value: null });
    else next.deferred.reject(new ProtocolError(current ? 'source_unavailable' : 'cancelled', 'fake.settle'));
    return true;
  }
  function setRequestResult(method: string, result: unknown) { requestResults.set(method, result); }
  const asClient = () => client as unknown as RuntimeClient;

  return { client, asClient, calls, pending, detach, settle, setRequestResult };
}

/** A controllable qualified selection capture, mirroring selectionScope.ts. */
export function createFakeCapture(
  clientScope: RuntimeScope,
  profileId: ConnectionProfileId,
  session: SessionRef,
  uiCurrent = { value: true },
): { capture: SelectionCapture; uiCurrent: { value: boolean } } {
  const capture: SelectionCapture = Object.freeze({
    selection: Object.freeze({ profileId, session }),
    selectionGeneration: 0,
    clientScope,
    signal: new AbortController().signal,
    // The selection-level fence: flips false the instant the user selects
    // another session. The new send path must NOT use this as its fence.
    isCurrent: () => uiCurrent.value,
  });
  return { capture, uiCurrent };
}
