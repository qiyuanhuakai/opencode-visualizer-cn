// @vitest-environment node
/**
 * Task 36 acceptance + failure-class tests — bounded auxiliary-history paging.
 *
 * Three HARD acceptance criteria from the plan, each proven by a named test that drives the REAL
 * product and asserts OBSERVED numbers (never prose):
 *
 *   AC1 "history 页和 native canonical 合并不倒退 tool terminal/text"
 *       — merging a history page into the native canonical never regresses a tool that already
 *         reached a terminal state, nor its terminal text. Driven on the real bridge merge
 *         (auxiliaryMerge.js) and through the real app cache (historyPages.ts).
 *
 *   AC2 "inactive cache 可 evict 再读"
 *       — an inactive resident page can be evicted and then re-read, returning hash-equal content,
 *         with the observed resident byte size and page count before and after.
 *
 *   AC3 "aux write durable ack 失败保留 dirty recovery，不堆所有 history"
 *       — when a durable write's ack fails, the dirty records are retained (bounded) for recovery
 *         and the full history is NOT buffered in memory.
 *
 * Failure classes from the plan's Failure QA: history page gap / corrupt record, old-generation
 * write, terminal overwritten by running, a single message > 2 MiB (oversized chunking), and a
 * durable-ack (DB) failure.
 *
 * The bridge modules are imported statically (they ship .d.ts type declarations, the repo's
 * convention for app-consumed bridge modules); the app cache is imported statically too. Every
 * expected value below is derived by construction from the fixtures, so the assertions are exact.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NATIVE_AUXILIARY_PAGED_NAMESPACE,
  openNativeAuxiliaryPaging,
} from '../backends/codex/nativeAuxiliaryStorage';
import { openCodexAuxiliaryPaging } from '../backends/codex/auxiliaryStorage';
import {
  BACKEND_HISTORY_PAGED_NAMESPACE,
  openBackendHistoryPaging,
} from '../utils/backendHistoryStorage';
import type { SessionDatabaseApi } from '../types/sessionDatabase';
import {
  AUXILIARY_TERMINAL_TOOL_STATUSES,
  isTerminalTextPart,
  isTerminalToolPart,
  mergeAuxiliaryCanonical,
} from '../../bridge/runtime/history/auxiliaryMerge.js';
import {
  AUXILIARY_HISTORY_LIMITS,
  createAuxiliaryHistoryService,
} from '../../bridge/runtime/history/historyService.js';
import {
  BACKEND_AUXILIARY_PAGED_NAMESPACE,
  createHistoryPageCache,
} from './historyPages';
import type { AuxiliaryEntry, AuxiliaryHistoryPage } from './historyPages';

const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A scripted reader: page N is returned for the Nth distinct cursor; call counts are observed so a
// re-read is distinguishable from a cache hit.
function scriptedReader(pages: readonly (readonly AuxiliaryEntry[])[]) {
  const calls: (string | null)[] = [];
  const reader = async (cursor: string | null) => {
    calls.push(cursor);
    const index = cursor === null ? 0 : Number(cursor);
    const entries = pages[index] ?? [];
    const next = index + 1 < pages.length ? String(index + 1) : null;
    return { entries: entries as unknown[], nextCursor: next };
  };
  return { reader, calls };
}

const disposables: { dispose(): void }[] = [];
afterEach(() => { for (const disposable of disposables.splice(0)) disposable.dispose(); });

function toolEntry(id: string, status: string, output: string, end?: number): AuxiliaryEntry {
  return {
    info: { id, time: { created: 1 } },
    parts: [{
      id: `${id}:tool`, type: 'tool', callID: `call-${id}`, tool: 'bash',
      state: { status, input: {}, output, ...(end === undefined ? {} : { time: { start: 1, end } }) },
    }],
  };
}
function textEntry(id: string, text: string, end?: number): AuxiliaryEntry {
  return {
    info: { id, time: { created: 1 } },
    parts: [{ id: `${id}:text`, type: 'text', text, ...(end === undefined ? {} : { time: { start: 1, end } }) }],
  };
}

function mockDatabase(overrides: Partial<SessionDatabaseApi> = {}): SessionDatabaseApi {
  return {
    readHistory: async () => ({ entries: [], nextCursor: null }),
    upsertHistory: async () => {},
    clearHistory: async () => {},
    flush: async () => {},
    onHistoryChanged: () => () => {},
    ...overrides,
  };
}

describe('the 16 MiB / three-page ceiling is the landed shared budget', () => {
  it('freezes the three-page and 16 MiB resident limits the paging service enforces', () => {
    expect(AUXILIARY_HISTORY_LIMITS.pages).toBe(3);
    expect(AUXILIARY_HISTORY_LIMITS.residentBytes).toBe(16777216);
    expect(AUXILIARY_HISTORY_LIMITS.entryInlineBytes).toBe(2097152);
    expect(AUXILIARY_HISTORY_LIMITS.chunkBytes).toBe(65536);
    expect(Object.isFrozen(AUXILIARY_HISTORY_LIMITS)).toBe(true);
  });
});

describe('AC1 — merging a history page with native canonical never regresses tool terminal/text', () => {
  it('a tool that already reached completed is not overwritten by a later running record, and terminal text is kept', () => {
    const terminalTool = toolEntry('m1', 'completed', 'FINAL OUTPUT', 2);
    const terminalText = textEntry('m1', 'final answer', 3);
    const nativeCanonical: AuxiliaryEntry[] = [
      { info: terminalTool.info, parts: [terminalTool.parts[0]!, terminalText.parts[0]!] },
    ];
    const historyPage: AuxiliaryEntry[] = [toolEntry('m1', 'running', '')]; // later, non-terminal

    const before = nativeCanonical[0]!.parts;
    const merged = mergeAuxiliaryCanonical(nativeCanonical, historyPage);
    const after = merged[0]!.parts;

    // The terminal tool part survived: still completed with its final output, not the running stub.
    const tool = after.find(part => part.id === 'm1:tool')!;
    expect(tool.state?.status).toBe('completed');
    expect(tool.state?.output).toBe('FINAL OUTPUT');
    // The terminal text survived: still "final answer" with its end time.
    const text = after.find(part => part.id === 'm1:text')!;
    expect(text.text).toBe('final answer');
    expect(text.time?.end).toBe(3);
    // Observed before/after: the terminal state and text are identical across the merge.
    expect(after).toEqual(before);
    // Read model is frozen.
    expect(Object.isFrozen(merged)).toBe(true);
    expect(Object.isFrozen(merged[0])).toBe(true);
    expect(Object.isFrozen(merged[0]!.parts)).toBe(true);
  });

  it('a terminal tool/continuation is not regressed through the real app cache merge either', () => {
    const cache = createHistoryPageCache({
      namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE,
      read: async () => ({ entries: [], nextCursor: null }),
    });
    disposables.push(cache);
    const canonical: AuxiliaryEntry[] = [
      { info: { id: 'c1', time: { created: 5 } }, parts: [{ id: 'c1:cont', type: 'continuation', text: 'done reasoning', time: { start: 1, end: 9 } }] },
    ];
    const page: AuxiliaryHistoryPage = {
      pageId: 'p', cursor: null, nextCursor: null, bytes: 0,
      entries: [{ info: { id: 'c1', time: { created: 5 } }, parts: [{ id: 'c1:cont', type: 'continuation', text: 'done' }] }],
      oversized: [],
    };
    const merged = cache.mergeWithCanonical(canonical, page);
    const cont = merged[0]!.parts[0]!;
    expect(isTerminalTextPart(cont)).toBe(true);
    expect(cont.text).toBe('done reasoning');
    expect(cont.time?.end).toBe(9);
  });

  it('exposes the terminal status set used by the guard', () => {
    expect([...AUXILIARY_TERMINAL_TOOL_STATUSES]).toEqual(['completed', 'error']);
    expect(isTerminalToolPart({ type: 'tool', state: { status: 'error' } })).toBe(true);
    expect(isTerminalToolPart({ type: 'tool', state: { status: 'running' } })).toBe(false);
  });
});

describe('AC2 — an inactive cache page can be evicted and re-read (hash-equal) with observed sizes', () => {
  it('evicts an inactive page then re-reads identical content, with resident bytes/pageCount observed before and after', async () => {
    const pages: AuxiliaryEntry[][] = [
      [textEntry('a0', 'page-zero-body')],
      [textEntry('a1', 'page-one-body')],
      [textEntry('a2', 'page-two-body')],
    ];
    const { reader, calls } = scriptedReader(pages);
    const service = createAuxiliaryHistoryService({ reader, limits: { pages: 3 } });
    disposables.push(service);

    const p0 = await service.page(null);
    await service.page('1');
    await service.page('2');
    // Cache is full at the three-page ceiling.
    expect(service.usage().pageCount).toBe(3);
    const residentBefore = service.usage().residentBytes;
    expect(residentBefore).toBeGreaterThan(0);
    const hashBefore = hashOf(p0.entries);

    // Evict the inactive first page; observe the resident size and count drop.
    const receipt = service.evict(p0.pageId);
    expect(receipt.evicted).toBe(true);
    expect(receipt.freedBytes).toBeGreaterThan(0);
    expect(service.usage().pageCount).toBe(2);
    expect(service.usage().residentBytes).toBe(residentBefore - receipt.freedBytes);
    expect(service.usage().evicted).toBe(1);
    expect(service.get(p0.pageId)).toBeNull();

    // Re-read the evicted page: identical (hash-equal) content, cache grows back to three pages.
    const readsBefore = calls.length;
    const p0again = await service.reread(null);
    expect(calls.length).toBe(readsBefore + 1); // a real re-read hit the reader, not the cache
    expect(hashOf(p0again.entries)).toBe(hashBefore);
    expect(service.usage().rereads).toBe(1);
    expect(service.usage().pageCount).toBe(3);
    expect(service.usage().residentBytes).toBe(residentBefore);
  });

  it('reading a fourth page past the ceiling evicts the least-recently-used inactive page', async () => {
    const pages: AuxiliaryEntry[][] = [
      [textEntry('b0', 'x')], [textEntry('b1', 'x')], [textEntry('b2', 'x')], [textEntry('b3', 'x')],
    ];
    const { reader } = scriptedReader(pages);
    const service = createAuxiliaryHistoryService({ reader, limits: { pages: 3 } });
    disposables.push(service);
    const p0 = await service.page(null);
    await service.page('1');
    await service.page('2');
    expect(service.usage().pageCount).toBe(3);
    // Touch p0 to make it most-recently-used, then read a fourth page.
    await service.page(null);
    const p3 = await service.page('3');
    expect(service.usage().pageCount).toBe(3); // still bounded
    expect(service.get(p0.pageId)).not.toBeNull(); // recently used page survived
    expect(service.get(p3.pageId)).not.toBeNull();
    expect(service.usage().evicted).toBeGreaterThanOrEqual(1);
  });
});

describe('AC3 — a failed durable-ack retains bounded dirty recovery without buffering all history', () => {
  it('retains the dirty records (bounded) after the durable ack fails and never buffers the whole history', async () => {
    let failAck = true;
    const persister = async () => { if (failAck) throw new Error('durable ack rejected: disk full'); };
    const service = createAuxiliaryHistoryService({
      reader: async () => ({ entries: [], nextCursor: null }),
      persister,
      limits: { dirtyMaxCount: 8, dirtyMaxBytes: 1024 * 1024 },
    });
    disposables.push(service);

    const staged: AuxiliaryEntry[] = Array.from({ length: 5 }, (_, index) => textEntry(`dirty-${index}`, 'y'.repeat(200)));
    service.stage(staged);
    expect(service.usage().dirtyCount).toBe(5);
    const dirtyBytes = service.usage().dirtyBytes;
    expect(dirtyBytes).toBeGreaterThan(0);
    expect(dirtyBytes).toBeLessThanOrEqual(1024 * 1024);

    // The durable ack fails.
    await expect(service.commit()).rejects.toMatchObject({ code: 'source_unavailable', field: 'history.durable_ack' });
    // Dirty recovery is retained for retry — bounded, and the full history was never buffered.
    expect(service.usage().dirtyCount).toBe(5);
    expect(service.usage().dirtyBytes).toBe(dirtyBytes);
    expect(service.usage().bufferedHistory).toBe(false);
    expect(service.usage().retainedBytes).toBeLessThanOrEqual(1024 * 1024 + service.usage().residentBytes);

    // Retrying after the ack recovers clears the dirty set.
    failAck = false;
    const result = await service.commit();
    expect(result.committed).toBe(5);
    expect(service.usage().dirtyCount).toBe(0);
    expect(service.usage().dirtyBytes).toBe(0);
  });

  it('refuses to stage past the dirty budget instead of piling up all history', () => {
    const service = createAuxiliaryHistoryService({
      reader: async () => ({ entries: [], nextCursor: null }),
      persister: async () => {},
      limits: { dirtyMaxCount: 4, dirtyMaxBytes: 1024 * 1024 },
    });
    disposables.push(service);
    service.stage(Array.from({ length: 4 }, (_, index) => textEntry(`cap-${index}`, 'z')));
    expect(service.usage().dirtyCount).toBe(4);
    // The next stage that would exceed the count budget is rejected with an explicit code.
    expect(() => service.stage([textEntry('cap-overflow', 'z')])).toThrow(
      expect.objectContaining({ code: 'invalid_request', field: 'history.dirty_budget' }),
    );
    expect(service.usage().dirtyCount).toBe(4); // unchanged — nothing was buffered
  });

  it('rejects a whole batch whose later record exceeds the dirty budget, leaving nothing staged', () => {
    const reader = async () => ({ entries: [], nextCursor: null });
    const persister = async () => {};
    const countOnly = createAuxiliaryHistoryService({ reader, persister, limits: { dirtyMaxCount: 1, dirtyMaxBytes: 1024 * 1024 } });
    disposables.push(countOnly);
    expect(() => countOnly.stage([textEntry('batch-a', 'a'), textEntry('batch-b', 'b')])).toThrow(
      expect.objectContaining({ code: 'invalid_request', field: 'history.dirty_budget' }),
    );
    expect(countOnly.usage()).toMatchObject({ dirtyCount: 0, dirtyBytes: 0 });

    const bytesOnly = createAuxiliaryHistoryService({ reader, persister, limits: { dirtyMaxCount: 8, dirtyMaxBytes: 400 } });
    disposables.push(bytesOnly);
    expect(() => bytesOnly.stage([textEntry('bytes-a', 'a'.repeat(300)), textEntry('bytes-b', 'b'.repeat(300))])).toThrow(
      expect.objectContaining({ code: 'invalid_request', field: 'history.dirty_budget' }),
    );
    expect(bytesOnly.usage()).toMatchObject({ dirtyCount: 0, dirtyBytes: 0 });

    const oversized = createAuxiliaryHistoryService({ reader, persister, limits: { dirtyMaxCount: 8, dirtyMaxBytes: 700 } });
    disposables.push(oversized);
    oversized.stage([textEntry('bytes-a', 'a'.repeat(300))]);
    const before = oversized.usage();
    expect(before).toMatchObject({ dirtyCount: 1, dirtyBytes: 402 });
    // The first record of the batch is affordable; the second is not, so neither may be staged.
    expect(() => oversized.stage([textEntry('bytes-c', 'c'.repeat(50)), textEntry('bytes-d', 'd'.repeat(300))])).toThrow(
      expect.objectContaining({ code: 'invalid_request', field: 'history.dirty_budget' }),
    );
    expect(oversized.usage()).toMatchObject({ dirtyCount: before.dirtyCount, dirtyBytes: before.dirtyBytes });
  });

  it('rejects an update-plus-insert batch whose insert cannot be afforded without applying the update', async () => {
    const committed: AuxiliaryEntry[] = [];
    const service = createAuxiliaryHistoryService({
      reader: async () => ({ entries: [], nextCursor: null }),
      persister: async (entries) => { committed.push(...entries); },
      limits: { dirtyMaxCount: 1, dirtyMaxBytes: 1024 * 1024 },
    });
    disposables.push(service);
    service.stage([textEntry('update-target', 'old')]);
    expect(service.usage().dirtyCount).toBe(1);

    // The batch updates the already-dirty record and then inserts a second one: the insert is
    // refused, and the update must not have been applied either.
    expect(() => service.stage([textEntry('update-target', 'new'), textEntry('insert-blocked', 'n')])).toThrow(
      expect.objectContaining({ code: 'invalid_request', field: 'history.dirty_budget' }),
    );
    expect(service.usage().dirtyCount).toBe(1);
    await service.commit();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.parts[0]).toMatchObject({ type: 'text', text: 'old' });
    expect(service.usage()).toMatchObject({ dirtyCount: 0, dirtyBytes: 0 });
  });
});

describe('failure classes — history page gap / corrupt record, old-generation write, oversized chunk', () => {
  it('a corrupt record in a page is rejected with an explicit code and loses no already-merged data', async () => {
    const reader = async () => ({ entries: [{ info: { time: { created: 1 } }, parts: [] } as unknown], nextCursor: null }); // missing info.id
    const service = createAuxiliaryHistoryService({ reader });
    disposables.push(service);
    await expect(service.page(null)).rejects.toMatchObject({ code: 'invalid_request', field: 'history.record' });
    expect(service.usage().pageCount).toBe(0); // nothing resident, nothing lost
  });

  it('a page gap (repeated cursor) is rejected with source_unavailable instead of looping forever', async () => {
    let first = true;
    const reader = async () => {
      if (first) { first = false; return { entries: [textEntry('g0', 'x')] as unknown[], nextCursor: '1' }; }
      return { entries: [textEntry('g1', 'x')] as unknown[], nextCursor: '1' };
    };
    const service = createAuxiliaryHistoryService({ reader });
    disposables.push(service);
    await service.page(null);
    await expect(service.page('1')).rejects.toMatchObject({ code: 'source_unavailable', field: 'history.cursor' });
  });

  it('an old-generation write is rejected with a conflict code and changes nothing', () => {
    const service = createAuxiliaryHistoryService({ reader: async () => ({ entries: [], nextCursor: null }), persister: async () => {} });
    disposables.push(service);
    service.stage([textEntry('gen-2', 'x')], 2); // establishes generation 2
    expect(service.usage().dirtyCount).toBe(1);
    expect(() => service.stage([textEntry('gen-1', 'x')], 1)).toThrow(
      expect.objectContaining({ code: 'conflict', field: 'history.generation' }),
    );
    expect(service.usage().dirtyCount).toBe(1); // the stale write added nothing
  });

  it('a single message larger than the 2 MiB inline ceiling is chunked and charged at its real size', async () => {
    const bigText = 'A'.repeat(3 * 1024 * 1024); // 3 MiB > 2 MiB entryInlineBytes
    const reader = async () => ({ entries: [textEntry('big', bigText)] as unknown[], nextCursor: null });
    const service = createAuxiliaryHistoryService({ reader, limits: { entryInlineBytes: 2 * 1024 * 1024, chunkBytes: 65536 } });
    disposables.push(service);
    const page = await service.page(null);
    // The oversized entry is represented as a chunked reference, and its body is CHARGED to the
    // resident budget at its real size — a reference that costs nothing would let the page hold
    // unbounded bytes while the budget reported a rounding error.
    expect(page.oversized).toHaveLength(1);
    expect(page.oversized[0]!.entryId).toBe('big');
    expect(page.bytes).toBeGreaterThan(bigText.length - 64);
    expect(service.usage().residentBytes).toBe(page.bytes);
    // Reading a chunk returns a bounded BYTE slice of the real body.
    const descriptorId = page.oversized[0]!.descriptorId;
    const chunk = await service.chunk(page.pageId, descriptorId, 0);
    expect(chunk.bytes).toBeInstanceOf(Uint8Array);
    expect(chunk.bytes.byteLength).toBeLessThanOrEqual(65536);
    expect(chunk.bytes.byteLength).toBeGreaterThan(0);
    const serialized = JSON.stringify(textEntry('big', bigText));
    expect(new TextDecoder().decode(chunk.bytes)).toBe(serialized.slice(0, 65536));
  });
});

describe('wiring — the storage modules expose the bounded paging under the NEW namespaces', () => {
  it('opens a bounded native auxiliary paging cache over the real sessionDatabase read/upsert contract', async () => {
    const readHistory = vi.fn(async () => ({ entries: [textEntry('n0', 'native-page')], nextCursor: null }));
    const upsertHistory = vi.fn(async () => {});
    const cache = openNativeAuxiliaryPaging(mockDatabase({ readHistory, upsertHistory }), 'thread-1');
    expect(cache).toBeDefined();
    expect(cache!.namespace).toBe(NATIVE_AUXILIARY_PAGED_NAMESPACE);
    const page = await cache!.page(null);
    expect(readHistory).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1', namespace: NATIVE_AUXILIARY_PAGED_NAMESPACE, limit: 200 }));
    expect(page.entries.map(entry => entry.info.id)).toEqual(['n0']);
    disposables.push(cache!);
  });

  it('opens a bounded backend history paging cache under the new backend-history-paged-v2 namespace', async () => {
    const readHistory = vi.fn(async () => ({ entries: [textEntry('bk0', 'backend-page')], nextCursor: null }));
    const cache = openBackendHistoryPaging(mockDatabase({ readHistory }), 'child-1', 'opencode', 'scope-x');
    expect(cache).toBeDefined();
    expect(cache!.namespace.startsWith(`${BACKEND_HISTORY_PAGED_NAMESPACE}:`)).toBe(true);
    const page = await cache!.page(null);
    expect(readHistory).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'child-1', namespace: expect.stringMatching(/^backend-history-paged-v2:[a-f0-9]{32}$/u) }));
    expect(page.entries.map(entry => entry.info.id)).toEqual(['bk0']);
    disposables.push(cache!);
  });

  it('the codex facade returns undefined without a native database and never throws', () => {
    expect(openCodexAuxiliaryPaging('thread-x')).toBeUndefined();
  });

  it('returns undefined (not a cache) when no database is available', () => {
    expect(openNativeAuxiliaryPaging(undefined, 'thread-1')).toBeUndefined();
    expect(openBackendHistoryPaging(undefined, 'child-1', 'opencode', 'scope-x')).toBeUndefined();
  });
});

describe('review findings — the paging budget, the chunk payload, the dirty buffer and the ack window', () => {
  const bigText = (size: number): string => 'A'.repeat(size);
  const body = (id: string, text: string): unknown[] => [textEntry(id, text)] as unknown[];

  it('an oversized body is charged to the resident budget, so a page that would blow it is refused', async () => {
    const over = 20 * 1024 * 1024;
    const service = createAuxiliaryHistoryService({
      reader: async () => ({ entries: body('huge', bigText(over)), nextCursor: null }),
      limits: { entryInlineBytes: 2 * 1024 * 1024, residentBytes: 16 * 1024 * 1024 },
    });
    disposables.push(service);
    await expect(service.page(null)).rejects.toMatchObject({ code: 'source_unavailable', field: 'history.memory' });
    expect(service.usage().residentBytes).toBe(0);
    expect(service.usage().pageCount).toBe(0);
  });

  it('a chunk carries the real bytes, and a non-ASCII body walks to the end at the declared size', async () => {
    const han = '汉'.repeat(800000);
    const serialized = JSON.stringify(textEntry('han', han));
    const service = createAuxiliaryHistoryService({
      reader: async () => ({ entries: body('han', han), nextCursor: null }),
      limits: { entryInlineBytes: 1024, chunkBytes: 65536 },
    });
    disposables.push(service);
    const page = await service.page(null);
    const descriptorId = page.oversized[0]!.descriptorId;

    const decoder = new TextDecoder();
    let reassembled = '';
    let offset = 0;
    let chunks = 0;
    for (let step = 0; step < 100000; step += 1) {
      const chunk = await service.chunk(page.pageId, descriptorId, offset);
      expect(chunk.bytes).toBeInstanceOf(Uint8Array);
      expect(chunk.bytes.byteLength).toBeLessThanOrEqual(65536);
      reassembled += decoder.decode(chunk.bytes, { stream: true });
      chunks += 1;
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    reassembled += decoder.decode();
    expect(chunks).toBeGreaterThan(1);
    expect(reassembled).toBe(serialized);
  });

  it('a same-id record staged again replaces the staged version instead of dropping it', async () => {
    const persisted: { parts: { text: string }[] }[] = [];
    const service = createAuxiliaryHistoryService({
      reader: async () => ({ entries: [], nextCursor: null }),
      persister: async (batch) => { persisted.push(...(batch as unknown as { parts: { text: string }[] }[])); },
    });
    disposables.push(service);
    service.stage([textEntry('m-1', 'partial stream')], 1);
    service.stage([textEntry('m-1', 'the final complete answer')], 2);
    await service.commit();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.parts[0]!.text).toBe('the final complete answer');
    expect(service.usage().dirtyCount).toBe(0);
  });

  it('a record staged while an ack is in flight survives that commit', async () => {
    let release = (): void => {};
    const ack = new Promise<void>((resolve) => { release = resolve; });
    const persisted: string[][] = [];
    const service = createAuxiliaryHistoryService({
      reader: async () => ({ entries: [], nextCursor: null }),
      persister: async (batch) => {
        await ack;
        persisted.push((batch as unknown as { info: { id: string } }[]).map((entry) => entry.info.id));
      },
    });
    disposables.push(service);
    service.stage([textEntry('a-1', 'first')]);
    const committing = service.commit();
    await Promise.resolve();
    service.stage([textEntry('b-1', 'second')]);
    expect(service.usage().dirtyCount).toBe(2);
    release();
    await committing;

    expect(service.usage().dirtyCount).toBe(1);
    const second = await service.commit();
    expect(second).toEqual({ committed: 1, bytes: second.bytes });
    expect(persisted).toEqual([['a-1'], ['b-1']]);
  });

  it('a failed ack keeps the whole batch dirty for recovery', async () => {
    const service = createAuxiliaryHistoryService({
      reader: async () => ({ entries: [], nextCursor: null }),
      persister: async () => { throw new Error('durable store unreachable'); },
    });
    disposables.push(service);
    service.stage([textEntry('a-1', 'first')]);
    service.stage([textEntry('a-2', 'second')]);
    await expect(service.commit()).rejects.toMatchObject({ code: 'source_unavailable', field: 'history.durable_ack' });
    expect(service.usage().dirtyCount).toBe(2);
  });
});
