import { describe, expect, it } from 'vitest';
import { HARNESS_KINDS, useRuntimeSessionTree, type HarnessKind } from './useRuntimeSessionTree';
import { encodeSessionKey, parseConnectionProfileId } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';

/**
 * Regression for PR #182 reviewer round-2, task-21 finding 1 (P2):
 * deleting the currently selected session must clear the selection exactly
 * once. The composable's refresh callback observes a one-page window; when the
 * selected session leaves that window it clears the selection through
 * `state.select(null)`, which notifies synchronously and re-enters the
 * callback. On the unchanged code the local `previousWindowKeys`/`selection`
 * markers are still stale during that synchronous re-entry, so the callback
 * repeats the clear until the stack overflows (RangeError; `history.select`
 * observed more than a thousand times for a single delete).
 *
 * These tests drive the REAL composable over the REAL task-20 state layer
 * (app/runtime/state.ts + entityCache.ts + selectionScope.ts). The only
 * controlled boundary is the runtime client fixture, which serves the bridge's
 * canonical entity shapes AND can deliver a tombstone `entity.patch` through
 * the observer exactly like the bridge does on delete.
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

function sessionRef(index: number, harness: HarnessKind = 'opencode'): SessionRef {
  return { environmentId: ENV, harnessInstanceId: HARNESS_IDS[harness], nativeSessionId: `session-${index}` };
}
function sessionKey(index: number, harness: HarnessKind = 'opencode'): string {
  return encodeSessionKey(sessionRef(index, harness));
}
function summaryValue(index: number): AnyRecord {
  return {
    session: sessionRef(index),
    title: `title-${index}`,
    directory: DIRECTORY,
    archived: false,
    pinned: false,
    parentSession: null,
    createdAt: 1700000000000 + index,
    updatedAt: 1700000000000 + index,
    status: 'idle',
  };
}
function canonical(key: string, revision: number, value: unknown): AnyRecord {
  return { collection: 'session_summaries', key, revision, value };
}

type ObserverDelivery = Readonly<{ kind: string; frame?: AnyRecord }>;
type SnapshotPage = Readonly<{ collection: string; items: readonly unknown[]; cursor: string | null; token: string; revision: number; watermark: number; expiresAt: number; target: string; epoch: string; generation: number }>;

/**
 * Runtime client fixture. Serves canonical entities over the same call surface
 * the real composable/state use (scope/onDetach/snapshot/request) and exposes a
 * `deleteSession` that delivers a tombstone `entity.patch` through the observer,
 * mirroring the bridge's delete path (`value: null` reconcile).
 */
class ReactiveClient {
  private readonly rows = new Map<string, AnyRecord[]>();
  private readonly canonicalRows = new Map<string, unknown>();
  private readonly tombstones = new Set<string>();
  private readonly queue: ObserverDelivery[] = [];
  private revision = 1000;
  private seq = 0;
  constructor(readonly environment: string = ENV) {}
  add(collection: string, row: AnyRecord): void {
    const list = this.rows.get(collection) ?? [];
    list.push(row);
    this.rows.set(collection, list);
    if (collection === 'session_summaries' && typeof row.key === 'string') this.canonicalRows.set(row.key, row.value);
  }
  scope() {
    return { binding: { target: this.environment as EnvironmentId, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => true };
  }
  onDetach(): () => void { return () => {}; }
  async snapshot(target: EnvironmentId, collections: string | readonly string[], options: { onPage: (collection: string, page: SnapshotPage) => Promise<void> | void; onDelivery?: (delivery: ObserverDelivery) => Promise<void> | void }): Promise<{ token: string; revision: number; watermark: number; observer: { read(): Promise<ObserverDelivery | null>; close(): Promise<void> } }> {
    const names = typeof collections === 'string' ? [collections] : collections;
    for (const name of names) {
      const rows = this.rows.get(name) ?? [];
      for (let offset = 0; offset === 0 || offset < rows.length; offset += 200) {
        const page = rows.slice(offset, offset + 200);
        await options.onPage(name, {
          collection: name, items: page, cursor: offset + 200 < rows.length ? String(offset + 200) : null,
          token: 'snapshot-1', revision: this.revision, watermark: 0, expiresAt: Date.now() + 60000, target, epoch: 'epoch', generation: 1,
        });
        if (offset + 200 >= rows.length) break;
      }
    }
    return {
      token: 'snapshot-1', revision: this.revision, watermark: 0,
      observer: {
        read: async () => {
          // Bounded poll: wake quickly on a queued delivery, otherwise yield so
          // the state run loop can observe an aborted controller and stop.
          if (this.queue.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 5));
          if (this.queue.length === 0) return null;
          const delivery = this.queue.shift()!;
          await options.onDelivery?.(delivery);
          return delivery;
        },
        close: async () => {},
      },
    };
  }
  async readIndex(target: EnvironmentId, collections: string | readonly string[], options: { onPage: (collection: string, page: SnapshotPage) => Promise<void> | void }): Promise<{ token: string; revision: number; watermark: number }> {
    const names = typeof collections === 'string' ? [collections] : collections;
    for (const name of names) {
      const rows = this.rows.get(name) ?? [];
      for (let offset = 0; offset === 0 || offset < rows.length; offset += 200) {
        const page = rows.slice(offset, offset + 200);
        await options.onPage(name, {
          collection: name, items: page, cursor: offset + 200 < rows.length ? String(offset + 200) : null,
          token: 'snapshot-1', revision: this.revision, watermark: 0, expiresAt: Date.now() + 60000, target, epoch: 'epoch', generation: 1,
        });
        if (offset + 200 >= rows.length) break;
      }
    }
    return { token: 'snapshot-1', revision: this.revision, watermark: 0 };
  }
  async request(_target: EnvironmentId, method: string, params: AnyRecord): Promise<unknown> {
    if (method === 'runtime.entity.resolve') {
      const event = params.event as AnyRecord;
      const payload = event.payload as AnyRecord;
      const key = String(payload.key);
      return { collection: 'session_summaries', key, revision: this.revision, value: this.tombstones.has(key) ? null : this.canonicalRows.get(key) };
    }
    if (method === 'session.list') return { items: [], cursor: null, completeness: 'complete' };
    throw new TypeError(`unexpected method ${method}`);
  }
  /** Deliver a tombstone entity.patch for `key` through the observer. */
  deleteSession(key: string): void {
    this.tombstones.add(key);
    this.revision += 1;
    this.rows.set('session_summaries', (this.rows.get('session_summaries') ?? []).filter((row) => row.key !== key));
    this.queue.push({
      kind: 'event',
      frame: {
        version: 1, kind: 'event', target: ENV, epoch: 'epoch', generation: 1, seq: ++this.seq,
        entityRevision: this.revision, scope: key, type: 'entity.patch',
        payload: { collection: 'session_summaries', key, deleted: true },
      },
    });
  }
}

function seedTopology(client: ReactiveClient): void {
  for (const kind of HARNESS_KINDS) {
    client.add('harnesses', {
      collection: 'harnesses', key: HARNESS_IDS[kind], revision: 1,
      value: { environmentId: ENV, harnessInstanceId: HARNESS_IDS[kind], kind, indexDiscovery: [{ scopeKey: '{}', status: 'complete', count: 10 }] },
    });
  }
  client.add('workspaces', {
    collection: 'workspaces', key: 'workspace:/repo', revision: 1,
    value: { kind: 'workspace', workspace: { environmentId: ENV, canonicalPath: DIRECTORY, pathPolicy: { platform: 'posix', caseSensitive: true, volumeId: 'vol' } }, sources: [], orphan: false, gitKind: 'git', repoKey: REPO_KEY },
  });
}

function historySpy(): { selects: Array<unknown>; history: AnyRecord } {
  const selects: Array<unknown> = [];
  return {
    selects,
    history: {
      usage: () => ({ residentBytes: 0, reservedBytes: 0, entries: 0 }),
      dispose: () => {},
      select: (capture: unknown) => { selects.push(capture); },
    },
  };
}

async function waitFor(predicate: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: condition not met before timeout');
}

describe('useRuntimeSessionTree — selection clear on delete', () => {
  it('deleting the currently selected session clears selection exactly once (no recursion)', async () => {
    const client = new ReactiveClient();
    seedTopology(client);
    const key = sessionKey(0);
    client.add('session_summaries', canonical(key, 1, summaryValue(0)));
    const { selects, history } = historySpy();
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV, history: history as never });
    try {
      await tree.start();
      expect(tree.viewStatus.value).toBe('complete');
      expect(await tree.selectByKey(key)).toBe(true);
      expect(tree.selection.value).not.toBeNull();
      expect(selects).toHaveLength(1);
      selects.length = 0;

      client.deleteSession(key);

      // The observer delivery re-enters the refresh callback synchronously.
      await waitFor(() => tree.selection.value === null);
      // Exactly one clear: the deletion clear. The unchanged code recurses and
      // observes `history.select` hundreds/thousands of times for this delete.
      expect(selects).toHaveLength(1);
      expect(tree.viewStatus.value).toBe('complete');
    } finally {
      await tree.dispose();
    }
  });

  it('deleting a NON-selected session leaves the selection unchanged (zero clears)', async () => {
    const client = new ReactiveClient();
    seedTopology(client);
    const selected = sessionKey(0);
    const other = sessionKey(1);
    client.add('session_summaries', canonical(selected, 1, summaryValue(0)));
    client.add('session_summaries', canonical(other, 2, summaryValue(1)));
    const { selects, history } = historySpy();
    const tree = useRuntimeSessionTree({ client: client as never, profileId: PROFILE, target: ENV, history: history as never });
    try {
      await tree.start();
      expect(await tree.selectByKey(selected)).toBe(true);
      selects.length = 0;

      client.deleteSession(other);

      await waitFor(() => {
        const view = tree.state.view('session_summaries', ENV);
        const present = view.items.some((item) => item.address.key === other);
        view.release();
        return !present;
      });
      expect(tree.selection.value).not.toBeNull();
      expect(selects).toHaveLength(0);
      expect(tree.viewStatus.value).toBe('complete');
    } finally {
      await tree.dispose();
    }
  });
});
