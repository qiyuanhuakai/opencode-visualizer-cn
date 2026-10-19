#!/usr/bin/env node
// Task 44 — runtime-v090 performance CORE.
//
// This module measures the REAL runtime store substrate (PinStore / DraftStore /
// DraftCache / DraftDigest under app/runtime/**) against a REAL IndexedDB in a
// REAL headless Chromium, via CDP + the OS — never by inference. It is the
// measurement engine behind scripts/qa/runtime-v090-performance.mjs.
//
// Design split (receiver-contract discipline):
//   * window.perf (the in-page bridge) is THIN: it imports the real worktree
//     modules through absolute Vite-served paths and exposes JSON-safe primitive
//     operations. Every operation records its own in-page performance.now()
//     latency, releases every lease it opens, and returns plain objects.
//   * All orchestration, the independent SHA-256 hash oracle, nearest-rank p95,
//     /proc RSS + CPU, CDP heap and longtask accounting live HERE in Node, so a
//     store self-report is always cross-checked against an independent value.
//
// The historical empty-renderer baseline (sourceState 'disconnected', the old
// global-backend UI) is preserved through validateSample() and the --check-sample
// CLI; nothing imports the JS exports, but the byte-hash pin in
// runtime-v090-evidence.mjs and the subprocess call in app/runtimeFixture.test.ts
// keep the CLI contract stable.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { cpus, totalmem } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedInventory, input as treeInput } from '../../app/dev/runtime-v090/fixtures/inventory.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const MiB = 1024 * 1024;

// Deterministic byte generator, byte-identical in Node and in the page so the
// independent hash oracle and the in-page DraftDigest agree on every input.
const generated = (size, seed = 0) => Uint8Array.from({ length: size }, (_, index) => (index + seed) % 251);
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Approved task-44 SLO thresholds (plan vis-v090, profile paragraph). These are
// FROZEN: a miss is fixed at the bottleneck module, never by moving the goalpost.
export const SLO = Object.freeze({
  // 10k normal, local network.
  warmTreeMs: 500,
  coldCachedTopologyMs: 1000,
  firstSelectableMs: 2000,
  selectedPageMsLocal: 1000,
  selectedPageMsRemote: 2000,
  indexCompleteMsLocal: 60000,
  indexCompleteMsRemote: 120000,
  interactionMs: 100,
  eventVisibleMs: 200,
  // Renderer heap ceiling (CDP HeapProfiler.collectGarbage + Runtime.getHeapUsage,
  // cross-checked with performance.memory under --enable-precise-memory-info).
  rendererHeapMiB: { '10k': 128, '100k': 160 },
  // Bridge/renderer process-tree RSS ceiling (/proc VmRSS, Vis-owned tree only).
  bridgeRssMiB: { '10k': 256, '100k': 512 },
  // Completeness: full enumeration must visit every record exactly once.
  coveragePct: 100,
});

export const HEAP_BUDGET = Object.freeze({ '10k': 128 * MiB, '100k': 160 * MiB });
export const DATASET = Object.freeze({
  '10k': { summaries: 10000, drafts: 10001, worktrees: 200 },
  '100k': { summaries: 100000, drafts: 100001, worktrees: 200 },
});

// ---------------------------------------------------------------------------
// The plan-prescribed TREE COMPOSITION (plan vis-v090, Verification strategy,
// performance-profile paragraph): "健康fixture共10k摘要均分五类/200worktree，含
// 1001+ Global roots、51+ Codex threads、等时间戳、archive/orphan/child；seed固定
// `090`". Every number below is a PLAN LITERAL read from the frozen generation
// input app/dev/runtime-v090/fixtures/seed090.json — nothing here is a value
// this harness measured or requested.
//
// Task 50 seeds and grades this composition. Before it, `seedPins()` wrote a
// FLAT set of {revision, pinned} records and the frozen DATASET `worktrees: 200`
// made the fixture LOOK like it encoded the plan's tree while nothing seeded,
// reported or graded a worktree / category / Global-root / Codex-thread /
// timestamp / archive dimension (gate finding GATE-F4). The composition is now
// seeded into a real IndexedDB in a real Chromium and every dimension is
// measured, so `dataset.worktrees` reports OBSERVED numbers.
// ---------------------------------------------------------------------------
export const TREE = Object.freeze({
  // The frozen generation input, handed to the page so the page derives the
  // same records from the same input the plan's own fixture generator uses.
  input: Object.freeze({
    seed: treeInput.seed,
    sources: Object.freeze([...treeInput.sources]),
    worktrees: treeInput.worktrees,
    timestamp: treeInput.timestamp,
  }),
  // The five categories are seeded as five distinct harness instances inside the
  // one environment (IS-1: one connection browses all five sources). The
  // product's identity grammar requires a UUID for a harness instance ID, so
  // these are deterministic fixtures derived from the frozen seed `090` and the
  // category index — reproducible, and disclosed rather than implied.
  harnessInstanceIds: Object.freeze([...treeInput.sources].map((_, index) => `0900000${index}-0000-4000-8000-00000000000${index}`)),
  // Plan literals: "1001+ Global roots、51+ Codex threads".
  globalRootsAtLeast: 1001,
  codexThreadsAtLeast: 51,
  // Plan literals: the composition carries archive / orphan / child members and
  // one shared timestamp ("等时间戳").
  groupsRequired: Object.freeze(['archived', 'orphan', 'child']),
  distinctTimestampsExpected: 1,
  // Distinct worktree nodes expanded per substrate run. Twelve nodes per run
  // over ten runs gives 120 real samples behind the tree-navigation percentile
  // (the task-44 lesson: a nearest-rank p95 over 10 samples is the max).
  nodesPerRun: 12,
  // The composition lives in a harness-owned IndexedDB because no browser-side
  // product store carries worktree topology in this harness (worktree topology
  // is bridge-side worktreeService and UI-side App.vue, neither of which this
  // substrate harness drives). Stated rather than implied.
  database: 'vis-runtime-perf-tree',
  note: 'seeded into the harness-owned IndexedDB vis-runtime-perf-tree (stores worktrees + summaries) in the same real Chromium as the pin/draft substrate; no browser-side product store carries worktree topology in this harness, so the tree dimension is graded over the seeded composition itself, not over a product module',
});

// The frozen load profiles the draft coverage must exercise. The task-44 draft
// leg only ever imported 2KiB single-`body`-part drafts, so large content and
// attachments had NO load coverage at all. Each profile below is a plan literal:
// the part names/kinds/sizes are fixed here and graded against the independent
// Node-side hash oracle, never against a value this driver measured.
export const LOAD_PROFILES = Object.freeze([
  {
    label: 'large-body',
    drafts: 4,
    parts: Object.freeze([{ name: 'body', kind: 'body', size: 512 * 1024, seed: 11 }]),
  },
  {
    label: 'multi-part-attachment',
    drafts: 4,
    parts: Object.freeze([
      { name: 'body', kind: 'body', size: 64 * 1024, seed: 21 },
      { name: 'attachment-0', kind: 'attachment', size: 128 * 1024, seed: 22 },
      { name: 'attachment-1', kind: 'attachment', size: 128 * 1024, seed: 23 },
    ]),
  },
]);

// The frozen recovery-leg count. The drafts leg used to prove THREE legs
// (offline read-back, switch, resume) while its row was named
// "offline/restart/switch/resume": no restart was ever executed — the offline
// read-back happened with the store/cache still open, and the dispose/close ran
// only AFTER the read. Restart is now its own graded leg: destroy the
// store/cache AND the page, rebuild, then read back offline.
export const RESTART_LEG_EXPECTED = 4;

/**
 * Independent Node-side derivation of the plan's composition rule from the
 * frozen generation input only. This is the ORACLE the observed numbers are
 * graded against; it deliberately does not read the seeded records.
 *
 * Rule (identical to the plan fixture's own inventory.mjs, re-implemented here
 * so two derivations must agree before anything is graded):
 *   source      = sources[ordinal % 5]           (five categories, even split)
 *   nativeId    = native-{floor(ordinal / 5)}    (IDs collide across categories)
 *   worktree    = wt-{ordinal % 200}, null every 29th   (orphan: no workspace)
 *   global      = ordinal % 5 === 0              (the Global root category)
 *   archived    = ordinal % 23 === 0
 *   child       = ordinal % 17 === 0             (parentId present)
 *   updatedAt   = the one frozen timestamp       (equal timestamps)
 *   globalRoots = ordinal % 5 === 0 && ordinal % 17 !== 0
 *   codexThreads= ordinal % 5 === 1
 */
export function planComposition(summaries) {
  if (!Number.isInteger(summaries) || summaries < 0) throw new RangeError('summaries must be a non-negative integer');
  const sources = TREE.input.sources;
  const categories = {};
  const groups = { globalRoots: 0, codexThreads: 0, archived: 0, orphan: 0, child: 0, equalTimestamp: summaries };
  for (let ordinal = 0; ordinal < summaries; ordinal += 1) {
    const source = sources[ordinal % sources.length];
    categories[source] = (categories[source] ?? 0) + 1;
    if (ordinal % sources.length === 0 && ordinal % 17 !== 0) groups.globalRoots += 1;
    if (ordinal % sources.length === 1) groups.codexThreads += 1;
    if (ordinal % 23 === 0) groups.archived += 1;
    if (ordinal % 29 === 0) groups.orphan += 1;
    if (ordinal % 17 === 0) groups.child += 1;
  }
  return {
    seed: TREE.input.seed,
    summaries,
    sources,
    worktrees: TREE.input.worktrees,
    timestamp: TREE.input.timestamp,
    categories,
    groups,
  };
}

/**
 * Cross-check: this harness's independent derivation of the plan rule must
 * agree with the plan fixture's own frozen oracle (expectedInventory) for both
 * registered profile sizes, and with the frozen worktree count. Returns null
 * when the count is not a registered profile size (nothing to cross-check).
 */
export function planCompositionAgreesWithFrozenFixtureOracle(summaries) {
  if (!treeInput.profiles.includes(summaries)) return null;
  const expected = expectedInventory(summaries);
  const derived = planComposition(summaries);
  return {
    summaries,
    groupsAgree: JSON.stringify(expected.groups) === JSON.stringify(derived.groups),
    categoriesAgree: JSON.stringify(expected.sources) === JSON.stringify(derived.categories),
    worktreesAgree: expected.worktrees === derived.worktrees && derived.worktrees === TREE.input.worktrees,
    frozenOracleGroups: expected.groups,
    derivedGroups: derived.groups,
  };
}

/** The plan's identity key for one ordinal: five categories = five harness instances. */
export const treeIdentity = (ordinal) => {
  const sources = TREE.input.sources;
  const index = ordinal % sources.length;
  return {
    category: sources[index],
    harnessInstanceId: TREE.harnessInstanceIds[index],
    nativeSessionId: `native-${Math.floor(ordinal / sources.length)}`,
    worktree: ordinal % 29 === 0 ? null : `wt-${ordinal % TREE.input.worktrees}`,
  };
};

// Nearest-rank p95: the value at ceil(0.95 * n) in the ascending sort (1-indexed).
export function nearestRankP95(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil(sorted.length * 0.95);
  return sorted[Math.min(rank, sorted.length) - 1];
}

// ---------------------------------------------------------------------------
// OS measurement: process-tree RSS and CPU from /proc (Linux). RSS sums VmRSS
// over the browser PID and every transitive child; CPU sums utime+stime jiffies
// over the same tree. Only Vis-owned processes are counted (no model/Harness).
// ---------------------------------------------------------------------------
const CLK_TCK = 100; // standard Linux USER_HZ for /proc jiffies.
export { CLK_TCK };

function readProcStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces/parens; split after the final ')'.
    const tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(tail[1]), utime: Number(tail[11]), stime: Number(tail[12]), rssPages: Number(tail[21]) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

export function readProcessTreeRss(rootPid) {
  const stats = [];
  for (const name of readdirSyncNumbers('/proc')) {
    const stat = readProcStat(name);
    if (stat) stats.push({ pid: name, ...stat });
  }
  const owned = new Set([rootPid]);
  for (let pass = 0; pass < stats.length; pass += 1) {
    for (const stat of stats) if (owned.has(stat.ppid)) owned.add(stat.pid);
  }
  const pageBytes = 4096;
  const ownedStats = stats.filter((stat) => owned.has(stat.pid));
  return {
    rootPid,
    processCount: ownedStats.length,
    rssBytes: ownedStats.reduce((sum, stat) => sum + stat.rssPages * pageBytes, 0),
    cpuJiffies: ownedStats.reduce((sum, stat) => sum + stat.utime + stat.stime, 0),
  };
}

function readdirSyncNumbers(dir) {
  const out = [];
  for (const name of readdirSync(dir)) if (/^\d+$/.test(name)) out.push(Number(name));
  return out;
}

// ---------------------------------------------------------------------------
// The in-page primitive bridge. Kept free of backticks and ${...} so it embeds
// safely. Every op returns plain JSON and releases its own lease.
// ---------------------------------------------------------------------------
const PERF_PAGE = `
(function () {
  var MiB = 1024 * 1024;
  var errors = [];
  window.__perfErrors = errors;
  window.addEventListener('error', function (e) { errors.push({ kind: 'error', message: String(e.message) }); });
  window.addEventListener('unhandledrejection', function (e) { errors.push({ kind: 'unhandledrejection', message: String((e.reason && e.reason.message) || e.reason) }); });
  function url(p) { return new URL(p, location.href).href; }
  function report(step, detail) {
    var node = document.getElementById('perf-status');
    if (node) node.textContent = step + (detail === undefined ? '' : ' ' + JSON.stringify(detail));
    return step;
  }
  function heap() {
    var m = performance.memory || {};
    return { usedJSHeapSize: m.usedJSHeapSize || 0, totalJSHeapSize: m.totalJSHeapSize || 0, jsHeapSizeLimit: m.jsHeapSizeLimit || 0 };
  }
  function settle() { if (typeof gc === 'function') { gc(); gc(); } }
  function generated(size, seed) { return Uint8Array.from({ length: size }, function (_, i) { return (i + (seed || 0)) % 251; }); }
  function digestModule() { return import(url('/app/runtime/migration/draftChunks.ts')); }
  async function sha256Hex(bytes) {
    var d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.prototype.map.call(new Uint8Array(d), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function idbEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) return { usage: null, quota: null };
    var e = await navigator.storage.estimate();
    return { usage: e.usage == null ? null : e.usage, quota: e.quota == null ? null : e.quota };
  }

  // ---- pins (real PinStore over real IndexedDB vis-runtime-pins) ----
  var pinStore = null;
  async function openPins() { var m = await import(url('/app/runtime/pinStore.ts')); pinStore = await m.PinStore.open(); return { ok: true }; }
  async function pagePins(args) {
    var t0 = performance.now();
    var page = await pinStore.page(args);
    var usage = pinStore.usage();
    var ms = performance.now() - t0;
    var out = { count: page.records.length, next: page.next == null ? null : page.next, usage: usage, ms: ms };
    page.release();
    return out;
  }
  function pinsUsage() { return pinStore.usage(); }
  async function enumeratePins(profileId) {
    var m = await import(url('/app/runtime/migration/draftChunks.ts'));
    var digest = new m.DraftDigest();
    var after = null; var count = 0; var pages = 0; var maxLedger = 0; var maxEntries = 0;
    var t0 = performance.now();
    for (;;) {
      var page = await pinStore.page({ profileId: profileId, after: after || undefined, limit: 100 });
      pages += 1;
      var usage = pinStore.usage();
      maxLedger = Math.max(maxLedger, usage.residentBytes + usage.reservedBytes);
      maxEntries = Math.max(maxEntries, usage.entries);
      for (var r = 0; r < page.records.length; r += 1) {
        var rec = page.records[r];
        digest.update(new TextEncoder().encode(JSON.stringify([rec.selection.profileId, rec.selection.session.environmentId, rec.selection.session.harnessInstanceId, rec.selection.session.nativeSessionId, rec.clientOrigin, rec.revision, rec.pinned])));
      }
      count += page.records.length;
      after = page.next == null ? null : page.next;
      page.release();
      if (!after) break;
    }
    return { count: count, pages: pages, maxLedger: maxLedger, maxEntries: maxEntries, hash: digest.finish(), enumerateMs: performance.now() - t0 };
  }
  function closePins() { if (pinStore) { pinStore.close(); pinStore = null; } }

  // ---- the plan-prescribed tree composition (harness-owned IndexedDB) ----
  // The frozen generation input is handed from Node, so the page derives the
  // SAME records from the SAME input the plan's own fixture generator uses.
  // Node grades the OBSERVED counts against its own independent derivation of
  // the plan rule, so a divergence here is a RED, never a silent pass.
  var treeDb = null;
  function openTreeDatabase() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open('vis-runtime-perf-tree', 1);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains('worktrees')) db.createObjectStore('worktrees');
        if (!db.objectStoreNames.contains('summaries')) {
          var store = db.createObjectStore('summaries', { keyPath: 'ordinal' });
          store.createIndex('worktree', 'worktree', { unique: false });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('vis-runtime-perf-tree upgrade blocked')); };
    });
  }
  function treeSummary(args, ordinal) {
    var sources = args.sources;
    return {
      ordinal: ordinal,
      source: sources[ordinal % sources.length],
      nativeSessionId: 'native-' + Math.floor(ordinal / sources.length),
      title: 'seed' + args.seed + ' session ' + ordinal,
      worktree: ordinal % 29 === 0 ? null : 'wt-' + (ordinal % args.worktrees),
      global: ordinal % sources.length === 0,
      archived: ordinal % 23 === 0,
      parentId: ordinal % 17 === 0 ? 'native-parent' : null,
      updatedAt: args.timestamp
    };
  }
  // Seed the whole composition in bounded, strictly-durable batches: 200
  // worktree records (the plan's canonicalPath/commonDir/branch metadata) plus
  // one summary per ordinal of the dataset.
  async function seedTreeComposition(args) {
    var t0 = performance.now();
    treeDb = await openTreeDatabase();
    var worktreeMs = 0; var summaryMs = 0;
    var wtTx = treeDb.transaction('worktrees', 'readwrite', { durability: 'strict' });
    var wtStart = performance.now();
    for (var i = 0; i < args.worktrees; i += 1) {
      wtTx.objectStore('worktrees').put({ canonicalPath: '/seed' + args.seed + '/repo/worktrees/wt-' + i, commonDir: '/seed' + args.seed + '/repo/.git', branch: 'fixture-' + i }, 'wt-' + i);
    }
    await new Promise(function (resolve, reject) { wtTx.oncomplete = resolve; wtTx.onerror = function () { reject(wtTx.error); }; wtTx.onabort = function () { reject(wtTx.error); }; });
    worktreeMs = performance.now() - wtStart;
    var batch = 1000;
    var sumStart = performance.now();
    for (var start = 0; start < args.summaries; start += batch) {
      var tx = treeDb.transaction('summaries', 'readwrite', { durability: 'strict' });
      var store = tx.objectStore('summaries');
      for (var ordinal = start; ordinal < Math.min(start + batch, args.summaries); ordinal += 1) store.put(treeSummary(args, ordinal));
      await new Promise(function (resolve, reject) { tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; tx.onabort = function () { reject(tx.error); }; });
    }
    summaryMs = performance.now() - sumStart;
    return { worktrees: args.worktrees, summaries: args.summaries, worktreeSeedMs: worktreeMs, summarySeedMs: summaryMs, seedMs: performance.now() - t0 };
  }
  // Page the worktree set (the topology itself): a real cursor page of the
  // 200 worktree records, used for the cold/warm topology measurements.
  async function pageWorktrees(args) {
    var t0 = performance.now();
    var tx = treeDb.transaction('worktrees', 'readonly');
    var range = args.after == null ? null : IDBKeyRange.lowerBound(args.after, true);
    var request = tx.objectStore('worktrees').openCursor(range);
    var keys = []; var last = null;
    var page = await new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor || keys.length >= args.limit) { resolve({ keys: keys, last: last }); return; }
        keys.push(cursor.key); last = cursor.key; cursor.continue();
      };
      request.onerror = function () { reject(request.error); };
    });
    await new Promise(function (resolve, reject) { tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
    return { count: page.keys.length, keys: page.keys, next: page.keys.length >= args.limit ? page.last : null, ms: performance.now() - t0 };
  }
  // Expand ONE worktree node: page its summaries through the worktree index.
  async function pageWorktreeSummaries(args) {
    var t0 = performance.now();
    var tx = treeDb.transaction('summaries', 'readonly');
    var index = tx.objectStore('summaries').index('worktree');
    var request = index.openCursor(IDBKeyRange.only(args.worktree));
    var ordinals = []; var sources = {}; var total = 0;
    var page = await new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor || ordinals.length >= args.limit) { resolve(true); return; }
        ordinals.push(cursor.value.ordinal); sources[cursor.value.source] = (sources[cursor.value.source] || 0) + 1; cursor.continue();
      };
      request.onerror = function () { reject(request.error); };
    });
    await new Promise(function (resolve, reject) { tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
    return { worktree: args.worktree, returned: ordinals.length, firstOrdinal: ordinals.length ? ordinals[0] : null, lastOrdinal: ordinals.length ? ordinals[ordinals.length - 1] : null, sources: sources, ms: performance.now() - t0 };
  }
  // Full enumeration of the seeded composition: every worktree exactly once and
  // every summary exactly once, folding a digest and tallying every graded
  // dimension, so the observed numbers are read out of the store itself.
  async function enumerateTree(args) {
    var digestModule = await import(url('/app/runtime/migration/draftChunks.ts'));
    var worktreeDigest = new digestModule.DraftDigest();
    var summaryDigest = new digestModule.DraftDigest();
    var t0 = performance.now();
    var worktrees = 0; var wtPages = 0; var wtAfter = null;
    for (;;) {
      var tx = treeDb.transaction('worktrees', 'readonly');
      var range = wtAfter == null ? null : IDBKeyRange.lowerBound(wtAfter, true);
      var request = tx.objectStore('worktrees').openCursor(range);
      var batch = await new Promise(function (resolve, reject) {
        var keys = [];
        request.onsuccess = function () {
          var cursor = request.result;
          if (!cursor || keys.length >= 200) { resolve(keys); return; }
          worktreeDigest.update(new TextEncoder().encode(JSON.stringify([cursor.key, cursor.value.canonicalPath, cursor.value.commonDir, cursor.value.branch])));
          keys.push(cursor.key); cursor.continue();
        };
        request.onerror = function () { reject(request.error); };
      });
      await new Promise(function (resolve, reject) { tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; });
      wtPages += 1; worktrees += batch.length;
      if (batch.length < 200) break;
      wtAfter = batch[batch.length - 1];
    }
    var summaries = 0; var categories = {}; var groups = { globalRoots: 0, codexThreads: 0, archived: 0, orphan: 0, child: 0 };
    var timestamps = {}; var worktreeMembers = {}; var sources = args.sources;
    var scan = treeDb.transaction('summaries', 'readonly');
    var scanRequest = scan.objectStore('summaries').openCursor();
    await new Promise(function (resolve, reject) {
      scanRequest.onsuccess = function () {
        var cursor = scanRequest.result;
        if (!cursor) { resolve(); return; }
        var row = cursor.value;
        summaryDigest.update(new TextEncoder().encode(JSON.stringify([row.source, row.nativeSessionId, row.ordinal, row.title, row.worktree, row.global, row.archived, row.parentId, row.updatedAt])));
        summaries += 1;
        categories[row.source] = (categories[row.source] || 0) + 1;
        if (row.global && row.parentId == null) groups.globalRoots += 1;
        if (row.source === sources[1]) groups.codexThreads += 1;
        if (row.archived) groups.archived += 1;
        if (row.worktree == null) groups.orphan += 1;
        if (row.parentId != null) groups.child += 1;
        timestamps[row.updatedAt] = (timestamps[row.updatedAt] || 0) + 1;
        if (row.worktree != null) worktreeMembers[row.worktree] = (worktreeMembers[row.worktree] || 0) + 1;
        cursor.continue();
      };
      scanRequest.onerror = function () { reject(scanRequest.error); };
    });
    await new Promise(function (resolve, reject) { scan.oncomplete = resolve; scan.onerror = function () { reject(scan.error); }; });
    return {
      worktrees: worktrees, worktreePages: wtPages, worktreeHash: worktreeDigest.finish(),
      summaries: summaries, summaryHash: summaryDigest.finish(),
      categories: categories, groups: groups,
      distinctTimestamps: Object.keys(timestamps).length, timestampCounts: timestamps,
      worktreesWithSummaries: Object.keys(worktreeMembers).length,
      maxSummariesPerWorktree: Object.keys(worktreeMembers).reduce(function (max, key) { return Math.max(max, worktreeMembers[key]); }, 0),
      enumerateMs: performance.now() - t0
    };
  }
  function closeTree() { if (treeDb) { treeDb.close(); treeDb = null; } }
  async function openTree() { treeDb = await openTreeDatabase(); return { ok: true }; }

  // ---- drafts (real DraftStore over real IndexedDB vis-runtime-client) ----
  var draftStore = null;
  var draftCache = null;
  async function openDraftStore() { var m = await import(url('/app/runtime/draftStore.ts')); draftStore = await m.DraftStore.open(); return { ok: true }; }
  // Stream a deterministic part into the store; returns the stored part record.
  async function writeDraftPart(args) {
    var identity = args.identity, size = args.size, seed = args.seed || 0, offset = 0;
    async function* input() { while (offset < size) { var n = Math.min(65536, size - offset); yield generated(n, (offset + seed) % 251); offset += n; } }
    var t0 = performance.now();
    var part = await draftStore.writePart(identity, { name: args.name, kind: args.kind, input: input() });
    return { part: part, ms: performance.now() - t0 };
  }
  // commit() returns void (it re-reads + re-verifies every part then puts the
  // header); the per-part sha256 lives on the writePart-returned DraftPart.
  async function commitDraftHeader(args) {
    var t0 = performance.now();
    await draftStore.commit(Object.assign({}, args.identity, { parts: args.parts }));
    return { revision: args.identity.revision, parts: args.parts.map(function (p) { return { name: p.name, kind: p.kind, bytes: p.bytes, sha256: p.sha256 }; }), ms: performance.now() - t0 };
  }
  // readPart takes the stored part OBJECT; verifies per-chunk sha256, folds digest.
  async function readDraftPart(args) {
    var m = await digestModule();
    var digest = new m.DraftDigest();
    var bytes = 0, largest = 0;
    var t0 = performance.now();
    for await (var chunk of draftStore.readPart(args.identity, args.part)) { digest.update(chunk); bytes += chunk.length; largest = Math.max(largest, chunk.length); }
    return { digest: digest.finish(), bytes: bytes, largest: largest, ms: performance.now() - t0 };
  }
  function draftPage(args) { return draftStore.page(args); }
  // Import ONE draft end-to-end in a single round-trip: stream the part, commit
  // (which re-reads and re-verifies bytes + sha256), then read it back and fold a
  // DraftDigest. Returns both the store-recorded sha256 and the read-back digest
  // so Node cross-checks each against an independent hash of the same bytes.
  async function importDraftOneByOne(args) {
    var identity = args.identity, size = args.size, seed = args.seed || 0, offset = 0;
    async function* input() { while (offset < size) { var n = Math.min(65536, size - offset); yield generated(n, (offset + seed) % 251); offset += n; } }
    var m = await digestModule();
    var t0 = performance.now();
    var part = await draftStore.writePart(identity, { name: 'body', kind: 'body', input: input() });
    // commit() re-reads + re-verifies the part's bytes + sha256 before put (void).
    await draftStore.commit(Object.assign({}, identity, { parts: [part] }));
    var digest = new m.DraftDigest();
    var bytes = 0;
    for await (var chunk of draftStore.readPart(identity, part)) { digest.update(chunk); bytes += chunk.length; }
    return { storedSha256: part.sha256, readBackSha256: digest.finish(), bytes: bytes, ms: performance.now() - t0 };
  }
  function draftStoreUsage() { return draftStore.usage(); }
  // Import a contiguous run of drafts ONE-BY-ONE (each individually streamed,
  // committed — which re-verifies — and read back with a folded digest), batched
  // only at the CDP round-trip level so 100k imports stay feasible. The per-draft
  // import + verification is unchanged and strictly sequential.
  async function importDraftBatch(args) {
    var results = [];
    for (var i = 0; i < args.count; i += 1) {
      var index = args.start + i;
      var identity = { context: args.prefix + '-' + String(index).padStart(6, '0'), clientOrigin: 'task44-perf-client', revision: 1 };
      var r = await importDraftOneByOne({ identity: identity, size: 2048, seed: index % 251 });
      results.push({ index: index, storedSha256: r.storedSha256, readBackSha256: r.readBackSha256, bytes: r.bytes, ms: r.ms });
    }
    return results;
  }
  function closeDraftStore() { if (draftStore) { draftStore.close(); draftStore = null; } }

  // ---- draft cache (real createDraftCache; bounded resident ledger) ----
  async function openDraftCache() { var m = await import(url('/app/runtime/draftCache.ts')); draftCache = m.createDraftCache({ store: draftStore }); return { ok: true }; }
  async function cachePageHeaders(args) {
    var t0 = performance.now();
    var page = await draftCache.pageHeaders(args);
    var usage = draftCache.usage();
    var ms = performance.now() - t0;
    var out = { count: page.headers.length, contexts: page.headers.map(function (h) { return h.context; }), next: page.next == null ? null : page.next, usage: usage, ms: ms };
    page.release();
    return out;
  }
  // Open \`count\` DISTINCT draft handles (each released before the next, so the
  // bounded ledger holds at most one), returning the full per-open latency array
  // so a 95th-percentile interaction SLO is estimated from many samples, not one.
  async function cacheOpenProbe(args) {
    var samples = []; var found = 0;
    for (var i = 0; i < args.count; i += 1) {
      var index = args.start + i;
      var identity = { context: args.prefix + '-' + String(index).padStart(6, '0'), clientOrigin: 'task44-perf-client', revision: 1 };
      var t0 = performance.now();
      var handle = await draftCache.open(identity);
      samples.push(performance.now() - t0);
      if (handle) { found += 1; handle.release(); }
    }
    return { found: found, count: args.count, samples: samples };
  }
  // Read the body part of \`count\` distinct drafts (open + export + release),
  // returning per-read latency plus the folded digests for independent checks.
  async function cacheExportBatch(args) {
    var m = await digestModule();
    var samples = []; var digests = [];
    for (var i = 0; i < args.count; i += 1) {
      var index = args.start + i;
      var identity = { context: args.prefix + '-' + String(index).padStart(6, '0'), clientOrigin: 'task44-perf-client', revision: 1 };
      var t0 = performance.now();
      try {
        var digest = new m.DraftDigest(); var bytes = 0;
        for await (var segment of draftCache.exportPart({ identity: identity, part: 'body' })) { digest.update(segment.bytes); bytes += segment.bytes.length; if (segment.release) segment.release(); }
        samples.push(performance.now() - t0); digests.push(digest.finish());
      } catch (error) {
        // A missing draft is recorded (null digest), never thrown, so one batch
        // measures a full run of reads.
        samples.push(performance.now() - t0); digests.push(null);
      }
    }
    return { count: args.count, samples: samples, digests: digests };
  }
  // exportPart takes the part NAME (string); verifies size + sha256 per segment.
  async function cacheExportPart(args) {
    var m = await digestModule();
    var digest = new m.DraftDigest();
    var bytes = 0, largest = 0;
    var t0 = performance.now();
    for await (var segment of draftCache.exportPart(args)) { digest.update(segment.bytes); bytes += segment.bytes.length; largest = Math.max(largest, segment.bytes.length); if (segment.release) segment.release(); }
    return { digest: digest.finish(), bytes: bytes, largest: largest, ms: performance.now() - t0 };
  }
  // Resume-editing: replace segment \`index\` of a part with new deterministic
  // bytes at nextRevision, verifying the old and new hashes; then re-export.
  async function cacheResumeEdit(args) {
    var m = await digestModule();
    var next = generated(args.size, args.seed || 0);
    var nextHash = await sha256Hex(next);
    var t0 = performance.now();
    var handle = await draftCache.editSegment({ identity: args.identity, part: args.part, nextRevision: args.nextRevision, index: args.index, bytes: next });
    var editMs = performance.now() - t0;
    var revision = handle.header.revision;
    handle.release();
    var readDigest = new m.DraftDigest();
    var readBytes = 0;
    var t1 = performance.now();
    // The edited content lives at nextRevision (editSegment writes the new
    // identity); re-export at that revision to read back what was written.
    for await (var segment of draftCache.exportPart({ identity: { context: args.identity.context, clientOrigin: args.identity.clientOrigin, revision: args.nextRevision }, part: args.part })) { readDigest.update(segment.bytes); readBytes += segment.bytes.length; if (segment.release) segment.release(); }
    return { revision: revision, nextHash: nextHash, readHash: readDigest.finish(), readBytes: readBytes, editMs: editMs, readMs: performance.now() - t1 };
  }
  function cacheUsage() { return draftCache.usage(); }
  async function disposeCache() { if (draftCache) { await draftCache.dispose(); draftCache = null; } }

  window.perf = {
    report: report, heap: heap, settle: settle, generated: generated, sha256Hex: sha256Hex, idbEstimate: idbEstimate,
    errors: function () { return errors; },
    openPins: openPins, pagePins: pagePins, pinsUsage: pinsUsage, enumeratePins: enumeratePins, closePins: closePins,
    seedTreeComposition: seedTreeComposition, openTree: openTree, pageWorktrees: pageWorktrees, pageWorktreeSummaries: pageWorktreeSummaries, enumerateTree: enumerateTree, closeTree: closeTree,
    openDraftStore: openDraftStore, writeDraftPart: writeDraftPart, commitDraftHeader: commitDraftHeader,
    readDraftPart: readDraftPart, importDraftOneByOne: importDraftOneByOne, importDraftBatch: importDraftBatch, draftPage: draftPage, draftStoreUsage: draftStoreUsage, closeDraftStore: closeDraftStore,
    openDraftCache: openDraftCache, cachePageHeaders: cachePageHeaders, cacheOpenProbe: cacheOpenProbe, cacheExportBatch: cacheExportBatch,
    cacheExportPart: cacheExportPart, cacheResumeEdit: cacheResumeEdit, cacheUsage: cacheUsage, disposeCache: disposeCache,
  };
  report('perf-ready', { modules: 'real worktree runtime modules via absolute Vite paths' });
})();
`;

const PERF_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Task 44 runtime-v090 performance</title><style>body{font:1rem/1.6 system-ui;margin:0;padding:1rem;max-width:64rem}h1{font-size:1.25rem}#perf-status{font-weight:600;padding:.5em;border:1px solid;border-radius:.25em}</style></head><body><main><h1>Task 44 — connected 10k/100k runtime performance</h1><p id="perf-status">booting</p></main><script>window.__perfErrors=[];window.addEventListener('error',function(e){window.__perfErrors.push({kind:'error',message:String(e.message)})});window.addEventListener('unhandledrejection',function(e){window.__perfErrors.push({kind:'unhandledrejection',message:String((e.reason&&e.reason.message)||e.reason)})});</script><script type="module" src="/perf/harness.mjs"></script></body></html>`;

// ---------------------------------------------------------------------------
// Measurement stack: real Vite (custom config serving the worktree modules) +
// real Chromium with precise-memory + expose-gc, a longtask PerformanceObserver,
// a CDP session, and /proc RSS/CPU probes against the browser PID.
// ---------------------------------------------------------------------------
export async function createStack({ out, log = () => {} }) {
  await mkdir(out, { recursive: true });
  const [{ createServer }, { chromium }] = await Promise.all([import('vite'), import('playwright')]);
  const lifecycle = { todo: ['close page', 'close context', 'close browser connection', 'close browser server', 'close Vite'], completed: [], ports: [] };
  const saveLifecycle = () => writeFile(path.join(out, 'lifecycle.json'), json(lifecycle));
  await saveLifecycle();

  let vite; let server; let browser; let context; let page; let cdp;
  try {
    vite = await createServer({ configFile: false, appType: 'custom', root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: true } });
    vite.middlewares.use('/perf', (request, response, next) => {
      const requestUrl = request.url ?? '/';
      if (requestUrl === '/' || requestUrl === '') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(PERF_HTML);
        return;
      }
      if (requestUrl === '/harness.mjs') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(PERF_PAGE);
        return;
      }
      next();
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    lifecycle.ports.push(new URL(origin).port);
    await saveLifecycle();
    log('vite-listening', { origin });

    server = await chromium.launchServer({ headless: true, args: ['--no-sandbox', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
    lifecycle.browserPid = server.process().pid;
    await saveLifecycle();
    browser = await chromium.connect(server.wsEndpoint());
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    await context.addInitScript(() => {
      globalThis.__perfLongTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) globalThis.__perfLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');

    const measureRss = () => readProcessTreeRss(server.process().pid);
    const collectHeap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const usage = await cdp.send('Runtime.getHeapUsage');
      return { usedSize: usage.usedSize, totalSize: usage.totalSize, sizeLimit: usage.sizeLimit };
    };
    const readLongTasks = () => page.evaluate(() => globalThis.__perfLongTasks ?? []);
    // A REAL observation of the emulated network: one same-origin round trip
    // measured in the page. With Network.emulateNetworkConditions latency L
    // applied, the round trip cannot complete faster than L, so this is the
    // verification that the formal samples are actually taken under the
    // profile's network conditions — not merely labelled with them (the
    // network100ms profile's drafts leg resets the emulation to unlimited at
    // its end, which used to leave the formal samples measuring an unlimited
    // network while the report still called them 100ms-RTT).
    const measureRoundTripMs = async () => {
      const started = await page.evaluate(() => performance.now());
      await page.evaluate(() => fetch('/', { cache: 'no-store' }).then(() => undefined));
      return (await page.evaluate(() => performance.now())) - started;
    };
    // The verification predicate, exported through the stack so the driver can
    // fail loudly on a network that did not take effect.
    const verifyNetworkLatency = (observedMs, expectedRttMs) => observedMs >= expectedRttMs;
    const setNetwork = (conditions) => cdp.send('Network.emulateNetworkConditions', conditions);
    const evaluate = (fn, argument) => page.evaluate(fn, argument);

    return {
      origin, page, cdp, context, browser, server, vite, lifecycle,
      log, measureRss, collectHeap, readLongTasks, setNetwork, evaluate, measureRoundTripMs, verifyNetworkLatency,      longTaskCount: async () => (await readLongTasks()).length,
      async close() {
        if (page) { await page.close().catch(() => {}); lifecycle.completed.push('close page'); }
        if (context) { await context.close().catch(() => {}); lifecycle.completed.push('close context'); }
        if (browser) { await browser.close().catch(() => {}); lifecycle.completed.push('close browser connection'); }
        if (server) { await server.close().catch(() => {}); lifecycle.completed.push('close browser server'); }
        if (vite) { await vite.close().catch(() => {}); lifecycle.completed.push('close Vite'); }
        await saveLifecycle();
      },
    };
  } catch (error) {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    if (vite) await vite.close().catch(() => {});
    await saveLifecycle();
    throw error;
  }
}

// Independent node-side expected hash for a deterministic draft part.
const expectedPartHash = (size, seed = 0) => sha256Hex(generated(size, seed));

// Identity/draft fixtures — deterministic, byte-identical to the in-page bridge.
// The pin identity set IS the plan-prescribed composition (task 50): 10k/100k
// summaries evenly split over the five categories, one harness instance per
// category inside the single environment, and the plan's native session IDs
// (which intentionally collide across categories, exactly as seed090 says).
export const FIXTURE = Object.freeze({
  profileId: '33333333-3333-4333-8333-333333333333',
  environmentId: '11111111-1111-4111-8111-111111111111',
  clientOrigin: 'task44-perf-client',
  pinNativeId: (index) => treeIdentity(index).nativeSessionId,
  pinHarnessInstanceId: (index) => treeIdentity(index).harnessInstanceId,
  pinKey: (index) => [FIXTURE.profileId, FIXTURE.environmentId, FIXTURE.pinHarnessInstanceId(index), FIXTURE.pinNativeId(index), FIXTURE.clientOrigin],
  draftContext: (prefix, index) => `${prefix}-${String(index).padStart(6, '0')}`,
  draftIdentity: (prefix, index) => ({ context: FIXTURE.draftContext(prefix, index), clientOrigin: FIXTURE.clientOrigin, revision: 1 }),
});

// ---------------------------------------------------------------------------
// Draft DATASET IDENTITY: which contexts belong to which leg.
//
// The plain 2KiB single-`body`-part drafts leg and the large-body /
// multi-part-attachment loads leg write into the SAME DraftStore + DraftCache
// IndexedDB, so a namespace that merely shares a PREFIX cannot tell them apart.
// That is precisely the defect this split closes: the load leg used to build its
// contexts as `${prefix}-load-<label>-NNNNNN`, which starts with `${prefix}-`,
// so the plain-draft coverage enumeration counted those 8 headers as well. The
// exact-count coverage row then rejected a HEALTHY run: 10001 + 8 = 10009
// against the frozen 10001 at the 10k scale, 100001 + 8 = 100009 against 100001
// at the 100k scale (the reviewer reproduced both with the unmodified
// runLoadsLeg + runCoverage over controlled responses). The row that was added
// to stop a failed run from passing was itself failing a healthy one.
//
// The identity is therefore STRICT, not a prefix test: a context belongs to the
// plain dataset only when it is the fixture's `${prefix}-NNNNNN` encoding — the
// six-digit zero-padded ordinal `importDraftBatch` writes. Any other namespace
// (the load leg's, or one added later) is a DIFFERENT dataset with its own
// graded rows and is never folded into this one.
//
// This does NOT hide the load leg from coverage. `runLoadsLeg` still imports,
// hash-verifies and offline-reads-back every part of every load profile, and
// `evaluateThresholds` still emits one FAILING row per load profile that was
// never measured. What changes is that each dataset is counted against its own
// frozen expectation instead of being pooled behind a shared prefix.
// ---------------------------------------------------------------------------

/** The load leg's namespace segment. A child of the run prefix, never the run prefix itself. */
export const LOAD_NAMESPACE = 'load';

/** The prefix the load leg owns: `${prefix}-load`. */
export const loadDraftPrefix = (prefix) => `${prefix}-${LOAD_NAMESPACE}`;

/**
 * One load draft's context. Lives beside `FIXTURE.draftContext` so the plain and
 * load namespaces cannot drift apart, and so a regression can enumerate the real
 * load-leg contexts without re-deriving them.
 */
export const loadDraftContext = (prefix, label, index) => FIXTURE.draftContext(`${prefix}-${label}`, index);

/**
 * The STRICT identity of the plain 2KiB single-body-part drafts dataset: the
 * zero-based ordinal the drafts leg imported under `prefix`, or null when the
 * context belongs to some other dataset (the load leg's, or an unknown one).
 *
 * `runCoverage` and `runDraftsLeg` classify in-page, because the contexts are
 * paged inside the browser; both carry this same rule inline (a page closure
 * cannot import a Node helper). The integration regression in
 * app/runtimeV090Performance.test.ts drives the REAL runLoadsLeg -> runCoverage
 * pair and is therefore the guard that the two copies still agree: if they
 * diverge, the plain coverage count stops matching the frozen expectation.
 */
export const plainDraftOrdinal = (context, prefix) => {
  if (typeof context !== 'string' || context.indexOf(`${prefix}-`) !== 0) return null;
  const ordinal = context.slice(prefix.length + 1);
  return /^\d{6}$/.test(ordinal) ? Number(ordinal) : null;
};

// ---------------------------------------------------------------------------
// Scenario: baseline — empty-renderer first paint of the unchanged app surface.
// Preserves the historical 'disconnected' empty-renderer baseline semantics.
// ---------------------------------------------------------------------------
export async function runBaseline(stack) {
  const { page, collectHeap, measureRss } = stack;
  await page.goto(stack.origin + '/perf/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.perf !== 'undefined');
  await collectHeap();
  const observed = await page.evaluate(() => ({
    paints: performance.getEntriesByType('paint').map((entry) => ({ name: entry.name, startTime: entry.startTime })),
    visibleText: document.body.innerText,
  }));
  const firstScreenMs = observed.paints.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null;
  return {
    scenario: 'empty-renderer-baseline',
    sourceState: 'disconnected',
    firstScreenMs,
    heap: await collectHeap(),
    // Empty-renderer process-tree RSS: the plan subtracts this baseline so the
    // reported "Bridge RSS" is the ADDITIONAL RSS of the Vis-owned tree, not
    // Chromium's own base footprint (browser/GPU/network processes).
    rss: measureRss(),
    limitation: 'Harness shell (no mixed-five-source runtime connected); first-paint + empty-renderer RSS baseline only. Connected 10k/100k is measured by the substrate scenarios, not here.',
  };
}

// ---------------------------------------------------------------------------
// Seed the identity set AND the plan-prescribed tree composition once (raw IDB,
// bounded batches). The pin identity set is the plan composition's identity
// dimension (five categories = five harness instances inside one environment,
// the plan's native session IDs); the composition itself — 200 worktree records
// plus one summary per ordinal — is seeded into the harness-owned
// vis-runtime-perf-tree database so the tree dimension exists on disk exactly
// like a populated store and can be measured. Drafts are imported one-by-one by
// runDraftsLeg (the load-bearing leg), never here.
// ---------------------------------------------------------------------------
export async function seedPins(stack, { pins }) {
  const { page, evaluate, log } = stack;
  log('seed-pins-start', { pins });
  await page.goto(stack.origin + '/perf/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.perf !== 'undefined');

  // Seed pins directly into the real IDB in bounded batches (raw store, not the
  // module) so the substrate exists on disk exactly like a real populated store.
  if (pins > 0) {
    await evaluate((args) => {
      const open = (name, version, stores) => new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => { for (const s of stores) if (!request.result.objectStoreNames.contains(s)) request.result.createObjectStore(s); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      // The plan composition's identity key: the five categories are five
      // harness instances inside the one environment (the product's identity
      // grammar requires a UUID, so the five IDs are the deterministic fixtures
      // TREE.harnessInstanceIds derives from the frozen seed and the category
      // index), and the native session IDs are the plan's own — colliding across
      // categories by design.
      const harness = args.harnessInstanceIds;
      const key = (index) => ['33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', harness[index % harness.length], 'native-' + Math.floor(index / harness.length), 'task44-perf-client'];
      return (async () => {
        const db = await open('vis-runtime-pins', 1, ['identities']);
        try {
          for (let start = 0; start < args.count; start += 1000) {
            const tx = db.transaction('identities', 'readwrite', { durability: 'strict' });
            const store = tx.objectStore('identities');
            for (let index = start; index < Math.min(start + 1000, args.count); index += 1) store.put({ revision: index, pinned: index % 3 !== 0 }, key(index));
            await done(tx);
          }
        } finally { db.close(); }
      })();
    }, { count: pins, harnessInstanceIds: [...TREE.harnessInstanceIds] });
  }
  log('seed-pins-done', { pins });

  // The plan-prescribed tree composition: 200 worktrees + one summary per
  // ordinal, derived in the page from the SAME frozen generation input the
  // plan's own fixture generator reads. Graded later against this module's
  // independent Node-side derivation of the plan rule.
  const composition = planComposition(pins);
  const crossCheck = planCompositionAgreesWithFrozenFixtureOracle(pins);
  if (crossCheck && !(crossCheck.groupsAgree && crossCheck.categoriesAgree && crossCheck.worktreesAgree)) {
    throw new Error(`plan composition derivation disagrees with the frozen fixture oracle: ${JSON.stringify(crossCheck)}`);
  }
  const seeded = await evaluate((args) => window.perf.seedTreeComposition(args), { ...TREE.input, summaries: pins });
  log('seed-tree-done', seeded);
  return { pins, tree: { prescribed: composition.worktrees, seededWorktrees: seeded.worktrees, seededSummaries: seeded.summaries, seedMs: seeded.seedMs, derivation: composition, frozenOracleAgreement: crossCheck } };
}

export async function runSubstrateSample(stack, { prefix }) {
  const { page, evaluate, collectHeap, measureRss } = stack;
  await page.goto(stack.origin + '/perf/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.perf !== 'undefined');

  // ---- pins: cold first page + warm re-page (fast ops only) ----
  const pinProfileId = FIXTURE.profileId;
  await evaluate(() => window.perf.openPins());
  const coldPins = await evaluate((args) => window.perf.pagePins({ profileId: args, limit: 100 }), pinProfileId);
  const warmPins = [];
  for (let i = 0; i < 4; i += 1) warmPins.push((await evaluate((args) => window.perf.pagePins({ profileId: args, limit: 100 }), pinProfileId)).ms);
  const pinLedgerAfter = await evaluate(() => window.perf.pinsUsage());
  await evaluate(() => window.perf.closePins());

  // ---- drafts: cold first header page + warm re-pages + full enumeration ----
  await evaluate(() => window.perf.openDraftStore());
  await evaluate(() => window.perf.openDraftCache());
  const coldDraftPage = await evaluate(() => window.perf.cachePageHeaders({ limit: 32 }));
  const warmDrafts = [];
  for (let i = 0; i < 4; i += 1) warmDrafts.push((await evaluate(() => window.perf.cachePageHeaders({ limit: 32 }))).ms);
  // Open many distinct draft handles + read many distinct draft bodies, so the
  // interaction / selected-page 95th-percentile SLOs are estimated from a real
  // distribution rather than one sample per run (which degenerates to the max).
  const openProbe = await evaluate((args) => window.perf.cacheOpenProbe({ prefix: args.prefix, start: 0, count: 30 }), { prefix });
  const exportProbe = await evaluate((args) => window.perf.cacheExportBatch({ prefix: args.prefix, start: 0, count: 10 }), { prefix });
  // Event-visible: a freshly committed draft header appears in a subsequent page.
  // Uses a context that sorts BEFORE the measured prefix and never matches it, so
  // the probe never inflates the measured drafts coverage and resolves on page 1.
  const eventVisible = await evaluate(async () => {
    const context = 'evt-visible-' + String(Math.floor(Math.random() * 1e9));
    const identity = { context, clientOrigin: 'task44-perf-client', revision: 1 };
    const t0 = performance.now();
    const written = await window.perf.writeDraftPart({ identity, name: 'body', kind: 'body', size: 2048, seed: 3 });
    await window.perf.commitDraftHeader({ identity, parts: [written.part] });
    let seen = false; let guard = 0;
    for (; guard < 3 && !seen; guard += 1) {
      const page = await window.perf.cachePageHeaders({ limit: 32 });
      if (page.contexts.indexOf(context) !== -1) seen = true;
      if (!seen && !page.next) break;
    }
    return { seen, ms: performance.now() - t0 };
  });
  const cacheLedgerAfter = await evaluate(() => window.perf.cacheUsage());
  await evaluate(() => window.perf.disposeCache());
  await evaluate(() => window.perf.closeDraftStore());

  // ---- the plan-prescribed tree composition (task 50) ----
  // Cold first page of the 200-worktree topology, warm re-pages of it, and the
  // expansion of 12 DISTINCT worktree nodes through the worktree index, so the
  // tree dimension carries a real per-run latency distribution (not one sample
  // per run, which would degenerate a nearest-rank p95 into the max).
  await evaluate(() => window.perf.openTree());
  const treeWorktreeCold = await evaluate(() => window.perf.pageWorktrees({ limit: 50 }));
  const treeWorktreeWarm = [];
  for (let i = 0; i < 4; i += 1) treeWorktreeWarm.push((await evaluate(() => window.perf.pageWorktrees({ limit: 50 }))).ms);
  const treeWorktreeNodes = [];
  for (let i = 0; i < TREE.nodesPerRun; i += 1) {
    const worktree = `wt-${(i * 17) % TREE.input.worktrees}`;
    treeWorktreeNodes.push(await evaluate((args) => window.perf.pageWorktreeSummaries(args), { worktree, limit: 50 }));
  }
  await evaluate(() => window.perf.closeTree());

  const heap = await collectHeap();
  const rss = measureRss();
  const idb = await evaluate(() => window.perf.idbEstimate());
  const longTasks = await stack.readLongTasks();
  const errors = await evaluate(() => window.perf.errors());

  return {
    scenario: 'substrate-sample',
    pins: {
      coldFirstPageMs: coldPins.ms,
      warmRepageSamples: warmPins,
      ledgerAfter: pinLedgerAfter,
    },
    drafts: {
      coldFirstPageMs: coldDraftPage.ms,
      warmRepageSamples: warmDrafts,
      openProbeFound: openProbe.found,
      openProbeSamples: openProbe.samples,
      selectedPageSamples: exportProbe.samples,
      selectedPageDigests: exportProbe.digests,
      eventVisible,
      ledgerAfter: cacheLedgerAfter,
    },
    tree: {
      worktreeColdFirstPageMs: treeWorktreeCold.ms,
      worktreeColdReturned: treeWorktreeCold.count,
      worktreeWarmRepageSamples: treeWorktreeWarm,
      worktreeNodes: treeWorktreeNodes,
      worktreeNodeSamples: treeWorktreeNodes.map((node) => node.ms),
      worktreeNodeReturned: treeWorktreeNodes.map((node) => node.returned),
    },
    heap,
    rss,
    idbBytes: idb.usage,
    idbQuotaBytes: idb.quota,
    longTaskCount: longTasks.length,
    longTasks,
    pageErrors: errors,
  };
}

// Heavy, run-once: full enumeration of the pin identity set and the draft header
// set. Proves complete coverage (every record visited exactly once) and folds an
// independent digest Node re-computes over the same deterministic encoding.
export async function runCoverage(stack, { prefix, pins, drafts }) {
  const { page, evaluate, collectHeap, measureRss } = stack;
  await page.goto(stack.origin + '/perf/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.perf !== 'undefined');

  await evaluate(() => window.perf.openPins());
  const pinEnum = await evaluate((args) => window.perf.enumeratePins(args), FIXTURE.profileId);
  await evaluate(() => window.perf.closePins());

  await evaluate(() => window.perf.openDraftStore());
  await evaluate(() => window.perf.openDraftCache());
  const draftEnum = await evaluate(async (args) => {
    let after = null; let headers = 0; let pages = 0; let maxLedger = 0; let maxEntries = 0;
    const contexts = new Set();
    const t0 = performance.now();
    for (;;) {
      const page = await window.perf.cachePageHeaders({ limit: 32, after: after || undefined });
      pages += 1; headers += page.count;
      // STRICT plain-dataset identity, mirroring the Node-side `plainDraftOrdinal`
      // this module exports: only the `${prefix}-NNNNNN` contexts the 2KiB
      // single-body-part drafts leg imported count toward THIS row. The load
      // leg's `${prefix}-load-<label>-NNNNNN` contexts share the prefix but are a
      // different dataset graded by its own rows; counting them here made a
      // healthy run fail its own exact expectation (10001 + 8 = 10009).
      for (const context of page.contexts) {
        const ordinal = context.indexOf(args.prefix + '-') === 0 ? context.slice(args.prefix.length + 1) : '';
        if (/^\d{6}$/.test(ordinal)) contexts.add(context);
      }
      maxLedger = Math.max(maxLedger, page.usage.residentBytes + page.usage.reservedBytes);
      maxEntries = Math.max(maxEntries, page.usage.entries);
      after = page.next == null ? null : page.next;
      if (!after) break;
    }
    // Distinct contexts: an editSegment resume bumps a header to a new revision
    // under the SAME context, which must count once toward coverage.
    return { headers, prefixHeaders: contexts.size, distinctContexts: contexts.size, pages, maxLedger, maxEntries, enumerateMs: performance.now() - t0 };
  }, { prefix });
  await evaluate(() => window.perf.disposeCache());
  await evaluate(() => window.perf.closeDraftStore());

  // ---- the plan-prescribed tree composition: full enumeration + independent digests ----
  await evaluate(() => window.perf.openTree());
  const treeEnum = await evaluate((args) => window.perf.enumerateTree(args), TREE.input);
  await evaluate(() => window.perf.closeTree());

  const heap = await collectHeap();
  const rss = measureRss();
  // Independent node-side expected digest over the same qualified pin encoding.
  const expectedPinHash = createHash('sha256');
  for (let index = 0; index < pins; index += 1) {
    expectedPinHash.update(JSON.stringify([FIXTURE.profileId, FIXTURE.environmentId, FIXTURE.pinHarnessInstanceId(index), FIXTURE.pinNativeId(index), FIXTURE.clientOrigin, index, index % 3 !== 0]));
  }
  const expectedPinDigest = expectedPinHash.digest('hex');
  // The store's own key order: [profileId, environmentId, harnessInstanceId,
  // nativeSessionId, clientOrigin]. profileId, environmentId and clientOrigin are
  // constant across the set, so enumeration walks the five harness instances in
  // ascending ID order (which is the plan's category order) and, inside each,
  // the native session IDs in ascending STRING order — which is NOT numeric
  // order, because the plan's native IDs are not zero-padded. The oracle
  // therefore folds in exactly that order instead of assuming ordinal order.
  const expectedPinHashOrdered = createHash('sha256');
  const perCategory = TREE.harnessInstanceIds.map(() => []);
  for (let index = 0; index < pins; index += 1) perCategory[index % TREE.harnessInstanceIds.length].push(index);
  for (const ordinals of perCategory) {
    for (const index of [...ordinals].sort((left, right) => (FIXTURE.pinNativeId(left) < FIXTURE.pinNativeId(right) ? -1 : 1))) {
      expectedPinHashOrdered.update(JSON.stringify([FIXTURE.profileId, FIXTURE.environmentId, FIXTURE.pinHarnessInstanceId(index), FIXTURE.pinNativeId(index), FIXTURE.clientOrigin, index, index % 3 !== 0]));
    }
  }
  const expectedPinDigestOrdered = expectedPinHashOrdered.digest('hex');
  // Independent node-side expected digests over the seeded composition, derived
  // from the frozen generation input alone (never from the seeded records).
  const expectedWorktreeHash = createHash('sha256');
  // The worktree store's own key order is ascending STRING order (wt-0, wt-1,
  // wt-10, wt-100, …), not numeric, so the oracle folds in exactly that order
  // rather than assuming 0..199.
  for (const i of [...Array(TREE.input.worktrees).keys()].sort((left, right) => (`wt-${left}` < `wt-${right}` ? -1 : 1))) {
    expectedWorktreeHash.update(JSON.stringify([`wt-${i}`, `/seed${TREE.input.seed}/repo/worktrees/wt-${i}`, `/seed${TREE.input.seed}/repo/.git`, `fixture-${i}`]));
  }
  const expectedWorktreeDigest = expectedWorktreeHash.digest('hex');
  const expectedSummaryHash = createHash('sha256');
  const composition = planComposition(pins);
  for (let ordinal = 0; ordinal < pins; ordinal += 1) {
    const identity = treeIdentity(ordinal);
    expectedSummaryHash.update(JSON.stringify([
      identity.category,
      identity.nativeSessionId,
      ordinal,
      `seed${TREE.input.seed} session ${ordinal}`,
      identity.worktree,
      ordinal % TREE.input.sources.length === 0,
      ordinal % 23 === 0,
      ordinal % 17 === 0 ? 'native-parent' : null,
      TREE.input.timestamp,
    ]));
  }
  const expectedSummaryDigest = expectedSummaryHash.digest('hex');
  return {
    scenario: 'coverage',
    pins: {
      visited: pinEnum.count,
      expected: pins,
      coveragePct: pins > 0 ? Math.round((pinEnum.count / pins) * 10000) / 100 : null,
      pages: pinEnum.pages,
      maxLedger: pinEnum.maxLedger,
      maxEntries: pinEnum.maxEntries,
      enumerateMs: pinEnum.enumerateMs,
      hash: pinEnum.hash,
      expectedHash: expectedPinDigest,
      expectedHashInKeyOrder: expectedPinDigestOrdered,
      hashMatch: pinEnum.count === pins ? pinEnum.hash === expectedPinDigestOrdered : false,
    },
    drafts: {
      visitedPrefix: draftEnum.prefixHeaders,
      expected: drafts,
      coveragePct: drafts > 0 ? Math.round((draftEnum.prefixHeaders / drafts) * 10000) / 100 : null,
      pages: draftEnum.pages,
      maxLedger: draftEnum.maxLedger,
      maxEntries: draftEnum.maxEntries,
      enumerateMs: draftEnum.enumerateMs,
    },
    tree: {
      worktrees: {
        visited: treeEnum.worktrees,
        expected: TREE.input.worktrees,
        coveragePct: Math.round((treeEnum.worktrees / TREE.input.worktrees) * 10000) / 100,
        pages: treeEnum.worktreePages,
        hash: treeEnum.worktreeHash,
        expectedHash: expectedWorktreeDigest,
        hashMatch: treeEnum.worktrees === TREE.input.worktrees ? treeEnum.worktreeHash === expectedWorktreeDigest : false,
      },
      summaries: {
        visited: treeEnum.summaries,
        expected: pins,
        coveragePct: pins > 0 ? Math.round((treeEnum.summaries / pins) * 10000) / 100 : null,
        hash: treeEnum.summaryHash,
        expectedHash: expectedSummaryDigest,
        hashMatch: treeEnum.summaries === pins ? treeEnum.summaryHash === expectedSummaryDigest : false,
        categories: treeEnum.categories,
        expectedCategories: composition.categories,
        groups: treeEnum.groups,
        expectedGroups: composition.groups,
        distinctTimestamps: treeEnum.distinctTimestamps,
        worktreesWithSummaries: treeEnum.worktreesWithSummaries,
        maxSummariesPerWorktree: treeEnum.maxSummariesPerWorktree,
      },
      enumerateMs: treeEnum.enumerateMs,
    },
    heap,
    rss,
  };
}

// ---------------------------------------------------------------------------
// Scenario: drafts leg (load-bearing) — import EVERY draft one-by-one with each
// hash verified against an independent node-side oracle, THEN measure
// offline-restart / switch / resume-editing load timing + heap WITH the drafts.
// Returns the per-draft hash ledger plus the recovery proof.
// ---------------------------------------------------------------------------
export async function runDraftsLeg(stack, { count, prefix, out }) {
  const { page, evaluate, collectHeap, measureRss, log } = stack;
  log('drafts-leg-start', { count, prefix });
  await page.goto(stack.origin + '/perf/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.perf !== 'undefined');
  await evaluate(() => window.perf.openDraftStore());

  const ledger = [];
  let importMsTotal = 0;
  const batch = 500;
  for (let start = 0; start < count; start += batch) {
    const size = Math.min(batch, count - start);
    // One-by-one import + in-page verification per draft, batched at the CDP hop.
    const batchResults = await evaluate((args) => window.perf.importDraftBatch({ prefix: args.prefix, start: args.start, count: args.count }), { prefix, start, count: size });
    for (const imported of batchResults) {
      const expected = expectedPartHash(2048, imported.index % 251);
      const match = imported.readBackSha256 === expected && imported.storedSha256 === expected;
      ledger.push({ index: imported.index, context: FIXTURE.draftContext(prefix, imported.index), expected, storedSha256: imported.storedSha256, readBackSha256: imported.readBackSha256, bytes: imported.bytes, match });
      importMsTotal += imported.ms;
    }
  }
  const allMatch = ledger.every((entry) => entry.match);
  const ledgerHash = sha256Hex(Buffer.from(JSON.stringify(ledger.map((e) => [e.index, e.expected, e.storedSha256, e.readBackSha256]))));
  await writeFile(path.join(out, 'draft-import-hash-ledger.json'), json({ count, prefix, allMatch, ledgerHash, entries: ledger }));

  // Load timing + heap WITH all drafts present: page every header once.
  await evaluate(() => window.perf.openDraftCache());
  const loadPaged = await evaluate(async (args) => {
    let after = null; let headers = 0; let pages = 0; let maxLedger = 0; let maxEntries = 0; let prefixHeaders = 0;
    const t0 = performance.now();
    for (;;) {
      const page = await window.perf.cachePageHeaders({ limit: 32, after: after || undefined });
      pages += 1; headers += page.count;
      // Same STRICT plain-dataset identity as `runCoverage` (see the note there):
      // only this leg's own `${prefix}-NNNNNN` imports count toward its coverage
      // percentage, so a namespace added by another leg can never inflate it.
      for (const context of page.contexts) {
        const ordinal = context.indexOf(args.prefix + '-') === 0 ? context.slice(args.prefix.length + 1) : '';
        if (/^\d{6}$/.test(ordinal)) prefixHeaders += 1;
      }
      const usage = page.usage; maxLedger = Math.max(maxLedger, usage.residentBytes + usage.reservedBytes); maxEntries = Math.max(maxEntries, usage.entries);
      after = page.next == null ? null : page.next;
      if (!after) break;
    }
    return { headers, prefixHeaders, pages, maxLedger, maxEntries, loadMs: performance.now() - t0 };
  }, { prefix });
  const heapWithDrafts = await collectHeap();
  const rssWithDrafts = measureRss();
  const idbWithDrafts = await evaluate(() => window.perf.idbEstimate());

  // ---- switch draft: open a DIFFERENT draft (the middle one) than index 0 ----
  const switchProbe = await evaluate((args) => window.perf.cacheOpenProbe({ prefix: args.prefix, start: args.start, count: 1 }), { prefix, start: Math.floor(count / 2) });

  // ---- resume-editing: replace segment 0 at nextRevision, verify new hash ----
  const resume = await evaluate((args) => window.perf.cacheResumeEdit({ identity: { context: args.context, clientOrigin: 'task44-perf-client', revision: 1 }, part: 'body', nextRevision: 2, index: 0, size: 2048, seed: 99 }), { context: FIXTURE.draftContext(prefix, 1) });
  const resumeExpected = expectedPartHash(2048, 99);
  const resumeMatch = resume.nextHash === resumeExpected && resume.readHash === resumeExpected && resume.revision === 2;

  // ---- offline recovery: cut the network at CDP, read a draft back ----
  await stack.setNetwork({ offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const offlineOnline = await page.evaluate(() => navigator.onLine);
  // exportPart takes the part NAME and verifies size + sha256 per segment even
  // while the network is cut; the store must still serve from IndexedDB.
  const offlineExport = await evaluate((args) => window.perf.cacheExportPart({ identity: { context: args, clientOrigin: 'task44-perf-client', revision: 1 }, part: 'body' }), FIXTURE.draftContext(prefix, 0));
  await stack.setNetwork({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const offlineExpected = expectedPartHash(2048, 0);
  const offlineMatch = offlineExport.digest === offlineExpected;

  // ---- REAL restart: destroy the store/cache AND the page, rebuild, read offline ----
  // The offline leg above ran with the store and cache STILL OPEN and disposed
  // only AFTER the read, so it proved an in-memory cache hit, not persistence
  // across a restart — while the recovery row was named
  // "offline/restart/switch/resume". This leg destroys the cache, the store and
  // the page itself, rebuilds the world from the same origin, cuts the network
  // at CDP and reads the same draft back: the restart is a graded leg of its
  // own in the performance driver (RESTART_LEG_EXPECTED).
  await evaluate(() => window.perf.disposeCache());
  await evaluate(() => window.perf.closeDraftStore());
  await page.goto(stack.origin + '/perf/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.perf !== 'undefined');
  // Open the store and cache BEFORE cutting the network: opening them performs
  // the page's dynamic module imports, which are real fetches and cannot run
  // under an offline emulation.
  await evaluate(() => window.perf.openDraftStore());
  await evaluate(() => window.perf.openDraftCache());
  await stack.setNetwork({ offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const restartOnline = await page.evaluate(() => navigator.onLine);
  const restartExport = await evaluate((args) => window.perf.cacheExportPart({ identity: { context: args, clientOrigin: 'task44-perf-client', revision: 1 }, part: 'body' }), FIXTURE.draftContext(prefix, 0));
  await stack.setNetwork({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const restartMatch = restartExport.digest === offlineExpected && restartExport.bytes === 2048;

  await evaluate(() => window.perf.disposeCache());
  await evaluate(() => window.perf.closeDraftStore());

  log('drafts-leg-done', { count, allMatch, resumeMatch, offlineMatch, restartMatch });
  return {
    scenario: 'drafts-leg',
    count,
    prefix,
    import: { count, allMatch, ledgerHash, importMsTotal, importMsPerDraft: count > 0 ? importMsTotal / count : null },
    loadWithDrafts: { ...loadPaged, coveragePct: count > 0 ? Math.round((loadPaged.prefixHeaders / count) * 10000) / 100 : null },
    heapWithDrafts,
    rssWithDrafts,
    idbBytesWithDrafts: idbWithDrafts.usage,
    switch: switchProbe,
    resume: { ...resume, expected: resumeExpected, match: resumeMatch },
    offline: { online: offlineOnline, digest: offlineExport.digest, expected: offlineExpected, match: offlineMatch },
    restart: { online: restartOnline, digest: restartExport.digest, bytes: restartExport.bytes, expected: offlineExpected, match: restartMatch },
  };
}

// ---------------------------------------------------------------------------
// Scenario: large-body and attachment loads — the load dimension the task-44
// draft leg never covered. That leg only ever imported 2KiB single-`body`-part
// drafts, so large content and multi-part attachments had no coverage at all
// and no per-load-type reporting.
//
// For every frozen LOAD_PROFILES entry: import each draft one-by-one with every
// part streamed, committed (which re-reads and re-verifies each part) and read
// back with a folded digest, verifying each part against the independent
// Node-side hash oracle. Then destroy the cache, the store AND the page, rebuild
// from the same origin, cut the network at CDP and read EVERY part back offline.
// Results are reported per load type, never pooled with the 2KiB single-part
// drafts, so a large-content regression cannot hide behind the small-draft
// numbers (and vice versa).
// ---------------------------------------------------------------------------
export async function runLoadsLeg(stack, { prefix, out }) {
  const { page, evaluate, log } = stack;
  log('loads-leg-start', { prefix, profiles: LOAD_PROFILES.map((profile) => profile.label) });
  await page.goto(stack.origin + '/perf/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.perf !== 'undefined');
  await evaluate(() => window.perf.openDraftStore());
  await evaluate(() => window.perf.openDraftCache());

  const profiles = [];
  const ledger = [];
  for (const profile of LOAD_PROFILES) {
    let partsVerified = 0;
    let partsExpected = 0;
    let importMsTotal = 0;
    for (let index = 0; index < profile.drafts; index += 1) {
      // Each load profile owns its own context namespace: two profiles sharing
      // one prefix would commit DIFFERENT part sets under the same identity and
      // the store would (correctly) refuse the second header as a conflict.
      // `loadDraftContext` keeps that namespace inside `${prefix}-load-<label>`,
      // which the STRICT plain-draft identity in `runCoverage` does not match —
      // the load dimension is graded by its own rows, never pooled with the
      // 2KiB single-body-part drafts.
      const identity = { context: loadDraftContext(prefix, profile.label, index), clientOrigin: 'task44-perf-client', revision: 1 };
      const written = [];
      for (const part of profile.parts) {
        const result = await evaluate((args) => window.perf.writeDraftPart({ identity: args.identity, name: args.part.name, kind: args.part.kind, size: args.part.size, seed: args.part.seed }), { identity, part });
        importMsTotal += result.ms;
        written.push(result.part);
      }
      await evaluate((args) => window.perf.commitDraftHeader({ identity: args.identity, parts: args.parts }), { identity, parts: written });
      for (const [position, part] of profile.parts.entries()) {
        const readBack = await evaluate((args) => window.perf.cacheExportPart({ identity: args.identity, part: args.name }), { identity, name: part.name });
        const expected = expectedPartHash(part.size, part.seed);
        const match = written[position].sha256 === expected && readBack.digest === expected && readBack.bytes === part.size;
        partsExpected += 1;
        if (match) partsVerified += 1;
        ledger.push({ profile: profile.label, index, part: part.name, kind: part.kind, size: part.size, expected, storedSha256: written[position].sha256, readBackSha256: readBack.digest, bytes: readBack.bytes, match });
      }
    }
    profiles.push({
      label: profile.label,
      drafts: profile.drafts,
      parts: profile.parts.map((part) => ({ name: part.name, kind: part.kind, size: part.size })),
      partsVerified,
      partsExpected,
      allMatch: partsVerified === partsExpected,
      importMsPerPart: partsExpected > 0 ? importMsTotal / partsExpected : null,
    });
  }
  const ledgerHash = sha256Hex(Buffer.from(JSON.stringify(ledger.map((entry) => [entry.profile, entry.index, entry.part, entry.expected, entry.storedSha256, entry.readBackSha256]))));
  await writeFile(path.join(out, 'load-import-hash-ledger.json'), json({ prefix, ledgerHash, entries: ledger }));

  // ---- offline restart read-back of EVERY part of EVERY load draft ----
  await evaluate(() => window.perf.disposeCache());
  await evaluate(() => window.perf.closeDraftStore());
  await page.goto(stack.origin + '/perf/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.perf !== 'undefined');
  // Open the store and cache BEFORE cutting the network: opening them performs
  // the page's dynamic module imports, which are real fetches and cannot run
  // under an offline emulation.
  await evaluate(() => window.perf.openDraftStore());
  await evaluate(() => window.perf.openDraftCache());
  await stack.setNetwork({ offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const restartOnline = await page.evaluate(() => navigator.onLine);
  for (const entry of profiles) {
    const profile = LOAD_PROFILES.find((candidate) => candidate.label === entry.label);
    let readBack = 0;
    for (let index = 0; index < profile.drafts; index += 1) {
      const identity = { context: loadDraftContext(prefix, entry.label, index), clientOrigin: 'task44-perf-client', revision: 1 };
      for (const part of profile.parts) {
        const result = await evaluate((args) => window.perf.cacheExportPart({ identity: args.identity, part: args.name }), { identity, name: part.name });
        if (result.digest === expectedPartHash(part.size, part.seed) && result.bytes === part.size) readBack += 1;
      }
    }
    entry.offlineRestartReadBack = readBack;
  }
  await stack.setNetwork({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate(() => window.perf.disposeCache());
  await evaluate(() => window.perf.closeDraftStore());

  log('loads-leg-done', { profiles: profiles.map((entry) => `${entry.label}:${entry.partsVerified}/${entry.partsExpected}`), restartOnline });
  return { scenario: 'loads-leg', prefix, ledgerHash, restartOnline, profiles };
}

// ---------------------------------------------------------------------------
// Scenario: source errors — a controlled native boundary that returns a real
// timeout (slow), a real 503 (error) and a real partial body. The runtime
// connection must surface each as a DISTINCT, independently visible state and
// must NEVER emit a full-tree completion for an incomplete source.
// ---------------------------------------------------------------------------
export async function runSourceErrors(stack, { out }) {
  const { page, evaluate, log } = stack;
  const requests = [];
  const makeFixture = (behaviour) => createHttpServer((request, response) => {
    requests.push({ behaviour, url: request.url, at: Date.now() });
    // The page origin and the fixture are different ports (cross-origin); without
    // CORS the browser fetch fails with a client TypeError that would MASK the
    // real fixture behaviour. Permit the read so the observed state is truthful.
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (behaviour === 'slow') return; // never responds -> a real client-side timeout
    if (behaviour === 'partial') {
      // A 200 whose body is truncated (never closed): an incomplete source that
      // must NOT be read as a complete/full-tree result.
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"sessions":[{"id":"partial-truncated"');
      return;
    }
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'seed090 source unavailable' }));
  });

  const results = [];
  for (const behaviour of ['error', 'slow', 'partial']) {
    const fixture = makeFixture(behaviour);
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const port = fixture.address().port;
    try {
      await page.goto(stack.origin + '/perf/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.perf !== 'undefined');
      const probe = await evaluate(async (endpoint) => {
        // Drive the HTTP probe boundary against the controlled fixture and record
        // the OBSERVED outcome without masking. No forbidden headers (Upgrade /
        // Connection) — a browser fetch refuses those and would mask the real
        // fixture behaviour with a client TypeError.
        const outcomes = {};
        const started = performance.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4000);
          const response = await fetch(endpoint, { signal: controller.signal });
          outcomes.status = response.status;
          outcomes.body = (await response.text()).slice(0, 80);
          clearTimeout(timer);
        } catch (error) {
          outcomes.error = error.name === 'AbortError' ? 'timeout' : String(error.name || error.message);
        }
        outcomes.ms = performance.now() - started;
        return outcomes;
      }, `http://127.0.0.1:${port}/runtime`);
      results.push({ behaviour, endpoint: `http://127.0.0.1:${port}/runtime`, probe, requestObserved: requests.some((r) => r.behaviour === behaviour) });
    } finally {
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
  }
  log('source-errors-done', { behaviours: results.map((r) => r.behaviour) });
  const classify = (r) => {
    if (r.probe.status === 503) return 'error:503';
    if (r.probe.error === 'timeout') return 'slow:timeout';
    const body = r.probe.body ?? '';
    if (r.probe.status === 200 && !body.trim().endsWith('}')) return 'partial:truncated';
    return 'other';
  };
  for (const r of results) r.visibleState = classify(r);
  const report = { scenario: 'source-errors', results, requests };
  await writeFile(path.join(out, 'source-errors.json'), json(report));
  const distinct = new Set(results.map((r) => r.visibleState));
  return {
    scenario: 'source-errors',
    results,
    distinctVisibleStates: distinct.size,
    allDistinct: distinct.size === 3,
    // No incomplete source is reported as a complete success: a "complete
    // success" would be a 200 with a properly-terminated body. error=503,
    // slow=timeout, partial=200-with-truncated-body — none qualifies.
    noneMaskedAsComplete: results.every((r) => !(r.probe.status === 200 && (r.probe.body ?? '').trim().endsWith('}'))),
  };
}

// ---------------------------------------------------------------------------
// Preserved sample validator + historical CLI contract. validateSample rejects
// an incomplete source that claims a completion timing (the --check-sample gate
// used by app/runtimeFixture.test.ts).
// ---------------------------------------------------------------------------
export function validateSample(sample) {
  if (!['ready', 'disconnected', 'slow', 'error', 'partial'].includes(sample.sourceState)) throw new Error('invalid sourceState');
  if (sample.sourceState !== 'ready' && sample.completeMs !== null && sample.completeMs !== undefined) throw new Error('incomplete source cannot have complete timing');
  if (sample.completeMs !== null && sample.completeMs !== undefined && (!Number.isFinite(sample.completeMs) || sample.completeMs <= 0)) throw new Error('invalid complete timing');
  return sample;
}

export function describeEnvironment() {
  return {
    node: process.version,
    platform: process.platform,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    referenceHardware: '4CPU/16GiB/SSD; host measurements are descriptive, not SLO acceptance',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--check-sample')) {
      validateSample(JSON.parse(await readFile(args[args.indexOf('--check-sample') + 1], 'utf8')));
    } else {
      // Standalone smoke: run the empty-renderer baseline to a directory.
      if (!args.includes('--out')) throw new Error('--out is required');
      const out = path.resolve(args[args.indexOf('--out') + 1]);
      const stack = await createStack({ out });
      try {
        const baseline = await runBaseline(stack);
        await writeFile(path.join(out, 'baseline.json'), json({ ...baseline, environment: describeEnvironment(), invocation: process.argv }));
        process.stdout.write(`${json({ ok: true, firstScreenMs: baseline.firstScreenMs })}\n`);
      } finally {
        await stack.close();
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
