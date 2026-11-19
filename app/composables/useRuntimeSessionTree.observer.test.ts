// @vitest-environment node
//
// Regression for PR #182 reviewer round a8ee4d9e8, item 2 (P2):
// the unified tree's extra snapshot conflicts with the state-held observer.
//
// `state.start` leaves a live observer open (the task-20 state layer owns ONE
// observer per attached target and reads it forever). The tree then read its
// index topology with `client.snapshot`, and every `client.snapshot` opens its
// OWN observer. The real dispatcher allows at most one observer per attached
// target (`runtime.observer_duplicate`), so `tree.start` failed with a real
// service error and the harness/workspace topology stayed empty. A second,
// subtler half: `client.snapshot` flips the per-target `paging` lock, which
// makes the state's in-flight `observer.read` throw `observer.busy` (conflict)
// and silently stops live updates for the rest of the search.
//
// These tests drive the REAL production stack end to end:
//   - REAL bridge createRuntimeServices (real SQLite store) + createRuntimeHost
//   - REAL createRuntimeDispatch (the single-observer enforcement lives here)
//   - REAL app/runtime/connection + app/runtime/client
//   - REAL app/runtime/state + the REAL useRuntimeSessionTree composable
// The ONLY controlled boundary is the transport between the client connection
// and the dispatcher (an in-process EventTarget shim): no TCP port is opened
// and no child process is spawned, so the test is deterministic and isolated.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import type { RuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import type { Json } from '../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeHost } from '../../bridge/runtime/runtimeHost.js';
import { createRuntimeConnection } from '../runtime/connection';
import type { RuntimeSocket } from '../runtime/connection';
import { createRuntimeClient } from '../runtime/client';
import { decodeFrame, encodeFrame } from '../../shared/runtime/protocol.js';
import type { Frame, Result } from '../../shared/runtime/protocol.js';
import { encodeSessionKey, parseConnectionProfileId } from '../../shared/runtime/identity.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';
import { useRuntimeSessionTree } from './useRuntimeSessionTree';

type Dispatcher = Readonly<{ request(input: unknown): Promise<void>; hello(): unknown }>;

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const supervisor = { start: async () => [], stop: async () => {}, getStatus: () => [] };
const acp = { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach: (): never => { throw new Error('Disabled ACP must not attach'); } };
const config = { version: 1 as const, nativeServices: { opencode: false, codex: false, 'kimi-web': false, dsh: false }, acpAgents: [] };

/** In-process transport shim: the client connection is the browser side, the
 * dispatcher is the bridge side. Only JSON request/result frames cross; no
 * socket, no port, no child process. */
class DispatcherSocket extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  /** Frames the browser sent (client -> bridge). */
  readonly requests: Frame[] = [];
  /** Frames the bridge sent (bridge -> client), before the connection transform. */
  readonly delivered: Frame[] = [];
  private readonly inflight: Promise<unknown>[] = [];
  constructor(private readonly dispatcher: Dispatcher) { super(); }
  close() { this.readyState = 3; }
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') throw new TypeError('binary request unsupported in the in-process shim');
    const frame = decodeFrame(data);
    if (frame.kind !== 'request') throw new TypeError('expected a request frame');
    this.requests.push(frame);
    this.inflight.push(this.dispatcher.request(frame));
  }
  deliver(frame: unknown) {
    this.delivered.push(frame as Frame);
    this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(frame) }));
  }
  async settle() { await Promise.allSettled(this.inflight); }
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: condition not met before timeout');
}
function summaryValue(environmentId: EnvironmentId, harnessInstanceId: string, directory: string, index: number): Json {
  return {
    session: { environmentId, harnessInstanceId, nativeSessionId: `live-${index}` },
    title: `live-${index}`,
    directory,
    archived: false,
    pinned: false,
    parentSession: null,
    createdAt: 1700000000000 + index,
    updatedAt: 1700000000000 + index,
    status: 'idle',
  };
}

async function treeFixture(wrap?: (services: RuntimeServices) => RuntimeServices) {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-tree-observer-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const services = await createRuntimeServices({
    environmentId: randomUUID(), stateRoot: root, role: 'local',
    roots: [{ root, permissions: ['read', 'write', 'command', 'pty'] }],
    config, nativeSupervisor: supervisor, acpManager: acp, runtime: { mutate: (operation) => operation() },
  });
  cleanups.push(() => services.close());
  await services.start();
  const graph = wrap ? wrap(services) : services;
  const host = createRuntimeHost({ environmentId: services.target, role: 'local', services: graph });
  host.start();
  cleanups.push(() => host.stop());
  await host.sourcesReady;

  const scope = host.connect('tree-observer');
  let socket!: DispatcherSocket;
  const dispatcher = scope.openRuntime({
    send: (frame) => socket.deliver(frame),
    sendBinary: () => {},
    canSend: () => true,
  });
  if (!dispatcher) throw new TypeError('runtime dispatcher unavailable');
  socket = new DispatcherSocket(dispatcher as Dispatcher);

  const connection = createRuntimeConnection({
    reference: { url: 'ws://127.0.0.1:43999/runtime' },
    resolveAuthentication: async () => ({}),
    createWebSocket: () => {
      // The bridge pushes hello on connect; deliver it after the connection has
      // attached its message listener (the same microtask turn).
      queueMicrotask(() => socket.deliver(dispatcher.hello()));
      return socket as unknown as RuntimeSocket;
    },
  });
  cleanups.push(() => connection.dispose());
  const client = createRuntimeClient({ connection });
  cleanups.push(() => client.dispose());
  await connection.connect();
  const target = services.target as EnvironmentId;
  const tree = useRuntimeSessionTree({ client, profileId: parseConnectionProfileId(services.connectionProfileId), target });
  cleanups.push(() => tree.dispose());
  return { services, socket, connection, client, tree, target, root };
}

function observerOpens(socket: DispatcherSocket): number {
  return socket.requests.filter((frame) => frame.kind === 'request' && frame.method === 'runtime.observer.open').length;
}
function dispatchErrors(socket: DispatcherSocket): string[] {
  return socket.delivered
    .filter((frame): frame is Extract<Result, { ok: false }> => frame.kind === 'result' && frame.ok === false)
    .map((frame) => frame.typedError.message);
}

describe('useRuntimeSessionTree over the real dispatch/client/connection/state', () => {
  it('starts without a duplicate observer and populates the harness/workspace topology', async () => {
    const { tree, socket } = await treeFixture();
    try {
      await tree.start();
    } catch (error) {
      const observed = (error instanceof Error ? error.message : String(error));
      throw new Error(`tree.start() failed: ${observed}; dispatch errors=${JSON.stringify(dispatchErrors(socket))}; observerOpens=${observerOpens(socket)}; harnesses=${tree.harnesses.value.length}; workspaces=${tree.workspaces.value.length}`);
    }
    // The topology must be NON-EMPTY, not merely error-free.
    expect(tree.harnesses.value.length).toBeGreaterThanOrEqual(5);
    expect(tree.workspaces.value.length).toBeGreaterThanOrEqual(1);
    // Exactly ONE observer for the whole start: the state's live observer. The
    // tree's topology read must not open a second one.
    expect(observerOpens(socket)).toBe(1);
    expect(dispatchErrors(socket)).not.toContain('runtime.observer_duplicate');
  });

  it('keeps live events flowing while a delayed full-index search is in flight', async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let gateOn = false;
    const { tree, socket, services, target, root } = await treeFixture((base) => ({
      ...base,
      snapshots: {
        async connect(binding, isCurrent) {
          const connection = await base.snapshots.connect(binding, isCurrent);
          return {
            ...connection,
            async page(input) {
              if (gateOn && input?.collection === 'session_summaries') { entered.resolve(); await gate.promise; }
              return connection.page(input);
            },
          };
        },
      },
    })    );
    const harnessInstanceId = services.registry.list()[0].harnessInstanceId;
    const harnessOf = (index: number) => ({ environmentId: target, harnessInstanceId, nativeSessionId: `live-${index}` } as const);
    // Seed the searchable row BEFORE start so it is inside the state's index
    // view (the tree's readIndex shares that view rather than minting a fresh
    // snapshot token per read against the bridge's tiny snapshot budget).
    const seed = harnessOf(0);
    await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(seed), value: summaryValue(target, harnessInstanceId, root, 0) }] });
    await tree.start();

    // Baseline: a store mutation publishes an event the state applies live.
    const first = harnessOf(1);
    await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(first), value: summaryValue(target, harnessInstanceId, root, 1) }] });
    await waitFor(() => tree.sessions.value.some((row) => row.nativeSessionId === 'live-1'));

    // Block the search's session_summaries index page, then start the search.
    gateOn = true;
    const searching = tree.search('live-0');
    await entered.promise;

    // While the search read is parked, another event must still reach the tree:
    // the parked index read must not hold the state's paging lock.
    const second = harnessOf(2);
    await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(second), value: summaryValue(target, harnessInstanceId, root, 2) }] });
    await waitFor(() => tree.sessions.value.some((row) => row.nativeSessionId === 'live-2'));

    gateOn = false;
    gate.resolve();
    const result = await searching;
    expect(result.status, JSON.stringify({ error: result.error, failure: tree.failure.value, view: tree.viewStatus.value, errors: dispatchErrors(socket) })).toBe('complete');
    expect(result.matches.map((row) => row.nativeSessionId)).toContain('live-0');
    expect(observerOpens(socket)).toBe(1);
    expect(dispatchErrors(socket)).not.toContain('observer.busy');
  });
});
