// Task 44 registered QA browser entry — the runtime store-substrate container.
//
// Served by the case-owned Vite stack that scripts/qa/runtime-v090-benchmark.mjs's createStack()
// builds (configFile:false, appType:'custom', root = the QA worktree). The case imports THIS module
// into the stack's page by absolute Vite path — `page.evaluate(() => import('/app/dev/runtime-v090/task44.ts'))`
// — so the harness, the runner and every product file are left untouched while this page still
// executes on the SAME real Chromium, the SAME real Vite transform and the SAME real IndexedDB the
// harness's own in-page bridge uses.
//
// What executes for REAL here: PinStore, DraftStore, createDraftCache and DraftDigest are the
// product's own modules under app/runtime/**, imported STATICALLY (so vue-tsc type-checks them and
// the case's static import walk discovers them), executed against a REAL IndexedDB
// (vis-runtime-pins / vis-runtime-client). There is no store mock, no fixture substitution and no
// in-memory stand-in for any graded surface.
//
// WHAT THIS ENTRY OWNS that the harness's in-page bridge does NOT — the four legs the plan's task-44
// failure lane demands and no existing seam provides:
//   * holdHandles() / releaseHandles() — the controlled NEGATIVE CONTROL. A draft-cache handle
//     reserves a fixed 2 MiB worst-case envelope against the cache's own 8 MiB / 32-entry ledger, so
//     holding handles forces residency and forbids eviction exactly as the plan words it ("强制常驻、
//     禁 cache eviction"). The product's OWN counters then show the ceiling reached and further
//     admission refused with the typed DraftStorageError('paused') — the budget is broken in the only
//     way this product ever breaks it: by REFUSING, never by silently exceeding.
//   * oversized() — an oversized selected message / draft-body attachment spanning many 64 KiB
//     chunks, exported through the cache's bounded streaming path.
//   * dirtyDrafts() — writePart WITHOUT commit: an unsaved ("脏") draft, timed end to end.
//   * queueBlocking() — the store's bounded write queue (32 pending entries / 8 MiB) driven past its
//     cap, observing the typed 'paused' refusal, the peak queue depth, and retry() draining it.
//   * restore() — dispose → close → reopen, then re-read a committed body so the case can prove the
//     restored content hash is unchanged.
//
// THE CONTROLLED BOUNDARY, stated rather than papered over: App.vue is not yet wired to the runtime
// (a later task owns that integration), so this page IS the container — it mounts no Vue app, it
// renders no session tree, and it claims NOTHING about what the running app displays. The five
// UI-TREE render metrics of the approved SLO are therefore graded at the STORE-SUBSTRATE level, the
// leading indicator the implementation lane disclosed. No live SSH, no live Slurm (task 46), no
// packaged/Electron run (task 45), and no PASS verdict is authored here — root dispatches the two
// registered invocations and an independent gate.
//
// Receiver-contract discipline (this plan's most expensive recurring lesson): EVERY value this entry
// returns crosses a page.evaluate serialisation boundary, so every return is a PLAIN JSON-safe
// object — never a class instance, never a live lease, never a Vue reactive proxy. Per-operation
// latencies are measured in-page with performance.now() and returned as numbers.
import { PinStore } from '../../runtime/pinStore';
import { DraftStore } from '../../runtime/draftStore';
import type { DraftIdentity } from '../../runtime/draftStore';
import { createDraftCache } from '../../runtime/draftCache';
import { DraftDigest } from '../../runtime/migration/draftChunks';

type AnyRecord = Record<string, any>;

const CLIENT_ORIGIN = 'task44-perf-client';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const PIN_LIMIT = 100;
const HEADER_LIMIT = 32;
const OVERSIZED_BYTES = 3 * 1024 * 1024;
const CHUNK_BYTES = 65536;

/** Deterministic byte generator — byte-identical to the Node-side independent hash oracle. */
const generated = (size: number, seed = 0): Uint8Array => Uint8Array.from({ length: size }, (_, index) => (index + seed) % 251);

/**
 * Streams `size` deterministic bytes in product-sized chunks, deriving each chunk's seed from its
 * byte offset so the concatenated stream is byte-identical to one contiguous `generated(size, seed)`
 * — the invariant that lets the Node-side oracle hash a single buffer and still agree with the page.
 */
async function* streamOf(size: number, seed: number): AsyncGenerator<Uint8Array> {
  let offset = 0;
  while (offset < size) {
    const next = Math.min(CHUNK_BYTES, size - offset);
    yield generated(next, (offset + seed) % 251);
    offset += next;
  }
}

interface ImportedDraft { readonly index: number; readonly context: string; readonly storedSha256: string; readonly readBackSha256: string; readonly bytes: number; readonly ms: number }
interface CacheUsage { readonly residentBytes: number; readonly reservedBytes: number; readonly entries: number }
interface Probe { readonly found: number; readonly count: number; readonly samples: readonly number[] }

// Module-level state. `errors`, `openLatencies` and `heldHandles` are PROBE ACCUMULATORS: they are
// reset in boot() so a second boot on the SAME page (the restore leg) cannot inherit the first
// boot's samples — the task-35 lesson, paid for once and encoded here.
const errors: AnyRecord[] = [];
const openLatencies: number[] = [];
const heldHandles: { release(): void }[] = [];
let pinStore: PinStore | null = null;
let draftStore: DraftStore | null = null;
let draftCache: ReturnType<typeof createDraftCache> | null = null;

window.addEventListener('error', (event) => { errors.push({ kind: 'error', message: String(event.message) }); });
window.addEventListener('unhandledrejection', (event) => { errors.push({ kind: 'unhandledrejection', message: String((event.reason && (event.reason as AnyRecord).message) || event.reason) }); });

const identityOf = (prefix: string, index: number): DraftIdentity => ({ context: `${prefix}-${String(index).padStart(6, '0')}`, clientOrigin: CLIENT_ORIGIN, revision: 1 });

async function openStores(): Promise<void> {
  pinStore = await PinStore.open();
  draftStore = await DraftStore.open();
  draftCache = createDraftCache({ store: draftStore });
}

async function closeStores(): Promise<void> {
  if (draftCache) { try { await draftCache.dispose(); } catch { /* a paused cache cannot dispose; close() below still releases the IDB handle */ } draftCache = null; }
  if (draftStore) { draftStore.close(); draftStore = null; }
  if (pinStore) { pinStore.close(); pinStore = null; }
}

/**
 * Import ONE draft end to end: stream the body part, commit (which re-reads and re-verifies every
 * chunk's sha256 before the header is put), then read the body back and fold a DraftDigest. Returns
 * BOTH the store-recorded part.sha256 and the read-back digest so the Node side cross-checks each
 * against its own independent hash of the same deterministic bytes.
 */
async function importOne(prefix: string, index: number, size: number): Promise<ImportedDraft> {
  const identity = identityOf(prefix, index);
  const started = performance.now();
  const part = await draftStore!.writePart(identity, { name: 'body', kind: 'body', input: streamOf(size, index % 251) });
  await draftStore!.commit({ ...identity, parts: [part] });
  const digest = new DraftDigest();
  let bytes = 0;
  for await (const chunk of draftStore!.readPart(identity, part)) { digest.update(chunk); bytes += chunk.length; }
  return { index, context: identity.context, storedSha256: part.sha256, readBackSha256: digest.finish(), bytes, ms: performance.now() - started };
}

const api = {
  /** Reset every module-level accumulator, then (re)open the real stores. */
  boot: async (): Promise<{ opened: boolean; clientOrigin: string }> => {
    errors.length = 0;
    openLatencies.length = 0;
    for (const handle of heldHandles.splice(0)) handle.release();
    await closeStores();
    await openStores();
    return { opened: pinStore !== null && draftStore !== null && draftCache !== null, clientOrigin: CLIENT_ORIGIN };
  },
  errors: (): AnyRecord[] => errors.map((entry) => ({ ...entry })),
  closeStores: async (): Promise<{ closed: boolean }> => { await closeStores(); return { closed: pinStore === null && draftStore === null && draftCache === null }; },
  heap: (): AnyRecord => {
    const memory = (performance as AnyRecord).memory ?? {};
    return { usedJSHeapSize: memory.usedJSHeapSize ?? 0, totalJSHeapSize: memory.totalJSHeapSize ?? 0, jsHeapSizeLimit: memory.jsHeapSizeLimit ?? 0 };
  },
  idbEstimate: async (): Promise<{ usage: number | null; quota: number | null }> => {
    if (!navigator.storage || !navigator.storage.estimate) return { usage: null, quota: null };
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage == null ? null : estimate.usage, quota: estimate.quota == null ? null : estimate.quota };
  },

  /* ------------------------------------------------------------------ pins */
  pinPage: async (input: { limit?: number } = {}): Promise<{ count: number; next: string[] | null; usage: CacheUsage; ms: number }> => {
    const started = performance.now();
    const page = await pinStore!.page({ profileId: PROFILE_ID as never, limit: input.limit ?? PIN_LIMIT });
    const usage = pinStore!.usage();
    const ms = performance.now() - started;
    const out = { count: page.records.length, next: page.next === null ? null : [...page.next], usage, ms };
    page.release();
    return out;
  },

  /* ------------------------------------------------------------------ drafts */
  /** Import `count` drafts ONE BY ONE (each streamed, committed and read back), batched at the CDP hop. */
  importDrafts: async (input: { prefix: string; start: number; count: number; size?: number }): Promise<{ count: number; drafts: ImportedDraft[] }> => {
    const size = input.size ?? 2048;
    const drafts: ImportedDraft[] = [];
    for (let index = input.start; index < input.start + input.count; index += 1) drafts.push(await importOne(input.prefix, index, size));
    return { count: drafts.length, drafts };
  },
  headerPage: async (input: { limit?: number; after?: string } = {}): Promise<{ count: number; contexts: string[]; next: string | null; usage: CacheUsage; ms: number }> => {
    const started = performance.now();
    const page = await draftCache!.pageHeaders({ limit: input.limit ?? HEADER_LIMIT, ...(input.after ? { after: input.after } : {}) });
    const usage = draftCache!.usage();
    const ms = performance.now() - started;
    const out = { count: page.headers.length, contexts: page.headers.map((header) => header.context), next: page.next, usage, ms };
    page.release();
    return out;
  },
  /** Open `count` DISTINCT draft handles, each released before the next, recording every latency. */
  openProbe: async (input: { prefix: string; start: number; count: number }): Promise<Probe & { usage: CacheUsage }> => {
    let found = 0;
    for (let index = input.start; index < input.start + input.count; index += 1) {
      const started = performance.now();
      const handle = await draftCache!.open(identityOf(input.prefix, index));
      openLatencies.push(performance.now() - started);
      if (handle) { found += 1; handle.release(); }
    }
    return { found, count: input.count, samples: [...openLatencies], usage: draftCache!.usage() };
  },
  /** Export `count` distinct draft bodies (open + export + release), recording latency and digest. */
  exportProbe: async (input: { prefix: string; start: number; count: number }): Promise<{ samples: number[]; digests: (string | null)[]; usage: CacheUsage }> => {
    const samples: number[] = [];
    const digests: (string | null)[] = [];
    for (let index = input.start; index < input.start + input.count; index += 1) {
      const identity = identityOf(input.prefix, index);
      const started = performance.now();
      try {
        const digest = new DraftDigest();
        let bytes = 0;
        for await (const segment of draftCache!.exportPart({ identity, part: 'body' })) { digest.update(segment.bytes); bytes += segment.bytes.length; segment.release(); }
        samples.push(performance.now() - started);
        digests.push(bytes > 0 ? digest.finish() : null);
      } catch { samples.push(performance.now() - started); digests.push(null); }
    }
    return { samples, digests, usage: draftCache!.usage() };
  },

  /* ------------------------------------------------------------------ the negative control */
  /**
   * THE CONTROLLED NEGATIVE CONTROL. Open and HOLD `count` draft-cache handles: each pins its fixed
   * 2 MiB worst-case envelope against the cache's own 8 MiB / 32-entry ledger, so the bounded ledger
   * cannot evict them. Observed on the PRODUCT'S OWN counters: residentBytes climbs to the ceiling,
   * entries to the held count, and every further open is REFUSED with the typed
   * DraftStorageError('paused'). A refusal is recorded, never swallowed and never thrown outward.
   */
  holdHandles: async (input: { prefix: string; start: number; count: number }): Promise<{ held: number; refused: number; refusalCode: string | null; usage: CacheUsage }> => {
    let refused = 0;
    let refusalCode: string | null = null;
    for (let index = input.start; index < input.start + input.count; index += 1) {
      try {
        const handle = await draftCache!.open(identityOf(input.prefix, index));
        if (handle) heldHandles.push(handle);
        else { refused += 1; refusalCode ??= 'missing'; }
      } catch (error) { refused += 1; refusalCode ??= String((error as AnyRecord).code ?? (error as Error).name); }
    }
    return { held: heldHandles.length, refused, refusalCode, usage: draftCache!.usage() };
  },
  /** The restore half of the negative control: release every held handle and re-read the ledger. */
  releaseHandles: (): { released: number; usage: CacheUsage } => {
    const held = heldHandles.splice(0);
    for (const handle of held) handle.release();
    return { released: held.length, usage: draftCache!.usage() };
  },
  usage: (): CacheUsage => draftCache!.usage(),
  pinUsage: (): CacheUsage => pinStore!.usage(),

  /* ------------------------------------------------------------------ the failure-lane timing legs */
  /** An oversized body spanning many 64 KiB chunks, committed and exported through the cache. */
  oversized: async (input: { prefix: string; index: number; size?: number }): Promise<{ bytes: number; chunks: number; storedSha256: string; readBackSha256: string; largest: number; writeMs: number; commitMs: number; exportMs: number }> => {
    const identity = { ...identityOf(input.prefix, input.index), revision: 1 };
    const size = input.size ?? OVERSIZED_BYTES;
    const writeStart = performance.now();
    const part = await draftStore!.writePart(identity, { name: 'body', kind: 'body', input: streamOf(size, input.index % 251) });
    const writeMs = performance.now() - writeStart;
    const commitStart = performance.now();
    await draftStore!.commit({ ...identity, parts: [part] });
    const commitMs = performance.now() - commitStart;
    const exportStart = performance.now();
    const digest = new DraftDigest();
    let bytes = 0;
    let largest = 0;
    for await (const segment of draftCache!.exportPart({ identity, part: 'body' })) { digest.update(segment.bytes); bytes += segment.bytes.length; largest = Math.max(largest, segment.bytes.length); segment.release(); }
    const exportMs = performance.now() - exportStart;
    return { bytes, chunks: part.chunks, storedSha256: part.sha256, readBackSha256: digest.finish(), largest, writeMs, commitMs, exportMs };
  },
  /** `count` DIRTY drafts: writePart WITHOUT commit — an unsaved draft whose chunks exist with no header. */
  dirtyDrafts: async (input: { prefix: string; start: number; count: number; size?: number }): Promise<{ count: number; samples: number[]; sha256: string[]; bytes: number[] }> => {
    const size = input.size ?? 2048;
    const samples: number[] = [];
    const sha256: string[] = [];
    const bytes: number[] = [];
    for (let index = input.start; index < input.start + input.count; index += 1) {
      const identity = identityOf(input.prefix, index);
      const started = performance.now();
      const part = await draftStore!.writePart(identity, { name: 'body', kind: 'body', input: streamOf(size, index % 251) });
      samples.push(performance.now() - started);
      sha256.push(part.sha256);
      bytes.push(part.bytes);
    }
    return { count: samples.length, samples, sha256, bytes };
  },
  /**
   * QUEUE BLOCKING: fire `count` concurrent chunk writes through the store's bounded write queue
   * (32 pending entries / 8 MiB). Every call is recorded — accepted (resolved) or refused (rejected
   * with the typed 'paused') — with its own latency, the peak queue depth, and the store's paused
   * flag. retry() then drains the queue and the store is observed usable again.
   */
  queueBlocking: async (input: { prefix: string; start: number; count: number }): Promise<{ accepted: number; refused: number; refusalCode: string | null; pendingPeak: number; paused: boolean; samples: number[]; retryPendingBefore: number; retryPendingAfter: number; pausedAfterRetry: boolean; wallMs: number }> => {
    const started0 = performance.now();
    let pendingPeak = 0;
    let polling = true;
    const poller = (async () => { while (polling) { pendingPeak = Math.max(pendingPeak, draftStore!.pendingCount); await new Promise<void>((resolve) => { setTimeout(resolve, 2); }); } })();
    const outcomes = await Promise.all(Array.from({ length: input.count }, async (_, offset) => {
      const index = input.start + offset;
      const identity = identityOf(input.prefix, index);
      const started = performance.now();
      try { await draftStore!.writeChunk(identity, { name: 'body', kind: 'body', index: 0, bytes: generated(2048, index % 251) }); return { ok: true, ms: performance.now() - started, code: null as string | null }; }
      catch (error) { return { ok: false, ms: performance.now() - started, code: String((error as AnyRecord).code ?? (error as Error).name) }; }
    }));
    polling = false;
    await poller;
    const paused = draftStore!.paused;
    const retryPendingBefore = draftStore!.pendingCount;
    if (paused) await draftStore!.retry();
    for (let attempt = 0; attempt < 200 && draftStore!.pendingCount > 0; attempt += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    const retryPendingAfter = draftStore!.pendingCount;
    return {
      accepted: outcomes.filter((entry) => entry.ok).length,
      refused: outcomes.filter((entry) => !entry.ok).length,
      refusalCode: outcomes.find((entry) => !entry.ok)?.code ?? null,
      pendingPeak,
      paused,
      samples: outcomes.map((entry) => entry.ms),
      retryPendingBefore,
      retryPendingAfter,
      pausedAfterRetry: draftStore!.paused,
      wallMs: performance.now() - started0,
    };
  },

  /* ------------------------------------------------------------------ content proof and restore */
  /** Read a committed draft body back and fold the product's own DraftDigest over the bytes. */
  contentDigest: async (input: { prefix: string; index: number; revision?: number }): Promise<{ digest: string; bytes: number }> => {
    const identity = { ...identityOf(input.prefix, input.index), revision: input.revision ?? 1 };
    const header = await draftStore!.header(identity);
    if (!header) throw new Error(`no committed draft at ${identity.context} revision ${identity.revision}`);
    const part = header.parts.find((entry) => entry.name === 'body');
    if (!part) throw new Error(`no body part at ${identity.context}`);
    const digest = new DraftDigest();
    let bytes = 0;
    for await (const chunk of draftStore!.readPart(identity, part)) { digest.update(chunk); bytes += chunk.length; }
    return { digest: digest.finish(), bytes };
  },
  /** THE RESTORE LEG: dispose the cache, close both stores, reopen both, re-read the same body. */
  restore: async (input: { prefix: string; index: number }): Promise<{ reopened: boolean; digest: string; bytes: number; usage: CacheUsage }> => {
    await closeStores();
    await openStores();
    const content = await api.contentDigest({ prefix: input.prefix, index: input.index });
    return { reopened: pinStore !== null && draftStore !== null && draftCache !== null, digest: content.digest, bytes: content.bytes, usage: draftCache!.usage() };
  },
};

(window as AnyRecord).task44 = api;
