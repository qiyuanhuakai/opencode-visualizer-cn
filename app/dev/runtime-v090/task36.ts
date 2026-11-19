// Task 36 registered QA browser entry — the cross-realm half of the bounded auxiliary-history paging contract.
//
// The product under test is the landed bounded auxiliary-history paging subsystem:
//   bridge/runtime/history/historyService.js      — the runtime paging engine (page/reread/chunk/evict/stage/commit/legacyExport)
//   bridge/runtime/history/auxiliaryMerge.js      — the pure canonical merge with the terminal guards
//   app/runtime/historyPages.ts                   — the app-side page cache that bundles the SAME engine
//   app/backends/codex/nativeAuxiliaryStorage.ts  — the native auxiliary paging wiring (codex-auxiliary-history-paged-v1)
//   app/backends/codex/auxiliaryStorage.ts        — the codex facade (openCodexAuxiliaryPaging)
//   app/utils/backendHistoryStorage.ts            — the backend-history paging wiring (backend-history-paged-v2)
//
// The product's own header makes the cross-realm claim this entry proves: historyService.js:19
// "Browser-safe: no node builtins, so the app-side cache bundles this module directly", and
// historyPages.ts:24-26 "This module is the client/renderer seam: it holds no node builtins, so it
// bundles for the browser exactly as the bridge paging engine does." This entry therefore drives the
// REAL app-side cache (createHistoryPageCache, which exposes the engine's ENTIRE surface — page, get,
// evict, reread, chunk, legacyExport, mergeWithCanonical, stage, commit, usage, dispose) in a real
// headless Chromium over the SAME fixed script the Node worker drives through the bridge engine
// directly, and the registered case asserts the two realms' read models are IDENTICAL — the same page
// bytes, the same entry hashes, the same chunk walk, the same eviction accounting, the same explicit
// codes and the same frozen flags. The app cache is therefore proven a transparent seam, not a fork.
//
// Controlled boundaries, stated rather than papered over:
//   * pageId and descriptorId are crypto.randomUUID() values, so they DIFFER between realms by
//     construction; every capture below strips them and compares only the deterministic read model
//     (entries, bytes, cursors, counters, codes, frozen flags). That is the same discipline task-32
//     used for its fixed createdAt.
//   * the three namespace literals are PINNED expectations in the worker (the worker cannot import the
//     app-side TypeScript that declares them) and are READ FROM THE PRODUCT here; equality proves the
//     product's constants are exactly those literals, and the wiring capture below observes them again
//     through the real open*Paging entry points.
//   * boundedness is asserted from the PRODUCT'S OWN usage() counters (residentBytes / pageCount /
//     evicted / dirtyCount / dirtyBytes / retainedBytes / bufferedHistory) against the frozen
//     AUXILIARY_HISTORY_LIMITS in BOTH realms, exactly as task-33 split its node:crypto-bound
//     checkpoint service. The Node worker additionally RECORDS process.memoryUsage() heap deltas,
//     explicitly labelled a GC-timing artefact rather than a retention proof (heapUsed measures
//     allocated-and-not-yet-collected, which a forced collection collapses while usage() stays
//     byte-identical); no boundedness decision is derived from them, and this realm measures no
//     heap at all — every boundedness claim below is a product resident counter.
//   * the storage wiring (openNativeAuxiliaryPaging / openBackendHistoryPaging / openCodexAuxiliaryPaging)
//     is app-side TypeScript, so it can only run in this realm; the Node worker cannot import it at all.
//     The database passed in is a case-owned double implementing the product's own declared injection
//     point (app/types/sessionDatabase.ts SessionDatabaseApi), exactly as the product's own regression
//     test mocks it; a real Electron sessionDatabaseWorker is task 12/46's end-to-end surface.
//   * no browser shim is needed: the whole import closure is pure ESM with no node:* builtin and no
//     bare or aliased specifier (historyPages.ts -> historyService.js -> capabilities.js -> identity.js;
//     nativeAuxiliaryStorage.ts -> writerFreeze.ts; auxiliaryStorage.ts -> storageKeys.ts), and the only
//     Vite-specific member, import.meta.hot, is guarded by `if (import.meta.hot)` in both storage modules.
//     This mirrors task-33 (no shim); task-30 needed one only because the real Icon component fetches
//     the Iconify API at runtime.
//
// This entry makes no UI claim, authors no PASS verdict, edits no product file and performs no git operation.
import {
  AUXILIARY_HISTORY_LIMITS,
} from '../../../bridge/runtime/history/historyService.js';
import type { AuxiliaryEntry } from '../../../bridge/runtime/history/auxiliaryMerge.js';
import {
  AUXILIARY_TERMINAL_TOOL_STATUSES,
  isTerminalTextPart,
  isTerminalToolPart,
  mergeAuxiliaryCanonical,
} from '../../../bridge/runtime/history/auxiliaryMerge.js';
import {
  BACKEND_AUXILIARY_PAGED_NAMESPACE,
  createHistoryPageCache,
} from '../../runtime/historyPages';
import type { HistoryPageCache } from '../../runtime/historyPages';
import {
  NATIVE_AUXILIARY_PAGED_NAMESPACE,
  openNativeAuxiliaryPaging,
} from '../../backends/codex/nativeAuxiliaryStorage';
import { openCodexAuxiliaryPaging } from '../../backends/codex/auxiliaryStorage';
import {
  BACKEND_HISTORY_PAGED_NAMESPACE,
  openBackendHistoryPaging,
} from '../../utils/backendHistoryStorage';
import type { SessionDatabaseApi } from '../../types/sessionDatabase';

type AnyRecord = Record<string, any>;

// ── fixtures: the SAME construction the Node worker uses, so both realms hash identically ──
const toolEntry = (id: string, status: string, output: string, end?: number): AuxiliaryEntry => ({
  info: { id, time: { created: 1 } },
  parts: [{
    id: `${id}:tool`, type: 'tool', callID: `call-${id}`, tool: 'bash',
    state: { status, input: {}, output, ...(end === undefined ? {} : { time: { start: 1, end } }) },
  }],
});
const textEntry = (id: string, text: string, end?: number): AuxiliaryEntry => ({
  info: { id, time: { created: 1 } },
  parts: [{ id: `${id}:text`, type: 'text', text, ...(end === undefined ? {} : { time: { start: 1, end } }) }],
});

/** A scripted reader: page N is returned for the Nth distinct cursor; calls are observed so a re-read is distinguishable from a cache hit. */
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

/** The canonical 635-item history: 634 continuation items plus one long tool session. */
function continuationCanonical(): AuxiliaryEntry[] {
  const canonical: AuxiliaryEntry[] = [];
  for (let index = 0; index < 634; index += 1) {
    canonical.push({
      info: { id: `cont-${String(index).padStart(4, '0')}`, time: { created: 1 } },
      parts: [{ id: `cont-${String(index).padStart(4, '0')}:cont`, type: 'continuation', text: `segment-${index}-${'c'.repeat(40 + index)}`, time: { start: 1, end: 100 + index } }],
    } as unknown as AuxiliaryEntry);
  }
  const toolOutput = `FINAL OUTPUT ${'t'.repeat(4000)}`;
  canonical.push({
    info: { id: 'tool-session', time: { created: 700 } },
    parts: [
      { id: 'tool-session:tool', type: 'tool', callID: 'call-tool-session', tool: 'bash', state: { status: 'completed', input: {}, output: toolOutput, time: { start: 1, end: 9 } } },
      { id: 'tool-session:cont', type: 'continuation', text: 'final continuation answer', time: { start: 1, end: 11 } },
    ],
  } as unknown as AuxiliaryEntry);
  return canonical;
}

/** The later, less-complete page: every continuation is a stub and the tool session is a running stub. */
function continuationStubs(canonical: readonly AuxiliaryEntry[]): AuxiliaryEntry[] {
  return canonical.map((entry) => (entry.info.id === 'tool-session'
    ? {
      info: { id: 'tool-session', time: { created: 700 } },
      parts: [
        { id: 'tool-session:tool', type: 'tool', callID: 'call-tool-session', tool: 'bash', state: { status: 'running', input: {}, output: '' } },
        { id: 'tool-session:cont', type: 'continuation', text: 'stub' },
      ],
    } as unknown as AuxiliaryEntry
    : { info: { id: entry.info.id, time: { created: 1 } }, parts: [{ id: `${entry.info.id}:cont`, type: 'continuation', text: 'stub' }] } as unknown as AuxiliaryEntry));
}

/** Opens the REAL app-side page cache over a scripted reader — the client/renderer seam under test. */
function openCache(pages: readonly (readonly AuxiliaryEntry[])[], limits?: AnyRecord) {
  const { reader, calls } = scriptedReader(pages);
  const cache: HistoryPageCache = createHistoryPageCache({
    namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE,
    read: reader,
    ...(limits === undefined ? {} : { limits }),
  });
  return { cache, calls };
}

const encoder = new TextEncoder();
const sha256 = async (value: string): Promise<string> => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('');
const digestOf = async (value: unknown): Promise<string> => sha256(JSON.stringify(value));

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa36-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

/** Captures a typed ProtocolError's code/field without swallowing anything else. */
function capture(run: () => unknown): AnyRecord {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      const record = error as AnyRecord;
      if (typeof record.code === 'string' && typeof record.field === 'string') return { code: record.code, field: record.field };
    }
    return { code: 'not-a-ProtocolError', field: String(error) };
  }
}

/** The async twin: a synchronous try/catch cannot catch an async function's rejection. */
async function captureAsync(run: () => Promise<unknown>): Promise<AnyRecord> {
  try { await run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      const record = error as AnyRecord;
      if (typeof record.code === 'string' && typeof record.field === 'string') return { code: record.code, field: record.field };
    }
    return { code: 'not-a-ProtocolError', field: String(error) };
  }
}

/** The frozen shared budget and the terminal-guard table, observed in this realm. */
function tables(): AnyRecord {
  domHost.textContent = JSON.stringify({ limits: { ...AUXILIARY_HISTORY_LIMITS } }, null, 2);
  return {
    limits: { ...AUXILIARY_HISTORY_LIMITS },
    limitsFrozen: Object.isFrozen(AUXILIARY_HISTORY_LIMITS),
    namespaces: {
      appPaged: BACKEND_AUXILIARY_PAGED_NAMESPACE,
      native: NATIVE_AUXILIARY_PAGED_NAMESPACE,
      backendHistoryPrefix: BACKEND_HISTORY_PAGED_NAMESPACE,
    },
    terminalStatuses: [...AUXILIARY_TERMINAL_TOOL_STATUSES],
    terminalStatusesFrozen: Object.isFrozen(AUXILIARY_TERMINAL_TOOL_STATUSES),
    terminalPredicates: {
      completed: isTerminalToolPart({ type: 'tool', state: { status: 'completed' } }),
      error: isTerminalToolPart({ type: 'tool', state: { status: 'error' } }),
      running: isTerminalToolPart({ type: 'tool', state: { status: 'running' } }),
      textWithEnd: isTerminalTextPart({ type: 'text', text: 'x', time: { start: 1, end: 2 } }),
      textWithoutEnd: isTerminalTextPart({ type: 'text', text: 'x', time: { start: 1 } }),
      continuationWithEnd: isTerminalTextPart({ type: 'continuation', text: 'x', time: { start: 1, end: 2 } }),
    },
  };
}

/** AC1 — a 635-item continuation chain plus a long tool session merged against later stubs. */
async function merge(): Promise<AnyRecord> {
  const canonical = continuationCanonical();
  const stubs = continuationStubs(canonical);
  const { cache } = openCache([stubs]);
  const page = await cache.page(null);
  const before = canonical[634]!.parts.map((part) => ({ ...part }));
  const merged = cache.mergeWithCanonical(canonical, page);
  const after = merged[634]!.parts.map((part) => ({ ...part }));
  const tool = merged[634]!.parts.find((part) => part.id === 'tool-session:tool')!;
  const continuation = merged[634]!.parts.find((part) => part.id === 'tool-session:cont')!;
  const chainTexts = merged.slice(0, 634).map((entry) => entry.parts[0]!.text);
  domHost.textContent = JSON.stringify({ mergedCount: merged.length, terminalToolStatus: tool.state?.status }, null, 2);
  const result = {
    canonicalCount: canonical.length,
    mergedCount: merged.length,
    mergedIds: merged.map((entry) => entry.info.id),
    chainPreserved: merged.slice(0, 634).every((entry, index) => entry.parts[0]!.text === canonical[index]!.parts[0]!.text && entry.parts[0]!.time?.end === 100 + index),
    chainDigest: await sha256(chainTexts.join('|')),
    chainHeadText: chainTexts[0],
    chainTailText: chainTexts[633],
    terminalToolStatus: tool.state?.status,
    terminalToolOutputPrefix: String(tool.state?.output).slice(0, 13),
    terminalToolOutputLength: String(tool.state?.output).length,
    terminalToolEnd: tool.state?.time?.end,
    terminalContinuationText: continuation.text,
    terminalContinuationEnd: continuation.time?.end,
    afterEqualsBefore: JSON.stringify(after) === JSON.stringify(before),
    frozen: [
      Object.isFrozen(merged),
      Object.isFrozen(merged[0]),
      Object.isFrozen(merged[0]!.parts),
      Object.isFrozen(merged[0]!.parts[0]),
    ],
    mergedSha256: await digestOf(merged),
  };
  cache.dispose();
  return result;
}

/** The paginated scroll over the real paging contract, plus the observed cache-hit behaviour. */
async function scroll(): Promise<AnyRecord> {
  const pages = Array.from({ length: 6 }, (_, page) => Array.from({ length: 100 }, (_, row) => textEntry(`p${page}-r${String(row).padStart(3, '0')}`, `body-${page}-${row}`)));
  const { cache, calls } = openCache(pages);
  const walk: AnyRecord[] = [];
  let cursor: string | null = null;
  for (let step = 0; step < 8; step += 1) {
    const page = await cache.page(cursor);
    walk.push({ cursor: page.cursor, nextCursor: page.nextCursor, count: page.entries.length, bytes: page.bytes });
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const callsAfterWalk = calls.length;
  const last = await cache.page('5');
  const previous = await cache.page('4');
  const callsAfterResidentRereads = calls.length;
  domHost.textContent = JSON.stringify({ totalEntries: walk.reduce((sum, entry) => sum + entry.count, 0) }, null, 2);
  const result = {
    walk,
    totalEntries: walk.reduce((sum, entry) => sum + entry.count, 0),
    readerCallsAfterWalk: callsAfterWalk,
    readerCallsAfterResidentRereads: callsAfterResidentRereads,
    residentRereadsAreCacheHits: callsAfterResidentRereads === callsAfterWalk,
    pageSha256s: [await digestOf(last.entries), await digestOf(previous.entries)],
    usage: cache.usage(),
  };
  cache.dispose();
  return result;
}

/** A single message over the 2 MiB inline ceiling is chunked; the walk is observed slice by slice. */
async function chunks(): Promise<AnyRecord> {
  const entry = textEntry('big', 'A'.repeat(3 * 1024 * 1024));
  const serialized = JSON.stringify(entry);
  const totalBytes = encoder.encode(serialized).length;
  const { cache } = openCache([[entry]]);
  const page = await cache.page(null);
  const reference = page.oversized[0]!;
  const walk: AnyRecord[] = [];
  const decoder = new TextDecoder();
  let reassembled = '';
  let offset = 0;
  for (let step = 0; step < 200; step += 1) {
    const slice = await cache.chunk(page.pageId, reference.descriptorId, offset);
    const payload = slice.bytes;
    walk.push({ offset, bytes: payload.byteLength, nextOffset: slice.nextOffset });
    // The body is reassembled ONLY from what the service hands back, never from the fixture.
    reassembled += decoder.decode(payload, { stream: true });
    if (slice.nextOffset === null) break;
    offset = slice.nextOffset;
  }
  reassembled += decoder.decode();
  domHost.textContent = JSON.stringify({ chunkCount: walk.length, totalBytes }, null, 2);
  const result = {
    serializedBytes: totalBytes,
    oversized: { entryId: reference.entryId, totalBytes: reference.totalBytes },
    pageBytes: page.bytes,
    pageEntryCount: page.entries.length,
    residentBytes: cache.usage().residentBytes,
    chunkCount: walk.length,
    firstThree: walk.slice(0, 3),
    lastTwo: walk.slice(-2),
    largestChunkBytes: Math.max(...walk.map((slice) => slice.bytes)),
    reassemblyEqualsSerialized: reassembled === serialized,
    reassemblySha256: await sha256(reassembled),
    serializedSha256: await sha256(serialized),
    usage: cache.usage(),
  };
  cache.dispose();
  return result;
}

/** AC2 — an inactive page is evicted, then re-read with hash-equal content and restored accounting. */
async function evictReopen(): Promise<AnyRecord> {
  const { cache, calls } = openCache([[textEntry('a0', 'page-zero-body')], [textEntry('a1', 'page-one-body')], [textEntry('a2', 'page-two-body')]], { pages: 3 });
  const first = await cache.page(null);
  await cache.page('1');
  await cache.page('2');
  const residentBefore = cache.usage().residentBytes;
  const hashBefore = await digestOf(first.entries);
  const receipt = cache.evict(first.pageId);
  const afterEvict = cache.usage();
  const getAfterEvict = cache.get(first.pageId);
  const readsBefore = calls.length;
  const again = await cache.reread(null);
  const readsAfter = calls.length;
  domHost.textContent = JSON.stringify({ freedBytes: receipt.freedBytes, hashEqual: true }, null, 2);
  const result = {
    residentBefore,
    pageCountBefore: 3,
    hashBefore,
    receipt: { freedBytes: receipt.freedBytes, evicted: receipt.evicted },
    afterEvict,
    residentEqualsBeforeMinusFreed: afterEvict.residentBytes === residentBefore - receipt.freedBytes,
    getAfterEvictIsNull: getAfterEvict === null,
    readerCallsBeforeReread: readsBefore,
    readerCallsAfterReread: readsAfter,
    rereadHash: await digestOf(again.entries),
    hashEqual: (await digestOf(again.entries)) === hashBefore,
    pageIdChanged: again.pageId !== first.pageId,
    entriesEqual: JSON.stringify(again.entries) === JSON.stringify(first.entries),
    afterReread: cache.usage(),
  };
  cache.dispose();
  return result;
}

/** The three-page ceiling auto-evicts the least-recently-used inactive page on a fourth read. */
async function lru(): Promise<AnyRecord> {
  const pages = Array.from({ length: 4 }, (_, index) => [textEntry(`b${index}`, 'x')]);
  const { cache } = openCache(pages, { pages: 3 });
  const first = await cache.page(null);
  const second = await cache.page('1');
  const third = await cache.page('2');
  await cache.page(null); // touch the first page -> most recently used
  const fourth = await cache.page('3');
  const result = {
    usage: cache.usage(),
    touchedPageResident: cache.get(first.pageId) !== null,
    leastRecentlyUsedEvicted: cache.get(second.pageId) === null,
    thirdPageResident: cache.get(third.pageId) !== null,
    fourthPageResident: cache.get(fourth.pageId) !== null,
    fourthPageCursor: fourth.cursor,
    touchedPageStillCached: (await cache.page(null)).pageId === first.pageId,
  };
  domHost.textContent = JSON.stringify({ evicted: cache.usage().evicted }, null, 2);
  cache.dispose();
  return result;
}

/** The 16 MiB resident ceiling refuses a single oversized page and admits nothing. */
async function memoryCeiling(): Promise<AnyRecord> {
  const entries = Array.from({ length: 171 }, (_, index) => textEntry(`mem-${index}`, 'm'.repeat(102400)));
  let attemptedBytes = 0;
  for (const entry of entries) attemptedBytes += encoder.encode(JSON.stringify(entry)).length;
  const { cache } = openCache([entries]);
  const rejection = await captureAsync(() => cache.page(null));
  domHost.textContent = JSON.stringify({ attemptedBytes }, null, 2);
  const result = {
    entryCount: entries.length,
    attemptedPageBytes: attemptedBytes,
    exceedsResidentCeiling: attemptedBytes > AUXILIARY_HISTORY_LIMITS.residentBytes,
    rejection,
    usage: cache.usage(),
  };
  cache.dispose();
  return result;
}

/** AC3 — a failed durable ack retains the bounded dirty set; the retry after the ack recovers it. */
async function dirtyAck(): Promise<AnyRecord> {
  let failAck = true;
  const persister = async () => { if (failAck) throw new Error('durable ack rejected: disk full'); };
  const staged = Array.from({ length: 5 }, (_, index) => textEntry(`dirty-${index}`, 'y'.repeat(200)));
  const cache: HistoryPageCache = createHistoryPageCache({
    namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE,
    read: async () => ({ entries: [], nextCursor: null }),
    persist: persister,
    limits: { dirtyMaxCount: 8, dirtyMaxBytes: 1024 * 1024 },
  });
  cache.stage(staged);
  const afterStage = cache.usage();
  const rejection = await captureAsync(() => cache.commit());
  const afterFail = cache.usage();
  failAck = false;
  const recovered = await cache.commit();
  domHost.textContent = JSON.stringify({ dirtyCount: afterFail.dirtyCount, recovered: recovered.committed }, null, 2);
  const result = {
    stagedCount: staged.length,
    perEntryBytes: encoder.encode(JSON.stringify(staged[0])).length,
    afterStage,
    rejection,
    afterFail,
    retainedBytesUnchanged: afterFail.dirtyBytes === afterStage.dirtyBytes,
    bufferedHistoryFalse: afterFail.bufferedHistory === false,
    retainedBounded: afterFail.retainedBytes <= 1024 * 1024 + afterFail.residentBytes,
    recovered,
    afterRecover: cache.usage(),
  };
  cache.dispose();
  return result;
}

/** legacyExport is the single explicit full read; the runtime page path never buffers the history. */
async function legacyExportRead(): Promise<AnyRecord> {
  const pages = [
    [textEntry('dup', 'first-segment', 1), textEntry('only-0', 'a')],
    [textEntry('dup', 'longer-second-segment', 2), textEntry('only-1', 'b')],
  ];
  const { cache, calls } = openCache(pages);
  const exported = await cache.legacyExport();
  const afterExport = cache.usage();
  cache.dispose();
  const runtime = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: scriptedReader(pages).reader });
  await runtime.page(null);
  await runtime.page('1');
  const runtimeUsage = runtime.usage();
  runtime.dispose();
  domHost.textContent = JSON.stringify({ exportedCount: exported.length, bufferedHistory: afterExport.bufferedHistory }, null, 2);
  return {
    exportedCount: exported.length,
    exportedIds: exported.map((entry) => entry.info.id),
    readerCalls: calls.length,
    afterExport,
    frozen: Object.isFrozen(exported),
    mergedDuplicateText: exported.find((entry) => entry.info.id === 'dup')!.parts[0]!.text,
    mergedDuplicateEnd: exported.find((entry) => entry.info.id === 'dup')!.parts[0]!.time?.end,
    runtimeUsage,
  };
}

/** Boundedness with real numbers: a 40-page / 8000-entry scroll inside the shared budget. */
async function boundedScroll(): Promise<AnyRecord> {
  const pages = Array.from({ length: 40 }, (_, page) => Array.from({ length: 200 }, (_, row) => textEntry(`s${page}-${String(row).padStart(3, '0')}`, `body-${page}-${row}`)));
  const { cache, calls } = openCache(pages);
  const bytes: number[] = [];
  let cursor: string | null = null;
  let total = 0;
  for (let step = 0; step < 40; step += 1) {
    const page = await cache.page(cursor);
    total += page.entries.length;
    bytes.push(page.bytes);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const usage = cache.usage();
  domHost.textContent = JSON.stringify({ totalEntries: total, evicted: usage.evicted }, null, 2);
  const result = {
    readerCalls: calls.length,
    totalEntries: total,
    firstPageBytes: bytes[0],
    lastPageBytes: bytes[bytes.length - 1],
    maxPageBytes: Math.max(...bytes),
    usage,
    residentUnderCeiling: usage.residentBytes < AUXILIARY_HISTORY_LIMITS.residentBytes,
    pageCountAtCeiling: usage.pageCount === AUXILIARY_HISTORY_LIMITS.pages,
  };
  cache.dispose();
  return result;
}

/** The storage wiring under the NEW namespaces, over the product's declared sessionDatabase seam. */
async function wiring(): Promise<AnyRecord> {
  const nativePages = [[textEntry('n0', 'native-page')]];
  const readHistoryRequests: AnyRecord[] = [];
  const upsertHistoryRequests: AnyRecord[] = [];
  const nativeDatabase: SessionDatabaseApi = {
    readHistory: async (request) => {
      readHistoryRequests.push({ ...request });
      const index = request.cursor === undefined ? 0 : Number(request.cursor);
      return { entries: (nativePages[index] ?? []) as unknown[], nextCursor: index + 1 < nativePages.length ? String(index + 1) : null };
    },
    upsertHistory: async (request) => { upsertHistoryRequests.push({ ...request }); },
    clearHistory: async () => {},
    flush: async () => {},
    onHistoryChanged: () => () => {},
  };
  const nativeCache = openNativeAuxiliaryPaging(nativeDatabase, 'thread-1');
  const nativeDefined = nativeCache !== undefined;
  const nativeNamespace = nativeCache?.namespace ?? null;
  const nativePage = nativeCache === undefined ? null : await nativeCache.page(null);
  if (nativeCache !== undefined) await nativeCache.page('1');
  nativeCache?.stage([textEntry('n1', 'native-write')]);
  const nativeCommitted = nativeCache === undefined ? null : await nativeCache.commit();
  nativeCache?.dispose();

  const backendPages = [[textEntry('bk0', 'backend-page')]];
  const backendRequests: AnyRecord[] = [];
  const backendDatabase: SessionDatabaseApi = {
    readHistory: async (request) => {
      backendRequests.push({ ...request });
      const index = request.cursor === undefined ? 0 : Number(request.cursor);
      return { entries: (backendPages[index] ?? []) as unknown[], nextCursor: index + 1 < backendPages.length ? String(index + 1) : null };
    },
    upsertHistory: async () => {},
    clearHistory: async () => {},
    flush: async () => {},
    onHistoryChanged: () => () => {},
  };
  const backendCache = openBackendHistoryPaging(backendDatabase, 'child-1', 'opencode', 'scope-x');
  const backendDefined = backendCache !== undefined;
  const backendNamespace = backendCache?.namespace ?? null;
  const backendPage = backendCache === undefined ? null : await backendCache.page(null);
  backendCache?.dispose();

  const codexFacade = openCodexAuxiliaryPaging('thread-x');
  const noNativeDatabase = openNativeAuxiliaryPaging(undefined, 'thread-1');
  const noBackendDatabase = openBackendHistoryPaging(undefined, 'child-1', 'opencode', 'scope-x');
  domHost.textContent = JSON.stringify({ nativeNamespace, backendNamespace }, null, 2);
  return {
    native: {
      defined: nativeDefined,
      namespace: nativeNamespace,
      readHistoryRequest: readHistoryRequests[0] ?? null,
      readHistoryRequestKeys: Object.keys(readHistoryRequests[0] ?? {}),
      secondReadHistoryRequest: readHistoryRequests[1] ?? null,
      entryIds: nativePage === null ? [] : nativePage.entries.map((entry) => entry.info.id),
      upsertRequestKeys: Object.keys(upsertHistoryRequests[0] ?? {}),
      upsertEntryIds: upsertHistoryRequests.length === 0 ? [] : (upsertHistoryRequests[0]!.entries as AuxiliaryEntry[]).map((entry) => entry.info.id),
      committed: nativeCommitted === null ? null : nativeCommitted.committed,
    },
    backendHistory: {
      defined: backendDefined,
      namespace: backendNamespace,
      namespaceMatchesPagedV2: typeof backendNamespace === 'string' && new RegExp(`^${BACKEND_HISTORY_PAGED_NAMESPACE}:[a-f0-9]{32}$`, 'u').test(backendNamespace),
      readHistoryRequestKeys: Object.keys(backendRequests[0] ?? {}),
      entryIds: backendPage === null ? [] : backendPage.entries.map((entry) => entry.info.id),
    },
    codexFacadeWithoutNativeDatabaseDefined: codexFacade !== undefined,
    noNativeDatabaseDefined: noNativeDatabase !== undefined,
    noBackendDatabaseDefined: noBackendDatabase !== undefined,
  };
}

// ── failure lane ──

/** A history page gap: the reader repeats a cursor, so the walk refuses instead of looping. */
async function pageGap(): Promise<AnyRecord> {
  let first = true;
  const reader = async () => {
    if (first) { first = false; return { entries: [textEntry('g0', 'x')] as unknown[], nextCursor: '1' }; }
    return { entries: [textEntry('g1', 'x')] as unknown[], nextCursor: '1' };
  };
  const cache = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: reader });
  const page = await cache.page(null);
  const rejection = await captureAsync(() => cache.page('1'));
  domHost.textContent = JSON.stringify({ rejection }, null, 2);
  const result = {
    rejection,
    usage: cache.usage(),
    firstPageStillResident: cache.get(page.pageId) !== null,
    firstPageSha256: await digestOf(page.entries),
  };
  cache.dispose();
  return result;
}

/** A corrupt record is refused with an explicit code and nothing becomes resident. */
async function corruptRecord(): Promise<AnyRecord> {
  const missingInfoId = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: async () => ({ entries: [{ info: { time: { created: 1 } }, parts: [] } as unknown], nextCursor: null }) });
  const first = await captureAsync(() => missingInfoId.page(null));
  const missingPartId = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: async () => ({ entries: [{ info: { id: 'ok' }, parts: [{ type: 'text', text: 'no id' }] } as unknown], nextCursor: null }) });
  const second = await captureAsync(() => missingPartId.page(null));
  const nullEntry = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: async () => ({ entries: [null as unknown], nextCursor: null }) });
  const third = await captureAsync(() => nullEntry.page(null));
  domHost.textContent = JSON.stringify({ first }, null, 2);
  const result = {
    missingInfoId: first,
    missingPartId: second,
    nullEntry: third,
    residentCounts: [missingInfoId.usage().pageCount, missingPartId.usage().pageCount, nullEntry.usage().pageCount],
    residentBytes: [missingInfoId.usage().residentBytes, missingPartId.usage().residentBytes, nullEntry.usage().residentBytes],
    dirtyCounts: [missingInfoId.usage().dirtyCount, missingPartId.usage().dirtyCount, nullEntry.usage().dirtyCount],
  };
  missingInfoId.dispose(); missingPartId.dispose(); nullEntry.dispose();
  return result;
}

/** An old-generation write is refused with a conflict code and changes nothing. */
async function oldGeneration(): Promise<AnyRecord> {
  const cache = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: async () => ({ entries: [], nextCursor: null }), persist: async () => {} });
  cache.stage([textEntry('gen-2', 'x')], 2);
  const afterFirst = cache.usage();
  const rejection = capture(() => cache.stage([textEntry('gen-1', 'x')], 1));
  const afterReject = cache.usage();
  const sameGeneration = capture(() => cache.stage([textEntry('gen-2b', 'x')], 2));
  const afterSame = cache.usage();
  const committed = await cache.commit();
  domHost.textContent = JSON.stringify({ rejection }, null, 2);
  const result = { afterFirst, rejection, afterReject, sameGeneration, afterSame, committed };
  cache.dispose();
  return result;
}

/** A terminal record overwritten by a running one is never regressed; the guard's direction is proven. */
async function terminalGuard(): Promise<AnyRecord> {
  const canonical: AuxiliaryEntry[] = [{
    info: { id: 'm1', time: { created: 1 } },
    parts: [
      { id: 'm1:tool', type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: {}, output: 'FINAL OUTPUT', time: { start: 1, end: 2 } } },
      { id: 'm1:text', type: 'text', text: 'final answer', time: { start: 1, end: 3 } },
    ],
  } as unknown as AuxiliaryEntry];
  const before = canonical[0]!.parts.map((part) => ({ ...part }));
  const merged = mergeAuxiliaryCanonical(canonical, [toolEntry('m1', 'running', '')]);
  const after = merged[0]!.parts.map((part) => ({ ...part }));
  const runningFirst = mergeAuxiliaryCanonical([toolEntry('m1', 'running', 'partial')], [toolEntry('m1', 'completed', 'FINAL OUTPUT', 2)]);
  const errorOverCompleted = mergeAuxiliaryCanonical([toolEntry('m1', 'completed', 'FIRST', 2)], [toolEntry('m1', 'error', 'SECOND', 3)]);
  const longerTextWins = mergeAuxiliaryCanonical([textEntry('m1', 'the longer transcript')], [textEntry('m1', 'short')]);
  const terminalTextWins = mergeAuxiliaryCanonical([textEntry('m1', 'final answer', 3)], [textEntry('m1', 'a much longer later stub')]);
  domHost.textContent = JSON.stringify({ mergedStatus: merged[0]!.parts[0]!.state?.status }, null, 2);
  return {
    runningStubRejectedByGuard: {
      status: merged[0]!.parts[0]!.state?.status,
      output: merged[0]!.parts[0]!.state?.output,
      end: merged[0]!.parts[0]!.state?.time?.end,
      text: merged[0]!.parts[1]!.text,
      textEnd: merged[0]!.parts[1]!.time?.end,
      afterEqualsBefore: JSON.stringify(after) === JSON.stringify(before),
    },
    guardIsDirectional: {
      runningThenCompleted: { status: runningFirst[0]!.parts[0]!.state?.status, output: runningFirst[0]!.parts[0]!.state?.output },
      errorOverCompleted: { status: errorOverCompleted[0]!.parts[0]!.state?.status, output: errorOverCompleted[0]!.parts[0]!.state?.output },
      longerTextWins: longerTextWins[0]!.parts[0]!.text,
      terminalTextWins: terminalTextWins[0]!.parts[0]!.text,
    },
  };
}

/** The chunk contract refuses a foreign, an unknown, a negative and a fractional request. */
async function chunkRefusals(): Promise<AnyRecord> {
  const pages = [[textEntry('big', 'A'.repeat(3 * 1024 * 1024))], [textEntry('small', 'tiny')]];
  const { cache } = openCache(pages);
  const first = await cache.page(null);
  const second = await cache.page('1');
  const descriptorId = first.oversized[0]!.descriptorId;
  domHost.textContent = JSON.stringify({ totalBytes: first.oversized[0]!.totalBytes }, null, 2);
  const result = {
    oversized: { entryId: first.oversized[0]!.entryId, totalBytes: first.oversized[0]!.totalBytes },
    pageBytes: first.bytes,
    residentBytes: cache.usage().residentBytes,
    residentUnderInlineCeiling: cache.usage().residentBytes < AUXILIARY_HISTORY_LIMITS.entryInlineBytes,
    foreignDescriptor: await captureAsync(() => cache.chunk(second.pageId, descriptorId, 0)),
    unknownDescriptor: await captureAsync(() => cache.chunk(first.pageId, 'not-a-descriptor', 0)),
    unknownPage: await captureAsync(() => cache.chunk('not-a-page', descriptorId, 0)),
    negativeOffset: await captureAsync(() => cache.chunk(first.pageId, descriptorId, -1)),
    fractionalOffset: await captureAsync(() => cache.chunk(first.pageId, descriptorId, 1.5)),
    ownDescriptorServed: await captureAsync(() => cache.chunk(first.pageId, descriptorId, 0)),
    usage: cache.usage(),
  };
  cache.dispose();
  return result;
}

/** Staging past the dirty count budget and past the dirty byte budget changes nothing. */
function dirtyBudget(): AnyRecord {
  const counting = createHistoryPageCache({
    namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE,
    read: async () => ({ entries: [], nextCursor: null }),
    persist: async () => {},
    limits: { dirtyMaxCount: 4, dirtyMaxBytes: 1024 * 1024 },
  });
  counting.stage(Array.from({ length: 4 }, (_, index) => textEntry(`cap-${index}`, 'z')));
  const afterFill = counting.usage();
  const countOverflow = capture(() => counting.stage([textEntry('cap-overflow', 'z')]));
  const afterCountOverflow = counting.usage();
  counting.dispose();
  const bytes = createHistoryPageCache({
    namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE,
    read: async () => ({ entries: [], nextCursor: null }),
    persist: async () => {},
    limits: { dirtyMaxCount: 32, dirtyMaxBytes: 1024 },
  });
  bytes.stage([textEntry('bytes-1', 'z'.repeat(200))]);
  const afterFirstByte = bytes.usage();
  const byteOverflow = capture(() => bytes.stage([textEntry('bytes-2', 'z'.repeat(2000))]));
  const afterByteOverflow = bytes.usage();
  bytes.dispose();
  domHost.textContent = JSON.stringify({ countOverflow, byteOverflow }, null, 2);
  return {
    countBudget: {
      afterFill,
      overflow: countOverflow,
      afterOverflow: afterCountOverflow,
      unchanged: afterCountOverflow.dirtyCount === afterFill.dirtyCount && afterCountOverflow.dirtyBytes === afterFill.dirtyBytes,
    },
    byteBudget: {
      afterFirst: afterFirstByte,
      overflow: byteOverflow,
      afterOverflow: afterByteOverflow,
      unchanged: afterByteOverflow.dirtyCount === afterFirstByte.dirtyCount && afterByteOverflow.dirtyBytes === afterFirstByte.dirtyBytes,
    },
  };
}

/** A failed durable ack keeps the dirty set across a full 8000-entry scroll, bounded. */
async function dbFail(): Promise<AnyRecord> {
  const pages = Array.from({ length: 40 }, (_, page) => Array.from({ length: 200 }, (_, row) => textEntry(`h${page}-${row}`, `body-${page}-${row}`)));
  const { reader, calls } = scriptedReader(pages);
  let failAck = true;
  const persister = async () => { if (failAck) throw new Error('disk full'); };
  const cache = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: reader, persist: persister });
  cache.stage(Array.from({ length: 5 }, (_, index) => textEntry(`dirty-${index}`, 'y'.repeat(200))));
  const staged = cache.usage();
  const rejection = await captureAsync(() => cache.commit());
  const afterFail = cache.usage();
  let cursor: string | null = null;
  let total = 0;
  for (let step = 0; step < 40; step += 1) {
    const page = await cache.page(cursor);
    total += page.entries.length;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const afterScroll = cache.usage();
  failAck = false;
  const recovered = await cache.commit();
  domHost.textContent = JSON.stringify({ retainedBytes: afterScroll.retainedBytes, recovered: recovered.committed }, null, 2);
  const result = {
    staged,
    rejection,
    afterFail,
    readerCalls: calls.length,
    totalEntriesScrolled: total,
    afterScroll,
    dirtySurvivedScroll: afterScroll.dirtyCount === 5 && afterScroll.dirtyBytes === afterFail.dirtyBytes,
    retainedBounded: afterScroll.retainedBytes <= AUXILIARY_HISTORY_LIMITS.dirtyMaxBytes + afterScroll.residentBytes,
    bufferedHistory: afterScroll.bufferedHistory,
    recovered,
    afterRecover: cache.usage(),
  };
  cache.dispose();
  return result;
}

/** Deliberately returns a value that violates the reader contract; the double cast is intentional. */
function contractViolatingReader(value: unknown): (cursor: string | null) => Promise<{ entries: readonly unknown[]; nextCursor: string | null }> {
  return (async () => value) as unknown as (cursor: string | null) => Promise<{ entries: readonly unknown[]; nextCursor: string | null }>;
}

/** A reader that throws, returns null, or returns a non-array entries fails with its own code. */
async function readerFailure(): Promise<AnyRecord> {
  const throwing = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: async () => { throw new Error('socket closed'); } });
  const readerThrows = await captureAsync(() => throwing.page(null));
  const nullRaw = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: contractViolatingReader(null) });
  const nullRejection = await captureAsync(() => nullRaw.page(null));
  const badEntries = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: contractViolatingReader({ entries: 'nope', nextCursor: null }) });
  const badEntriesRejection = await captureAsync(() => badEntries.page(null));
  const missingEntries = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: contractViolatingReader({}) });
  const missingRejection = await captureAsync(() => missingEntries.page(null));
  domHost.textContent = JSON.stringify({ readerThrows }, null, 2);
  const result = {
    readerThrows,
    nullRaw: nullRejection,
    entriesNotArray: badEntriesRejection,
    missingEntries: missingRejection,
    residentCounts: [throwing.usage().pageCount, nullRaw.usage().pageCount, badEntries.usage().pageCount, missingEntries.usage().pageCount],
    dirtyCounts: [throwing.usage().dirtyCount, nullRaw.usage().dirtyCount, badEntries.usage().dirtyCount, missingEntries.usage().dirtyCount],
  };
  throwing.dispose(); nullRaw.dispose(); badEntries.dispose(); missingEntries.dispose();
  return result;
}

/** After dispose the mutating entry points are fenced; the observed read models are empty. */
async function disposeFences(): Promise<AnyRecord> {
  const cache = createHistoryPageCache({
    namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE,
    read: async () => ({ entries: [textEntry('d0', 'x')] as unknown[], nextCursor: null }),
    persist: async () => {},
  });
  const page = await cache.page(null);
  cache.stage([textEntry('d1', 'x')]);
  cache.dispose();
  const pageAfter = await captureAsync(() => cache.page(null));
  const rereadAfter = await captureAsync(() => cache.reread(null));
  const stageAfter = capture(() => cache.stage([textEntry('d2', 'x')]));
  const commitAfter = await captureAsync(() => cache.commit());
  const exportAfter = await captureAsync(() => cache.legacyExport());
  const usage = cache.usage();
  const evictedReceipt = cache.evict(page.pageId);
  domHost.textContent = JSON.stringify({ pageAfter, usage }, null, 2);
  return {
    page: pageAfter,
    reread: rereadAfter,
    stage: stageAfter,
    commit: commitAfter,
    // OBSERVED, NOT FORCED: legacyExport() calls the injected reader directly and never goes through
    // readPage(), so it is the one entry point dispose does NOT fence. Recorded as an observed gap.
    legacyExport: exportAfter,
    legacyExportCompleted: exportAfter.code === null,
    getAfterDisposeIsNull: cache.get(page.pageId) === null,
    evictAfterDispose: { freedBytes: evictedReceipt.freedBytes, evicted: evictedReceipt.evicted },
    chunkAfterDispose: await captureAsync(() => cache.chunk(page.pageId, 'x', 0)),
    usage,
  };
}

/** A cursor gap inside legacyExport is refused, and the export still marks the history buffered. */
async function exportGap(): Promise<AnyRecord> {
  const reader = async () => ({ entries: [textEntry('e0', 'x')] as unknown[], nextCursor: '1' });
  const cache = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: reader });
  const rejection = await captureAsync(() => cache.legacyExport());
  const usage = cache.usage();
  domHost.textContent = JSON.stringify({ rejection }, null, 2);
  const result = { rejection, usage, bufferedHistoryAfterFailedExport: usage.bufferedHistory };
  cache.dispose();
  return result;
}

/** Staging a corrupt record or an already-dirty id adds nothing to the bounded dirty set. */
async function stageValidation(): Promise<AnyRecord> {
  const cache = createHistoryPageCache({ namespace: BACKEND_AUXILIARY_PAGED_NAMESPACE, read: async () => ({ entries: [], nextCursor: null }), persist: async () => {} });
  cache.stage([textEntry('v0', 'x')]);
  const afterFirst = cache.usage();
  const corrupt = capture(() => cache.stage([{ info: {}, parts: [] } as unknown as AuxiliaryEntry]));
  const duplicate = capture(() => cache.stage([textEntry('v0', 'x')]));
  const afterDuplicate = cache.usage();
  const committed = await cache.commit();
  const emptyCommit = await cache.commit();
  domHost.textContent = JSON.stringify({ corrupt, duplicate }, null, 2);
  const result = { afterFirst, corrupt, duplicate, afterDuplicate, committed, emptyCommit };
  cache.dispose();
  return result;
}

const api = {
  ready: true,
  errors: () => errors,
  tables,
  merge,
  scroll,
  chunks,
  evictReopen,
  lru,
  memoryCeiling,
  dirtyAck,
  legacyExportRead,
  boundedScroll,
  wiring,
  pageGap,
  corruptRecord,
  oldGeneration,
  terminalGuard,
  chunkRefusals,
  dirtyBudget,
  dbFail,
  readerFailure,
  disposeFences,
  exportGap,
  stageValidation,
  domText: () => domHost.textContent ?? '',
};

(window as unknown as AnyRecord).task36 = api;
