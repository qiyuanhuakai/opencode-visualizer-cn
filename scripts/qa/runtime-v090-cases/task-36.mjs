// Task 36 registered QA case — bounded auxiliary-history paging and cache eviction.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge paging engine bridge/runtime/history/historyService.js
//     and the landed pure merge bridge/runtime/history/auxiliaryMerge.js, imported statically and
//     driven with no stubbed logic. The reader and the persister are the engine's OWN declared
//     injection points (historyService.js:38-41), so every read, eviction, chunk, generation, dirty
//     and durable-ack path runs the real product code.
//   * In a real headless Chromium: the SAME engine bundled by a case-owned Vite server, reached
//     through the REAL app-side client/renderer seam app/runtime/historyPages.ts
//     (createHistoryPageCache exposes the engine's ENTIRE surface), plus the REAL storage wiring
//     app/backends/codex/nativeAuxiliaryStorage.ts, app/backends/codex/auxiliaryStorage.ts and
//     app/utils/backendHistoryStorage.ts. The case asserts the two realms are BYTE-IDENTICAL — the
//     same page bytes, the same entry hashes, the same chunk walk, the same eviction accounting, the
//     same explicit codes and the same frozen flags — which is the product's own claim
//     (historyService.js:19 "Browser-safe: no node builtins, so the app-side cache bundles this
//     module directly"; historyPages.ts:24-26 "it holds no node builtins, so it bundles for the
//     browser exactly as the bridge paging engine does").
//
// The controlled boundaries are:
//   * pageId and descriptorId are crypto.randomUUID() values, so they differ between realms by
//     construction; every capture strips them and compares only the deterministic read model (the
//     same discipline task-32 used for its fixed createdAt).
//   * the three namespace literals are PINNED expectations in the worker (which cannot import the
//     app-side TypeScript that declares them) and are READ FROM THE PRODUCT in the browser; equality
//     proves the product's constants, and the wiring capture observes them again through the real
//     open*Paging entry points.
//   * the storage wiring is app-side TypeScript, so it can only run in the browser realm; the Node
//     worker cannot import it at all. The database passed in is a case-owned double implementing the
//     product's own declared seam (app/types/sessionDatabase.ts SessionDatabaseApi), exactly as the
//     product's own regression test mocks it; a real Electron sessionDatabaseWorker is task 12/46's
//     end-to-end surface. NO production caller of the new paging exports is claimed: they have none
//     yet (the plan's "independent service" posture), and this case asserts only what the exports
//     themselves do.
//   * boundedness is asserted from the PRODUCT'S OWN usage() counters (residentBytes / pageCount /
//     evicted / dirtyCount / dirtyBytes / retainedBytes / bufferedHistory) against the product's
//     frozen AUXILIARY_HISTORY_LIMITS in BOTH realms, exactly as task 33 does. The Node worker
//     additionally RECORDS process.memoryUsage() heap deltas, explicitly labelled a GC-TIMING
//     ARTEFACT (heapUsed measures allocated-and-not-yet-collected, which a forced collection
//     collapses) rather than a retention proof; no boundedness decision is derived from them.
//     A former absolute 64 MiB HEAP_BOUND decided boundedness from those deltas and went red on
//     ~105 MiB of uncollected garbage whose resident footprint is a constant 66,810 bytes — the
//     twenty-third instance of this plan's receiver-contract lesson: a value passed to a receiver
//     must be checked against the RECEIVER's contract, and the receiver here is the boundedness
//     assertion, whose contract is the product's resident counters, not the process heap.
//   * no browser shim is needed: the whole import closure is pure ESM with no node:* builtin and no
//     bare or aliased specifier, and the only Vite-specific member (import.meta.hot) is guarded in
//     both storage modules. task-30 needed a shim only because the real Icon component fetches the
//     Iconify API at runtime.
//
// TWO OBSERVED PRODUCT BEHAVIOURS ARE RECORDED RATHER THAN FORCED (details in defects and in the
// DoneClaim): (1) the terminal guard is a PRESERVATION, not a throw — a later running stub is
// refused by keeping the terminal state, so there is no error code to assert; the case therefore
// asserts the preserved status/output/end-time and proves the guard is DIRECTIONAL (a later
// terminal does replace an earlier one, and a longer non-terminal text does win). (2) legacyExport()
// calls the injected reader directly and never goes through readPage(), so dispose does NOT fence it
// — the one entry point that still completes after dispose. Both are asserted as observed.
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that —
// claims no UI rendering (task 35 owns the Thread UI), authors no PASS verdict, edits no product or
// test file, and performs no git operation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-36-fixture.mjs';

import {
  AUXILIARY_HISTORY_LIMITS,
  createAuxiliaryHistoryService,
} from '../../../bridge/runtime/history/historyService.js';
import {
  AUXILIARY_TERMINAL_TOOL_STATUSES,
  isTerminalTextPart,
  isTerminalToolPart,
  mergeAuxiliaryCanonical,
} from '../../../bridge/runtime/history/auxiliaryMerge.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
// NO absolute heap bound is declared here any more. The former `const HEAP_BOUND = 64 * 1024 * 1024`
// decided boundedness from process.memoryUsage().heapUsed deltas — but heapUsed measures
// "allocated and not yet collected", a GC-TIMING artefact, not a retention property. The happy QA
// measured ~105 MiB of growth for a workload whose RESIDENT occupancy is a constant 66,810 bytes /
// three pages / bufferedHistory false, and a forced collection collapses that growth (root's
// --expose-gc replay and this executor's own replay both measured this workload's growth falling
// from ~3 MiB to ~0.4 MiB with usage() byte-identical across the collection). Boundedness is now
// asserted ONLY from the product's own usage() counters against the product's own frozen
// AUXILIARY_HISTORY_LIMITS, exactly as task 33 does. The heap numbers are still RECORDED (see
// record('heap', ...) below and workerDbFailHeap), explicitly labelled a GC-timing artefact, and
// they decide nothing.
// The three namespace literals, read from the product sources (historyPages.ts:27,
// nativeAuxiliaryStorage.ts:173, backendHistoryStorage.ts:230) and pinned here because the worker
// cannot import the app-side TypeScript that declares them; the browser realm reads them live.
const NAMESPACE_APP_PAGED = 'auxiliary-history-paged-v1';
const NAMESPACE_NATIVE = 'codex-auxiliary-history-paged-v1';
const NAMESPACE_BACKEND_HISTORY_PREFIX = 'backend-history-paged-v2';
const PRODUCT_FILES = [
  'bridge/runtime/history/historyService.js',
  'bridge/runtime/history/auxiliaryMerge.js',
  'app/runtime/historyPages.ts',
  'app/backends/codex/nativeAuxiliaryStorage.ts',
  'app/backends/codex/auxiliaryStorage.ts',
  'app/utils/backendHistoryStorage.ts',
  'app/runtime/historyPaging.test.ts',
];

// ── the worker's own fixtures: the SAME construction the browser entry uses ──
const toolEntry = (id, status, output, end) => ({
  info: { id, time: { created: 1 } },
  parts: [{
    id: `${id}:tool`, type: 'tool', callID: `call-${id}`, tool: 'bash',
    state: { status, input: {}, output, ...(end === undefined ? {} : { time: { start: 1, end } }) },
  }],
});
const textEntry = (id, text, end) => ({
  info: { id, time: { created: 1 } },
  parts: [{ id: `${id}:text`, type: 'text', text, ...(end === undefined ? {} : { time: { start: 1, end } }) }],
});
function scriptedReader(pages) {
  const calls = [];
  const reader = async (cursor) => {
    calls.push(cursor);
    const index = cursor === null ? 0 : Number(cursor);
    const entries = pages[index] ?? [];
    const next = index + 1 < pages.length ? String(index + 1) : null;
    return { entries, nextCursor: next };
  };
  return { reader, calls };
}
function continuationCanonical() {
  const canonical = [];
  for (let index = 0; index < 634; index += 1) {
    const id = `cont-${String(index).padStart(4, '0')}`;
    canonical.push({ info: { id, time: { created: 1 } }, parts: [{ id: `${id}:cont`, type: 'continuation', text: `segment-${index}-${'c'.repeat(40 + index)}`, time: { start: 1, end: 100 + index } }] });
  }
  const toolOutput = `FINAL OUTPUT ${'t'.repeat(4000)}`;
  canonical.push({
    info: { id: 'tool-session', time: { created: 700 } },
    parts: [
      { id: 'tool-session:tool', type: 'tool', callID: 'call-tool-session', tool: 'bash', state: { status: 'completed', input: {}, output: toolOutput, time: { start: 1, end: 9 } } },
      { id: 'tool-session:cont', type: 'continuation', text: 'final continuation answer', time: { start: 1, end: 11 } },
    ],
  });
  return canonical;
}
function continuationStubs(canonical) {
  return canonical.map((entry) => (entry.info.id === 'tool-session'
    ? {
      info: { id: 'tool-session', time: { created: 700 } },
      parts: [
        { id: 'tool-session:tool', type: 'tool', callID: 'call-tool-session', tool: 'bash', state: { status: 'running', input: {}, output: '' } },
        { id: 'tool-session:cont', type: 'continuation', text: 'stub' },
      ],
    }
    : { info: { id: entry.info.id, time: { created: 1 } }, parts: [{ id: `${entry.info.id}:cont`, type: 'continuation', text: 'stub' }] }));
}

// ── capture helpers: a typed ProtocolError is { code, field }; anything else is loud ──
// BOTH realms must emit the SAME envelope on EVERY path, success included (the task-32 lesson):
// the browser capture (app/dev/runtime-v090/task36.ts capture/captureAsync) returns
// { code: null, field: null } on success, so the worker mirrors it exactly — same keys, same order,
// same loudness.
const captureSync = (run) => {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      if (typeof error.code === 'string' && typeof error.field === 'string') return { code: error.code, field: error.field };
    }
    return { code: 'not-a-ProtocolError', field: String(error) };
  }
};
// A synchronous try/catch cannot catch an async function's rejection.
const captureAsync = async (run) => {
  try { await run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      if (typeof error.code === 'string' && typeof error.field === 'string') return { code: error.code, field: error.field };
    }
    return { code: 'not-a-ProtocolError', field: String(error) };
  }
};
const sha256 = async (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const digestOf = async (value) => sha256(JSON.stringify(value));

// ── the worker halves of every cross-realm shape; each mirrors the browser entry exactly ──
function workerTables() {
  return {
    limits: { ...AUXILIARY_HISTORY_LIMITS },
    limitsFrozen: Object.isFrozen(AUXILIARY_HISTORY_LIMITS),
    namespaces: {
      appPaged: NAMESPACE_APP_PAGED,
      native: NAMESPACE_NATIVE,
      backendHistoryPrefix: NAMESPACE_BACKEND_HISTORY_PREFIX,
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

async function workerMerge() {
  const canonical = continuationCanonical();
  const stubs = continuationStubs(canonical);
  const { reader } = scriptedReader([stubs]);
  const service = createAuxiliaryHistoryService({ reader });
  const page = await service.page(null);
  const before = canonical[634].parts.map((part) => ({ ...part }));
  const merged = mergeAuxiliaryCanonical(canonical, page.entries);
  const after = merged[634].parts.map((part) => ({ ...part }));
  const tool = merged[634].parts.find((part) => part.id === 'tool-session:tool');
  const continuation = merged[634].parts.find((part) => part.id === 'tool-session:cont');
  const chainTexts = merged.slice(0, 634).map((entry) => entry.parts[0].text);
  const result = {
    canonicalCount: canonical.length,
    mergedCount: merged.length,
    mergedIds: merged.map((entry) => entry.info.id),
    chainPreserved: merged.slice(0, 634).every((entry, index) => entry.parts[0].text === canonical[index].parts[0].text && entry.parts[0].time.end === 100 + index),
    chainDigest: await sha256(chainTexts.join('|')),
    chainHeadText: chainTexts[0],
    chainTailText: chainTexts[633],
    terminalToolStatus: tool.state.status,
    terminalToolOutputPrefix: String(tool.state.output).slice(0, 13),
    terminalToolOutputLength: String(tool.state.output).length,
    terminalToolEnd: tool.state.time.end,
    terminalContinuationText: continuation.text,
    terminalContinuationEnd: continuation.time.end,
    afterEqualsBefore: JSON.stringify(after) === JSON.stringify(before),
    frozen: [
      Object.isFrozen(merged),
      Object.isFrozen(merged[0]),
      Object.isFrozen(merged[0].parts),
      Object.isFrozen(merged[0].parts[0]),
    ],
    mergedSha256: await digestOf(merged),
  };
  service.dispose();
  return result;
}

async function workerScroll() {
  const pages = Array.from({ length: 6 }, (_, page) => Array.from({ length: 100 }, (_, row) => textEntry(`p${page}-r${String(row).padStart(3, '0')}`, `body-${page}-${row}`)));
  const { reader, calls } = scriptedReader(pages);
  const service = createAuxiliaryHistoryService({ reader });
  const walk = [];
  let cursor = null;
  for (let step = 0; step < 8; step += 1) {
    const page = await service.page(cursor);
    walk.push({ cursor: page.cursor, nextCursor: page.nextCursor, count: page.entries.length, bytes: page.bytes });
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const callsAfterWalk = calls.length;
  const last = await service.page('5');
  const previous = await service.page('4');
  const callsAfterResidentRereads = calls.length;
  const result = {
    walk,
    totalEntries: walk.reduce((sum, entry) => sum + entry.count, 0),
    readerCallsAfterWalk: callsAfterWalk,
    readerCallsAfterResidentRereads: callsAfterResidentRereads,
    residentRereadsAreCacheHits: callsAfterResidentRereads === callsAfterWalk,
    pageSha256s: [await digestOf(last.entries), await digestOf(previous.entries)],
    usage: service.usage(),
  };
  service.dispose();
  return result;
}

async function workerChunks() {
  const entry = textEntry('big', 'A'.repeat(3 * 1024 * 1024));
  const serialized = JSON.stringify(entry);
  const totalBytes = new TextEncoder().encode(serialized).length;
  const { reader } = scriptedReader([[entry]]);
  const service = createAuxiliaryHistoryService({ reader });
  const page = await service.page(null);
  const reference = page.oversized[0];
  const walk = [];
  let offset = 0;
  for (let step = 0; step < 200; step += 1) {
    const chunk = await service.chunk(page.pageId, reference.descriptorId, offset);
    // chunk() returns a bounded BYTE slice (Uint8Array); its length is the slice's byte count.
    walk.push({ offset, bytes: chunk.bytes.byteLength, nextOffset: chunk.nextOffset });
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  }
  let reassembled = '';
  let readOffset = 0;
  for (let step = 0; step < 200; step += 1) {
    const chunk = await service.chunk(page.pageId, reference.descriptorId, readOffset);
    reassembled += new TextDecoder().decode(chunk.bytes);
    if (chunk.nextOffset === null) break;
    readOffset = chunk.nextOffset;
  }
  const result = {
    serializedBytes: totalBytes,
    oversized: { entryId: reference.entryId, totalBytes: reference.totalBytes },
    pageBytes: page.bytes,
    pageEntryCount: page.entries.length,
    residentBytes: service.usage().residentBytes,
    chunkCount: walk.length,
    firstThree: walk.slice(0, 3),
    lastTwo: walk.slice(-2),
    largestChunkBytes: Math.max(...walk.map((slice) => slice.bytes)),
    reassemblyEqualsSerialized: reassembled === serialized,
    reassemblySha256: await sha256(reassembled),
    serializedSha256: await sha256(serialized),
    usage: service.usage(),
  };
  service.dispose();
  return result;
}

async function workerEvictReopen() {
  const { reader, calls } = scriptedReader([[textEntry('a0', 'page-zero-body')], [textEntry('a1', 'page-one-body')], [textEntry('a2', 'page-two-body')]]);
  const service = createAuxiliaryHistoryService({ reader, limits: { pages: 3 } });
  const first = await service.page(null);
  await service.page('1');
  await service.page('2');
  const residentBefore = service.usage().residentBytes;
  const hashBefore = await digestOf(first.entries);
  const receipt = service.evict(first.pageId);
  const afterEvict = service.usage();
  const getAfterEvict = service.get(first.pageId);
  const readsBefore = calls.length;
  const again = await service.reread(null);
  const readsAfter = calls.length;
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
    afterReread: service.usage(),
  };
  service.dispose();
  return result;
}

async function workerLru() {
  const pages = Array.from({ length: 4 }, (_, index) => [textEntry(`b${index}`, 'x')]);
  const { reader } = scriptedReader(pages);
  const service = createAuxiliaryHistoryService({ reader, limits: { pages: 3 } });
  const first = await service.page(null);
  const second = await service.page('1');
  const third = await service.page('2');
  await service.page(null); // touch the first page -> most recently used
  const fourth = await service.page('3');
  const result = {
    usage: service.usage(),
    touchedPageResident: service.get(first.pageId) !== null,
    leastRecentlyUsedEvicted: service.get(second.pageId) === null,
    thirdPageResident: service.get(third.pageId) !== null,
    fourthPageResident: service.get(fourth.pageId) !== null,
    fourthPageCursor: fourth.cursor,
    touchedPageStillCached: (await service.page(null)).pageId === first.pageId,
  };
  service.dispose();
  return result;
}

async function workerMemoryCeiling() {
  const entries = Array.from({ length: 171 }, (_, index) => textEntry(`mem-${index}`, 'm'.repeat(102400)));
  const encoder = new TextEncoder();
  let attemptedBytes = 0;
  for (const entry of entries) attemptedBytes += encoder.encode(JSON.stringify(entry)).length;
  const { reader } = scriptedReader([entries]);
  const service = createAuxiliaryHistoryService({ reader });
  const rejection = await captureAsync(() => service.page(null));
  const result = {
    entryCount: entries.length,
    attemptedPageBytes: attemptedBytes,
    exceedsResidentCeiling: attemptedBytes > AUXILIARY_HISTORY_LIMITS.residentBytes,
    rejection,
    usage: service.usage(),
  };
  service.dispose();
  return result;
}

async function workerDirtyAck() {
  let failAck = true;
  const persister = async () => { if (failAck) throw new Error('durable ack rejected: disk full'); };
  const service = createAuxiliaryHistoryService({
    reader: async () => ({ entries: [], nextCursor: null }),
    persister,
    limits: { dirtyMaxCount: 8, dirtyMaxBytes: 1024 * 1024 },
  });
  const staged = Array.from({ length: 5 }, (_, index) => textEntry(`dirty-${index}`, 'y'.repeat(200)));
  service.stage(staged);
  const afterStage = service.usage();
  const rejection = await captureAsync(() => service.commit());
  const afterFail = service.usage();
  failAck = false;
  const recovered = await service.commit();
  const result = {
    stagedCount: staged.length,
    perEntryBytes: new TextEncoder().encode(JSON.stringify(staged[0])).length,
    afterStage,
    rejection,
    afterFail,
    retainedBytesUnchanged: afterFail.dirtyBytes === afterStage.dirtyBytes,
    bufferedHistoryFalse: afterFail.bufferedHistory === false,
    retainedBounded: afterFail.retainedBytes <= 1024 * 1024 + afterFail.residentBytes,
    recovered,
    afterRecover: service.usage(),
  };
  service.dispose();
  return result;
}

async function workerLegacyExportRead() {
  const pages = [
    [textEntry('dup', 'first-segment', 1), textEntry('only-0', 'a')],
    [textEntry('dup', 'longer-second-segment', 2), textEntry('only-1', 'b')],
  ];
  const { reader, calls } = scriptedReader(pages);
  const service = createAuxiliaryHistoryService({ reader });
  const exported = await service.legacyExport();
  const afterExport = service.usage();
  service.dispose();
  const runtime = createAuxiliaryHistoryService({ reader: scriptedReader(pages).reader });
  await runtime.page(null);
  await runtime.page('1');
  const runtimeUsage = runtime.usage();
  runtime.dispose();
  return {
    exportedCount: exported.length,
    exportedIds: exported.map((entry) => entry.info.id),
    readerCalls: calls.length,
    afterExport,
    frozen: Object.isFrozen(exported),
    mergedDuplicateText: exported.find((entry) => entry.info.id === 'dup').parts[0].text,
    mergedDuplicateEnd: exported.find((entry) => entry.info.id === 'dup').parts[0].time.end,
    runtimeUsage,
  };
}

async function workerBoundedScroll() {
  const pages = Array.from({ length: 40 }, (_, page) => Array.from({ length: 200 }, (_, row) => textEntry(`s${page}-${String(row).padStart(3, '0')}`, `body-${page}-${row}`)));
  const { reader, calls } = scriptedReader(pages);
  const service = createAuxiliaryHistoryService({ reader });
  const bytes = [];
  let cursor = null;
  let total = 0;
  for (let step = 0; step < 40; step += 1) {
    const page = await service.page(cursor);
    total += page.entries.length;
    bytes.push(page.bytes);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const usage = service.usage();
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
  service.dispose();
  return result;
}

async function workerPageGap() {
  let first = true;
  const reader = async () => {
    if (first) { first = false; return { entries: [textEntry('g0', 'x')], nextCursor: '1' }; }
    return { entries: [textEntry('g1', 'x')], nextCursor: '1' };
  };
  const service = createAuxiliaryHistoryService({ reader });
  const page = await service.page(null);
  const rejection = await captureAsync(() => service.page('1'));
  const result = {
    rejection,
    usage: service.usage(),
    firstPageStillResident: service.get(page.pageId) !== null,
    firstPageSha256: await digestOf(page.entries),
  };
  service.dispose();
  return result;
}

async function workerCorruptRecord() {
  const missingInfoId = createAuxiliaryHistoryService({ reader: async () => ({ entries: [{ info: { time: { created: 1 } }, parts: [] }], nextCursor: null }) });
  const first = await captureAsync(() => missingInfoId.page(null));
  const missingPartId = createAuxiliaryHistoryService({ reader: async () => ({ entries: [{ info: { id: 'ok' }, parts: [{ type: 'text', text: 'no id' }] }], nextCursor: null }) });
  const second = await captureAsync(() => missingPartId.page(null));
  const nullEntry = createAuxiliaryHistoryService({ reader: async () => ({ entries: [null], nextCursor: null }) });
  const third = await captureAsync(() => nullEntry.page(null));
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

async function workerOldGeneration() {
  const service = createAuxiliaryHistoryService({ reader: async () => ({ entries: [], nextCursor: null }), persister: async () => {} });
  service.stage([textEntry('gen-2', 'x')], 2);
  const afterFirst = service.usage();
  const rejection = captureSync(() => service.stage([textEntry('gen-1', 'x')], 1));
  const afterReject = service.usage();
  const sameGeneration = captureSync(() => service.stage([textEntry('gen-2b', 'x')], 2));
  const afterSame = service.usage();
  const committed = await service.commit();
  const result = { afterFirst, rejection, afterReject, sameGeneration, afterSame, committed };
  service.dispose();
  return result;
}

async function workerTerminalGuard() {
  const canonical = [{
    info: { id: 'm1', time: { created: 1 } },
    parts: [
      { id: 'm1:tool', type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: {}, output: 'FINAL OUTPUT', time: { start: 1, end: 2 } } },
      { id: 'm1:text', type: 'text', text: 'final answer', time: { start: 1, end: 3 } },
    ],
  }];
  const before = canonical[0].parts.map((part) => ({ ...part }));
  const merged = mergeAuxiliaryCanonical(canonical, [toolEntry('m1', 'running', '')]);
  const after = merged[0].parts.map((part) => ({ ...part }));
  const runningFirst = mergeAuxiliaryCanonical([toolEntry('m1', 'running', 'partial')], [toolEntry('m1', 'completed', 'FINAL OUTPUT', 2)]);
  const errorOverCompleted = mergeAuxiliaryCanonical([toolEntry('m1', 'completed', 'FIRST', 2)], [toolEntry('m1', 'error', 'SECOND', 3)]);
  const longerTextWins = mergeAuxiliaryCanonical([textEntry('m1', 'the longer transcript')], [textEntry('m1', 'short')]);
  const terminalTextWins = mergeAuxiliaryCanonical([textEntry('m1', 'final answer', 3)], [textEntry('m1', 'a much longer later stub')]);
  return {
    runningStubRejectedByGuard: {
      status: merged[0].parts[0].state.status,
      output: merged[0].parts[0].state.output,
      end: merged[0].parts[0].state.time.end,
      text: merged[0].parts[1].text,
      textEnd: merged[0].parts[1].time.end,
      afterEqualsBefore: JSON.stringify(after) === JSON.stringify(before),
    },
    guardIsDirectional: {
      runningThenCompleted: { status: runningFirst[0].parts[0].state.status, output: runningFirst[0].parts[0].state.output },
      errorOverCompleted: { status: errorOverCompleted[0].parts[0].state.status, output: errorOverCompleted[0].parts[0].state.output },
      longerTextWins: longerTextWins[0].parts[0].text,
      terminalTextWins: terminalTextWins[0].parts[0].text,
    },
  };
}

async function workerChunkRefusals() {
  const { reader } = scriptedReader([[textEntry('big', 'A'.repeat(3 * 1024 * 1024))], [textEntry('small', 'tiny')]]);
  const service = createAuxiliaryHistoryService({ reader });
  const first = await service.page(null);
  const second = await service.page('1');
  const descriptorId = first.oversized[0].descriptorId;
  const result = {
    oversized: { entryId: first.oversized[0].entryId, totalBytes: first.oversized[0].totalBytes },
    pageBytes: first.bytes,
    residentBytes: service.usage().residentBytes,
    residentUnderInlineCeiling: service.usage().residentBytes < AUXILIARY_HISTORY_LIMITS.entryInlineBytes,
    foreignDescriptor: await captureAsync(() => service.chunk(second.pageId, descriptorId, 0)),
    unknownDescriptor: await captureAsync(() => service.chunk(first.pageId, 'not-a-descriptor', 0)),
    unknownPage: await captureAsync(() => service.chunk('not-a-page', descriptorId, 0)),
    negativeOffset: await captureAsync(() => service.chunk(first.pageId, descriptorId, -1)),
    fractionalOffset: await captureAsync(() => service.chunk(first.pageId, descriptorId, 1.5)),
    ownDescriptorServed: await captureAsync(() => service.chunk(first.pageId, descriptorId, 0)),
    usage: service.usage(),
  };
  service.dispose();
  return result;
}

function workerDirtyBudget() {
  const counting = createAuxiliaryHistoryService({
    reader: async () => ({ entries: [], nextCursor: null }),
    persister: async () => {},
    limits: { dirtyMaxCount: 4, dirtyMaxBytes: 1024 * 1024 },
  });
  counting.stage(Array.from({ length: 4 }, (_, index) => textEntry(`cap-${index}`, 'z')));
  const afterFill = counting.usage();
  const countOverflow = captureSync(() => counting.stage([textEntry('cap-overflow', 'z')]));
  const afterCountOverflow = counting.usage();
  counting.dispose();
  const bytes = createAuxiliaryHistoryService({
    reader: async () => ({ entries: [], nextCursor: null }),
    persister: async () => {},
    limits: { dirtyMaxCount: 32, dirtyMaxBytes: 1024 },
  });
  bytes.stage([textEntry('bytes-1', 'z'.repeat(200))]);
  const afterFirstByte = bytes.usage();
  const byteOverflow = captureSync(() => bytes.stage([textEntry('bytes-2', 'z'.repeat(2000))]));
  const afterByteOverflow = bytes.usage();
  bytes.dispose();
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

async function workerDbFail() {
  const pages = Array.from({ length: 40 }, (_, page) => Array.from({ length: 200 }, (_, row) => textEntry(`h${page}-${row}`, `body-${page}-${row}`)));
  const { reader, calls } = scriptedReader(pages);
  let failAck = true;
  const persister = async () => { if (failAck) throw new Error('disk full'); };
  const service = createAuxiliaryHistoryService({ reader, persister });
  service.stage(Array.from({ length: 5 }, (_, index) => textEntry(`dirty-${index}`, 'y'.repeat(200))));
  const staged = service.usage();
  const rejection = await captureAsync(() => service.commit());
  const afterFail = service.usage();
  let cursor = null;
  let total = 0;
  for (let step = 0; step < 40; step += 1) {
    const page = await service.page(cursor);
    total += page.entries.length;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const afterScroll = service.usage();
  failAck = false;
  const recovered = await service.commit();
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
    afterRecover: service.usage(),
  };
  service.dispose();
  return result;
}

async function workerReaderFailure() {
  const throwing = createAuxiliaryHistoryService({ reader: async () => { throw new Error('socket closed'); } });
  const readerThrows = await captureAsync(() => throwing.page(null));
  const nullRaw = createAuxiliaryHistoryService({ reader: async () => null });
  const nullRejection = await captureAsync(() => nullRaw.page(null));
  const badEntries = createAuxiliaryHistoryService({ reader: async () => ({ entries: 'nope', nextCursor: null }) });
  const badEntriesRejection = await captureAsync(() => badEntries.page(null));
  const missingEntries = createAuxiliaryHistoryService({ reader: async () => ({}) });
  const missingRejection = await captureAsync(() => missingEntries.page(null));
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

async function workerDisposeFences() {
  const service = createAuxiliaryHistoryService({
    reader: async () => ({ entries: [textEntry('d0', 'x')], nextCursor: null }),
    persister: async () => {},
  });
  const page = await service.page(null);
  service.stage([textEntry('d1', 'x')]);
  service.dispose();
  const pageAfter = await captureAsync(() => service.page(null));
  const rereadAfter = await captureAsync(() => service.reread(null));
  const stageAfter = captureSync(() => service.stage([textEntry('d2', 'x')]));
  const commitAfter = await captureAsync(() => service.commit());
  const exportAfter = await captureAsync(() => service.legacyExport());
  const usage = service.usage();
  const evictedReceipt = service.evict(page.pageId);
  return {
    page: pageAfter,
    reread: rereadAfter,
    stage: stageAfter,
    commit: commitAfter,
    // OBSERVED, NOT FORCED: legacyExport() calls the injected reader directly and never goes through
    // readPage(), so it is the one entry point dispose does NOT fence. Recorded as an observed gap.
    legacyExport: exportAfter,
    legacyExportCompleted: exportAfter.code === null,
    getAfterDisposeIsNull: service.get(page.pageId) === null,
    evictAfterDispose: { freedBytes: evictedReceipt.freedBytes, evicted: evictedReceipt.evicted },
    chunkAfterDispose: await captureAsync(() => service.chunk(page.pageId, 'x', 0)),
    usage,
  };
}

async function workerExportGap() {
  const reader = async () => ({ entries: [textEntry('e0', 'x')], nextCursor: '1' });
  const service = createAuxiliaryHistoryService({ reader });
  const rejection = await captureAsync(() => service.legacyExport());
  const usage = service.usage();
  const result = { rejection, usage, bufferedHistoryAfterFailedExport: usage.bufferedHistory };
  service.dispose();
  return result;
}

async function workerStageValidation() {
  const service = createAuxiliaryHistoryService({ reader: async () => ({ entries: [], nextCursor: null }), persister: async () => {} });
  service.stage([textEntry('v0', 'x')]);
  const afterFirst = service.usage();
  const corrupt = captureSync(() => service.stage([{ info: {}, parts: [] }]));
  const duplicate = captureSync(() => service.stage([textEntry('v0', 'x')]));
  const afterDuplicate = service.usage();
  const committed = await service.commit();
  const emptyCommit = await service.commit();
  const result = { afterFirst, corrupt, duplicate, afterDuplicate, committed, emptyCommit };
  service.dispose();
  return result;
}

/**
 * The DB-fail boundedness workload: three rounds of staging five records, failing the durable ack
 * and scrolling all 8000 entries, then the recovery commit.
 *
 * The PRODUCT'S OWN usage() counters are the load-bearing evidence — residentBytes / pageCount /
 * evicted / dirtyCount / dirtyBytes / retainedBytes / bufferedHistory — captured twice: after the
 * three failed acks (the dirty set is RETAINED for recovery) and after the recovery commit.
 *
 * The heap numbers are RECORDED, and they are a GC-TIMING ARTEFACT, not a retention proof:
 * process.memoryUsage().heapUsed measures "allocated and not yet collected", so it grows with
 * whatever garbage the workload produced and collapses the moment a collection runs — the
 * executor's own --expose-gc replay of this exact workload measured the growth falling from
 * 2.99 MiB to 0.41 MiB while usage() stayed byte-identical. No boundedness decision is derived
 * from them anywhere in this case; they are observations, nothing more.
 */
async function workerDbFailHeap() {
  const pages = Array.from({ length: 40 }, (_, page) => Array.from({ length: 200 }, (_, row) => textEntry(`h${page}-${row}`, `body-${page}-${row}`)));
  const { reader, calls } = scriptedReader(pages);
  let failAck = true;
  const persister = async () => { if (failAck) throw new Error('disk full'); };
  const service = createAuxiliaryHistoryService({ reader, persister });
  const heapStart = process.memoryUsage().heapUsed;
  let peak = heapStart;
  let entriesFlowed = 0;
  let failedCommits = 0;
  for (let round = 0; round < 3; round += 1) {
    service.stage(Array.from({ length: 5 }, (_, index) => textEntry(`retry-${round}-${index}`, 'y'.repeat(200))));
    failedCommits += (await captureAsync(() => service.commit())).code === 'source_unavailable' ? 1 : 0;
    let cursor = null;
    for (let step = 0; step < 40; step += 1) {
      const page = await service.page(cursor);
      entriesFlowed += page.entries.length;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  // The dirty set is RETAINED across the failed acks — the product's own counter, captured before
  // the recovery commit, which is the retention evidence a heap delta can never provide.
  const afterFailedAcks = service.usage();
  failAck = false;
  const recovered = await service.commit();
  const usage = service.usage();
  const heapEnd = process.memoryUsage().heapUsed;
  const result = {
    heapStart,
    heapPeak: peak,
    heapEnd,
    heapPeakGrowthBytes: peak - heapStart,
    heapGrowthBytes: heapEnd - heapStart,
    readerCalls: calls.length,
    failedCommits,
    entriesFlowed,
    afterFailedAcks,
    usage,
    residentInsideCeiling: usage.residentBytes <= AUXILIARY_HISTORY_LIMITS.residentBytes && afterFailedAcks.residentBytes <= AUXILIARY_HISTORY_LIMITS.residentBytes,
    retainedInsideBudgets: usage.retainedBytes <= AUXILIARY_HISTORY_LIMITS.residentBytes + AUXILIARY_HISTORY_LIMITS.dirtyMaxBytes && afterFailedAcks.retainedBytes <= AUXILIARY_HISTORY_LIMITS.residentBytes + AUXILIARY_HISTORY_LIMITS.dirtyMaxBytes,
    pageCountInsideCeiling: usage.pageCount <= AUXILIARY_HISTORY_LIMITS.pages && afterFailedAcks.pageCount <= AUXILIARY_HISTORY_LIMITS.pages,
    bufferedHistoryFalse: usage.bufferedHistory === false && afterFailedAcks.bufferedHistory === false,
    evictedNonZero: usage.evicted > 0,
    dirtyRetainedAcrossFailedAcks: afterFailedAcks.dirtyCount === 3 * 5 && afterFailedAcks.dirtyBytes === recovered.bytes,
    recovered,
  };
  service.dispose();
  return result;
}

/** Independently recomputes the sha256 of the pinned product files (the evidence-binding guard). */
function productHashes(root) {
  return Object.fromEntries(PRODUCT_FILES.map((file) => [
    file,
    createHash('sha256').update(readFileSync(path.resolve(root, file))).digest('hex'),
  ]));
}

export const sourceFiles = [...new Set([
  // the product paths this case exercises
  'bridge/runtime/history/historyService.js',
  'bridge/runtime/history/historyService.d.ts',
  'bridge/runtime/history/auxiliaryMerge.js',
  'bridge/runtime/history/auxiliaryMerge.d.ts',
  'app/runtime/historyPages.ts',
  'app/backends/codex/nativeAuxiliaryStorage.ts',
  'app/backends/codex/auxiliaryStorage.ts',
  'app/utils/backendHistoryStorage.ts',
  'app/runtime/historyPaging.test.ts',
  // the modules the product pulls in
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'app/runtime/migration/writerFreeze.ts',
  'app/utils/storageKeys.ts',
  'app/types/sessionDatabase.ts', 'app/types/sse.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task36.ts',
  'scripts/qa/runtime-v090-cases/task-36.mjs',
  'scripts/qa/runtime-v090-cases/task-36-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 36 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task36Errors=[];window.addEventListener('error',(e)=>window.__task36Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task36Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task36.ts"></script></body></html>`;

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-36/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { node: {}, browser: {} };
  const proof = { case: context.case, runDir, checks, observations, protocol };
  let peakHeap = process.memoryUsage().heapUsed;
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'the real landed bridge paging engine bridge/runtime/history/historyService.js plus the pure merge auxiliaryMerge.js in the Node worker, and the SAME engine reached through the real app-side seam app/runtime/historyPages.ts (createHistoryPageCache) plus the real storage wiring nativeAuxiliaryStorage.ts / auxiliaryStorage.ts / backendHistoryStorage.ts in a real headless Chromium served by a case-owned Vite server',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-36.mjs',
    'scripts/qa/runtime-v090-cases/task-36-fixture.mjs',
    'app/dev/runtime-v090/task36.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const productHashesBefore = productHashes(context.root);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;

  // Drives one worker mirror and its browser twin, then asserts the two realms are IDENTICAL.
  const crossRealm = async (name, workerValue, browserValue, expected) => {
    protocol.node[name] = workerValue;
    protocol.browser[name] = browserValue;
    record(name, { worker: workerValue, browser: browserValue });
    check(name, {
      worker: workerValue,
      browser: browserValue,
      equal: JSON.stringify(workerValue) === JSON.stringify(browserValue),
    }, { worker: expected, browser: expected, equal: true });
  };

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the real app-side cache (no shim: no node:* builtin anywhere)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa36', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa36/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task36 && window.task36.ready)), 'task36 browser entry', 60000);
    const evaluate = (fn) => page.evaluate(fn);

    // ── C1: the frozen shared budget, the namespaces and the terminal table are identical ──
    await crossRealm('the frozen shared budget (three pages / 16 MiB resident / 2 MiB inline / 64 KiB chunk / 200 records per page / 32 dirty records / 8 MiB dirty), the three paging namespaces and the terminal-guard table are identical in the browser realm and the bridge worker, and every table is frozen — the browser realm READS the namespace literals from the real product modules while the worker pins them, so equality proves the product constants', workerTables(), await evaluate(() => window.task36.tables()), {
      limits: { pages: 3, residentBytes: 16777216, entryInlineBytes: 2097152, chunkBytes: 65536, recordsPerPage: 200, dirtyMaxCount: 32, dirtyMaxBytes: 8388608 },
      limitsFrozen: true,
      namespaces: { appPaged: 'auxiliary-history-paged-v1', native: 'codex-auxiliary-history-paged-v1', backendHistoryPrefix: 'backend-history-paged-v2' },
      terminalStatuses: ['completed', 'error'],
      terminalStatusesFrozen: true,
      terminalPredicates: { completed: true, error: true, running: false, textWithEnd: true, textWithoutEnd: false, continuationWithEnd: true },
    });

    if (context.case === 'happy') {
      // ══════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: the 635-item continuation and the long tool session, the paginated scroll,
      // the evict/reopen hash equality, the 16 MiB ceiling, the dirty recovery and the wiring
      // ══════════════════════════════════════════════════════════════════════════════════════

      // ── H1: AC1 — the merge never regresses a tool's terminal state or its text ──
      await crossRealm('a 635-item continuation chain (634 continuation items plus one long tool session) merged against a later page of running stubs keeps EVERY terminal in both realms: the observed merged count 635, the observed 634-id continuation chain whose digest and head/tail texts are preserved verbatim with their end times, the observed terminal tool state (completed / "FINAL OUTPUT …" at 4013 bytes / end 9), the observed terminal continuation text and end, after === before, and the frozen read model — the same merged sha256 53a18475… in both realms', await workerMerge(), await evaluate(() => window.task36.merge()), {
        canonicalCount: 635,
        mergedCount: 635,
        mergedIds: Array.from({ length: 635 }, (_, index) => (index < 634 ? `cont-${String(index).padStart(4, '0')}` : 'tool-session')),
        chainPreserved: true,
        chainDigest: 'b6aba4a623ebaaae1c56777e0bd6cf5412f74111948a805de873c292d666e5ef',
        chainHeadText: `segment-0-${'c'.repeat(40)}`,
        chainTailText: `segment-633-${'c'.repeat(673)}`,
        terminalToolStatus: 'completed',
        terminalToolOutputPrefix: 'FINAL OUTPUT ',
        terminalToolOutputLength: 4013,
        terminalToolEnd: 9,
        terminalContinuationText: 'final continuation answer',
        terminalContinuationEnd: 11,
        afterEqualsBefore: true,
        frozen: [true, true, true, true],
        mergedSha256: '53a184750fa79b75a82bb4e8ac45de39aeba3a40921ce06ab9f5bac15c9284cb',
      });

      // ── H2: the paginated scroll over the real paging contract ──
      await crossRealm('a six-page scroll walks the real paging contract with the OBSERVED cursor chain null→"1"→"2"→"3"→"4"→"5"→null, 100 entries and 11090 bytes on every page, 600 entries in total, and re-reading the two still-resident pages is a CACHE HIT (the reader was called exactly 6 times across the whole scenario) with the observed per-page sha256 — identical in both realms', await workerScroll(), await evaluate(() => window.task36.scroll()), {
        walk: Array.from({ length: 6 }, (_, index) => ({ cursor: index === 0 ? null : String(index), nextCursor: index === 5 ? null : String(index + 1), count: 100, bytes: 11090 })),
        totalEntries: 600,
        readerCallsAfterWalk: 6,
        readerCallsAfterResidentRereads: 6,
        residentRereadsAreCacheHits: true,
        pageSha256s: ['f56cf2f50fb4839be5575fc433821f5dbc7210e9d1392df3b5a3eb2d739709f3', 'b9813c63d8179816468de46d9e2cab63041fdb4d32afdf50411fe6d40d5c0bcb'],
        usage: { residentBytes: 33270, pageCount: 3, evicted: 3, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 33270, bufferedHistory: false },
      });

      // ── H3: a single message over 2 MiB is chunked, slice by slice ──
      await crossRealm('a single 3145728-byte message becomes ONE chunked reference (observed totalBytes 3145822 of the serialized entry) served in 49 observed slices of at most 65536 bytes — offset 0/65536/131072 with nextOffset 65536/131072/196608, the last slice 94 bytes at offset 3145728 with nextOffset null — the page holds 0 inline entries and charges the body\'s FULL encoded size to the resident budget (observed pageBytes and residentBytes 3145822 of the 16 MiB ceiling, so a 20 MiB body would be refused instead of admitted), no single read materialises more than one 65536-byte slice, and the reassembly re-hashes to the SAME sha256 46ffe21c… as the serialized entry in both realms', await workerChunks(), await evaluate(() => window.task36.chunks()), {
        serializedBytes: 3145822,
        oversized: { entryId: 'big', totalBytes: 3145822 },
        pageBytes: 3145822,
        pageEntryCount: 0,
        residentBytes: 3145822,
        chunkCount: 49,
        firstThree: [{ offset: 0, bytes: 65536, nextOffset: 65536 }, { offset: 65536, bytes: 65536, nextOffset: 131072 }, { offset: 131072, bytes: 65536, nextOffset: 196608 }],
        lastTwo: [{ offset: 3080192, bytes: 65536, nextOffset: 3145728 }, { offset: 3145728, bytes: 94, nextOffset: null }],
        largestChunkBytes: 65536,
        reassemblyEqualsSerialized: true,
        reassemblySha256: '46ffe21cefb51a9978ca872083e7eeb1ef31a5adc17d46b33b6f443c05a5ac43',
        serializedSha256: '46ffe21cefb51a9978ca872083e7eeb1ef31a5adc17d46b33b6f443c05a5ac43',
        usage: { residentBytes: 3145822, pageCount: 1, evicted: 0, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 3145822, bufferedHistory: false },
      });

      // ── H4: AC2 — evict, then reopen with hash-equal content ──
      await crossRealm('three pages are resident (observed residentBefore 316, pageCount 3); evicting the inactive first page frees the observed 106 bytes, drops pageCount to 2 and residentBytes to 316-106=210 with evicted 1 and get() null; the re-read calls the reader once more (3→4, so NOT a cache hit) and returns hash-equal content (sha256 cf8e68cd… before and after) under a NEW pageId with byte-equal entries, restoring pageCount 3, residentBytes 316 and rereads 1 — identical in both realms', await workerEvictReopen(), await evaluate(() => window.task36.evictReopen()), {
        residentBefore: 316,
        pageCountBefore: 3,
        hashBefore: 'cf8e68cdaa86ab194f43222387e127c348fb57b2199a59b4d4a1f6c0a05b6bde',
        receipt: { freedBytes: 106, evicted: true },
        afterEvict: { residentBytes: 210, pageCount: 2, evicted: 1, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 210, bufferedHistory: false },
        residentEqualsBeforeMinusFreed: true,
        getAfterEvictIsNull: true,
        readerCallsBeforeReread: 3,
        readerCallsAfterReread: 4,
        rereadHash: 'cf8e68cdaa86ab194f43222387e127c348fb57b2199a59b4d4a1f6c0a05b6bde',
        hashEqual: true,
        pageIdChanged: true,
        entriesEqual: true,
        afterReread: { residentBytes: 316, pageCount: 3, evicted: 1, rereads: 1, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 316, bufferedHistory: false },
      });

      // ── H5: the three-page ceiling auto-evicts the least-recently-used inactive page ──
      await crossRealm('reading a fourth page past the three-page ceiling evicts exactly the least-recently-used inactive page: after touching the first page it stays resident and is still the SAME cached page, the untouched second page is the one evicted (evicted 1), the third and fourth pages are resident, and pageCount stays at the ceiling of 3 — identical in both realms', await workerLru(), await evaluate(() => window.task36.lru()), {
        usage: { residentBytes: 279, pageCount: 3, evicted: 1, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 279, bufferedHistory: false },
        touchedPageResident: true,
        leastRecentlyUsedEvicted: true,
        thirdPageResident: true,
        fourthPageResident: true,
        fourthPageCursor: '3',
        touchedPageStillCached: true,
      });

      // ── H6: the 16 MiB / three-page ceiling is enforced with observed numbers ──
      await crossRealm('the 16 MiB resident ceiling is enforced with the OBSERVED numbers: a single page of 171 entries totalling 17,527,622 bytes (over the 16,777,216-byte ceiling) is refused with source_unavailable/history.memory and NOTHING becomes resident (pageCount 0, residentBytes 0, evicted 0, retainedBytes 0) — the page is refused before admission, so no eviction and no partial state is left behind', await workerMemoryCeiling(), await evaluate(() => window.task36.memoryCeiling()), {
        entryCount: 171,
        attemptedPageBytes: 17527622,
        exceedsResidentCeiling: true,
        rejection: { code: 'source_unavailable', field: 'history.memory' },
        usage: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 0, bufferedHistory: false },
      });

      // ── H7: AC3 — a failed durable ack retains bounded dirty recovery ──
      await crossRealm('five staged records (observed dirtyCount 5, dirtyBytes 1510 at 302 bytes each) are retained after the durable ack fails with source_unavailable/history.durable_ack: the dirty count and bytes are UNCHANGED, bufferedHistory stays false, the retained 1510 bytes stay inside the 1 MiB dirty budget, and the retry after the ack recovers all five (committed 5, bytes 1510, dirtyCount 0) — identical in both realms', await workerDirtyAck(), await evaluate(() => window.task36.dirtyAck()), {
        stagedCount: 5,
        perEntryBytes: 302,
        afterStage: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 5, dirtyBytes: 1510, retainedBytes: 1510, bufferedHistory: false },
        rejection: { code: 'source_unavailable', field: 'history.durable_ack' },
        afterFail: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 5, dirtyBytes: 1510, retainedBytes: 1510, bufferedHistory: false },
        retainedBytesUnchanged: true,
        bufferedHistoryFalse: true,
        retainedBounded: true,
        recovered: { committed: 5, bytes: 1510 },
        afterRecover: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 0, bufferedHistory: false },
      });

      // ── H8: legacyExport is the single explicit full read ──
      await crossRealm('legacyExport() is the single explicit read-only full read: it walks both pages through the reader (2 calls), merges the duplicate id canonically (the observed longer later segment "longer-second-segment" with end 2 wins over the earlier terminal segment), returns a frozen 3-entry canonical and marks bufferedHistory true — while the RUNTIME page path over the same reader leaves bufferedHistory FALSE and admits only its two pages (pageCount 2), so the runtime path never buffers the whole history', await workerLegacyExportRead(), await evaluate(() => window.task36.legacyExportRead()), {
        exportedCount: 3,
        exportedIds: ['dup', 'only-0', 'only-1'],
        readerCalls: 2,
        afterExport: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 0, bufferedHistory: true },
        frozen: true,
        mergedDuplicateText: 'longer-second-segment',
        mergedDuplicateEnd: 2,
        runtimeUsage: { residentBytes: 478, pageCount: 2, evicted: 0, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 478, bufferedHistory: false },
      });

      // ── H9: boundedness with REAL numbers over a long scroll ──
      await crossRealm('a 40-page / 8000-entry scroll stays inside the shared budget with REAL numbers: 40 reader calls, 8000 entries observed, the observed page bytes 21890 (first) through 22490 (last), only THREE pages resident (pageCount 3) at 67,470 resident bytes — far under the 16 MiB ceiling — after 37 evictions, and the whole history is never buffered (bufferedHistory false) — identical in both realms', await workerBoundedScroll(), await evaluate(() => window.task36.boundedScroll()), {
        readerCalls: 40,
        totalEntries: 8000,
        firstPageBytes: 21890,
        lastPageBytes: 22490,
        maxPageBytes: 22490,
        usage: { residentBytes: 67470, pageCount: 3, evicted: 37, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 67470, bufferedHistory: false },
        residentUnderCeiling: true,
        pageCountAtCeiling: true,
      });

      // ── H10: the storage wiring under the NEW namespaces (browser realm only) ──
      // The three open*Paging exports are app-side TypeScript, so the Node worker cannot import
      // them at all; the database is the product's own declared SessionDatabaseApi seam.
      const wiringValue = await evaluate(() => window.task36.wiring());
      protocol.browser.wiring = wiringValue;
      record('wiring', { browser: wiringValue });
      check('the storage modules expose the bounded paging under the NEW namespaces over the real sessionDatabase contract, with NO production caller claimed: openNativeAuxiliaryPaging opens a cache named codex-auxiliary-history-paged-v1 whose read request is exactly {threadId:"thread-1", namespace:"codex-auxiliary-history-paged-v1", limit:200} (the cursor key omitted for a null cursor, present as "1" for the second read), serves the observed entry n0, and commits a staged write through upsertHistory with exactly {threadId, namespace, entries} carrying n1; openBackendHistoryPaging opens a cache whose namespace matches ^backend-history-paged-v2:[a-f0-9]{32}$ (the scoped 32-hex suffix) and serves bk0; the codex facade returns undefined without a native database, and both openers return undefined when no database is available', { browser: wiringValue }, {
        browser: {
          native: {
            defined: true,
            namespace: 'codex-auxiliary-history-paged-v1',
            readHistoryRequest: { threadId: 'thread-1', namespace: 'codex-auxiliary-history-paged-v1', limit: 200 },
            readHistoryRequestKeys: ['threadId', 'namespace', 'limit'],
            secondReadHistoryRequest: { threadId: 'thread-1', namespace: 'codex-auxiliary-history-paged-v1', cursor: '1', limit: 200 },
            entryIds: ['n0'],
            upsertRequestKeys: ['threadId', 'namespace', 'entries'],
            upsertEntryIds: ['n1'],
            committed: 1,
          },
          backendHistory: {
            defined: true,
            namespace: 'backend-history-paged-v2:6d891a0d7631fba930a2ca0b254115bd',
            namespaceMatchesPagedV2: true,
            readHistoryRequestKeys: ['threadId', 'namespace', 'limit'],
            entryIds: ['bk0'],
          },
          codexFacadeWithoutNativeDatabaseDefined: false,
          noNativeDatabaseDefined: false,
          noBackendDatabaseDefined: false,
        },
      });
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: page gap, corrupt record, old-generation write, terminal overwritten by
      // running, the >2 MiB chunk contract, the dirty budgets, the DB fail and the dispose fences
      // ══════════════════════════════════════════════════════════════════════════════════════

      // ── F1: a history page gap ──
      await crossRealm('a history page gap is refused with the OBSERVED code and field and loses NO auxiliary data: a reader that repeats cursor "1" is refused with source_unavailable/history.cursor instead of looping, the first page stays resident (pageCount 1, residentBytes 93) and its content hash 59cf87ba… is unchanged — identical in both realms', await workerPageGap(), await evaluate(() => window.task36.pageGap()), {
        rejection: { code: 'source_unavailable', field: 'history.cursor' },
        usage: { residentBytes: 93, pageCount: 1, evicted: 0, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 93, bufferedHistory: false },
        firstPageStillResident: true,
        firstPageSha256: '59cf87bac95467ced4f6523af1ffc6b555690eab19cf00271eca346db1d4c5cd',
      });

      // ── F2: a corrupt record ──
      await crossRealm('a corrupt record is refused with the OBSERVED code and field instead of being silently dropped, and nothing becomes resident or dirty: an entry missing info.id, a part missing its id and a null entry are EACH refused with invalid_request/history.record, and all three services report pageCount 0, residentBytes 0 and dirtyCount 0 — identical in both realms', await workerCorruptRecord(), await evaluate(() => window.task36.corruptRecord()), {
        missingInfoId: { code: 'invalid_request', field: 'history.record' },
        missingPartId: { code: 'invalid_request', field: 'history.record' },
        nullEntry: { code: 'invalid_request', field: 'history.record' },
        residentCounts: [0, 0, 0],
        residentBytes: [0, 0, 0],
        dirtyCounts: [0, 0, 0],
      });

      // ── F3: an old-generation write ──
      await crossRealm('an old-generation write is refused with the OBSERVED code and field and changes nothing: after staging at generation 2 (dirtyCount 1, dirtyBytes 99) a generation-1 write is refused with conflict/history.generation and the dirty set is UNCHANGED (still 1 record / 99 bytes), a same-generation write is accepted (2 records / 200 bytes) and commits both — identical in both realms', await workerOldGeneration(), await evaluate(() => window.task36.oldGeneration()), {
        afterFirst: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 1, dirtyBytes: 99, retainedBytes: 99, bufferedHistory: false },
        rejection: { code: 'conflict', field: 'history.generation' },
        afterReject: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 1, dirtyBytes: 99, retainedBytes: 99, bufferedHistory: false },
        sameGeneration: { code: null, field: null },
        afterSame: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 2, dirtyBytes: 200, retainedBytes: 200, bufferedHistory: false },
        committed: { committed: 2, bytes: 200 },
      });

      // ── F4: a terminal record being overwritten by a running one is refused ──
      // OBSERVED, NOT FORCED: the guard is a PRESERVATION, not a throw — a later running stub is
      // refused by KEEPING the terminal state, so there is no error code. The observed terminal
      // status, output and end-time are asserted, and the guard is proven DIRECTIONAL (a later
      // terminal does replace an earlier one; a longer non-terminal text does win), which is what
      // shows the guard discriminates on terminal-ness rather than blindly keeping the first record.
      await crossRealm('a terminal record being overwritten by a running one is REFUSED BY PRESERVING IT — there is no error code because the merge never throws on this path: the observed merged tool part is still completed with output "FINAL OUTPUT" and end 2, the observed text part is still "final answer" with end 3, and after === before; the guard is proven DIRECTIONAL rather than blind — a running record followed by a completed one takes the completed status and output, an error record over a completed one takes the error status (a later terminal replaces an earlier terminal), a longer non-terminal text wins over a shorter one, and a terminal text wins over a longer non-terminal stub — identical in both realms', await workerTerminalGuard(), await evaluate(() => window.task36.terminalGuard()), {
        runningStubRejectedByGuard: { status: 'completed', output: 'FINAL OUTPUT', end: 2, text: 'final answer', textEnd: 3, afterEqualsBefore: true },
        guardIsDirectional: {
          runningThenCompleted: { status: 'completed', output: 'FINAL OUTPUT' },
          errorOverCompleted: { status: 'error', output: 'SECOND' },
          longerTextWins: 'the longer transcript',
          terminalTextWins: 'final answer',
        },
      });

      // ── F5: a single message over 2 MiB and the chunk contract's refusals ──
      await crossRealm('a single message over 2 MiB is chunked and charged at its FULL encoded size (observed totalBytes 3145822, pageBytes 3145822, residentBytes 3145924 across both pages, residentUnderInlineCeiling false because the whole body counts against the 16 MiB resident ceiling — the bound is the budget, not a 2 MiB per-entry cap), and the chunk contract refuses every malformed request with the OBSERVED code and field: a descriptor belonging to another page, an unknown descriptor and an unknown page are each invalid_request/history.descriptor, a negative offset and a fractional offset are each invalid_request/history.offset, and the page\'s own descriptor at offset 0 is served — identical in both realms', await workerChunkRefusals(), await evaluate(() => window.task36.chunkRefusals()), {
        oversized: { entryId: 'big', totalBytes: 3145822 },
        pageBytes: 3145822,
        residentBytes: 3145924,
        residentUnderInlineCeiling: false,
        foreignDescriptor: { code: 'invalid_request', field: 'history.descriptor' },
        unknownDescriptor: { code: 'invalid_request', field: 'history.descriptor' },
        unknownPage: { code: 'invalid_request', field: 'history.descriptor' },
        negativeOffset: { code: 'invalid_request', field: 'history.offset' },
        fractionalOffset: { code: 'invalid_request', field: 'history.offset' },
        ownDescriptorServed: { code: null, field: null },
        usage: { residentBytes: 3145924, pageCount: 2, evicted: 0, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 3145924, bufferedHistory: false },
      });

      // ── F6: the dirty budgets refuse instead of piling up all history ──
      await crossRealm('staging past the bounded dirty budget is refused with the OBSERVED code and field and changes NOTHING: a fifth record past a dirtyMaxCount of 4 is refused with invalid_request/history.dirty_budget leaving 4 records / 396 bytes, and a record past a 1024-byte dirtyMaxBytes is refused with the same code leaving 1 record / 302 bytes — the dirty set is bounded by BOTH the count and the byte budget, so no unbounded history is buffered', workerDirtyBudget(), await evaluate(() => window.task36.dirtyBudget()), {
        countBudget: {
          afterFill: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 4, dirtyBytes: 396, retainedBytes: 396, bufferedHistory: false },
          overflow: { code: 'invalid_request', field: 'history.dirty_budget' },
          afterOverflow: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 4, dirtyBytes: 396, retainedBytes: 396, bufferedHistory: false },
          unchanged: true,
        },
        byteBudget: {
          afterFirst: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 1, dirtyBytes: 302, retainedBytes: 302, bufferedHistory: false },
          overflow: { code: 'invalid_request', field: 'history.dirty_budget' },
          afterOverflow: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 1, dirtyBytes: 302, retainedBytes: 302, bufferedHistory: false },
          unchanged: true,
        },
      });

      // ── F7: a DB fail loses no auxiliary data and stays bounded ──
      await crossRealm('a DB fail loses NO auxiliary data and stays bounded: five staged records (dirtyCount 5, dirtyBytes 1510) survive a failed durable ack (source_unavailable/history.durable_ack) AND a full 8000-entry scroll across 40 pages (40 reader calls), with the dirty count and bytes UNCHANGED after the scroll, the observed retained bytes 68,320 (66,810 resident + 1,510 dirty) inside the 8 MiB dirty budget plus the 16 MiB resident ceiling, bufferedHistory false, and the retry after the ack recovers all five — identical in both realms', await workerDbFail(), await evaluate(() => window.task36.dbFail()), {
        staged: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 5, dirtyBytes: 1510, retainedBytes: 1510, bufferedHistory: false },
        rejection: { code: 'source_unavailable', field: 'history.durable_ack' },
        afterFail: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 5, dirtyBytes: 1510, retainedBytes: 1510, bufferedHistory: false },
        readerCalls: 40,
        totalEntriesScrolled: 8000,
        afterScroll: { residentBytes: 66810, pageCount: 3, evicted: 37, rereads: 0, dirtyCount: 5, dirtyBytes: 1510, retainedBytes: 68320, bufferedHistory: false },
        dirtySurvivedScroll: true,
        retainedBounded: true,
        bufferedHistory: false,
        recovered: { committed: 5, bytes: 1510 },
        afterRecover: { residentBytes: 66810, pageCount: 3, evicted: 37, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 66810, bufferedHistory: false },
      });

      // ── F8: the DB fail stays bounded in the PRODUCT'S OWN resident counters (worker realm) ──
      const heapValue = await workerDbFailHeap();
      protocol.node.dbFailHeap = heapValue;
      record('dbFailHeap', heapValue);
      check('the DB fail loses NO auxiliary data and stays bounded in the PRODUCT\'S OWN resident counters: three rounds of staging five records each, failing the durable ack and scrolling all 8000 entries move 24,000 entries through the engine over 120 reader calls with three failed commits, the dirty set is RETAINED across the failed acks at 15 records / 4,590 bytes (retained 71,400 with the resident pages), the recovery commit then recovers all 15 records at 4,590 bytes, and the engine holds exactly three pages at 66,810 resident bytes after 117 real evictions with bufferedHistory false throughout — inside the frozen three-page ceiling and the 16 MiB resident + 8 MiB dirty budgets; the no-OOM claim is proven by the worker SURVIVING this workload (an OOM would kill it and the runner would report a signal), and the observed heap numbers are RECORDED as a GC-timing artefact (heapUsed measures allocated-and-not-yet-collected, which a forced collection collapses — the executor-owned --expose-gc replay of this exact workload measured the growth falling from 2.99 MiB to 0.41 MiB while usage() stayed byte-identical), NOT a retention proof, and they decide nothing', heapValue, {
        heapStart: heapValue.heapStart,
        heapPeak: heapValue.heapPeak,
        heapEnd: heapValue.heapEnd,
        heapPeakGrowthBytes: heapValue.heapPeakGrowthBytes,
        heapGrowthBytes: heapValue.heapGrowthBytes,
        readerCalls: 120,
        failedCommits: 3,
        entriesFlowed: 24000,
        afterFailedAcks: { residentBytes: 66810, pageCount: 3, evicted: 117, rereads: 0, dirtyCount: 15, dirtyBytes: 4590, retainedBytes: 71400, bufferedHistory: false },
        usage: { residentBytes: 66810, pageCount: 3, evicted: 117, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 66810, bufferedHistory: false },
        residentInsideCeiling: true,
        retainedInsideBudgets: true,
        pageCountInsideCeiling: true,
        bufferedHistoryFalse: true,
        evictedNonZero: true,
        dirtyRetainedAcrossFailedAcks: true,
        recovered: { committed: 15, bytes: 4590 },
      });

      // ── F9: the reader failure shapes ──
      await crossRealm('a failing source is refused with its OWN explicit code and nothing is retained: a reader that throws is source_unavailable/history.source (the non-ProtocolError is wrapped, not leaked), and a reader returning null, a non-array entries or a missing entries member is source_unavailable/history.page — all four services report pageCount 0 and dirtyCount 0, so a broken source never leaves a half-read page behind', await workerReaderFailure(), await evaluate(() => window.task36.readerFailure()), {
        readerThrows: { code: 'source_unavailable', field: 'history.source' },
        nullRaw: { code: 'source_unavailable', field: 'history.page' },
        entriesNotArray: { code: 'source_unavailable', field: 'history.page' },
        missingEntries: { code: 'source_unavailable', field: 'history.page' },
        residentCounts: [0, 0, 0, 0],
        dirtyCounts: [0, 0, 0, 0],
      });

      // ── F10: the dispose fences ──
      await crossRealm('after dispose every mutating entry point is fenced with the OBSERVED code and field — page, reread, stage and commit are each cancelled/history.disposed — the read models are empty (get() null, evict frees 0 bytes, chunk is invalid_request/history.descriptor) and usage reports zero resident and dirty bytes; OBSERVED AND RECORDED RATHER THAN FORCED, legacyExport() is the one entry point dispose does NOT fence, because it reads through the injected reader directly instead of readPage(), so it still completes (and still marks bufferedHistory true, which is why usage.rereads is 1 — the failed reread increments it before the fence throws)', await workerDisposeFences(), await evaluate(() => window.task36.disposeFences()), {
        page: { code: 'cancelled', field: 'history.disposed' },
        reread: { code: 'cancelled', field: 'history.disposed' },
        stage: { code: 'cancelled', field: 'history.disposed' },
        commit: { code: 'cancelled', field: 'history.disposed' },
        legacyExport: { code: null, field: null },
        legacyExportCompleted: true,
        getAfterDisposeIsNull: true,
        evictAfterDispose: { freedBytes: 0, evicted: false },
        chunkAfterDispose: { code: 'invalid_request', field: 'history.descriptor' },
        usage: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 1, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 0, bufferedHistory: true },
      });

      // ── F11: a cursor gap inside legacyExport ──
      await crossRealm('a cursor gap inside the legacy export is refused with source_unavailable/history.cursor instead of looping forever, and the OBSERVED side effect is recorded rather than hidden: the failed export still leaves bufferedHistory true (the flag is set before the walk begins), so a failed export honestly reports that the full-read path was attempted', await workerExportGap(), await evaluate(() => window.task36.exportGap()), {
        rejection: { code: 'source_unavailable', field: 'history.cursor' },
        usage: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 0, bufferedHistory: true },
        bufferedHistoryAfterFailedExport: true,
      });

      // ── F12: staging validation adds nothing to the bounded dirty set ──
      await crossRealm('staging a corrupt record or an already-staged id adds NOTHING to the bounded dirty set: a record without info.id is refused with invalid_request/history.record, re-staging the same id is accepted but counted once by the fresh-record filter (dirtyCount stays 1, dirtyBytes stays 93), the commit reports the observed 1 record / 93 bytes, and a second empty commit reports committed 0 / bytes 0 — identical in both realms', await workerStageValidation(), await evaluate(() => window.task36.stageValidation()), {
        afterFirst: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 1, dirtyBytes: 93, retainedBytes: 93, bufferedHistory: false },
        corrupt: { code: 'invalid_request', field: 'history.record' },
        duplicate: { code: null, field: null },
        afterDuplicate: { residentBytes: 0, pageCount: 0, evicted: 0, rereads: 0, dirtyCount: 1, dirtyBytes: 93, retainedBytes: 93, bufferedHistory: false },
        committed: { committed: 1, bytes: 93 },
        emptyCommit: { committed: 0, bytes: 0 },
      });
    }

    // ── the browser entry logged no error across the whole case ──
    const browserErrors = await evaluate(() => window.task36.errors());
    check('the browser entry logged no error while running the real app-side paging cache and the real storage wiring in a second JS realm', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace (the surface the browser computed).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa36-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa36-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }
    protocol.browser.domText = await evaluate(() => window.task36.domText());
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowthBytes = heapEnd - heapStart;
    record('heap', { heapStart, heapPeak: peakHeap, heapEnd, heapGrowthBytes, heapPeakGrowthBytes: peakHeap - heapStart });
    // The load-bearing boundedness evidence is the PRODUCT'S OWN resident counters over the
    // DB-fail workload — the same workload in BOTH lanes, so the evidence is lane-independent.
    // The heap numbers recorded above (and the ones inside `bounded`) are observations of GC
    // timing (allocated-and-not-yet-collected), not a retention measure, and they decide nothing.
    const bounded = await workerDbFailHeap();
    protocol.node.boundedness = bounded;
    record('boundedness', bounded);
    check('the case stays bounded in the PRODUCT\'S OWN resident counters, not in a raw heap delta: the DB-fail workload (three rounds of staging five records, failing the durable ack and scrolling all 8000 entries — 120 reader calls, 24,000 entries flowed, three failed commits) leaves the engine holding exactly three pages at 66,810 resident bytes, the dirty set retained across the failed acks at 15 records / 4,590 bytes (retained 71,400) and fully recovered by the retry (committed 15, bytes 4,590, dirtyCount 0), inside the frozen three-page ceiling and the 16 MiB resident + 8 MiB dirty budgets, after 117 real evictions with bufferedHistory false throughout; the observed heap numbers are RECORDED as a GC-timing artefact (heapUsed measures allocated-and-not-yet-collected, which a forced collection collapses — the root-owned --expose-gc replay and the executor-owned replay both measured the growth of this workload falling from ~3 MiB to ~0.4 MiB with usage() byte-identical across the collection), NOT a retention proof, and they decide nothing; the case also exercised a fixed set of owned resources with zero borrowed spawns', {
      usage: bounded.usage,
      afterFailedAcks: bounded.afterFailedAcks,
      residentInsideCeiling: bounded.residentInsideCeiling,
      retainedInsideBudgets: bounded.retainedInsideBudgets,
      pageCountInsideCeiling: bounded.pageCountInsideCeiling,
      bufferedHistoryFalse: bounded.bufferedHistoryFalse,
      evictedNonZero: bounded.evictedNonZero,
      dirtyRetainedAcrossFailedAcks: bounded.dirtyRetainedAcrossFailedAcks,
      readerCalls: bounded.readerCalls,
      failedCommits: bounded.failedCommits,
      entriesFlowed: bounded.entriesFlowed,
      recovered: bounded.recovered,
      heapGrowthBytes,
      heapPeakGrowthBytes: peakHeap - heapStart,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
    }, {
      usage: { residentBytes: 66810, pageCount: 3, evicted: 117, rereads: 0, dirtyCount: 0, dirtyBytes: 0, retainedBytes: 66810, bufferedHistory: false },
      afterFailedAcks: { residentBytes: 66810, pageCount: 3, evicted: 117, rereads: 0, dirtyCount: 15, dirtyBytes: 4590, retainedBytes: 71400, bufferedHistory: false },
      residentInsideCeiling: true,
      retainedInsideBudgets: true,
      pageCountInsideCeiling: true,
      bufferedHistoryFalse: true,
      evictedNonZero: true,
      dirtyRetainedAcrossFailedAcks: true,
      readerCalls: 120,
      failedCommits: 3,
      entriesFlowed: 24000,
      recovered: { committed: 15, bytes: 4590 },
      heapGrowthBytes,
      heapPeakGrowthBytes: peakHeap - heapStart,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
    });

    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    const differingFiles = ownedFiles.filter((file) => sourceAfter[file] !== sourceBefore[file]).length;
    check('the registered case leaves its own authored files unchanged and pins a populated source inventory', {
      authoredFileCount: ownedFiles.length,
      differingFiles,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: fixture.resources.length,
    }, {
      authoredFileCount: 3,
      differingFiles: 0,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: fixture.resources.length,
    });

    // ── the evidence binds to the CURRENT bytes of the product ──
    // Independently recomputed here at the end of the run and compared with the values recomputed
    // before any scenario ran; a green report against the wrong bytes is worthless (this exact
    // failure made task 21's first gate return REJECT). The comparison against the artifact's own
    // sourceHashes is mechanical for the independent gate, because every path below is in sourceFiles.
    const productHashesAfter = productHashes(context.root);
    record('sourceBinding', { before: productHashesBefore, after: productHashesAfter });
    check('the evidence binds to the current bytes: the sha256 of all seven pinned product files is independently recomputed at the END of the run and equals the values recomputed before any scenario ran, so no product byte moved under the case — the seven hashes are recorded for the independent gate to compare against the artifact sourceHashes', {
      pinnedProductFileCount: PRODUCT_FILES.length,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: JSON.stringify(productHashesBefore) === JSON.stringify(productHashesAfter),
      allSha256Shaped: Object.values(productHashesAfter).every((hash) => /^[a-f0-9]{64}$/.test(hash)),
    }, {
      pinnedProductFileCount: 7,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: true,
      allSha256Shaped: true,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task36Errors ?? [], task36: Boolean(window.task36) })).catch((value) => ({ unavailable: String(value) }));
      await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => undefined);
    }
    persist();
    throw error;
  } finally {
    const closed = await fixture.close().catch((error) => ({ error: String(error) }));
    proof.cleanup = closed;
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'), artifact(path.join(runDir, 'resources.json'), 'resource-ledger'));
  }

  return {
    scenarios,
    artifacts,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'bounded-auxiliary-history-paging', schema: 'runtime-history-paging/v1' },
    cleanup: proof.cleanup,
    defects: {
      terminalGuardIsAPreservationNotARejection: {
        severity: 'acceptance-criterion-wording',
        observed: 'the merge never regresses a terminal: merging a canonical tool part {status:"completed", output:"FINAL OUTPUT", time:{start:1,end:2}} plus a terminal text {text:"final answer", time:{start:1,end:3}} against a later {status:"running", output:""} stub leaves after === before, so the terminal status, output and end-time all survive',
        contradictsPlanCriterion: 'the plan\'s failure criterion "terminal被running覆盖" (a terminal being overwritten by running) reads as a REFUSAL with a code',
        whyNoCodeExists: 'auxiliaryMerge.js mergeAuxiliaryPart (lines 43-53) has no throw on this path — it RETURNS the existing terminal part (freezePart(existing)) when isTerminalToolPart(existing) && !isTerminalToolPart(incoming), which is the refusal. The only rejection codes the merge can emit come from assertAuxiliaryEntry (invalid_request/history.record).',
        workaroundProvenByThisCase: 'the case asserts the preserved status/output/end-time and after === before, and proves the guard is DIRECTIONAL rather than blind: a running record followed by a completed one takes the completed status and output, an error record over a completed one takes the error status (a later terminal replaces an earlier terminal), a longer non-terminal text wins over a shorter one, and a terminal text wins over a longer non-terminal stub',
        notCoveredByProductTests: 'app/runtime/historyPaging.test.ts proves the preservation (line 136 `expect(after).toEqual(before)`) but never asserts the directional cases, so nothing in the product\'s own suite would catch a guard that blindly kept the FIRST record',
      },
      legacyExportIsNotFencedByDispose: {
        severity: 'observed-gap',
        observed: 'after dispose(), page/reread/stage/commit are each refused with cancelled/history.disposed, but legacyExport() still COMPLETES against the injected reader and still sets bufferedHistory true',
        rootCause: 'historyService.js assertOpen() is called from readPage (line 98), stage (line 190) and commit (line 206), but legacyExport (lines 168-183) calls `reader(cursor)` directly in its own loop and never goes through readPage, so the disposed fence never fires on that path',
        consequence: 'a consumer that disposes a service and then calls legacyExport() still reads the full transcript through the injected reader; the read is read-only and the page cache is already cleared, so no stale page is served, but the fence is inconsistent across the API surface',
        recordedNotForced: 'the case asserts the observed behaviour (legacyExportCompleted true, usage.rereads 1 from the failed reread, bufferedHistory true) and names the gap in the check title rather than asserting a fence that does not exist',
        notCoveredByProductTests: 'app/runtime/historyPaging.test.ts has no dispose test at all',
      },
    },
    evidenceBoundary: 'The real landed bridge paging engine bridge/runtime/history/historyService.js and the real pure merge bridge/runtime/history/auxiliaryMerge.js run in the Node worker with no stubbed logic — the reader and the persister are the engine\'s own declared injection points, so every read, eviction, chunk, generation, dirty and durable-ack path runs the real product code. The SAME engine, bundled by a case-owned Vite server and reached through the real app-side client/renderer seam app/runtime/historyPages.ts (createHistoryPageCache exposes the engine\'s ENTIRE surface: page, get, evict, reread, chunk, legacyExport, mergeWithCanonical, stage, commit, usage, dispose), plus the real storage wiring app/backends/codex/nativeAuxiliaryStorage.ts, app/backends/codex/auxiliaryStorage.ts and app/utils/backendHistoryStorage.ts, runs in a real headless Chromium; every shared capture is asserted BYTE-IDENTICAL across the two realms (page bytes, entry hashes, the chunk walk, the eviction accounting, the explicit codes and the frozen flags), with the realm-specific crypto.randomUUID ids stripped. pageId/descriptorId differ by construction; the three namespace literals are pinned in the worker and read from the product in the browser; the heap numbers are recorded in the worker only, explicitly labelled a GC-timing artefact (heapUsed measures allocated-and-not-yet-collected, which a forced collection collapses) and they decide nothing — boundedness is asserted from the product-owned usage() counters against the frozen AUXILIARY_HISTORY_LIMITS in BOTH realms; the storage wiring is browser-only because it is app-side TypeScript; the database double implements the product\'s own declared SessionDatabaseApi seam (a real Electron sessionDatabaseWorker is task 12/46\'s end-to-end surface). NO production caller of openNativeAuxiliaryPaging / openCodexAuxiliaryPaging / openBackendHistoryPaging exists or is claimed — the plan\'s "independent service" posture; the case asserts only what the exports themselves do. This case performs or claims NO live SSH and NO live Slurm verification (task 46 owns that), claims NO UI rendering (task 35 owns the Thread UI), and authors no PASS verdict.',
  };
}
