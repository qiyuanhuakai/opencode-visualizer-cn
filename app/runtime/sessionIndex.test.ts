// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';
import { createSessionIndex } from '../../bridge/runtime/sessionIndex.js';
import { createHarnessRegistry, CORE_OPERATIONS, unsupported } from '../../shared/runtime/harnessContract.js';
import type { HarnessKind, HarnessManifest, CoreOperation, HarnessContext } from '../../shared/runtime/harnessContract.js';
import { encodeWorkspaceKey, parseEnvironmentId, parseHarnessInstanceId, parseSessionRef, encodeSessionKey } from '../../shared/runtime/identity.js';
import { nativePage, sourceIdentity } from '../../bridge/runtime/sessionSummaries.js';
import { createNativeEventIntake } from '../../bridge/runtime/nativeEventIntake.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const epoch = '33333333-3333-4333-8333-333333333333';
const session = (nativeSessionId: string) => parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId });
const row = (id: string, directory = '/repo') => ({ session: session(id), title: id, cwd: directory });
function manifest(kind: HarnessKind): HarnessManifest {
  const core = Object.fromEntries(Object.keys(CORE_OPERATIONS).map((name) => [name, name === 'listSessionPage' ? { state: 'supported' } : unsupported('fixture')]));
  return { environmentId, harnessInstanceId, kind, protocolVersion: 1, core: core as Record<CoreOperation, HarnessManifest['core'][CoreOperation]>, extensions: [], capabilities: {} };
}
async function fixture(list: (context: HarnessContext) => Promise<unknown>, run: (value: {
  index: ReturnType<typeof createSessionIndex>; store: ReturnType<typeof createRuntimeStore>; directories: string[]; generation: { value: number };
}) => Promise<void>, kind: HarnessKind = 'codex') {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-index-'));
  const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch });
  const registry = createHarnessRegistry();
  registry.register({ manifest: manifest(kind), driver: { core: { listSessionPage: list }, native: {} } });
  const directories: string[] = [];
  const generation = { value: 1 };
  const index = createSessionIndex({ store, registry, catalog: {
    async register({ workspace }) {
      const key = encodeWorkspaceKey(workspace);
      const prior = await store.get({ collection: 'workspaces', key });
      await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'workspaces', key, expectedRevision: prior?.revision ?? 0, value: { workspace } }] });
      return key;
    },
    page: (input = {}) => store.page({ ...input, collection: 'workspaces' }),
    async probe() { throw new Error('background Git probe'); },
  }, resolveWorkspace: async ({ directory: canonicalPath }) => {
    directories.push(canonicalPath);
    return { environmentId, canonicalPath, pathPolicy: { platform: 'posix', caseSensitive: true, volumeId: 'test-volume' } };
  } });
  try { await store.ready; await run({ index, store, directories, generation }); }
  finally { await index.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
}

describe('progressive native summary index', () => {
  it('publishes each page and newly discovered directories before enumeration finishes', async () => {
    let page = 0;
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await fixture(async ({ params }) => {
      page++;
      expect(params).toEqual({ cursor: page === 1 ? null : 'native-opaque', limit: 200 });
      if (page === 1) return { items: [row('first')], cursor: 'native-opaque', completeness: 'partial' };
      await hold;
      return { items: [row('second', '/new-directory')], cursor: null, completeness: 'complete' };
    }, async ({ index, store, directories }) => {
      const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: 1 }), subscribe: false });
      const work = source.discover();
      try {
        await expect.poll(async () => (await index.page()).items.length).toBe(1);
        expect((await index.topology({ collection: 'workspaces' })).items).toHaveLength(1);
        release();
        expect(await work).toMatchObject({ status: 'complete', count: 2 });
        expect(directories).toEqual(['/repo', '/new-directory']);
        expect((await store.get({ collection: 'session_summaries', key: encodeSessionKey(session('second')) }))?.value).toMatchObject({ title: 'second', directory: '/new-directory' });
      } finally { release(); await work; }
    });
  });
  it('keeps ACP partial-null cursor honest and never deletes missing cached summaries', async () => {
    await fixture(async () => ({ items: [], cursor: null, status: 'partial', reason: 'native_session_list_bounded', epoch, processGeneration: 1 }), async ({ index, store }) => {
      const key = encodeSessionKey(session('cached'));
      await store.mutate({ intentId: 'cached', changes: [{ collection: 'session_summaries', key, value: { session: session('cached'), directory: '/repo' } }] });
      const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: 1 }), subscribe: false });
      expect(await source.discover()).toMatchObject({ status: 'partial', reason: 'native_session_list_bounded' });
      expect((await store.get({ collection: 'session_summaries', key }))?.value).not.toBeNull();
    }, 'acp');
  });
  it('deletes absent rows only in the completed scope and keeps other scopes', async () => {
    await fixture(async () => ({ items: [row('present')], cursor: null, completeness: 'complete' }), async ({ index, store }) => {
      await store.mutate({ intentId: 'seed', changes: ['missing', 'other'].map((id) => ({ collection: 'session_summaries', key: encodeSessionKey(session(id)), value: { session: session(id), title: id, directory: id === 'other' ? '/other' : '/repo' } })) });
      const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: 1 }), subscribe: false });
      expect(await source.discover({ scope: { directory: '/repo' } })).toMatchObject({ status: 'complete', count: 1 });
      expect((await store.get({ collection: 'session_summaries', key: encodeSessionKey(session('missing')) }))?.value).toBeNull();
      expect((await store.get({ collection: 'session_summaries', key: encodeSessionKey(session('other')) }))?.value).toMatchObject({ title: 'other' });
    });
  });
  it('fences a page from the old process generation and completes the same round after restart', async () => {
    let calls = 0;
    let change = () => {};
    await fixture(async () => {
      calls++;
      if (calls === 1) change();
      return { items: [row(calls === 1 ? 'old' : 'new')], cursor: null, completeness: 'complete' };
    }, async ({ index, generation }) => {
      change = () => { generation.value++; };
      const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: generation.value }), subscribe: false });
      expect(await source.discover()).toMatchObject({ status: 'complete', count: 1, authority: { processGeneration: 2 } });
      expect((await index.page()).items.map((item) => item.key)).toEqual([encodeSessionKey(session('new'))]);
      expect(calls).toBe(2);
    });
  });
  it('normalizes the five real adapter shapes without copying transcripts or source blobs', () => {
    const inputs: Record<HarnessKind, unknown> = {
      codex: { ...row('same'), source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } }, transcript: 'secret' },
      opencode: { session: session('same'), summary: { id: 'same', directory: '/repo', title: 'same', parentID: 'parent', time: { created: 1, updated: 2 } } },
      acp: { session: session('same'), native: { sessionId: 'same', cwd: '/repo', title: 'same' } },
      'kimi-web': { session: session('same'), directory: '/repo', title: 'same', nativeWorkspaceId: 'ws' },
      dsh: { session: session('same'), directory: '/repo', title: 'same', workspaceId: 'ws', pinned: true },
    };
    for (const kind of Object.keys(inputs) as HarnessKind[]) {
      const page = nativePage(sourceIdentity({ kind, environmentId, harnessInstanceId }), { items: [inputs[kind]], cursor: null, ...(kind === 'acp' ? { status: 'complete' } : { completeness: 'complete' }) });
      expect(page.items[0]).toMatchObject({ session: session('same'), directory: '/repo', title: 'same' });
      expect(page.items[0]).not.toHaveProperty('transcript');
      expect(page.items[0]).not.toHaveProperty('source');
    }
  });
  it('keeps an explicit native deletion ahead of the already captured old page', async () => {
    let captured: () => void = () => {};
    const entered = new Promise<void>((resolve) => { captured = resolve; });
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let inventory = [row('deleted')];
    let calls = 0;
    await fixture(async () => {
      const items = [...inventory];
      if (++calls === 1) { captured(); await hold; }
      return { items, cursor: null, completeness: 'complete' };
    }, async ({ index, store }) => {
      const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: 1 }), subscribe: false });
      const work = source.discover();
      try {
        await entered;
        inventory = [];
        expect(source.publish({ type: 'thread/deleted', session: session('deleted'), epoch, processGeneration: 1 })).toBe(true);
        await source.flush();
        release();
        expect(await work).toMatchObject({ status: 'complete', count: 0 });
        const tombstone = await store.get({ collection: 'session_summaries', key: encodeSessionKey(session('deleted')) });
        expect(tombstone?.value).toBeNull();
        expect(tombstone?.revision).toBeGreaterThan(0);
        expect(calls).toBeGreaterThanOrEqual(2);
      } finally { release(); await work; }
    });
  });
  it('counts duplicate cross-page identities once and rejects a cycling native cursor', async () => {
    let calls = 0;
    await fixture(async () => {
      calls++;
      return { items: [row('same')], cursor: 'repeated', completeness: 'partial' };
    }, async ({ index }) => {
      const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: 1 }), subscribe: false });
      expect(await source.discover()).toMatchObject({ status: 'partial', count: 1, reason: 'index_cursor_cycle' });
      expect(calls).toBe(2);
      expect((await index.page()).items).toHaveLength(1);
    });
  });
  it('does not interpret a native sequence as the durable store sequence', async () => {
    await fixture(async () => ({ items: [], cursor: null, completeness: 'complete' }), async ({ index, store }) => {
      const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: 1 }), subscribe: false });
      const update = { type: 'session.updated', session: session('event'), summary: { directory: '/repo', title: 'latest', time: {} }, epoch, processGeneration: 1, seq: 1000000 };
      expect(source.publish(update)).toBe(true);
      await source.flush();
      expect(source.publish({ ...update, seq: 999999, summary: { directory: '/repo', title: 'stale', time: {} } })).toBe(false);
      expect((await store.get({ collection: 'session_summaries', key: encodeSessionKey(session('event')) }))?.value).toMatchObject({ title: 'latest' });
      expect((await store.inspect()).seq).toBeLessThan(1000000);
      expect(source.state.intake.sequence).toBe(1000000);
    }, 'opencode');
  });
  it('uses the installed Kimi full-summary page limit of100', async () => {
    await fixture(async ({ params }) => {
      expect(params).toEqual({ cursor: null, limit: 100 });
      return { items: [{ session: session('kimi'), title: 'kimi', directory: '/repo' }], cursor: null, completeness: 'complete' };
    }, async ({ index }) => {
      const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: 1 }), subscribe: false });
      expect(await source.discover()).toMatchObject({ status: 'complete', count: 1 });
    }, 'kimi-web');
  });
  it('bounds a stalled native producer by4MiB while reserved control notifications progress', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let controls = 0;
    const failures: string[] = [];
    const intake = createNativeEventIntake({
      source: { identity: sourceIdentity({ kind: 'opencode', environmentId, harnessInstanceId }), authority: () => ({ epoch, processGeneration: 1 }), serial: () => 0, assertCurrent() {}, async list() { throw new Error('unexpected list'); } },
      mutations: { async apply() { throw new Error('unexpected page'); }, async complete() { throw new Error('unexpected complete'); }, async progress() { throw new Error('unexpected progress'); }, async event() { await hold; return true; } },
      dirty() {}, onControl() { controls++; }, onFailure(reason) { failures.push(reason); },
    });
    try {
      for (let sequence = 1; sequence <= 300; sequence++) intake.publish({ type: 'session.updated', seq: sequence, epoch, processGeneration: 1, session: session(String(sequence)), summary: { title: 'x'.repeat(8192), directory: `/${'a'.repeat(16382)}` } });
      expect(intake.state.bytes).toBeLessThanOrEqual(4194304);
      expect(intake.state.bytes).toBeGreaterThan(4000000);
      expect(intake.state.count).toBeLessThanOrEqual(256);
      expect(failures).toContain('replay_required');
      expect(intake.publish({ type: 'permission.asked', seq: 301, epoch, processGeneration: 1 })).toBe(true);
      expect(controls).toBe(1);
      expect(intake.publish({ type: 'permission.asked', seq: 302, epoch, processGeneration: 1, payload: 'x'.repeat(1048576) })).toBe(false);
      expect(controls).toBe(1);
      release(); await intake.flush();
      expect(intake.state).toMatchObject({ count: 0, bytes: 0 });
    } finally { release(); await intake.close(); }
  });
});
