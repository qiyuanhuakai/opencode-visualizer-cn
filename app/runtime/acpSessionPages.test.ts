// @vitest-environment node
// Regression cover for PR #180 finding i2: ACP session/list carries no page-size
// parameter, so a legal native answer can hold 201-1000 summaries. The adapter must hand
// that answer to the index in pages the index can actually apply inside one scheduler
// round, instead of dropping the whole page on the 15s discovery deadline.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAcpSessions } from '../../bridge/runtime/drivers/acpSessions.js';
import { createIndexDiscovery } from '../../bridge/runtime/indexDiscovery.js';
import { createDiscoveryScheduler } from '../../bridge/runtime/discoveryScheduler.js';
import { sourceIdentity } from '../../bridge/runtime/sessionSummaries.js';
import { createRuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseInstanceId } from '../../shared/runtime/identity.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import type { AcpRpc } from '../../bridge/runtime/drivers/acpRpc.js';
import type { AcpMutations, AcpScope } from '../../bridge/runtime/drivers/acpMutations.js';
import type { AcpCapabilities, AcpQueue } from '../../shared/runtime/native/acp/capabilities.js';
import type { DiscoveryDemand, DiscoveryLease, DiscoveryScheduler } from '../../bridge/runtime/discoveryScheduler.js';
import type { DiscoverySource } from '../../bridge/runtime/indexDiscovery.js';
import type { IndexMutations } from '../../bridge/runtime/indexMutations.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const instanceId = parseInstanceId('33333333-3333-4333-8333-333333333333');
// The unified index page budget every adapter is expected to respect. A real store commits
// one summary in ~22ms, so a round holding more than this many summaries cannot finish
// inside the scheduler's 15s discovery deadline.
const INDEX_PAGE_SIZE = 200;
const ROUND_BUDGET_MS = 450;
const PER_ITEM_MS = 1;

function unavailable(what: string): never {
  throw new Error(`${what} is not exercised by ACP session listing`);
}
function burn(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function acpCapabilities(): AcpCapabilities {
  return { protocolVersion: 1, load: false, resume: false, list: true, concurrent: false, authMethods: [], native: {}, listCompleteness: 'native' };
}
function acpQueue(): AcpQueue {
  return (action) => Promise.resolve().then(action);
}
function acpMutations(): AcpMutations {
  const binding = { target: environmentId, harnessInstanceId, epoch: instanceId, processGeneration: 1 };
  return {
    binding,
    processKey: 'acp-session-pages',
    owner: 'test',
    async run(): Promise<never> { return unavailable('acp mutation run'); },
    scopeFor(): AcpScope { return { ...binding }; },
    async get(): Promise<never> { return unavailable('acp mutation get'); },
    async reconcile(): Promise<void> { return unavailable('acp mutation reconcile'); },
    async close(): Promise<void> { return unavailable('acp mutation close'); },
    async authority(): Promise<never> { return unavailable('acp mutation authority'); },
    leaseKey(): string { return unavailable('acp mutation leaseKey'); },
  };
}
function acpRpc(answers: readonly JsonValue[]) {
  const requests: { method: string; params: unknown }[] = [];
  let served = 0;
  const rpc: AcpRpc = {
    async request(method, params) {
      requests.push({ method, params });
      return answers[Math.min(served++, answers.length - 1)];
    },
    reply(): void { unavailable('acp rpc reply'); },
    notify(): void { unavailable('acp rpc notify'); },
    assertCurrent(): void {},
    active: true,
    processGeneration: 1,
    pid: 1,
    async close(): Promise<void> {},
  };
  return { rpc, requests };
}
function nativeAnswer(prefix: string, count: number, nextCursor: string | null = null) {
  return {
    sessions: Array.from({ length: count }, (_, index) => ({ sessionId: `${prefix}-${index}`, cwd: '/repo', title: `${prefix}-${index}` })),
    ...(nextCursor === null ? {} : { nextCursor }),
  } as unknown as JsonValue;
}
async function withStore(run: (store: Awaited<ReturnType<typeof createRuntimeStore>>) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'acp-session-pages-'));
  const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch: instanceId });
  try {
    await store.ready;
    await run(store);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function drain(adapter: ReturnType<typeof createAcpSessions>) {
  const pages: { items: readonly { session: { nativeSessionId: string } }[]; status: string; cursor: string | null; reason?: string }[] = [];
  return (async () => {
    let cursor: string | null = null;
    do {
      const page = await adapter.list(cursor === null ? {} : { cursor });
      pages.push(page);
      cursor = page.cursor;
    } while (cursor !== null);
    return pages;
  })();
}

describe('ACP session pages', () => {
  it('pages every legal native answer of 201-1000 summaries into index-sized pages', async () => {
    for (const count of [0, 200, 201, 202, 399, 400, 401, 599, 600, 601, 799, 800, 801, 999, 1000]) {
      const { rpc, requests } = acpRpc([nativeAnswer('acp', count)]);
      const adapter = createAcpSessions({ rpc, mutations: acpMutations(), capabilities: acpCapabilities(), queue: acpQueue(), cwd: '/repo', emit: () => {} });
      const pages = await drain(adapter);
      const identities = pages.flatMap((page) => page.items.map((item) => item.session.nativeSessionId));
      expect(identities, `count ${count}`).toEqual(Array.from({ length: count }, (_, index) => `acp-${index}`));
      expect(pages.length, `count ${count}`).toBe(count === 0 ? 1 : Math.ceil(count / INDEX_PAGE_SIZE));
      for (const [index, page] of pages.entries()) {
        expect(page.items.length, `count ${count} page ${index}`).toBe(Math.min(INDEX_PAGE_SIZE, count - index * INDEX_PAGE_SIZE));
        if (index === pages.length - 1) {
          expect(page, `count ${count}`).toMatchObject({ status: 'complete', cursor: null });
        } else {
          expect(page.status, `count ${count} page ${index}`).toBe('partial');
          expect(typeof page.cursor, `count ${count} page ${index}`).toBe('string');
          expect(page.cursor?.length, `count ${count} page ${index}`).toBeGreaterThan(0);
        }
      }
      // One native round trip serves every internal page of that native answer.
      expect(requests, `count ${count}`).toEqual([{ method: 'session/list', params: { cwd: '/repo' } }]);
    }
  });
  it('advances the native cursor only after the buffered native page is drained', async () => {
    const { rpc, requests } = acpRpc([nativeAnswer('acp', 1000, 'native-second'), nativeAnswer('later', 3)]);
    const adapter = createAcpSessions({ rpc, mutations: acpMutations(), capabilities: acpCapabilities(), queue: acpQueue(), cwd: '/repo', emit: () => {} });
    const pages = await drain(adapter);
    expect(pages).toHaveLength(6);
    expect(pages.slice(0, 5).map((page) => page.items.length)).toEqual([200, 200, 200, 200, 200]);
    expect(pages[5]).toMatchObject({ status: 'complete', cursor: null });
    expect(pages[5].items.map((item) => item.session.nativeSessionId)).toEqual(['later-0', 'later-1', 'later-2']);
    expect(requests).toEqual([{ method: 'session/list', params: { cwd: '/repo' } }, { method: 'session/list', params: { cwd: '/repo', cursor: 'native-second' } }]);
  });
  it('keeps fencing a native cursor the agent repeats', async () => {
    const { rpc, requests } = acpRpc([nativeAnswer('acp', 1000, 'native-loop'), nativeAnswer('later', 3, 'native-loop')]);
    const adapter = createAcpSessions({ rpc, mutations: acpMutations(), capabilities: acpCapabilities(), queue: acpQueue(), cwd: '/repo', emit: () => {} });
    const pages = await drain(adapter);
    expect(pages).toHaveLength(6);
    expect(pages[5]).toMatchObject({ status: 'partial', cursor: null, reason: 'repeated_cursor' });
    expect(requests).toHaveLength(2);
  });
  it('keeps the native round budget and the adapter page fence', async () => {
    const oversized = acpRpc([nativeAnswer('acp', 1001)]);
    const adapter = createAcpSessions({ rpc: oversized.rpc, mutations: acpMutations(), capabilities: acpCapabilities(), queue: acpQueue(), cwd: '/repo', emit: () => {} });
    await expect(adapter.list({})).rejects.toThrow(/session_list/);
    const duplicated = acpRpc([{ sessions: [{ sessionId: 'same', cwd: '/repo' }, { sessionId: 'same', cwd: '/repo' }] } as unknown as JsonValue]);
    const repeating = createAcpSessions({ rpc: duplicated.rpc, mutations: acpMutations(), capabilities: acpCapabilities(), queue: acpQueue(), cwd: '/repo', emit: () => {} });
    await expect(repeating.list({})).rejects.toThrow(/index_duplicate_page/);
    // Every native answer hands back a fresh cursor, so only the adapter's own round budget
    // can stop the walk. It has to fire on the 1001st native round, not run the index's
    // 10000-cursor fence instead.
    const answers: JsonValue[] = [];
    for (let round = 1; round <= 1001; round++) answers.push(nativeAnswer('acp', 1, `native-${round}`));
    const { rpc } = acpRpc(answers);
    const budgeted = createAcpSessions({ rpc, mutations: acpMutations(), capabilities: acpCapabilities(), queue: acpQueue(), cwd: '/repo', emit: () => {} });
    const pages = await drain(budgeted);
    expect(pages.at(-1)).toMatchObject({ status: 'partial', cursor: null, reason: 'cursor_budget' });
    expect(pages).toHaveLength(1001);
  });
  it('never asks one discovery round to apply more than the index page budget', async () => {
    await withStore(async (store) => {
      const { rpc } = acpRpc([nativeAnswer('acp', 1000)]);
      const adapter = createAcpSessions({ rpc, mutations: acpMutations(), capabilities: acpCapabilities(), queue: acpQueue(), cwd: '/repo', emit: () => {} });
      const source: DiscoverySource = {
        identity: sourceIdentity({ kind: 'acp', environmentId, harnessInstanceId }),
        authority: () => ({ epoch: instanceId, processGeneration: 1 }),
        serial: () => 0,
        assertCurrent() {},
        list: (params) => adapter.list(typeof params.cursor === 'string' ? { cursor: params.cursor } : {}),
      };
      const batches: number[] = [];
      let applied = 0;
      const mutations: IndexMutations = {
        async apply(scan, items) {
          batches.push(items.length);
          for (let index = 0; index < items.length; index++) scan.assertCurrent();
          applied += items.length;
          return items.length;
        },
        async complete() { return { count: applied, deleted: 0 }; },
        async event(): Promise<boolean> { return unavailable('index event'); },
        async progress(): Promise<void> {},
      };
      const discovery = createIndexDiscovery({ store, scheduler: createDiscoveryScheduler(), mutations });
      expect(await discovery.discover(source)).toMatchObject({ status: 'complete', count: 1000, reason: 'native_exhausted' });
      expect(batches).toEqual([200, 200, 200, 200, 200]);
      expect(discovery.active).toBe(0);
    });
  });
  it('finishes a full native answer inside one scheduler deadline per round', async () => {
    await withStore(async (store) => {
      const { rpc } = acpRpc([nativeAnswer('acp', 1000)]);
      const adapter = createAcpSessions({ rpc, mutations: acpMutations(), capabilities: acpCapabilities(), queue: acpQueue(), cwd: '/repo', emit: () => {} });
      const source: DiscoverySource = {
        identity: sourceIdentity({ kind: 'acp', environmentId, harnessInstanceId }),
        authority: () => ({ epoch: instanceId, processGeneration: 1 }),
        serial: () => 0,
        assertCurrent() {},
        list: (params) => adapter.list(typeof params.cursor === 'string' ? { cursor: params.cursor } : {}),
      };
      // The scheduler accepts any deadline in 1..15000ms and the index uses its default, so
      // the 15s production budget is compressed here to keep the probe fast: one round must
      // stay inside one deadline whatever that deadline is. 1000 summaries at the measured
      // ~22ms each need ~22s, far past a single round, while 200 need ~4.4s.
      const inner = createDiscoveryScheduler();
      const scheduler: DiscoveryScheduler = {
        schedule: <T>(demand: DiscoveryDemand, action: (lease: DiscoveryLease) => T | Promise<T>): Promise<T> =>
          inner.schedule({ ...demand, deadlineMs: ROUND_BUDGET_MS }, action),
        cancel: (demand) => inner.cancel(demand),
        close: () => inner.close(),
        get state() { return inner.state; },
      };
      const mutations: IndexMutations = {
        async apply(scan, items) {
          for (let index = 0; index < items.length; index++) {
            burn(PER_ITEM_MS);
            scan.assertCurrent();
          }
          return items.length;
        },
        async complete() { return { count: 1000, deleted: 0 }; },
        async event(): Promise<boolean> { return unavailable('index event'); },
        async progress(): Promise<void> {},
      };
      const discovery = createIndexDiscovery({ store, scheduler, mutations });
      expect(await discovery.discover(source)).toMatchObject({ status: 'complete', count: 1000, reason: 'native_exhausted' });
    });
  });
});
