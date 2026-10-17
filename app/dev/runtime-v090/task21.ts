// Task 21 registered QA browser entry — unified virtualizable session tree.
//
// Loaded by scripts/qa/runtime-v090-cases/task-21.mjs from a runner-served page
// (the repository page route is owned by task 19; this entry is served by the
// task-21 runner so no shared file is edited). The REAL production modules
// execute in a real headless Chromium: the real useRuntimeSessionTree
// composable over the REAL task-20 runtime state (state.ts/entityCache.ts/
// selectionScope.ts), the real runtime client/connection, and the real
// SessionTree.vue / HarnessBadge.vue / DiscoveryStatus.vue components.
//
// The only controlled boundary is the runtime WebSocket wire (TreeWire): a
// fixture at the transport seam that serves the bridge's canonical entity
// shapes (five harnesses, a git repo workspace plus an orphan workspace, and a
// 10k-session index) and can inject per-source discovery failures, session
// deletions and summary-snapshot failures so every registered scenario has a
// deterministic observable.
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
const HARNESS_INSTANCES: Readonly<Record<HarnessKind, string>> = {
  opencode: '10000000-0000-4000-8000-000000000001',
  codex: '10000000-0000-4000-8000-000000000002',
  'kimi-web': '10000000-0000-4000-8000-000000000003',
  dsh: '10000000-0000-4000-8000-000000000004',
  acp: '10000000-0000-4000-8000-000000000005',
};
const HARNESS_ORDER: readonly HarnessKind[] = ['opencode', 'codex', 'kimi-web', 'dsh', 'acp'];
const DIRECTORY = '/repo';
const REPO_KEY = '/repo';
const ORPHAN_DIRECTORY = '/orphan-workspace';
const PAGE = 200;

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && event.reason.message) || event.reason)}`); });
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function harnessOf(index: number): HarnessKind { return HARNESS_ORDER[index % HARNESS_ORDER.length]!; }
function sessionRef(index: number) {
  return { environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCES[harnessOf(index)] as HarnessInstanceId, nativeSessionId: `session-${index}` };
}
function sessionKeyOf(index: number): string { return encodeSessionKey(sessionRef(index)); }

const SPECIAL = Object.freeze({
  archived: 3,
  global: 4,
  orphan: 5,
  longTitle: 6,
  hostWithChildren: 0,
  secondHostWithChildren: 1,
  unparentedNative: 199,
});

function summary(index: number): AnyRecord {
  const base: AnyRecord = {
    session: sessionRef(index),
    title: index === SPECIAL.longTitle
      ? `overflow-${'x'.repeat(400)}-${index}`
      : index === SPECIAL.unparentedNative ? `orphan-native-${index}` : `title-${index}`,
    directory: index === SPECIAL.global ? null : index === SPECIAL.orphan ? ORPHAN_DIRECTORY : DIRECTORY,
    archived: index === SPECIAL.archived,
    pinned: false,
    parentSession: null,
    createdAt: 1700000000000 + index,
    updatedAt: 1700000000000 + index,
    status: index % 4 === 0 ? 'busy' : 'idle',
  };
  if (index === SPECIAL.hostWithChildren || index === SPECIAL.secondHostWithChildren) {
    base.parentSession = null;
  }
  if (index === 10 || index === 11) base.parentSession = { environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCES[harnessOf(SPECIAL.hostWithChildren)], nativeSessionId: `session-${SPECIAL.hostWithChildren}` };
  if (index === 12) base.parentSession = { environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCES[harnessOf(SPECIAL.secondHostWithChildren)], nativeSessionId: `session-${SPECIAL.secondHostWithChildren}` };
  if (index === SPECIAL.unparentedNative) base.parentSession = { environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCES.acp, nativeSessionId: 'session-absent-host' };
  return base;
}

// Controlled runtime WebSocket wire. Structurally a RuntimeSocket so the real
// client/connection codecs run unchanged; only the server side is a fixture.
class TreeWire extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  readonly methods = new Map<string, number>();
  readonly canonical = new Map<string, AnyRecord | null>();
  readonly deliveries: Array<AnyRecord | null> = [];
  readonly failures = new Set<HarnessKind>();
  readonly deleted = new Set<string>();
  readonly listCalls = new Map<string, number>();
  readonly snapshots = new Map<string, number>();
  failSummaries = false;
  creates = 0;
  opened = 0;
  closed = 0;
  seq = 0;
  private revision = 300000;
  constructor(readonly count: number) {
    super();
    for (const kind of HARNESS_ORDER) {
      this.canonical.set(`harness:${kind}`, {
        environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCES[kind], kind,
        indexDiscovery: [{ scopeKey: '{}', status: 'complete', count: this.count }],
      });
    }
    for (let index = 0; index < this.count * HARNESS_ORDER.length; index += 1) {
      this.canonical.set(sessionKeyOf(index), summary(index));
    }
  }
  close() { this.readyState = 3; }
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
    this.methods.set(request.method, (this.methods.get(request.method) ?? 0) + 1);
    this.respond(request);
  }
  rowsOf(collection: string): AnyRecord[] {
    if (collection === 'harnesses') {
      return HARNESS_ORDER.map((kind) => ({
        collection: 'harnesses', key: HARNESS_INSTANCES[kind], revision: 1,
        value: this.failures.has(kind)
          ? { environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCES[kind], kind, indexDiscovery: [{ scopeKey: '{}', status: 'partial', count: 0, reason: 'native_timeout' }] }
          : this.canonical.get(`harness:${kind}`),
      }));
    }
    if (collection === 'workspaces') {
      return [
        { collection: 'workspaces', key: 'workspace:/repo', revision: 1, value: { kind: 'workspace', workspace: { environmentId: TARGET, canonicalPath: DIRECTORY, pathPolicy: { platform: 'posix', caseSensitive: true, volumeId: 'vol' } }, sources: [], orphan: false, gitKind: 'git', repoKey: REPO_KEY } },
        { collection: 'workspaces', key: 'workspace:/orphan-workspace', revision: 1, value: { kind: 'workspace', workspace: { environmentId: TARGET, canonicalPath: ORPHAN_DIRECTORY, pathPolicy: { platform: 'posix', caseSensitive: true, volumeId: 'vol' } }, sources: [], orphan: true, gitKind: null, repoKey: null } },
      ];
    }
    if (collection === 'session_summaries') {
      const rows: AnyRecord[] = [];
      for (let index = 0; index < this.count * HARNESS_ORDER.length; index += 1) {
        const key = sessionKeyOf(index);
        if (this.deleted.has(key)) continue;
        rows.push({ collection: 'session_summaries', key, revision: index + 1, value: this.canonical.get(key) });
      }
      return rows;
    }
    return [];
  }
  deleteSession(index: number): string {
    const key = sessionKeyOf(index);
    this.deleted.add(key);
    this.seq += 1;
    this.revision += 1;
    const value = this.canonical.get(key);
    this.canonical.set(key, value === undefined ? null : { ...value });
    this.deliveries.push({ kind: 'event', frame: { version: 1, kind: 'event', target: TARGET, epoch: 'epoch', generation: 1, seq: this.seq, entityRevision: this.revision, scope: key, type: 'entity.patch', payload: { collection: 'session_summaries', key, deleted: true } } });
    return key;
  }
  clearFailures(): void { this.failures.clear(); }
  respond(request: AnyRecord) {
    switch (request.method) {
      case 'runtime.inspect':
        this.reply(request, { role: 'local', state: 'ready', subscribers: 1, topology: [], sources: [], connectionProfileId: String(PROFILE),
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
        if (name === 'session_summaries' && this.failSummaries && offset === 0) {
          this.fail(request, 'source_unavailable', 'session summary source failed');
          break;
        }
        const rows = this.rowsOf(name);
        const end = Math.min(rows.length, offset + PAGE);
        this.reply(request, {
          version: 1, kind: 'snapshot', target: request.target, epoch: request.epoch, generation: request.generation,
          token: request.params.token ?? `snapshot-${this.snapshots.get(name)}`, revision: this.revision, watermark: this.seq,
          expiresAt: Date.now() + 60000, cursor: end < rows.length ? String(end) : null,
          items: rows.slice(offset, end),
        });
        break;
      }
      case 'runtime.observer.open': {
        this.opened += 1;
        this.reply(request, { observerId: `observer-${this.opened}` });
        break;
      }
      case 'runtime.observer.read': this.reply(request, this.deliveries.shift() ?? null); break;
      case 'runtime.observer.close': this.closed += 1; this.reply(request, { closed: true }); break;
      case 'runtime.entity.resolve': {
        const event = request.params.event;
        const key = event?.payload?.key;
        const canonical = this.canonical.get(key);
        if (!canonical) { this.fail(request, 'invalid_request', 'missing canonical row'); break; }
        const tombstone = this.deleted.has(key);
        this.reply(request, { collection: 'session_summaries', key, revision: this.revision, ...(tombstone ? { value: null } : { value: canonical }) });
        break;
      }
      case 'session.list': {
        const harnessInstanceId = String(request.params.harnessInstanceId);
        this.listCalls.set(harnessInstanceId, (this.listCalls.get(harnessInstanceId) ?? 0) + 1);
        const kind = HARNESS_ORDER.find((entry) => HARNESS_INSTANCES[entry] === harnessInstanceId);
        if (kind) this.failures.delete(kind);
        this.reply(request, { items: [], cursor: null, completeness: 'complete' });
        break;
      }
      case 'session.create': this.creates += 1; this.reply(request, { operationId: 'create-1', value: {} }); break;
      default: throw new TypeError(`unexpected method ${request.method}`);
    }
  }
}

const CAPABILITIES = parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] });
void CAPABILITIES;

async function openTree(count: number): Promise<{ wire: TreeWire; client: ReturnType<typeof createRuntimeClient>; connection: ReturnType<typeof createRuntimeConnection> }> {
  const wire = new TreeWire(count);
  let resolveCreated!: () => void;
  const created = new Promise<void>((resolve) => { resolveCreated = resolve; });
  const connection = createRuntimeConnection({
    reference: { url: 'ws://127.0.0.1:43211/runtime' },
    resolveAuthentication: async () => ({}),
    createWebSocket: () => { resolveCreated(); return wire as unknown as RuntimeSocket; },
  });
  const client = createRuntimeClient({ connection });
  const connecting = connection.connect();
  await created;
  wire.frame({ kind: 'hello', version: 1, target: TARGET, epoch: 'epoch', generation: 1, instanceId: INSTANCE, capabilities: CAPABILITIES });
  await connecting;
  return { wire, client, connection };
}

// ------------------------------------------------------------------- mount --
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });
const host = document.createElement('div');
host.className = 'qa21-host';
host.style.height = '100%';
document.body.appendChild(host);

let tree!: ReturnType<typeof useRuntimeSessionTree>;
let releaseStart: () => void = () => {};
const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });

function createHostApp() {
  const instance = createApp({
    setup() {
      tree = useRuntimeSessionTree({ client: (window as AnyRecord).__task21Client, profileId: PROFILE, target: TARGET, history: { usage: () => ({ residentBytes: 0, reservedBytes: 0, entries: 0 }), dispose: () => {}, select: () => {}, invalidate: () => { (window as AnyRecord).__task21SelectionInvalidated = true; } } });
      void startGate.then(async () => {
        await tree.start();
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
        (window as AnyRecord).__task21Ready = true;
      });
      const selectedKey = () => {
        const capture = tree.selection.value;
        return capture ? encodeSessionKey(capture.selection.session) : '';
      };
      return () => h('div', { class: 'qa21-tree', style: 'height:100%;display:flex;flex-direction:column;min-height:0;' }, [
        h(SessionTree, {
          projects: [],
          expandedPaths: [...tree.expanded.value],
          selectedSessionId: '',
          selectedKey: selectedKey(),
          treeRows: tree.rows.value,
          sources: tree.harnesses.value,
          retrying: tree.retrying.value,
          childScans: tree.childScans.value,
          viewStatus: tree.viewStatus.value,
          viewLoaded: tree.viewLoaded.value,
          viewError: tree.viewError.value,
          filterKinds: tree.filterKinds.value,
          searchState: tree.searchState.value,
          indexWaiting: tree.indexWaiting.value,
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
  return instance;
}

function domMetrics() {
  const root = document.querySelector('.qa21-tree') as HTMLElement;
  const rows = [...root.querySelectorAll('[data-tree-row]')] as HTMLElement[];
  const labels = [...root.querySelectorAll('.unified-row-label')] as HTMLElement[];
  let worstOverflow = 0;
  for (const label of labels) worstOverflow = Math.max(worstOverflow, label.scrollWidth - label.clientWidth);
  let worstRowOverflow = 0;
  for (const row of rows) worstRowOverflow = Math.max(worstRowOverflow, row.scrollWidth - row.clientWidth);
  const scroller = root.querySelector('[data-testid="unified-scroll"]') as HTMLElement | null;
  const rowHeight = 28;
  const overscan = 8;
  const expectedVirtualRows = Math.min(rows.length, Math.ceil((scroller?.clientHeight ?? 0) / rowHeight) + overscan * 2);
  return {
    domRows: rows.length,
    expectedVirtualRows,
    rowKeys: rows.map((row) => row.getAttribute('data-row-key')),
    harnessBadges: rows.map((row) => row.getAttribute('data-harness')).filter((value): value is string => Boolean(value)),
    rowKinds: rows.map((row) => row.getAttribute('data-row-kind')),
    worstLabelOverflow: worstOverflow,
    worstRowOverflow,
    scrollerHeight: scroller?.clientHeight ?? 0,
    scrollerScrollHeight: scroller?.scrollHeight ?? 0,
    nestedNativeParents: rows.filter((row) => (row.getAttribute('data-row-key') ?? '').startsWith('native:')).map((row) => (row.getAttribute('data-row-key') ?? '').split(':')[1] ?? ''),
    loadingAffordance: Boolean(root.querySelector('.unified-meta-loading')),
    emptyAffordance: Boolean(root.querySelector('[data-testid="unified-empty"]')),
    errorAffordance: Boolean(root.querySelector('[data-testid="source-view-error"]')),
    retryAffordances: root.querySelectorAll('[data-testid="source-retry"]').length,
    sourceRows: [...root.querySelectorAll('[data-source]')].map((element) => ({ source: element.getAttribute('data-source'), status: element.getAttribute('data-status') })),
    searchSummary: root.querySelector('[data-testid="search-summary"]')?.textContent ?? null,
    searchResults: root.querySelectorAll('[data-testid="search-result"]').length,
    focusedKey: root.querySelector('[data-tree-row][data-focused="true"]')?.getAttribute('data-row-key') ?? null,
    selectedRow: root.querySelector('[data-tree-row][data-selected="true"]')?.getAttribute('data-row-key') ?? null,
    horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
  };
}

const THEME_VARIABLES: Readonly<Record<string, string>> = {
  bg: '--theme-side-bg',
  text: '--theme-side-text',
  border: '--theme-side-border',
  accent: '--theme-side-accent',
  controlBg: '--theme-side-control-bg',
  activeBg: '--theme-side-active-bg',
  activeText: '--theme-side-active-text',
  textMuted: '--theme-side-text-muted',
};
const THEME_SEMANTIC: Readonly<Record<string, string>> = {
  bg: '--theme-surface-panel',
  text: '--theme-text-primary',
  border: '--theme-border-default',
  accent: '--theme-accent-primary',
  controlBg: '--theme-surface-panel-muted',
  activeBg: '--theme-surface-panel-active',
  activeText: '--theme-text-inverse',
  textMuted: '--theme-text-muted',
};
const THEME_DROPDOWN: Readonly<Record<string, string>> = {
  bg: '--theme-dropdown-bg',
  border: '--theme-dropdown-border',
  text: '--theme-dropdown-text',
  textMuted: '--theme-dropdown-text-muted',
  controlBg: '--theme-dropdown-control-bg',
  hoverBg: '--theme-dropdown-hover-bg',
  activeBg: '--theme-dropdown-active-bg',
  accent: '--theme-dropdown-accent',
};

const api = {
  errors: () => errors,
  ready: () => Boolean((window as AnyRecord).__task21Ready),
  releaseStart: () => { releaseStart(); },
  whenReady: async () => { await startGate; for (let attempt = 0; attempt < 200; attempt += 1) { if ((window as AnyRecord).__task21Ready) return true; await wait(25); } throw new Error('task21 browser entry never became ready'); },
  state: () => ({
    viewStatus: tree.viewStatus.value,
    viewLoaded: tree.viewLoaded.value,
    viewError: tree.viewError.value,
    rows: tree.rows.value.length,
    sessions: tree.sessions.value.length,
    sources: tree.harnesses.value.map((entry) => ({ kind: entry.kind, status: entry.status, reason: entry.reason })),
    workspaces: tree.workspaces.value.map((entry) => ({ path: entry.path, repoKey: entry.repoKey, orphan: entry.orphan })),
    selectedKey: tree.selection.value ? encodeSessionKey(tree.selection.value.selection.session) : null,
    expanded: [...tree.expanded.value],
    dom: domMetrics(),
    flatRowKinds: tree.rows.value.map((row) => row.node.kind),
    flatRowKeys: tree.rows.value.map((row) => row.key),
    flatRowCount: tree.rows.value.length,
    wire: {
      listCalls: Object.fromEntries(((window as AnyRecord).__task21Wire as TreeWire).listCalls),
      snapshots: Object.fromEntries(((window as AnyRecord).__task21Wire as TreeWire).snapshots),
      creates: ((window as AnyRecord).__task21Wire as TreeWire).creates,
      failures: [...((window as AnyRecord).__task21Wire as TreeWire).failures],
      failSummaries: ((window as AnyRecord).__task21Wire as TreeWire).failSummaries,
    },
  }),
  setTheme: (theme: AnyRecord) => {
    const side = theme?.regions?.sidePanel ?? {};
    const dropdown = theme?.components?.dropdown ?? {};
    for (const [key, cssVariable] of Object.entries(THEME_VARIABLES)) if (typeof side[key] === 'string') host.style.setProperty(cssVariable, side[key]);
    for (const [key, cssVariable] of Object.entries(THEME_SEMANTIC)) if (typeof side[key] === 'string') host.style.setProperty(cssVariable, side[key]);
    for (const [key, cssVariable] of Object.entries(THEME_DROPDOWN)) if (typeof dropdown[key] === 'string') host.style.setProperty(cssVariable, dropdown[key]);
    if (typeof side.bg === 'string') host.style.background = side.bg;
    if (typeof side.text === 'string') host.style.color = side.text;
    return { applied: Object.keys(side).length + Object.keys(dropdown).length };
  },
  expandSessions: async () => {
    let count = 0;
    const walk = (nodes: readonly AnyRecord[]) => {
      for (const node of nodes) {
        if (node.kind === 'session' && node.children.length && !tree.expanded.value.has(node.key)) { tree.toggleExpand(node.key); count += 1; }
        walk(node.children as readonly AnyRecord[]);
      }
    };
    walk(tree.tree.value as never);
    await nextTick();
    return { expandedSessions: count };
  },
  keyboard: async (keys: string[]) => {
    const scroller = document.querySelector('[data-testid="unified-scroll"]') as HTMLElement;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    for (const key of keys) scroller.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await nextTick();
    await new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });
    return domMetrics();
  },
  search: async (query: string) => {
    const result = await tree.search(query);
    await nextTick();
    return { status: result.status, query: result.query, scanned: result.scanned, pages: result.pages, matched: result.matches.length, keys: result.matches.map((row) => row.key), error: result.error };
  },
  loadChildren: async (key: string) => {
    const result = await tree.loadMoreChildren(key);
    await nextTick();
    return { ...result };
  },
  retry: async (kind: HarnessKind) => {
    const entry = tree.harnesses.value.find((item) => item.kind === kind);
    if (!entry) throw new Error(`missing harness source ${kind}`);
    const result = await tree.retrySource(entry.harnessInstanceId);
    await nextTick();
    return { ...result };
  },
  retryTarget: async () => { await tree.state.retry(TARGET); await nextTick(); return { viewStatus: tree.viewStatus.value, viewLoaded: tree.viewLoaded.value }; },
  failSource: async (kind: HarnessKind) => {
    ((window as AnyRecord).__task21Wire as TreeWire).failures.add(kind);
    await tree.refresh();
    await nextTick();
    return tree.harnesses.value.map((entry) => ({ kind: entry.kind, status: entry.status, reason: entry.reason }));
  },
  failAllSources: async () => {
    const wire = (window as AnyRecord).__task21Wire as TreeWire;
    for (const kind of HARNESS_ORDER) wire.failures.add(kind);
    await tree.refresh();
    await nextTick();
    return tree.harnesses.value.map((entry) => ({ kind: entry.kind, status: entry.status, reason: entry.reason }));
  },
  failSummaries: async () => {
    ((window as AnyRecord).__task21Wire as TreeWire).failSummaries = true;
    await tree.state.retry(TARGET).catch(() => undefined);
    await nextTick();
    return { viewStatus: tree.viewStatus.value, viewError: tree.viewError.value };
  },
  recoverSummaries: async () => {
    const wire = (window as AnyRecord).__task21Wire as TreeWire;
    wire.failSummaries = false;
    wire.clearFailures();
    await tree.state.retry(TARGET);
    await nextTick();
    return { viewStatus: tree.viewStatus.value, viewLoaded: tree.viewLoaded.value };
  },
  deleteSession: async (index: number) => {
    const wire = (window as AnyRecord).__task21Wire as TreeWire;
    const key = wire.deleteSession(index);
    await wait(200);
    await tree.refresh();
    await nextTick();
    return { key, present: domMetrics().rowKeys.includes(key), selectedKey: tree.selection.value ? encodeSessionKey(tree.selection.value.selection.session) : null };
  },
  selectByIndex: async (index: number) => {
    const ok = await tree.selectByKey(sessionKeyOf(index));
    await nextTick();
    return { ok, selectedKey: tree.selection.value ? encodeSessionKey(tree.selection.value.selection.session) : null };
  },
  sessionKey: (index: number) => sessionKeyOf(index),
  hostKey: (index: number) => sessionKeyOf(index),
  debugTree: () => ({
    sessions: tree.sessions.value.length,
    sample: tree.sessions.value.slice(0, 6).map((row) => ({ key: row.key.slice(0, 24), title: row.title, directory: row.directory, harness: row.harness, archived: row.archived, parent: row.parentSessionKey === null ? null : row.parentSessionKey.slice(0, 24) })),
    rows: tree.rows.value.slice(0, 14).map((row) => ({ kind: row.node.kind, key: row.key.slice(0, 24), title: row.node.kind === 'session' || row.node.kind === 'native' ? row.node.session.title : row.node.kind, depth: row.depth, children: row.node.kind === 'session' || row.node.kind === 'native' ? row.node.children.length : row.node.children.length })),
    expanded: [...tree.expanded.value].slice(0, 8),
    workspaces: tree.workspaces.value,
  }),
};

const COUNT = Number(new URLSearchParams(location.search).get('count') ?? '2000');
void (async () => {
  const opened = await openTree(COUNT);
  (window as AnyRecord).__task21Wire = opened.wire;
  (window as AnyRecord).__task21Client = opened.client;
  (window as AnyRecord).__task21Connection = opened.connection;
  const booted = createHostApp();
  booted.mount(host);
  (window as AnyRecord).task21 = api;
})();
