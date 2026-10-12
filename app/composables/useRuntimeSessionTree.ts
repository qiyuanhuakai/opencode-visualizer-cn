// Unified, virtualizable session tree over the task-20 bounded runtime state.
//
// This composable CONSUMES the frozen task-20 state layer (app/runtime/state.ts,
// entityCache.ts, selectionScope.ts): one createRuntimeState instance owns the
// bounded entity cache (ENTITY_LIMITS), the single selection scope and the
// newest-selection fences. It never clones the project and never introduces a
// second store.
//
// Three read paths, each with one job:
//   1. state.view('session_summaries', target) — the bounded visible window
//      (≤ ENTITY_LIMITS.page rows) that the tree renders.
//   2. client.snapshot(target, 'harnesses' | 'workspaces') — index topology
//      (which of the five harnesses exist, per-source discovery status, and the
//      workspace→repo mapping). Small collections, read once after start and
//      re-read after a source retry.
//   3. client.snapshot(target, 'session_summaries', { onPage }) — a FULL-INDEX
//      traversal used by search and child pagination. It deliberately bypasses
//      the bounded LRU window so a match outside the visible window (and
//      outside the 2000-entry entity cache) is still found.
//
// Reads on paths 2 and 3 are serialized (the runtime client rejects concurrent
// snapshots with `snapshot.pending`), mirroring the state layer's own
// serialized discipline. A per-source retry re-invokes ONLY that harness's
// native `session.list`; it never restarts the target snapshot, so the other
// sources are not re-fetched.
import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue';
import type { ErrorCode } from '../../shared/runtime/capabilities.js';
import { decodeSessionKey, encodeSessionKey } from '../../shared/runtime/identity.js';
import type { EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import type { IndexCollection } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeClient } from '../runtime/client';
import { createRuntimeState } from '../runtime/state';
import type { RuntimeState, RuntimeStateOptions } from '../runtime/state';

export const HARNESS_KINDS = ['opencode', 'codex', 'kimi-web', 'dsh', 'acp'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];
/** A session whose harness instance is not (yet) in the harnesses topology. */
export type SessionHarness = HarnessKind | 'unknown';
export const HARNESS_LABELS: Readonly<Record<SessionHarness, string>> = {
  opencode: 'OpenCode',
  codex: 'Codex',
  'kimi-web': 'Kimi Web',
  dsh: 'DSH',
  acp: 'ACP',
  unknown: 'Unknown',
};

export type UnifiedSessionRow = Readonly<{
  key: string;
  nativeSessionId: string;
  title: string;
  directory: string | null;
  harness: SessionHarness;
  harnessInstanceId: string;
  status: string | null;
  archived: boolean;
  pinned: boolean;
  parentSessionKey: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}>;

export type WorkspaceEntry = Readonly<{ path: string; repoKey: string | null; gitKind: string | null; orphan: boolean }>;

export type UnifiedSectionKind = 'archived' | 'orphan' | 'global' | 'native-unparented';
export type UnifiedTreeNode =
  | Readonly<{ kind: 'repo'; key: string; name: string; children: readonly UnifiedTreeNode[] }>
  | Readonly<{ kind: 'worktree'; key: string; name: string; directory: string; children: readonly UnifiedTreeNode[] }>
  | Readonly<{ kind: 'section'; key: string; section: UnifiedSectionKind; children: readonly UnifiedTreeNode[] }>
  | Readonly<{ kind: 'session'; key: string; session: UnifiedSessionRow; children: readonly UnifiedTreeNode[] }>
  | Readonly<{ kind: 'native'; key: string; session: UnifiedSessionRow; children: readonly UnifiedTreeNode[] }>;

export type UnifiedFlatRow = Readonly<{ key: string; node: UnifiedTreeNode; depth: number; expandable: boolean }>;

export type HarnessEntry = Readonly<{
  harnessInstanceId: string;
  kind: SessionHarness;
  status: 'loading' | 'partial' | 'complete' | 'error';
  reason: string | null;
}>;

export type UnifiedSearchState = Readonly<{
  status: 'idle' | 'searching' | 'complete' | 'error';
  query: string;
  scanned: number;
  pages: number;
  matches: readonly UnifiedSessionRow[];
  error: ErrorCode | null;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
}
function asText(value: unknown, maximum = 16384): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0') ? value : null;
}
function asTime(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return asText(value, 128);
}
function asHarnessKind(value: unknown): SessionHarness {
  return typeof value === 'string' && (HARNESS_KINDS as readonly string[]).includes(value) ? (value as HarnessKind) : 'unknown';
}

/**
 * Parse one canonical `session_summaries` entity value (bridge
 * sessionSummaries.js shape) into a tree row. A malformed row returns null so
 * one bad entity can never blank or crash the tree.
 */
export function parseUnifiedSessionRow(key: string, value: unknown, harness: SessionHarness): UnifiedSessionRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const session = asRecord(row.session);
  if (!session) return null;
  const nativeSessionId = asText(session.nativeSessionId, 2048);
  const harnessInstanceId = asText(session.harnessInstanceId, 64);
  if (!nativeSessionId || !harnessInstanceId) return null;
  let parentSessionKey: string | null = null;
  const parent = asRecord(row.parentSession);
  if (parent) {
    const parentNative = asText(parent.nativeSessionId, 2048);
    const parentHarness = asText(parent.harnessInstanceId, 64);
    const parentEnvironment = asText(parent.environmentId, 64);
    if (parentNative && parentHarness && parentEnvironment) {
      parentSessionKey = encodeSessionKey({
        environmentId: parentEnvironment as EnvironmentId,
        harnessInstanceId: parentHarness as UnifiedSessionRow['harnessInstanceId'] & string,
        nativeSessionId: parentNative,
      } as SessionRef);
    }
  }
  return Object.freeze({
    key,
    nativeSessionId,
    title: asText(row.title, 8192) ?? nativeSessionId,
    directory: asText(row.directory, 16384),
    harness,
    harnessInstanceId,
    status: asText(row.status, 128),
    archived: row.archived === true,
    pinned: row.pinned === true,
    parentSessionKey,
    createdAt: asTime(row.createdAt),
    updatedAt: asTime(row.updatedAt),
  });
}

/** Parse one `harnesses` entity value into a per-source discovery status. */
export function parseHarnessEntry(key: string, value: unknown): HarnessEntry | null {
  const row = asRecord(value);
  if (!row) return null;
  const discovery = Array.isArray(row.indexDiscovery) ? row.indexDiscovery : [];
  let status: HarnessEntry['status'] = 'loading';
  let reason: string | null = null;
  for (const entry of discovery) {
    const record = asRecord(entry);
    if (!record) continue;
    const value_ = asText(record.status, 64);
    if (value_ === 'complete') { status = 'complete'; reason = null; }
    else if (value_ === 'partial') { status = asText(record.reason, 1024) ? 'error' : 'partial'; reason = asText(record.reason, 1024); }
  }
  return Object.freeze({ harnessInstanceId: key, kind: asHarnessKind(row.kind), status, reason });
}

/** Parse one `workspaces` entity value into the workspace→repo mapping. */
export function parseWorkspaceEntry(value: unknown): WorkspaceEntry | null {
  const row = asRecord(value);
  if (!row) return null;
  const workspace = asRecord(row.workspace);
  const path = workspace ? asText(workspace.canonicalPath, 16384) : null;
  if (!path) return null;
  return Object.freeze({
    path,
    repoKey: asText(row.repoKey, 4096),
    gitKind: asText(row.gitKind, 64),
    orphan: row.orphan === true,
  });
}

function sortSessions(rows: readonly UnifiedSessionRow[]): UnifiedSessionRow[] {
  return [...rows].sort((left, right) => {
    const leftUpdated = left.updatedAt ?? left.createdAt ?? 0;
    const rightUpdated = right.updatedAt ?? right.createdAt ?? 0;
    if (typeof leftUpdated === 'number' && typeof rightUpdated === 'number' && leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
    if (leftUpdated !== rightUpdated) return String(rightUpdated).localeCompare(String(leftUpdated));
    return left.title.localeCompare(right.title);
  });
}

/**
 * Build the unified tree: repo → worktree (git worktree navigation) → host
 * sessions, with archived / orphan / Global sections and native sub-sessions
 * nested ONLY under their host session. A native sub-session whose host is
 * outside the current window lands in the `native-unparented` section — it is
 * never interleaved into a host member list.
 */
export function buildUnifiedTree(
  sessions: readonly UnifiedSessionRow[],
  workspaces: readonly WorkspaceEntry[],
  nativeChildren?: ReadonlyMap<string, readonly UnifiedSessionRow[]>,
): UnifiedTreeNode[] {
  const workspaceByPath = new Map(workspaces.map((entry) => [entry.path, entry]));
  const hosts = new Map<string, UnifiedSessionRow>();
  for (const row of sessions) if (row.parentSessionKey === null) hosts.set(row.key, row);
  const nativeByParent = new Map<string, UnifiedSessionRow[]>();
  for (const row of sessions) {
    if (row.parentSessionKey === null) continue;
    const list = nativeByParent.get(row.parentSessionKey) ?? [];
    list.push(row);
    nativeByParent.set(row.parentSessionKey, list);
  }

  const byName = (left: UnifiedTreeNode, right: UnifiedTreeNode) => (left.kind === 'worktree' ? left.name : '').localeCompare(right.kind === 'worktree' ? right.name : '');
  /** Group host rows into repo → worktree nodes. `orphanOnly` selects the orphan pass. */
  const collect = (rows: readonly UnifiedSessionRow[], orphanOnly: boolean): UnifiedTreeNode[] => {
    const buckets = new Map<string, { repoKey: string | null; directory: string; rows: UnifiedSessionRow[] }>();
    for (const row of rows) {
      const workspace = row.directory ? workspaceByPath.get(row.directory) : undefined;
      if (orphanOnly !== (workspace?.orphan === true)) continue;
      const repoKey = workspace?.repoKey ?? null;
      const directory = row.directory ?? '';
      const bucketKey = `${repoKey ?? ''}\u0000${directory}`;
      const bucket = buckets.get(bucketKey) ?? { repoKey, directory, rows: [] };
      bucket.rows.push(row);
      buckets.set(bucketKey, bucket);
    }
    const worktrees: UnifiedTreeNode[] = [];
    const repoGroups = new Map<string, { name: string; children: UnifiedTreeNode[] }>();
    for (const bucket of buckets.values()) {
      const sessionsNode = sortSessions(bucket.rows).map((session) => sessionNode(session, nativeChildren, nativeByParent));
      if (!sessionsNode.length) continue;
      const worktree: UnifiedTreeNode = Object.freeze({
        kind: 'worktree',
        key: `worktree:${orphanOnly ? 'orphan' : bucket.repoKey ?? 'global'}:${bucket.directory || 'none'}`,
        name: bucket.directory ? bucket.directory.replace(/\/+$/, '').split('/').pop() || bucket.directory : 'No workspace',
        directory: bucket.directory,
        children: sessionsNode,
      });
      if (orphanOnly || !bucket.repoKey) worktrees.push(worktree);
      else {
        const repoKey = `repo:${bucket.repoKey}`;
        const group = repoGroups.get(repoKey) ?? { name: bucket.repoKey.replace(/\/+$/, '').split('/').pop() || bucket.repoKey, children: [] };
        group.children.push(worktree);
        repoGroups.set(repoKey, group);
      }
    }
    const repos = [...repoGroups.entries()].map(([key, group]) =>
      Object.freeze({ kind: 'repo' as const, key, name: group.name, children: group.children.sort(byName) }),
    );
    if (!worktrees.length) return repos.sort((left, right) => left.name.localeCompare(right.name));
    const section: UnifiedTreeNode = Object.freeze({
      kind: 'section',
      key: orphanOnly ? 'section:orphan' : 'section:global',
      section: orphanOnly ? ('orphan' as const) : ('global' as const),
      children: worktrees.sort(byName),
    });
    return [...repos.sort((left, right) => left.name.localeCompare(right.name)), section];
  };

  const active = sessions.filter((row) => row.parentSessionKey === null && !row.archived);
  const archived = sessions.filter((row) => row.parentSessionKey === null && row.archived);
  const nodes: UnifiedTreeNode[] = [...collect(active, false), ...collect(active, true)];
  const archivedSessions = sortSessions(archived).map((session) => sessionNode(session, nativeChildren, nativeByParent));
  if (archivedSessions.length) nodes.push(Object.freeze({ kind: 'section', key: 'section:archived', section: 'archived', children: archivedSessions }));
  const unparented = sessions
    .filter((row) => row.parentSessionKey !== null && !hosts.has(row.parentSessionKey))
    .map((session) => Object.freeze({ kind: 'native' as const, key: `native-unparented:${session.key}`, session, children: [] as readonly UnifiedTreeNode[] }));
  if (unparented.length) nodes.push(Object.freeze({ kind: 'section', key: 'section:native-unparented', section: 'native-unparented', children: sortSessions(unparented.map((node) => node.session)).map((session) => Object.freeze({ kind: 'native' as const, key: `native-unparented:${session.key}`, session, children: [] as readonly UnifiedTreeNode[] })) }));
  return nodes;
}

function nativeNode(parentKey: string, child: UnifiedSessionRow): UnifiedTreeNode {
  return Object.freeze({ kind: 'native', key: `native:${parentKey}:${child.key}`, session: child, children: [] as readonly UnifiedTreeNode[] });
}

function sessionNode(session: UnifiedSessionRow, nativeChildren: ReadonlyMap<string, readonly UnifiedSessionRow[]> | undefined, nativeByParent: ReadonlyMap<string, readonly UnifiedSessionRow[]>): UnifiedTreeNode {
  const merged = new Map<string, UnifiedSessionRow>();
  for (const child of nativeByParent.get(session.key) ?? []) merged.set(child.key, child);
  for (const child of nativeChildren?.get(session.key) ?? []) merged.set(child.key, child);
  const children = [...merged.values()].map((child) => nativeNode(session.key, child));
  return Object.freeze({ kind: 'session', key: session.key, session, children });
}

/** Flatten the expanded tree into the row list the virtual scroller renders. */
export function flattenUnifiedTree(
  nodes: readonly UnifiedTreeNode[],
  expanded: ReadonlySet<string>,
  filter: ReadonlySet<SessionHarness>,
): UnifiedFlatRow[] {
  const rows: UnifiedFlatRow[] = [];
  const walk = (list: readonly UnifiedTreeNode[], depth: number) => {
    for (const node of list) {
      if ((node.kind === 'session' || node.kind === 'native') && !filter.has(node.session.harness)) continue;
      const expandable = node.kind !== 'native' ? node.children.length > 0 : node.children.length > 0;
      const isOpen = expanded.has(node.key);
      rows.push(Object.freeze({ key: node.key, node, depth, expandable }));
      if (expandable && isOpen) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

function matchesQuery(row: UnifiedSessionRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  return row.title.toLowerCase().includes(needle)
    || row.nativeSessionId.toLowerCase().includes(needle)
    || HARNESS_LABELS[row.harness].toLowerCase().includes(needle)
    || (row.directory?.toLowerCase().includes(needle) ?? false);
}

export type UnifiedSessionTreeOptions = RuntimeStateOptions & Readonly<{ client: RuntimeClient; target: EnvironmentId }>;

/**
 * Create the unified tree over one environment target. The runtime state is
 * owned here (one instance, the task-20 layer) and disposed with the scope.
 */
export function useRuntimeSessionTree(options: UnifiedSessionTreeOptions) {
  const { client, target } = options;
  const history = options.history;
  const state = createRuntimeState({
    ...options,
    ...(history ? {
      history: {
        usage: history.usage,
        dispose: history.dispose,
        select: history.select,
        invalidate: (capture) => history.invalidate?.(capture),
      },
    } : {}),
  });  const kindById = new Map<string, SessionHarness>();
  const viewStatus = shallowRef<'loading' | 'partial' | 'complete' | 'error'>('loading');
  const viewLoaded = shallowRef(0);
  const viewError = shallowRef<ErrorCode | null>(null);
  const sessions = shallowRef<readonly UnifiedSessionRow[]>([]);
  const workspaces = shallowRef<readonly WorkspaceEntry[]>([]);
  const harnesses = shallowRef<readonly HarnessEntry[]>([]);
  const nativeChildren = shallowRef<ReadonlyMap<string, readonly UnifiedSessionRow[]>>(new Map());
  const childScans = shallowRef<ReadonlySet<string>>(new Set<string>());
  const expanded = shallowRef<ReadonlySet<string>>(new Set<string>());
  const filterKinds = shallowRef<ReadonlySet<SessionHarness>>(new Set<SessionHarness>([...HARNESS_KINDS, 'unknown']));
  const search = shallowRef<UnifiedSearchState>({ status: 'idle', query: '', scanned: 0, pages: 0, matches: [], error: null });
  const retrying = shallowRef<ReadonlySet<string>>(new Set());
  const selection = shallowRef(state.capture());
  const usage = shallowRef(state.usage());
  const started = shallowRef(false);
  const failure = shallowRef<ErrorCode | null>(null);
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let readChain: Promise<unknown> = Promise.resolve();
  let previousWindowKeys: ReadonlySet<string> = new Set<string>();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = readChain.then(work, work);
    readChain = next.then(() => undefined, () => undefined);
    return next;
  }
  function refreshFromState(): void {
    const view = state.view('session_summaries', target);
    const windowKeys = new Set<string>();
    try {
      viewStatus.value = view.status;
      viewLoaded.value = view.loaded;
      viewError.value = view.error?.code ?? null;
      const rows: UnifiedSessionRow[] = [];
      for (const item of view.items) {
        windowKeys.add(item.address.key);
        if (item.value === null || item.value === undefined) continue;
        const harnessInstanceId = asText(asRecord(asRecord(item.value)?.session)?.harnessInstanceId, 64);
        const parsed = parseUnifiedSessionRow(item.address.key, item.value, harnessInstanceId ? kindById.get(harnessInstanceId) ?? 'unknown' : 'unknown');
        if (parsed) rows.push(parsed);
      }
      sessions.value = Object.freeze(rows);
    } finally {
      view.release();
    }
    const captured = selection.value;
    if (captured && viewStatus.value !== 'loading') {
      const key = encodeSessionKey(captured.selection.session);
      if (previousWindowKeys.has(key) && !windowKeys.has(key)) void state.select(null).catch(() => {});
    }
    previousWindowKeys = windowKeys;
    selection.value = state.capture();
    usage.value = state.usage();
  }
  async function pageCollection(name: IndexCollection): Promise<Readonly<Record<string, unknown>>[]> {
    const items: Readonly<Record<string, unknown>>[] = [];
    const result = await client.snapshot(target, name, {
      onPage: (_collection, page) => {
        for (const item of page.items) {
          const record = asRecord(item);
          if (record && typeof record.key === 'string') items.push(record);
        }
      },
    });
    await result.observer.close();
    return items;
  }
  async function readTopology(): Promise<void> {
    // Sequential: the runtime client rejects a second concurrent snapshot with
    // `snapshot.pending`, and the state layer may still hold the paging lock.
    const harnessValues = await pageCollection('harnesses');
    const workspaceValues = await pageCollection('workspaces');
    if (disposed) return;
    const entries: HarnessEntry[] = [];
    for (const value of harnessValues) {
      const parsed = parseHarnessEntry(String(value.key), value.value);
      if (!parsed) continue;
      entries.push(parsed);
      kindById.set(parsed.harnessInstanceId, parsed.kind);
    }
    harnesses.value = Object.freeze(entries);
    const mapped: WorkspaceEntry[] = [];
    for (const value of workspaceValues) {
      const parsed = parseWorkspaceEntry(value.value);
      if (parsed) mapped.push(parsed);
    }
    workspaces.value = Object.freeze(mapped);
  }
  async function start(): Promise<void> {
    await state.start(target, { collection: 'session_summaries', visible: true });
    if (disposed) return;
    started.value = true;
    refreshFromState();
    unsubscribe = state.subscribe(() => { if (!disposed) refreshFromState(); });
    await serialize(readTopology);
    refreshFromState();
  }
  /** Re-read the state window and the index topology without restarting the target. */
  async function refresh(): Promise<void> {
    refreshFromState();
    await serialize(readTopology);
    refreshFromState();
  }
  /** Full-index search: traverses every session_summaries page, not the LRU window. */
  async function searchAll(query: string): Promise<UnifiedSearchState> {
    search.value = { status: 'searching', query, scanned: 0, pages: 0, matches: [], error: null };
    return serialize(async () => {
      const matches: UnifiedSessionRow[] = [];
      let scanned = 0;
      let pages = 0;
      try {
        const result = await client.snapshot(target, 'session_summaries', {
          onPage: (_collection, page) => {
            pages += 1;
            for (const item of page.items) {
              scanned += 1;
              const record = asRecord(item);
              if (!record || typeof record.key !== 'string') continue;
              const session = asRecord(record.value)?.session;
              const parsed = parseUnifiedSessionRow(record.key, record.value, kindById.get(asText(asRecord(session)?.harnessInstanceId, 64) ?? '') ?? 'unknown');
              if (!parsed || !matchesQuery(parsed, query) || !filterKinds.value.has(parsed.harness)) continue;
              matches.push(parsed);
            }
          },
        });
        await result.observer.close();
        const complete: UnifiedSearchState = { status: 'complete', query, scanned, pages, matches: Object.freeze(matches), error: null };
        search.value = complete;
        return complete;
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'source_unavailable';
        const failed: UnifiedSearchState = { status: 'error', query, scanned, pages, matches: Object.freeze(matches), error: code as ErrorCode };
        search.value = failed;
        return failed;
      }
    });
  }
  /** Child expand pagination: full-index scan for ONE parent's native children. */
  async function loadMoreChildren(parentKey: string): Promise<Readonly<{ parentKey: string; scanned: number; pages: number; added: number; duplicates: number; total: number; alreadyScanned: boolean }>> {
    if (childScans.value.has(parentKey)) {
      const existing = nativeChildren.value.get(parentKey) ?? [];
      return Object.freeze({ parentKey, scanned: 0, pages: 0, added: 0, duplicates: 0, total: existing.length, alreadyScanned: true });
    }
    return serialize(async () => {
      const found: UnifiedSessionRow[] = [];
      let scanned = 0;
      let pages = 0;
      const result = await client.snapshot(target, 'session_summaries', {
        onPage: (_collection, page) => {
          pages += 1;
          for (const item of page.items) {
            scanned += 1;
            const record = asRecord(item);
            if (!record || typeof record.key !== 'string') continue;
            const parsed = parseUnifiedSessionRow(record.key, record.value, kindById.get(asText(asRecord(asRecord(record.value)?.session)?.harnessInstanceId, 64) ?? '') ?? 'unknown');
            if (parsed && parsed.parentSessionKey === parentKey) found.push(parsed);
          }
        },
      });
      await result.observer.close();
      const existing = nativeChildren.value.get(parentKey) ?? [];
      const merged = new Map(existing.map((row) => [row.key, row]));
      let duplicates = 0;
      for (const row of found) {
        if (merged.has(row.key)) duplicates += 1;
        else merged.set(row.key, row);
      }
      const next = new Map(nativeChildren.value);
      next.set(parentKey, Object.freeze([...merged.values()]));
      nativeChildren.value = next;
      const scans = new Set(childScans.value);
      scans.add(parentKey);
      childScans.value = scans;
      return Object.freeze({ parentKey, scanned, pages, added: found.length - duplicates, duplicates, total: merged.size, alreadyScanned: false });
    });
  }
  /** Retry ONE failed source: re-invokes only that harness's native session.list. */
  async function retrySource(harnessInstanceId: string): Promise<Readonly<{ harnessInstanceId: string; retried: true }>> {
    const next = new Set(retrying.value);
    next.add(harnessInstanceId);
    retrying.value = next;
    try {
      await client.request(target, 'session.list', { harnessInstanceId: harnessInstanceId as HarnessInstanceId, args: {} });
      await serialize(readTopology);
      refreshFromState();
      return Object.freeze({ harnessInstanceId, retried: true as const });
    } finally {
      const left = new Set(retrying.value);
      left.delete(harnessInstanceId);
      retrying.value = left;
    }
  }
  function toggleExpand(key: string): void {
    const next = new Set(expanded.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded.value = next;
  }
  function setFilterKinds(kinds: readonly SessionHarness[]): void {
    filterKinds.value = new Set(kinds);
  }
  async function select(session: SessionRef | null): Promise<boolean> {
    const captured = await state.select(session);
    selection.value = state.capture();
    return captured !== null;
  }
  async function selectByKey(key: string): Promise<boolean> {
    try {
      return await select(decodeSessionKey(key));
    } catch {
      return false;
    }
  }
  const tree = computed(() => buildUnifiedTree(sessions.value, workspaces.value, nativeChildren.value));
  const rows = computed(() => flattenUnifiedTree(tree.value, expanded.value, filterKinds.value));
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    sessions.value = Object.freeze([]);
    await state.dispose();
    usage.value = state.usage();
  }
  if (getCurrentScope()) {
    onScopeDispose(() => { void dispose().catch((error: unknown) => { failure.value = (error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'source_unavailable') as ErrorCode; }); });
  }
  return {
    start, refresh, dispose,
    rows, tree, sessions, workspaces, harnesses, nativeChildren, childScans,
    viewStatus, viewLoaded, viewError, selection, usage, failure, started,
    expanded, toggleExpand, filterKinds, setFilterKinds,
    search: searchAll, searchState: search, loadMoreChildren, retrySource, retrying,
    select, selectByKey,
    state,
  };
}

export type UnifiedSessionTree = ReturnType<typeof useRuntimeSessionTree>;
export type { RuntimeState };
