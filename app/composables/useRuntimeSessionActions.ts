// Task 22 — qualified session action routing.
//
// Every legacy session operation used a BARE native session id together with a
// single "active backend" switch. Two sources can legitimately expose the SAME
// native id (a Codex thread id and an OpenCode session id are independent
// namespaces), so a bare id can route an action to the wrong source. This
// module is the ONE router every migrated operation goes through: it binds an
// operation to the FULL qualified identity — (profileId, environmentId,
// harnessInstanceId, nativeSessionId) — and refuses to dispatch when the action
// session does not belong to the profile or when the target is detached.
//
// The router is deliberately thin. It does not own the runtime client, the
// entity cache or the selection scope; it CONSUMES the frozen task-20 layer
// (`RuntimeClient.mutate/request/scope` and `SelectionCapture`). That keeps the
// shared Scope contract fixed and makes the routing provable with a fake client.
import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import { encodeSessionKey, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import type { JsonObject, NativeCall, NativeMutationResult, RuntimeParams } from '../../shared/runtime/runtimeWire.js';
import type { InjectionKey } from 'vue';
import type { MutationMethod, RequestMethod, RuntimeClient } from '../runtime/client';
import type { SelectionCapture } from '../runtime/selectionScope';

/** The composer payload a send carries; the same shape on every migrated source. */
export type RuntimeSendInput = Readonly<{
  text?: string;
  attachments?: readonly JsonValue[];
  model?: string | null;
  mode?: string | null;
  thinking?: string | null;
  queue?: boolean;
  args?: Readonly<Record<string, JsonValue>>;
}>;

/** The narrow client surface the router needs; the real `RuntimeClient` satisfies it. */
export type RuntimeActionClient = Pick<RuntimeClient, 'mutate' | 'request' | 'scope'>;

export type RuntimeActionContext = Readonly<{
  client: RuntimeActionClient;
  profileId: ConnectionProfileId;
  /** The current qualified selection, or null. NEVER used as an in-flight fence. */
  capture(): SelectionCapture | null;
}>;

/** The immutable qualified identity an operation is bound to. */
export type SessionActionScope = Readonly<{
  profileId: ConnectionProfileId;
  session: SessionRef;
  target: EnvironmentId;
  harnessInstanceId: HarnessInstanceId;
  key: string;
}>;

/** A resolved action binding: the scope plus the fence that governs in-flight cancellation. */
export type BoundAction = Readonly<{
  scope: SessionActionScope;
  selectionCurrent: () => boolean;
}>;

/** A legacy composable may hand its operation to the new path through this binding. */
export type RuntimeActionBinding = Readonly<{
  profileId: ConnectionProfileId;
  session: SessionRef;
}>;

export type SessionMutation = Readonly<{ accepted: Promise<Readonly<{ operationId: string }>>; executed: Promise<NativeMutationResult> }>;

let idempotencyCounter = 0;
function nextIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID;
  if (typeof random === 'function') return `ui-action:${random.call(globalThis.crypto)}`;
  return `ui-action:${Date.now()}:${++idempotencyCounter}`;
}

function asJsonObject(value: Readonly<Record<string, JsonValue>>): JsonObject {
  return Object.freeze({ ...value });
}

export function createSessionActionRouter(ctx: RuntimeActionContext) {
  /** profileId + the encoded SessionRef. Two sources with a colliding native id get different keys. */
  function qualifiedKey(session: SessionRef): string {
    return `${ctx.profileId}\u0000${encodeSessionKey(parseSessionRef(session))}`;
  }

  /**
   * Bind an operation to its qualified identity.
   *
   * When `capture` is supplied (the capture-scope send), the fence is the
   * CAPTURED TARGET's `clientScope.isCurrent()` — NOT `capture.isCurrent()` and
   * NOT `capture.signal`. `selectionScope.ts#invalidate()` flips those two the
   * moment the user selects another session, so using them would cancel a busy
   * turn as a side effect of switching selection (GAP-1). The captured target
   * scope only becomes false when the target itself detaches/rebinds.
   */
  function bind(session: SessionRef, capture: SelectionCapture | null = null): BoundAction {
    const ref = parseSessionRef(session);
    requireValue(ref.nativeSessionId.length > 0, 'action.session');
    const scope = Object.freeze({
      profileId: ctx.profileId,
      session: ref,
      target: ref.environmentId,
      harnessInstanceId: ref.harnessInstanceId,
      key: qualifiedKey(ref),
    });
    if (capture) {
      requireValue(capture.selection.profileId === ctx.profileId, 'action.profile', 'unauthorized');
      requireValue(encodeSessionKey(capture.selection.session) === encodeSessionKey(ref), 'action.session_target', 'unauthorized');
      const targetScope = capture.clientScope;
      return Object.freeze({ scope, selectionCurrent: () => targetScope.isCurrent() });
    }
    const live = ctx.client.scope(ref.environmentId);
    return Object.freeze({ scope, selectionCurrent: () => live.isCurrent() });
  }

  function call(bound: BoundAction, args: Readonly<Record<string, JsonValue>>): NativeCall {
    return Object.freeze({
      harnessInstanceId: bound.scope.harnessInstanceId,
      session: bound.scope.session,
      args: asJsonObject(args),
    });
  }

  function mutate(bound: BoundAction, method: MutationMethod, params: RuntimeParams[MutationMethod]): SessionMutation {
    return ctx.client.mutate(bound.scope.target, method, params, {
      idempotencyKey: nextIdempotencyKey(),
      selectionCurrent: bound.selectionCurrent,
    });
  }

  function read<M extends RequestMethod>(bound: BoundAction, method: M, params: RuntimeParams[M]): Promise<unknown> {
    return ctx.client.request(bound.scope.target, method, params, { selectionCurrent: bound.selectionCurrent });
  }

  /** Build a `session.send` command envelope (the backend-agnostic native command). */
  function commandArgs(name: string, args?: Readonly<Record<string, JsonValue>>): JsonObject {
    requireValue(typeof name === 'string' && name.length > 0 && name.length <= 64, 'action.command');
    return args === undefined
      ? asJsonObject({ command: { name } })
      : asJsonObject({ command: { name, arguments: asJsonObject(args) } });
  }

  return { qualifiedKey, bind, call, mutate, read, commandArgs };
}

export type SessionActionRouter = ReturnType<typeof createSessionActionRouter>;

/** The delegate a legacy `useBackend*` composable calls when it has a qualified binding. */
export type RuntimeSessionRouter = Readonly<{
  sendMessage(scope: RuntimeActionBinding, input: RuntimeSendInput): unknown;
  cancel(scope: RuntimeActionBinding): unknown;
  fork(scope: RuntimeActionBinding, payload: Readonly<Record<string, JsonValue>>): unknown;
  rename(scope: RuntimeActionBinding, title: string): unknown;
  archive(scope: RuntimeActionBinding): unknown;
  unarchive(scope: RuntimeActionBinding): unknown;
  delete(scope: RuntimeActionBinding): unknown;
  compact(scope: RuntimeActionBinding): unknown;
  revert(scope: RuntimeActionBinding, payload: Readonly<Record<string, JsonValue>>): unknown;
  todos(scope: RuntimeActionBinding): unknown;
  tokenMonitor(scope: RuntimeActionBinding): unknown;
  history(scope: RuntimeActionBinding, args: Readonly<Record<string, JsonValue>>): unknown;
  respond(scope: RuntimeActionBinding, interactionId: string, response: Readonly<Record<string, JsonValue>>): unknown;
}>;

/**
 * Session lifecycle actions (fork / rename / archive / unarchive / delete /
 * compact / revert) plus the two read-only monitors (todos / tokenMonitor).
 * Every operation is routed by the full qualified SessionRef.
 */
export function useRuntimeSessionActions(ctx: RuntimeActionContext) {
  const router = createSessionActionRouter(ctx);

  function command(session: SessionRef, name: string, args?: Readonly<Record<string, JsonValue>>): SessionMutation {
    const bound = router.bind(session);
    return router.mutate(bound, 'session.send', router.call(bound, router.commandArgs(name, args)));
  }

  function readSession(session: SessionRef, include: readonly string[]): Promise<unknown> {
    const bound = router.bind(session);
    return router.read(bound, 'session.get', router.call(bound, { include }));
  }

  return {
    router,
    fork(session: SessionRef, payload: Readonly<Record<string, JsonValue>> = {}) { return command(session, 'fork', payload); },
    rename(session: SessionRef, title: string) {
      requireValue(typeof title === 'string' && title.trim().length > 0, 'action.title');
      return command(session, 'rename', { title: title.trim() });
    },
    archive(session: SessionRef) { return command(session, 'archive'); },
    unarchive(session: SessionRef) { return command(session, 'unarchive'); },
    delete(session: SessionRef) { return command(session, 'delete'); },
    compact(session: SessionRef) { return command(session, 'compact'); },
    revert(session: SessionRef, payload: Readonly<Record<string, JsonValue>> = {}) { return command(session, 'revert', payload); },
    todos(session: SessionRef) { return readSession(session, ['todos']); },
    tokenMonitor(session: SessionRef) { return readSession(session, ['usage']); },
    history(session: SessionRef, args: Readonly<Record<string, JsonValue>> = {}) {
      const bound = router.bind(session);
      return router.read(bound, 'session.history', router.call(bound, args));
    },
  };
}

export type RuntimeSessionActions = ReturnType<typeof useRuntimeSessionActions>;

/**
 * The optional seam a legacy `useBackend*` composable accepts. When the owner
 * (App.vue, task 24) supplies it, each migrated operation delegates to the new
 * qualified router; otherwise the legacy backend-specific path runs unchanged.
 */
export type RuntimeSessionRuntime = Readonly<{
  binding(): RuntimeActionBinding | null;
  router: RuntimeSessionRouter;
}>;

/**
 * Injection key a container (App.vue) provides so presentational components can
 * prefer the new qualified path. Absent → components keep their legacy emits.
 */
export const RUNTIME_SESSION_ACTIONS_KEY: InjectionKey<RuntimeSessionRuntime | null> = Symbol('vis.runtime.sessionActions');

/**
 * Shared guard used by the legacy `useBackend*` composables. Returns the
 * current qualified binding, or `null` when no seam is supplied or the binding
 * is not a well-formed SessionRef — in which case the caller keeps its legacy
 * behavior exactly as before.
 */
export function bindRuntimeAction(runtime?: RuntimeSessionRuntime): RuntimeActionBinding | null {
  if (!runtime) return null;
  let value: RuntimeActionBinding | null;
  try { value = runtime.binding(); } catch (error) {
    if (error instanceof ProtocolError) return null;
    throw error;
  }
  if (!value) return null;
  try { parseSessionRef(value.session); } catch (error) {
    if (error instanceof ProtocolError) return null;
    throw error;
  }
  return value;
}
