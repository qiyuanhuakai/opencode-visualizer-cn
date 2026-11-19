import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createWorkspaceCatalog } from '../../../bridge/runtime/workspaceCatalog.js';
import { createSessionIndex } from '../../../bridge/runtime/sessionIndex.js';
import { createHarnessRegistry, CORE_OPERATIONS, unsupported } from '../../../shared/runtime/harnessContract.js';
import { parseSessionRef } from '../../../shared/runtime/identity.js';

export const environmentId = '11111111-1111-4111-8111-111111111111';
export const epoch = '33333333-3333-4333-8333-333333333333';
export function harnessId(number) { return `22222222-2222-4222-8222-${String(number).padStart(12, '0')}`; }
export function deferred() { let resolve; const promise = new Promise((accept) => { resolve = accept; }); return { promise, resolve }; }
export async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) { assert(Date.now() < deadline, `deadline:${label}`); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
export function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
export function inspectSql(directory) {
  const database = new DatabaseSync(path.join(directory, 'runtime/runtime.db'), { readOnly: true });
  try {
    const rows = (collection) => database.prepare(`SELECT key,revision,value FROM ${collection} ORDER BY key`).all().map((row) => ({ ...row, value: JSON.parse(row.value) }));
    return { integrity: database.prepare('PRAGMA integrity_check').get().integrity_check, summaries: rows('session_summaries'), workspaces: rows('workspaces'), harnesses: rows('harnesses'), interactions: rows('interactions'), operations: rows('operations'), events: database.prepare('SELECT seq,revision,payload FROM runtime_events ORDER BY seq').all().map((row) => ({ ...row, payload: JSON.parse(row.payload) })) };
  } finally { database.close(); }
}
export async function createIndexFixture({ root, name, register, raw }) {
  const directory = path.join(root, name);
  register({ kind: 'task18-private-state-and-workspaces', directory, teardown: 'close index/native subscriptions/store; PID absence; runner removes owned root' });
  await mkdir(directory, { recursive: true });
  const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch });
  await store.ready;
  register({ kind: 'task18-runtime-worker', pid: store.pid, directory, teardown: 'store.close then kill-zero absence' });
  const registry = createHarnessRegistry();
  const probes = [];
  const catalog = createWorkspaceCatalog({ store, git: { async probe(workspace) { probes.push(workspace); return { kind: 'non-git', workspace }; } } });
  const index = createSessionIndex({ store, registry, catalog, resolveWorkspace: async ({ source, directory: nativeDirectory }) => {
    const canonicalPath = await realpath(nativeDirectory);
    assert(canonicalPath.startsWith(`${directory}${path.sep}`), 'QA target resolver rejects directories outside owned root');
    return { environmentId: source.environmentId, canonicalPath, pathPolicy: { platform: 'posix', caseSensitive: true, volumeId: 'qa-owned-volume' } };
  } });
  const sources = [];
  async function workspace(name) {
    const target = path.join(directory, name);
    register({ kind: 'task18-native-directory', directory: target, teardown: 'runner removes owned root' });
    await mkdir(target, { recursive: true });
    return target;
  }
  async function addSource(number, options = {}) {
    const harnessInstanceId = harnessId(number);
    const identity = { environmentId, harnessInstanceId };
    const state = { generation: 1, rows: [], calls: [], beforeReturn: undefined, completeness: 'complete', reason: 'native_exhausted', ...options };
    const manifest = { ...identity, kind: 'codex', protocolVersion: 1, core: Object.fromEntries(Object.keys(CORE_OPERATIONS).map((name) => [name, name === 'listSessionPage' ? { state: 'supported' } : unsupported('controlled summary-only source')])), extensions: [], capabilities: {} };
    registry.register({ manifest, driver: { core: { async listSessionPage({ params }) {
      assert.deepEqual(Object.keys(params).sort(), ['cursor', 'limit']);
      const offset = params.cursor === null ? 0 : Number(params.cursor.replace('opaque:', ''));
      assert(Number.isSafeInteger(offset) && offset >= 0);
      state.calls.push({ params, generation: state.generation, at: Date.now() });
      const items = state.rows.slice(offset, offset + params.limit);
      const cursor = offset + items.length < state.rows.length ? `opaque:${offset + items.length}` : null;
      await state.beforeReturn?.({ params, items, cursor });
      return { items, cursor, completeness: state.completeness, reason: state.reason };
    } }, native: {} } });
    const source = await index.attach({ harnessInstanceId, authority: () => ({ epoch, processGeneration: state.generation }), subscribe: false });
    sources.push(source);
    return { source, state, identity, row(id, cwd, extra = {}) { return { session: parseSessionRef({ ...identity, nativeSessionId: id }), title: id, cwd, ...extra }; } };
  }
  let closed = false;
  return { directory, store, index, registry, catalog, probes, workspace, addSource,
    sql() { const value = inspectSql(directory); raw.sql.push(value); return value; },
    async close() {
      if (closed) return;
      closed = true;
      await index.close();
      const exit = await store.close();
      const result = { kind: 'task18-runtime-worker', ...exit, pidAbsent: !alive(exit.pid), observers: index.state.events.observers, sources: index.state.sources, scheduler: index.state.scheduler };
      raw.cleanup.push(result);
      assert(result.pidAbsent && result.observers === 0 && result.sources === 0, 'owned resources absent');
      return result;
    },
  };
}
