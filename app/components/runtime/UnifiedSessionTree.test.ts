import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import SessionTree from '../SessionTree.vue';
import {
  HARNESS_KINDS,
  SEARCH_LIMITS,
  buildUnifiedTree,
  flattenUnifiedTree,
  parseUnifiedSessionRow,
  useRuntimeSessionTree,
  type HarnessKind,
  type UnifiedSessionRow,
  type UnifiedTreeNode,
} from '../../composables/useRuntimeSessionTree';
import { encodeSessionKey, parseConnectionProfileId } from '../../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../../shared/runtime/identity.js';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

/**
 * Task 21 registered acceptance tests — unified virtualizable session tree.
 *
 * Every scenario drives the REAL production modules: the real SessionTree.vue
 * (unified mode), the real HarnessBadge/DiscoveryStatus components, and the
 * real useRuntimeSessionTree composable over the REAL task-20 state layer
 * (app/runtime/state.ts + entityCache.ts + selectionScope.ts). The only
 * controlled boundary is the runtime client: an in-memory fixture that serves
 * the same canonical entity shapes the bridge publishes, so the bounded
 * entity cache, the 200-row visible window and the selection fences all
 * execute for real. Numbers below are measured, not asserted as booleans.
 */

const ENV = '11111111-1111-4111-8111-111111111111' as EnvironmentId;
const PROFILE: ConnectionProfileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const HARNESS_IDS: Readonly<Record<HarnessKind, HarnessInstanceId>> = {
  opencode: '10000000-0000-4000-8000-000000000001' as HarnessInstanceId,
  codex: '10000000-0000-4000-8000-000000000002' as HarnessInstanceId,
  'kimi-web': '10000000-0000-4000-8000-000000000003' as HarnessInstanceId,
  dsh: '10000000-0000-4000-8000-000000000004' as HarnessInstanceId,
  acp: '10000000-0000-4000-8000-000000000005' as HarnessInstanceId,
};
const DIRECTORY = '/repo';
const REPO_KEY = '/repo';

type AnyRecord = Record<string, unknown>;

function sessionRef(index: number, harness: HarnessKind): SessionRef {
  return { environmentId: ENV, harnessInstanceId: HARNESS_IDS[harness], nativeSessionId: `session-${index}` };
}
function sessionKey(index: number, harness: HarnessKind): string {
  return encodeSessionKey(sessionRef(index, harness));
}
function summaryValue(index: number, harness: HarnessKind, options: Readonly<{ parent?: HarnessKind; parentIndex?: number; archived?: boolean; directory?: string | null }> = {}): AnyRecord {
  return {
    session: sessionRef(index, harness),
    title: `title-${index}`,
    directory: options.directory === undefined ? DIRECTORY : options.directory,
    archived: options.archived === true,
    pinned: false,
    parentSession: options.parent ? { environmentId: ENV, harnessInstanceId: HARNESS_IDS[options.parent], nativeSessionId: `session-${options.parentIndex ?? 0}` } : null,
    createdAt: 1700000000000 + index,
    updatedAt: 1700000000000 + index,
    status: index % 3 === 0 ? 'busy' : 'idle',
  };
}
function canonical(collection: string, key: string, revision: number, value: unknown): AnyRecord {
  return { collection, key, revision, value };
}

type SnapshotPage = Readonly<{ collection: string; items: readonly unknown[]; cursor: string | null; token: string; revision: number; watermark: number; expiresAt: number; target: string; epoch: string; generation: number }>;

/** In-memory runtime client fixture: serves the bridge's canonical entity shapes. */
class FakeClient {
  readonly rows = new Map<string, AnyRecord[]>();
  readonly snapshots = new Map<string, number>();
  readonly listCalls = new Map<string, number>();
  abortedSnapshots = 0;
  readonly completedReads = new Map<string, number>();
  private tokens = 0;
  private readonly revision = 200000;
  private indexSnapshot?: Readonly<{ token: string; revision: number; watermark: number; expiresAt: number }>;
  constructor(readonly environment: string = ENV) {}
  private mintToken(): string { return `snapshot-${++this.tokens}`; }
  add(collection: string, row: AnyRecord): void {
    const list = this.rows.get(collection) ?? [];
    list.push(row);
    this.rows.set(collection, list);
  }
  scope() {
    return { binding: { target: this.environment as EnvironmentId, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => true };
  }
  onDetach(): () => void { return () => {}; }
  async snapshot(target: EnvironmentId, collections: string | readonly string[], options: { onPage: (collection: string, page: SnapshotPage) => Promise<void> | void; onDelivery?: unknown; signal?: AbortSignal }): Promise<{ token: string; revision: number; watermark: number; observer: { read(): Promise<null>; close(): Promise<void> } }> {
    const names = typeof collections === 'string' ? [collections] : collections;
    const token = this.mintToken();
    for (const name of names) {
      const rows = this.rows.get(name) ?? [];
      this.snapshots.set(name, (this.snapshots.get(name) ?? 0) + 1);
      for (let offset = 0; offset === 0 || offset < rows.length; offset += 200) {
        if (options.signal?.aborted) {
          this.abortedSnapshots += 1;
          throw Object.assign(new Error('snapshot cancelled'), { code: 'cancelled' });
        }
        const page = rows.slice(offset, offset + 200);
        await options.onPage(name, {
          collection: name, items: page, cursor: offset + 200 < rows.length ? String(offset + 200) : null,
          token, revision: this.revision, watermark: 0, expiresAt: Date.now() + 60000, target, epoch: 'epoch', generation: 1,
        });
        if (offset + 200 >= rows.length) break;
      }
    }
    this.indexSnapshot = Object.freeze({ token, revision: this.revision, watermark: 0, expiresAt: Date.now() + 60000 });
    return { token, revision: this.revision, watermark: 0, observer: { read: async () => null, close: async () => {} } };
  }
  private indexPage(name: string, target: EnvironmentId, token: string | undefined, cursor: string | null): SnapshotPage {
    const rows = this.rows.get(name) ?? [];
    const start = cursor === null ? 0 : Number(cursor);
    return {
      collection: name,
      items: rows.slice(start, start + 200),
      cursor: start + 200 < rows.length ? String(start + 200) : null,
      token: token ?? this.mintToken(),
      revision: this.revision,
      watermark: 0,
      expiresAt: Date.now() + 60000,
      target,
      epoch: 'epoch',
      generation: 1,
    };
  }
  async readIndex(target: EnvironmentId, collections: string | readonly string[], options: { onPage: (collection: string, page: SnapshotPage) => Promise<void> | void; signal?: AbortSignal; selectionCurrent?: () => boolean }): Promise<{ token: string; revision: number; watermark: number }> {
    const names = typeof collections === 'string' ? [collections] : collections;
    if (names.length === 0 || names.length > 5 || new Set(names).size !== names.length) throw new TypeError('snapshot.collections');
    const cached = this.indexSnapshot;
    const reuse = cached !== undefined && cached.expiresAt - Date.now() > 2000 ? cached.token : undefined;
    let first: SnapshotPage | undefined;
    for (const name of names) {
      this.snapshots.set(name, (this.snapshots.get(name) ?? 0) + 1);
      let cursor: string | null = null;
      do {
        if (options.signal?.aborted) {
          this.abortedSnapshots += 1;
          throw Object.assign(new Error('readIndex cancelled'), { code: 'cancelled' });
        }
        const token = first !== undefined ? first.token : (cursor === null && name === names[0] ? reuse : undefined);
        let page: SnapshotPage;
        try {
          if (token !== undefined && token !== this.indexSnapshot?.token) throw Object.assign(new Error('snapshot view is stale'), { code: 'replay_required' });
          page = this.indexPage(name, target, token, cursor);
        } catch (error) {
          if (first !== undefined || token === undefined || (error as { code?: string }).code !== 'replay_required') throw error;
          this.indexSnapshot = undefined;
          page = this.indexPage(name, target, undefined, cursor);
        }
        if (first === undefined) {
          first = page;
          this.indexSnapshot = Object.freeze({ token: page.token, revision: page.revision, watermark: page.watermark, expiresAt: page.expiresAt });
        }
        if (page.token !== first.token || page.revision !== first.revision || page.watermark !== first.watermark
          || page.target !== target || page.epoch !== 'epoch' || page.generation !== 1) {
          throw Object.assign(new Error('snapshot.atomic'), { code: 'replay_required' });
        }
        if (!(page.expiresAt > Date.now()) || (page.cursor !== null && page.cursor === cursor)) {
          throw Object.assign(new Error('snapshot.expired'), { code: 'replay_required' });
        }
        await options.onPage(name, page);
        cursor = page.cursor;
      } while (cursor !== null);
    }
    if (first === undefined) throw Object.assign(new Error('snapshot.empty'), { code: 'replay_required' });
    for (const name of names) this.completedReads.set(name, (this.completedReads.get(name) ?? 0) + 1);
    return { token: first.token, revision: first.revision, watermark: first.watermark };
  }
  async request(_target: EnvironmentId, method: string, params: AnyRecord): Promise<unknown> {
    if (method === 'session.list') {
      const id = String(params.harnessInstanceId);
      this.listCalls.set(id, (this.listCalls.get(id) ?? 0) + 1);
      return { items: [], cursor: null, completeness: 'complete' };
    }
    throw new TypeError(`unexpected method ${method}`);
  }
}

function seedTopology(client: FakeClient, options: Readonly<{ failed?: readonly HarnessKind[] }> = {}): void {
  for (const kind of HARNESS_KINDS) {
    const failed = (options.failed ?? []).includes(kind);
    client.add('harnesses', canonical('harnesses', HARNESS_IDS[kind], 1, {
      environmentId: ENV, harnessInstanceId: HARNESS_IDS[kind], kind,
      ...(failed ? { indexDiscovery: [{ scopeKey: '{}', status: 'partial', count: 0, reason: 'native_timeout' }] } : { indexDiscovery: [{ scopeKey: '{}', status: 'complete', count: 10 }] }),
    }));
  }
  client.add('workspaces', canonical('workspaces', 'workspace:/repo', 1, { kind: 'workspace', workspace: { environmentId: ENV, canonicalPath: DIRECTORY, pathPolicy: { platform: 'posix', caseSensitive: true, volumeId: 'vol' } }, sources: [], orphan: false, gitKind: 'git', repoKey: REPO_KEY }));
}

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } });

async function mountTree(props: AnyRecord): Promise<{ root: HTMLElement; unmount(): void; emitted: Map<string, unknown[]> }> {
  const emitted = new Map<string, unknown[]>();
  const handlers: AnyRecord = {};
  for (const name of ['toggle-key', 'select-key', 'retry-source', 'filter-change', 'search', 'load-more-children', 'reload']) {
    const prop = `on${name.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase()).replace(/^(\w)/, (_match, letter: string) => letter.toUpperCase())}`;
    handlers[prop] = (payload: unknown) => {
      const list = emitted.get(name) ?? [];
      list.push(payload);
      emitted.set(name, list);
    };
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(SessionTree, { projects: [], expandedPaths: [], selectedSessionId: '', ...props, ...handlers });
  app.use(i18n);
  app.mount(host);
  await nextTick();
  return { root: host, unmount: () => app.unmount(), emitted };
}

function expandGroups(nodes: readonly UnifiedTreeNode[], expanded: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === 'repo' || node.kind === 'section' || node.kind === 'worktree') {
      expanded.add(node.key);
      expandGroups(node.children, expanded);
    }
  }
}

const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const entry of mounted.splice(0)) entry.unmount(); document.body.innerHTML = ''; });

describe('task 21 — unified session tree acceptance', () => {
  it('same repo shows sessions from all five harnesses with per-session source badges', async () => {
    const client = new FakeClient();
    seedTopology(client);
    for (const [offset, kind] of HARNESS_KINDS.entries()) {
      client.add('session_summaries', canonical('session_summaries', sessionKey(offset, kind), offset + 1, summaryValue(offset, kind)));
    }
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV });
    await tree.start();
    expect(tree.viewStatus.value).toBe('complete');
    expect(tree.harnesses.value).toHaveLength(5);
    expect(tree.workspaces.value.map((entry) => entry.repoKey)).toEqual([REPO_KEY]);

    const expanded = new Set<string>();
    expandGroups(tree.tree.value, expanded);
    tree.expanded.value = expanded;
    await nextTick();
    const rows = tree.rows.value;
    const sessionRows = rows.filter((row) => row.node.kind === 'session');
    expect(sessionRows).toHaveLength(5);
    const badges = sessionRows.map((row) => (row.node.kind === 'session' ? row.node.session.harness : 'unknown'));
    expect([...badges].sort()).toEqual([...HARNESS_KINDS].sort());
    const repoRows = rows.filter((row) => row.node.kind === 'repo');
    expect(repoRows).toHaveLength(1);
    expect(repoRows[0]?.key).toBe(`repo:${REPO_KEY}`);

    const mountedTree = await mountTree({ treeRows: tree.rows.value, expandedPaths: [...expanded], sources: tree.harnesses.value, viewStatus: 'complete', viewLoaded: 5, selectedKey: sessionRows[0]?.key });
    mounted.push(mountedTree);
    const domBadges = [...mountedTree.root.querySelectorAll('[data-tree-row][data-harness]')].map((element) => element.getAttribute('data-harness'));
    expect([...domBadges].sort()).toEqual([...HARNESS_KINDS].sort());
    expect(mountedTree.root.querySelectorAll('[data-tree-row]').length).toBe(rows.length);
    expect(mountedTree.root.querySelectorAll('[data-testid="source-ready-count"]')[0]?.textContent).toBe('5/5');
    await tree.dispose();
  });

  it('native sub-sessions are structurally separated from host members and never interleaved', () => {
    const sessions: UnifiedSessionRow[] = [];
    for (const index of [1, 2, 3]) sessions.push(parseUnifiedSessionRow(sessionKey(index, 'opencode'), summaryValue(index, 'opencode'), 'opencode')!);
    sessions.push(parseUnifiedSessionRow(sessionKey(11, 'opencode'), summaryValue(11, 'opencode', { parent: 'opencode', parentIndex: 1 }), 'opencode')!);
    sessions.push(parseUnifiedSessionRow(sessionKey(12, 'opencode'), summaryValue(12, 'opencode', { parent: 'opencode', parentIndex: 2 }), 'opencode')!);
    sessions.push(parseUnifiedSessionRow(sessionKey(99, 'dsh'), summaryValue(99, 'dsh', { parent: 'acp', parentIndex: 77 }), 'dsh')!);
    expect(sessions.every(Boolean)).toBe(true);

    const nodes = buildUnifiedTree(sessions, [{ path: DIRECTORY, repoKey: REPO_KEY, gitKind: 'git', orphan: false }]);
    const expanded = new Set<string>();
    expandGroups(nodes, expanded);
    const host = nodes[0];
    expect(host?.kind).toBe('repo');
    const worktree = host?.kind === 'repo' ? host.children[0] : undefined;
    const hostMembers = worktree?.kind === 'worktree' ? worktree.children.filter((node) => node.kind === 'session') : [];
    expect(hostMembers.map((node) => (node.kind === 'session' ? node.session.nativeSessionId : ''))).toEqual(['session-3', 'session-2', 'session-1']);
    for (const member of hostMembers) if (member.kind === 'session' && member.children.length) expanded.add(member.key);

    const rows = flattenUnifiedTree(nodes, expanded, new Set([...HARNESS_KINDS, 'unknown'] as const));
    const hostIndex = rows.findIndex((row) => row.node.kind === 'session' && row.node.session.nativeSessionId === 'session-1');
    const childIndex = rows.findIndex((row) => row.node.kind === 'native' && row.node.session.nativeSessionId === 'session-11');
    const hostKey = rows[hostIndex]?.key ?? '';
    expect(hostIndex).toBeGreaterThanOrEqual(0);
    expect(childIndex).toBe(hostIndex + 1);
    expect(rows[childIndex]?.depth).toBe((rows[hostIndex]?.depth ?? 0) + 1);
    expect(rows[childIndex]?.key).toBe(`native:${hostKey}:${sessionKey(11, 'opencode')}`);
    const nativeRows = rows.filter((row) => row.node.kind === 'native');
    expect(nativeRows).toHaveLength(3);
    const unparented = rows.filter((row) => row.node.kind === 'native' && row.key.startsWith('native-unparented:'));
    expect(unparented).toHaveLength(1);
    expect(unparented[0]?.node.kind === 'native' ? unparented[0].node.session.nativeSessionId : null).toBe('session-99');
    const unparentedIndex = rows.findIndex((row) => row.key === unparented[0]?.key);
    const sectionIndex = rows.findIndex((row) => row.node.kind === 'section' && row.node.section === 'native-unparented');
    expect(unparentedIndex).toBeGreaterThan(sectionIndex);
    const hostKeys = new Set(rows.filter((row) => row.node.kind === 'session').map((row) => row.key));
    for (const row of nativeRows) if (!row.key.startsWith('native-unparented:')) expect(hostKeys.has(row.key)).toBe(false);
  });

  it('10k sessions render with a virtual DOM window of at most 200 rows', async () => {
    const total = 10000;
    const client = new FakeClient();
    seedTopology(client);
    for (let index = 0; index < total; index += 1) {
      const kind = HARNESS_KINDS[index % HARNESS_KINDS.length]!;
      client.add('session_summaries', canonical('session_summaries', sessionKey(index, kind), index + 1, summaryValue(index, kind)));
    }
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV });
    await tree.start();
    expect(tree.viewLoaded.value).toBe(total);
    const view = tree.state.view('session_summaries', ENV);
    const windowRows = view.items.length;
    view.release();
    expect(windowRows).toBe(200);

    const expanded = new Set<string>();
    expandGroups(tree.tree.value, expanded);
    tree.expanded.value = expanded;
    await nextTick();
    expect(tree.rows.value.length).toBe(202);

    const mountedTree = await mountTree({ treeRows: tree.rows.value, expandedPaths: [...expanded], sources: tree.harnesses.value, viewStatus: 'complete', viewLoaded: total });
    mounted.push(mountedTree);
    const domRows = mountedTree.root.querySelectorAll('[data-tree-row]');
    expect(domRows.length).toBeLessThanOrEqual(200);
    expect(domRows.length).toBe(39);
    const scroller = mountedTree.root.querySelector('[data-testid="unified-scroll"]') as HTMLElement;
    scroller.scrollTop = 140 * 28;
    scroller.dispatchEvent(new Event('scroll'));
    await nextTick();
    const scrolledRows = mountedTree.root.querySelectorAll('[data-tree-row]');
    expect(scrolledRows.length).toBeLessThanOrEqual(200);
    const firstKey = scrolledRows[0]?.getAttribute('data-row-key');
    const expectedFirst = tree.rows.value[140 - 8]?.key;
    expect(firstKey).toBe(expectedFirst);
    expect(mountedTree.root.querySelector('[data-testid="unified-footer-count"]')?.textContent).toBe('202');

    const synthetic: UnifiedSessionRow[] = [];
    for (let index = 0; index < total; index += 1) {
      const kind = HARNESS_KINDS[index % HARNESS_KINDS.length]!;
      synthetic.push(parseUnifiedSessionRow(sessionKey(index, kind), summaryValue(index, kind), kind)!);
    }
    const syntheticNodes = buildUnifiedTree(synthetic, [{ path: DIRECTORY, repoKey: REPO_KEY, gitKind: 'git', orphan: false }]);
    const syntheticExpanded = new Set<string>();
    expandGroups(syntheticNodes, syntheticExpanded);
    const syntheticRows = flattenUnifiedTree(syntheticNodes, syntheticExpanded, new Set([...HARNESS_KINDS, 'unknown'] as const));
    expect(syntheticRows.length).toBe(total + 2);
    const virtualTree = await mountTree({ treeRows: syntheticRows, expandedPaths: [...syntheticExpanded], sources: tree.harnesses.value, viewStatus: 'complete', viewLoaded: total });
    mounted.push(virtualTree);
    expect(virtualTree.root.querySelectorAll('[data-tree-row]').length).toBeLessThanOrEqual(200);
    const virtualScroller = virtualTree.root.querySelector('[data-testid="unified-scroll"]') as HTMLElement;
    virtualScroller.scrollTop = 5000 * 28;
    virtualScroller.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(virtualTree.root.querySelectorAll('[data-tree-row]').length).toBeLessThanOrEqual(200);
    expect(virtualTree.root.querySelectorAll('[data-tree-row]')[0]?.getAttribute('data-row-key')).toBe(syntheticRows[5000 - 8]?.key);
    await tree.dispose();
  });

  it('search targets the full 10k index, finding a hit outside the 200-row window and the 2000-entry LRU', async () => {
    const total = 10000;
    const client = new FakeClient();
    seedTopology(client);
    for (let index = 0; index < total; index += 1) {
      const kind = HARNESS_KINDS[index % HARNESS_KINDS.length]!;
      client.add('session_summaries', canonical('session_summaries', sessionKey(index, kind), index + 1, summaryValue(index, kind)));
    }
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV });
    await tree.start();
    const view = tree.state.view('session_summaries', ENV);
    const windowKeys = view.items.map((item) => item.address.key);
    view.release();
    expect(windowKeys).toHaveLength(200);

    const deepIndex = 9500;
    const deepKind = HARNESS_KINDS[deepIndex % HARNESS_KINDS.length]!;
    const deepKey = sessionKey(deepIndex, deepKind);
    expect(windowKeys).not.toContain(deepKey);

    const result = await tree.search('title-9500');
    expect(result.status).toBe('complete');
    expect(result.scanned).toBe(total);
    expect(result.pages).toBe(50);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.key).toBe(deepKey);
    expect(result.matches[0]?.nativeSessionId).toBe(`session-${deepIndex}`);
    expect(result.totalMatched).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
    const allResult = await tree.search('title-');
    expect(allResult.matches).toHaveLength(SEARCH_LIMITS.maxRetained);
    expect(allResult.totalMatched).toBe(total);
    expect(allResult.hasMore).toBe(true);
    expect(allResult.cursor).toBe(String(SEARCH_LIMITS.maxRetained));
    expect(allResult.scanned).toBe(total);

    const nextPage = await tree.searchMore();
    expect(nextPage.matches).toHaveLength(SEARCH_LIMITS.maxRetained);
    expect(nextPage.totalMatched).toBe(total);
    expect(nextPage.matches[0]?.key).not.toBe(allResult.matches[0]?.key);
    await tree.dispose();
  });

  it('bounds retained search results for a 100k all-match index (search budget)', async () => {
    // Reviewer round-2 finding (P2): a broad query over a large paginated index
    // retained EVERY match in composable state (100000 rows measured on a
    // controlled 500x200 input), bypassing the task-20 bounded-resident budget.
    // This reproduces that exact shape: 500 pages x 200 rows, every row matching.
    const pages = 500;
    const pageSize = 200;
    const total = pages * pageSize;
    const client = new FakeClient();
    seedTopology(client);
    for (let index = 0; index < total; index += 1) {
      const kind = HARNESS_KINDS[index % HARNESS_KINDS.length]!;
      client.add('session_summaries', canonical('session_summaries', sessionKey(index, kind), index + 1, summaryValue(index, kind)));
    }
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV });
    await tree.start();
    const ledgerBefore = tree.state.usage().entities;

    const result = await tree.search('title-');
    expect(result.status).toBe('complete');
    expect(result.scanned).toBe(total);
    expect(result.pages).toBe(pages);
    expect(result.totalMatched).toBe(total);
    expect(result.matches).toHaveLength(SEARCH_LIMITS.maxRetained);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe(String(SEARCH_LIMITS.maxRetained));

    const ledgerAfter = tree.state.usage().entities;
    expect(ledgerAfter.entries).toBe(ledgerBefore.entries);
    expect(ledgerAfter.residentBytes).toBe(ledgerBefore.residentBytes);

    const nextPage = await tree.searchMore();
    expect(nextPage.matches).toHaveLength(SEARCH_LIMITS.maxRetained);
    expect(nextPage.totalMatched).toBe(total);
    expect(nextPage.matches[0]?.key).not.toBe(result.matches[0]?.key);

    const residualAtDispose = result.matches.length;
    await tree.dispose();
    expect(tree.searchState.value.matches).toHaveLength(0);
    expect(residualAtDispose).toBeLessThanOrEqual(SEARCH_LIMITS.maxRetained);
  });

  it('a superseded query cannot land its results in the state (search generation fence)', async () => {
    const total = 600;
    const client = new FakeClient();
    seedTopology(client);
    for (let index = 0; index < total; index += 1) {
      const kind = HARNESS_KINDS[index % HARNESS_KINDS.length]!;
      client.add('session_summaries', canonical('session_summaries', sessionKey(index, kind), index + 1, summaryValue(index, kind)));
    }
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV });
    await tree.start();

    const first = tree.search('title-1');
    const second = tree.search('title-2');
    await Promise.all([first, second]);

    const settled = tree.searchState.value;
    expect(settled.status).toBe('complete');
    expect(settled.query).toBe('title-2');
    expect(settled.matches.length).toBeGreaterThan(0);
    for (const row of settled.matches) expect(row.title).toContain('title-2');
    expect(client.completedReads.get('session_summaries') ?? 0).toBe(1);
    await tree.dispose();
  });

  it('a failed source can be retried alone without re-fetching the other sources', async () => {
    const client = new FakeClient();
    seedTopology(client, { failed: ['dsh'] });
    for (const [offset, kind] of HARNESS_KINDS.entries()) {
      client.add('session_summaries', canonical('session_summaries', sessionKey(offset, kind), offset + 1, summaryValue(offset, kind)));
    }
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV });
    await tree.start();
    const failed = tree.harnesses.value.filter((entry) => entry.status === 'error');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.kind).toBe('dsh');
    expect(failed[0]?.reason).toBe('native_timeout');

    const summarySnapshotsBefore = client.snapshots.get('session_summaries') ?? 0;
    const retried = await tree.retrySource(HARNESS_IDS.dsh);
    expect(retried.retried).toBe(true);
    expect(client.listCalls.get(HARNESS_IDS.dsh)).toBe(1);
    for (const kind of HARNESS_KINDS) if (kind !== 'dsh') expect(client.listCalls.get(HARNESS_IDS[kind]) ?? 0).toBe(0);
    expect(client.snapshots.get('session_summaries') ?? 0).toBe(summarySnapshotsBefore);
    expect(client.snapshots.get('harnesses') ?? 0).toBeGreaterThan(1);

    const mountedTree = await mountTree({ treeRows: tree.rows.value, expandedPaths: [], sources: tree.harnesses.value, viewStatus: 'complete', viewLoaded: 5 });
    mounted.push(mountedTree);
    (mountedTree.root.querySelector('.discovery-status-summary') as HTMLElement).click();
    await nextTick();
    const retryButtons = mountedTree.root.querySelectorAll('[data-testid="source-retry"]');
    expect(retryButtons).toHaveLength(1);
    expect(retryButtons[0]?.getAttribute('data-harness')).toBe('dsh');
    expect(mountedTree.root.querySelectorAll('[data-source="dsh"][data-status="error"]')).toHaveLength(1);
    expect(mountedTree.root.querySelector('[data-testid="source-ready-count"]')?.textContent).toBe('4/5');
    await tree.dispose();
  });

  it('an unloaded index shows a loading affordance instead of an empty tree', async () => {
    const mountedTree = await mountTree({ treeRows: [], expandedPaths: [], sources: [], viewStatus: 'loading', viewLoaded: 0 });
    mounted.push(mountedTree);
    expect(mountedTree.root.querySelector('[data-testid="unified-empty"]')).toBeNull();
    expect(mountedTree.root.querySelector('[data-testid="unified-meta"]')?.textContent).toContain('Loading sessions');
    const loaded = await mountTree({ treeRows: [], expandedPaths: [], sources: [], viewStatus: 'complete', viewLoaded: 0 });
    mounted.push(loaded);
    expect(loaded.root.querySelector('[data-testid="unified-empty"]')).not.toBeNull();
  });

  it('keyboard navigation selects the focused row and expands groups', async () => {
    const sessions: UnifiedSessionRow[] = [];
    for (const index of [1, 2, 3]) sessions.push(parseUnifiedSessionRow(sessionKey(index, 'opencode'), summaryValue(index, 'opencode'), 'opencode')!);
    const nodes = buildUnifiedTree(sessions, [{ path: DIRECTORY, repoKey: REPO_KEY, gitKind: 'git', orphan: false }]);
    const expanded = new Set<string>();
    expandGroups(nodes, expanded);
    const rows = flattenUnifiedTree(nodes, expanded, new Set([...HARNESS_KINDS, 'unknown'] as const));
    const mountedTree = await mountTree({ treeRows: rows, expandedPaths: [...expanded], sources: [], viewStatus: 'complete', viewLoaded: 3 });
    mounted.push(mountedTree);
    const scroller = mountedTree.root.querySelector('[data-testid="unified-scroll"]') as HTMLElement;
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await nextTick();
    const focused = mountedTree.root.querySelector('[data-tree-row][data-focused="true"]');
    expect(focused?.getAttribute('data-row-key')).toBe(rows[3]?.key);
    expect(rows[3]?.node.kind).toBe('session');
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(mountedTree.emitted.get('select-key')).toEqual([rows[3]?.key]);
  });

  it('clicking a native sub-session row selects the session by its canonical key and highlights it', async () => {
    const client = new FakeClient();
    seedTopology(client);
    const hostKey = sessionKey(1, 'opencode');
    const childKey = sessionKey(11, 'opencode');
    client.add('session_summaries', canonical('session_summaries', hostKey, 1, summaryValue(1, 'opencode')));
    client.add('session_summaries', canonical('session_summaries', childKey, 2, summaryValue(11, 'opencode', { parent: 'opencode', parentIndex: 1 })));
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV });
    await tree.start();

    const expanded = new Set<string>();
    expandGroups(tree.tree.value, expanded);
    expanded.add(hostKey);
    tree.expanded.value = expanded;
    await nextTick();

    const nativeRow = tree.rows.value.find((row) => row.node.kind === 'native');
    expect(nativeRow?.node.kind).toBe('native');
    const decoratedKey = nativeRow?.key ?? '';
    const canonicalKey = nativeRow?.node.kind === 'native' ? nativeRow.node.session.key : '';
    expect(decoratedKey.startsWith('native:')).toBe(true);
    expect(decoratedKey).not.toBe(canonicalKey);

    // Reviewer reproduction against the real module: the DECORATED tree key cannot
    // be decoded, while the same session's CANONICAL key selects successfully.
    expect(await tree.selectByKey(decoratedKey)).toBe(false);
    expect(await tree.selectByKey(canonicalKey)).toBe(true);
    const capture = tree.selection.value;
    expect(capture ? encodeSessionKey(capture.selection.session) : null).toBe(canonicalKey);

    // The selection highlight must use the same canonical identity as the selection
    // call, so the highlighted row and the selected session always agree.
    const mountedTree = await mountTree({
      treeRows: tree.rows.value,
      expandedPaths: [...expanded],
      sources: tree.harnesses.value,
      viewStatus: 'complete',
      viewLoaded: 2,
      selectedKey: canonicalKey,
    });
    mounted.push(mountedTree);
    const nativeElement = mountedTree.root.querySelector(`[data-tree-row][data-row-key="${decoratedKey}"]`);
    expect(nativeElement).not.toBeNull();
    expect(nativeElement?.getAttribute('data-selected')).toBe('true');

    // Clicking the native row emits the canonical session key, never the decorated key.
    (nativeElement as HTMLElement).click();
    await nextTick();
    expect(mountedTree.emitted.get('select-key')).toEqual([canonicalKey]);
    await tree.dispose();
  });
});
