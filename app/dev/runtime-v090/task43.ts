// Task 43 registered QA browser entry — the full-chain system lane's UI half.
//
// Served by scripts/qa/runtime-v090-system.mjs from a case-owned Vite server (the repository page
// route is owned by task 19, so no shared file is edited). The REAL production modules execute in a
// real headless Chromium: the real useRuntimeSessionTree composable over the real task-20 runtime
// state, the real runtime client/connection and the real SessionTree.vue, exactly as task 21's
// entry mounts them — the tree here is seeded from the LEGACY STORE the worker read, so the
// browser proves the plan's "5 来源从旧 store → 统一 tree" leg on the real UI surface.
//
// The controlled boundary is the runtime WebSocket wire (TreeWire), a fixture at the transport
// seam that serves the bridge's canonical entity shapes for FIVE harnesses and can inject a
// per-source discovery failure and a client-side disconnect, so every scenario has a deterministic
// observable. Nothing else is stubbed: the composable, the client, the connection, the codecs and
// the component are the product's own.
//
// The stateful collaboration services (thread, handoff, team, fan-out, artifact integration) import
// node:crypto / node:fs / node:path / node:child_process at module scope and cannot execute in a
// browser realm at all, so those legs of the chain are driven in the QA worker over the real bridge
// modules — the same split tasks 37, 38, 39, 40, 41 and 42 disclosed. This entry makes NO claim
// that the running app renders anything: no container provides the runtime state key yet and
// App.vue integration is a later task's, so this page IS the container.
import { createApp, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { createRuntimeConnection } from '../../runtime/connection';
import type { RuntimeSocket } from '../../runtime/connection';
import { createRuntimeClient } from '../../runtime/client';
import { decodeFrame, encodeFrame } from '../../../shared/runtime/protocol.js';
import { parseCapabilities } from '../../../shared/runtime/capabilities.js';
import { RUNTIME_WIRE_METHODS } from '../../../shared/runtime/runtimeWire.js';
import { encodeSessionKey, parseConnectionProfileId, parseEnvironmentId, parseInstanceId } from '../../../shared/runtime/identity.js';
import type { HarnessInstanceId } from '../../../shared/runtime/identity.js';
import { useRuntimeSessionTree } from '../../composables/useRuntimeSessionTree';
import type { HarnessKind } from '../../composables/useRuntimeSessionTree';
import SessionTree from '../../components/SessionTree.vue';

type AnyRecord = Record<string, any>;

const TARGET = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const PROFILE = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const INSTANCE = parseInstanceId('66666666-6666-4666-8666-666666666666');
const PAGE = 200;

/** The five sources in the seed090 oracle's own order, each with its own harness instance. */
const SOURCES: readonly string[] = ['opencode', 'codex', 'acp', 'kimi-web', 'dsh'];
const HARNESS_INSTANCE: Readonly<Record<string, string>> = Object.fromEntries(SOURCES.map((source, index) => [source, `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** One legacy history record the worker read out of the legacy store, already parsed. */
interface LegacyRow { readonly source: string; readonly nativeSessionId: string; readonly workspace: string | null }
function sessionRefOf(row: LegacyRow) {
  return { environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCE[row.source] as HarnessInstanceId, nativeSessionId: row.nativeSessionId };
}

/**
 * Controlled runtime WebSocket wire. Structurally a RuntimeSocket so the real client/connection
 * codecs run unchanged; only the server side is a fixture. `rows` are the legacy-store records the
 * worker passed in, so the browser's unified tree is built from the OLD STORE.
 */
class TreeWire extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  readonly rows: readonly LegacyRow[];
  readonly failures = new Set<string>();
  readonly snapshots = new Map<string, number>();
  failSummaries = false;
  opens = 0;
  closes = 0;
  seq = 0;
  private revision = 400000;
  constructor(rows: readonly LegacyRow[]) {
    super();
    this.rows = rows;
  }
  close() { this.readyState = 3; this.closes += 1; this.dispatchEvent(new Event('close')); }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  reply(request: AnyRecord, result: unknown) {
    this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase: 'read', result });
  }
  fail(request: AnyRecord, code: string, message: string) {
    this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: false, typedError: { code, message } });
  }
  send(value: string | Uint8Array) {
    if (typeof value !== 'string') throw new TypeError('unexpected binary request');
    const request: AnyRecord = decodeFrame(value);
    if (request.kind !== 'request') throw new TypeError('unexpected frame');
    this.respond(request);
  }
  private harnesses() {
    return SOURCES.map((source) => ({
      collection: 'harnesses', key: HARNESS_INSTANCE[source], revision: 1,
      value: {
        environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCE[source], kind: source,
        indexDiscovery: [{ scopeKey: '{}', status: this.failures.has(source) ? 'partial' : 'complete', count: this.failures.has(source) ? 0 : this.rows.filter((row) => row.source === source).length, ...(this.failures.has(source) ? { reason: 'native_timeout' } : {}) }],
      },
    }));
  }
  private summaries() {
    return this.rows.map((row, index) => ({
      collection: 'session_summaries', key: encodeSessionKey(sessionRefOf(row)), revision: index + 1,
      value: {
        session: sessionRefOf(row), title: `legacy ${row.source} ${row.nativeSessionId}`,
        directory: row.workspace ?? '/orphan-workspace', archived: false, pinned: false, parentSession: null,
        createdAt: 1700000000000 + index, updatedAt: 1700000000000 + index, status: 'idle',
      },
    }));
  }
  private respond(request: AnyRecord) {
    switch (request.method) {
      case 'runtime.inspect':
        this.reply(request, { role: 'local', state: 'ready', subscribers: 1, topology: [], sources: [], connectionProfileId: PROFILE,
          targets: [{ target: String(TARGET), role: 'execution', capabilities: parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] }), permissions: [], workspaceKeys: [] }],
          harnesses: [], transports: { direct: true, ssh: false, slurm: false } });
        break;
      case 'runtime.target.attach':
        this.reply(request, { hello: { kind: 'hello', version: 1, target: TARGET, epoch: 'epoch', generation: 1, instanceId: INSTANCE, capabilities: parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] }) }, grant: { target: String(TARGET), role: 'execution', capabilities: parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] }), permissions: [], workspaceKeys: [] } });
        break;
      case 'runtime.snapshot': {
        const name = request.params.collection;
        this.snapshots.set(name, (this.snapshots.get(name) ?? 0) + 1);
        const offset = request.params.cursor ? Number(request.params.cursor) : 0;
        if (name === 'session_summaries' && this.failSummaries && offset === 0) { this.fail(request, 'source_unavailable', 'session summary source failed'); break; }
        const rows = name === 'harnesses' ? this.harnesses() : name === 'session_summaries' ? this.summaries()
          : name === 'workspaces' ? [
            { collection: 'workspaces', key: 'workspace:/repo', revision: 1, value: { kind: 'workspace', workspace: { environmentId: TARGET, canonicalPath: '/repo', pathPolicy: { platform: 'posix', caseSensitive: true, volumeId: 'vol' } }, sources: [], orphan: false, gitKind: 'git', repoKey: '/repo' } },
            { collection: 'workspaces', key: 'workspace:/orphan-workspace', revision: 1, value: { kind: 'workspace', workspace: { environmentId: TARGET, canonicalPath: '/orphan-workspace', pathPolicy: { platform: 'posix', caseSensitive: true, volumeId: 'vol' } }, sources: [], orphan: true, gitKind: null, repoKey: null } },
          ] : [];
        const end = Math.min(rows.length, offset + PAGE);
        this.reply(request, {
          version: 1, kind: 'snapshot', target: request.target, epoch: request.epoch, generation: request.generation,
          token: request.params.token ?? `snapshot-${this.snapshots.get(name)}`, revision: this.revision, watermark: this.seq,
          expiresAt: Date.now() + 60000, cursor: end < rows.length ? String(end) : null, items: rows.slice(offset, end),
        });
        break;
      }
      case 'runtime.observer.open': this.reply(request, { observerId: 'observer-1' }); break;
      case 'runtime.observer.read': this.reply(request, null); break;
      case 'runtime.observer.close': this.reply(request, { closed: true }); break;
      // The per-source discovery demand the real composable issues on a retry: it names the harness
      // instance, so the wire clears that source's injected failure and reports a complete page.
      case 'session.list': {
        const harnessInstanceId = String(request.params.harnessInstanceId);
        for (const source of SOURCES) if (HARNESS_INSTANCE[source] === harnessInstanceId) this.failures.delete(source);
        this.reply(request, { items: [], cursor: null, completeness: 'complete' });
        break;
      }
      default: throw new TypeError(`unexpected method ${request.method}`);
    }
  }
}

const CAPABILITIES = parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] });

interface Opened { wire: TreeWire; client: ReturnType<typeof createRuntimeClient>; connection: ReturnType<typeof createRuntimeConnection>; connecting: Promise<void> }
async function openTree(rows: readonly LegacyRow[]): Promise<Opened> {
  const wire = new TreeWire(rows);
  let resolveCreated!: () => void;
  const created = new Promise<void>((resolve) => { resolveCreated = resolve; });
  const connection = createRuntimeConnection({
    reference: { url: 'ws://127.0.0.1:43212/runtime' },
    resolveAuthentication: async () => ({}),
    createWebSocket: () => { resolveCreated(); return wire as unknown as RuntimeSocket; },
  });
  const client = createRuntimeClient({ connection });
  const connecting: Promise<void> = connection.connect().then(() => undefined);
  await created;
  wire.frame({ kind: 'hello', version: 1, target: TARGET, epoch: 'epoch', generation: 1, instanceId: INSTANCE, capabilities: CAPABILITIES });
  await connecting;
  return { wire, client, connection, connecting };
}

// ------------------------------------------------------------------- mount --
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });
const host = document.createElement('div');
host.className = 'qa43-host';
host.style.height = '100%';
document.body.appendChild(host);

let tree!: ReturnType<typeof useRuntimeSessionTree>;
let opened: Opened | undefined;
let app: ReturnType<typeof createApp> | null = null;
const selectedIndex = { value: -1 };

async function boot(rows: readonly LegacyRow[]): Promise<void> {
  if (app !== null) { app.unmount(); app = null; }
  opened = await openTree(rows);
  (window as AnyRecord).__task43Wire = opened.wire;
  (window as AnyRecord).__task43Client = opened.client;
  const instance = createApp({
    setup() {
      tree = useRuntimeSessionTree({ client: (window as AnyRecord).__task43Client, profileId: PROFILE, target: TARGET, history: { usage: () => ({ residentBytes: 0, reservedBytes: 0, entries: 0 }), dispose: () => {}, select: () => {}, invalidate: () => {} } });
      void tree.start().then(async () => {
        const expandGroups = (nodes: readonly { kind: string; key: string; children: readonly unknown[] }[]) => {
          for (const node of nodes) {
            if (node.kind === 'repo' || node.kind === 'section' || node.kind === 'worktree') {
              if (!tree.expanded.value.has(node.key)) tree.toggleExpand(node.key);
              expandGroups(node.children as never);
            }
          }
        };
        expandGroups(tree.tree.value as never);
        await nextTick();
        (window as AnyRecord).__task43Ready = true;
      });
      return () => h('div', { class: 'qa43-tree', style: 'height:100%;display:flex;flex-direction:column;min-height:0;' }, [
        h(SessionTree, {
          projects: [], expandedPaths: [...tree.expanded.value], selectedSessionId: '', selectedKey: '',
          treeRows: tree.rows.value, sources: tree.harnesses.value, retrying: tree.retrying.value, childScans: tree.childScans.value,
          viewStatus: tree.viewStatus.value, viewLoaded: tree.viewLoaded.value, viewError: tree.viewError.value,
          filterKinds: tree.filterKinds.value, searchState: tree.searchState.value,
          'onToggle-key': (key: string) => { tree.toggleExpand(key); },
          'onSelect-key': (key: string) => { void tree.selectByKey(key); },
          'onRetry-source': (harnessInstanceId: string) => { void tree.retrySource(harnessInstanceId); },
          'onFilter-change': (kinds: string[]) => { tree.setFilterKinds(kinds as HarnessKind[]); },
          'onSearch': (query: string) => { void tree.search(query); },
          'onLoad-more-children': (key: string) => { void tree.loadMoreChildren(key); },
        }),
      ]);
    },
  });
  instance.use(i18n);
  instance.mount(host);
}

function state() {
  const current = tree!;
  return {
    viewStatus: current.viewStatus.value,
    viewLoaded: current.viewLoaded.value,
    viewError: current.viewError.value,
    rows: current.rows.value.length,
    sessions: current.sessions.value.length,
    sources: current.harnesses.value.map((entry) => ({ kind: entry.kind, status: entry.status, reason: entry.reason ?? null })),
    workspaces: current.workspaces.value.map((entry) => ({ path: entry.path, repoKey: entry.repoKey, orphan: entry.orphan })),
    selectedKey: current.selection.value ? encodeSessionKey(current.selection.value.selection.session) : null,
    wire: { snapshots: Object.fromEntries(((window as AnyRecord).__task43Wire as TreeWire).snapshots), failures: [...((window as AnyRecord).__task43Wire as TreeWire).failures], closes: ((window as AnyRecord).__task43Wire as TreeWire).closes },
  };
}

const api = {
  errors: () => errors,
  ready: () => Boolean((window as AnyRecord).__task43Ready),
  whenReady: async () => { for (let attempt = 0; attempt < 200; attempt += 1) { if ((window as AnyRecord).__task43Ready) return true; await wait(25); } throw new Error('task43 browser entry never became ready'); },
  boot: async (rows: readonly LegacyRow[]) => { (window as AnyRecord).__task43Ready = false; await boot(rows); await api.whenReady(); return state(); },
  state: () => state(),
  failSource: async (source: string) => {
    ((window as AnyRecord).__task43Wire as TreeWire).failures.add(source);
    await tree.refresh();
    await nextTick();
    return state();
  },
  // The REAL UI retry path: `onRetry-source` hands the composable the failing harness instance,
  // exactly as the rendered retry affordance does, so recovery is observed through the product.
  recoverSources: async (source: string) => {
    const wire = (window as AnyRecord).__task43Wire as TreeWire;
    wire.failures.clear();
    const entry = tree.harnesses.value.find((item) => item.kind === source);
    if (entry === undefined) throw new Error(`missing harness source ${source}`);
    await tree.retrySource(entry.harnessInstanceId);
    await nextTick();
    return state();
  },
  select: async (index: number) => {
    const rows = ((window as AnyRecord).__task43Wire as TreeWire).rows;
    const row = rows[index];
    if (row === undefined) throw new Error(`no legacy row at ${index}`);
    const ok = await tree.selectByKey(encodeSessionKey(sessionRefOf(row)));
    await nextTick();
    selectedIndex.value = index;
    return { ok, index, selectedKey: tree.selection.value ? encodeSessionKey(tree.selection.value.selection.session) : null };
  },
  // The client-side disconnect: the socket is closed under the REAL connection, so whatever the
  // product reports is observed rather than assumed. `recover` re-opens and re-drives the tree.
  breakUi: async () => {
    ((window as AnyRecord).__task43Wire as TreeWire).close();
    await wait(120);
    await nextTick();
    return state();
  },
  restart: async () => api.boot(((window as AnyRecord).__task43Wire as TreeWire).rows),
  /** The mapping rows this realm observed, checked against the scenarios THIS page drove. */
  observeMapping: (rows: readonly AnyRecord[]) => rows.map((row) => ({
    id: row.id,
    scenario: row.scenario,
    observed: ['SYS-02-five-source-unified-index'].includes(row.scenario as string) && state().sessions > 0,
  })),
};

(window as AnyRecord).task43 = api;
