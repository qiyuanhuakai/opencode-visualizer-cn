// @vitest-environment node
// Task 50 / IS-2 — the performance SCORING must not pass a run whose operations
// actually failed. The review found that cacheOpenProbe records a duration even
// when it finds no draft, cacheExportBatch records a duration and a null digest
// after catching, and event-visible returns seen=false with a fast duration —
// while openProbeFound / selectedPageDigests / eventVisible.seen never entered
// any scoring condition, so a run passed on latency alone even when open/export
// failed or the event was invisible. These tests drive the REAL row builder with
// a failed-but-fast run and require every one of those rows to FAIL.
//
// They also drive the REAL leg orchestration (runDraftsLeg -> runLoadsLeg ->
// runCoverage) through a controlled page/store double, because the hand-built
// COVERAGE objects below cannot see an INTEGRATION conflict between two legs
// that share one DraftStore IndexedDB.
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { evaluateThresholds } from '../scripts/qa/runtime-v090-performance.mjs';
import type { DraftsLegInput, LoadsLegInput, MetricsReport, SourceErrorsReport, ThresholdRow, TreeCoverageReport, TreeMetricsReport, CoverageInput } from '../scripts/qa/runtime-v090-performance.mjs';
import {
  FIXTURE,
  LOAD_PROFILES,
  RESTART_LEG_EXPECTED,
  loadDraftContext,
  loadDraftPrefix,
  plainDraftOrdinal,
  runCoverage,
  runDraftsLeg,
  runLoadsLeg,
} from '../scripts/qa/runtime-v090-benchmark.mjs';
import type {
  CoverageReport,
  DraftIdentity,
  DraftsLegReport,
  HeaderPage,
  ImportedDraft,
  LoadsLegReport,
  PerfBridge,
  PerfPage,
  PerfStack,
  PinEnumeration,
  TreeEnumeration,
  WrittenPart,
} from '../scripts/qa/runtime-v090-benchmark.mjs';

// A run whose LATENCIES are all fast (well inside every SLO) but whose
// OPERATIONS failed: no open probe found its draft, every export produced a null
// digest, and no event ever became visible.
const FAST_METRICS: MetricsReport = {
  warmPinsP95: 10, coldPinsP95: 20, coldDraftsP95: 30, selectedPageP95: 40, openProbeP95: 5, eventVisibleP95: 7,
  openProbeFound: 0, openProbeExpected: 30,
  selectedPageDigests: 0, selectedPageDigestsExpected: 10,
  eventVisibleSeen: 0, eventVisibleRuns: 10,
};
const GREEN_METRICS: MetricsReport = { ...FAST_METRICS, openProbeFound: 30, selectedPageDigests: 10, eventVisibleSeen: 10 };
const COVERAGE: CoverageInput = {
  pins: { visited: 10000, expected: 10000, coveragePct: 100, hashMatch: true },
  drafts: { visitedPrefix: 10001, expected: 10001, coveragePct: 100 },
};
const DRAFTS_LEG: DraftsLegInput = {
  import: { count: 10001, allMatch: true, ledgerHash: 'a'.repeat(64) },
  offline: { match: true }, resume: { match: true, revision: 2 }, switch: { found: 1 },
  restart: { match: true },
};
const SOURCE_ERRORS: SourceErrorsReport = { distinctVisibleStates: 3, allDistinct: true };
const TREE_COVERAGE: TreeCoverageReport = {
  worktrees: { visited: 200, expected: 200, coveragePct: 100, hashMatch: true, pages: 3 },
  summaries: {
    visited: 10001, expected: 10001, coveragePct: 100, hashMatch: true,
    categories: { opencode: 2001, codex: 2000, acp: 2000, kimiWeb: 2000, dsh: 2000 },
    expectedCategories: { opencode: 2001, codex: 2000, acp: 2000, kimiWeb: 2000, dsh: 2000 },
    groups: { globalRoots: 1001, codexThreads: 51, archived: 100, orphan: 10, child: 500 },
    expectedGroups: { globalRoots: 1001, codexThreads: 51, archived: 100, orphan: 10, child: 500 },
    distinctTimestamps: 1, worktreesWithSummaries: 200, maxSummariesPerWorktree: 60,
  },
  enumerateMs: 500,
};
const TREE_METRICS: TreeMetricsReport = { worktreeWarmP95: 10, worktreeColdP95: 20, worktreeNodeP95: 5 };
const LOADS_LEG: LoadsLegInput = {
  profiles: LOAD_PROFILES.map((profile) => ({
    label: profile.label,
    drafts: profile.drafts,
    partsVerified: profile.drafts * profile.parts.length,
    partsExpected: profile.drafts * profile.parts.length,
    allMatch: true,
    offlineRestartReadBack: profile.drafts * profile.parts.length,
  })),
};

const rows = (metrics: MetricsReport, extra: { draftsLeg?: Partial<DraftsLegInput>; loadsLeg?: LoadsLegInput | null } = {}): ThresholdRow[] => evaluateThresholds('10k', false, metrics, COVERAGE, { ...DRAFTS_LEG, ...extra.draftsLeg }, SOURCE_ERRORS, 64 * 1024 * 1024, 16 * 1024 * 1024, TREE_METRICS, TREE_COVERAGE, extra.loadsLeg ?? LOADS_LEG);

/** Locate a row, failing loudly when it is absent (a dropped row must not read as a pass). */
const findRow = (table: ThresholdRow[], match: (candidate: ThresholdRow) => boolean): ThresholdRow => {
  const found = table.find(match);
  if (found === undefined) throw new Error(`no threshold row matched; rows: ${table.map((candidate) => candidate.name).join(' | ')}`);
  return found;
};
const row = (table: ThresholdRow[], name: string): ThresholdRow => findRow(table, (candidate) => candidate.name.includes(name));

describe('performance scoring cannot pass a failed operation', () => {
  it('a run whose open probes found NO draft fails the interaction row despite a fast p95', () => {
    const result = row(rows(FAST_METRICS), 'interaction (open draft handle)');
    expect(result).toBeDefined();
    expect(result.measured).toBeLessThanOrEqual(result.threshold);
    expect(result.passed).toBe(false);
  });

  it('a run whose exports all returned a null digest fails the selected-page row despite a fast p95', () => {
    const result = row(rows(FAST_METRICS), 'selected-page');
    expect(result).toBeDefined();
    expect(result.measured).toBeLessThanOrEqual(result.threshold);
    expect(result.passed).toBe(false);
  });

  it('a run whose event never became visible fails the event-visible row despite a fast p95', () => {
    const result = row(rows(FAST_METRICS), 'event-visible');
    expect(result).toBeDefined();
    expect(result.measured).toBeLessThanOrEqual(result.threshold);
    expect(result.passed).toBe(false);
  });

  it('a partially failed run fails too: 29 of 30 probes found, 9 of 10 digests, 9 of 10 events', () => {
    const partial = { ...FAST_METRICS, openProbeFound: 29, selectedPageDigests: 9, eventVisibleSeen: 9 };
    expect(row(rows(partial), 'interaction (open draft handle)').passed).toBe(false);
    expect(row(rows(partial), 'selected-page').passed).toBe(false);
    expect(row(rows(partial), 'event-visible').passed).toBe(false);
  });

  it('a green run still passes those three rows (the fix adds a condition, it does not fail everything)', () => {
    expect(row(rows(GREEN_METRICS), 'interaction (open draft handle)').passed).toBe(true);
    expect(row(rows(GREEN_METRICS), 'selected-page').passed).toBe(true);
    expect(row(rows(GREEN_METRICS), 'event-visible').passed).toBe(true);
  });
});

describe('coverage rounding cannot pass a missing record', () => {
  // The rounding defect only bites at the 100k scale: the coverage percentage is
  // rounded to two decimals, so 100000/100001 (one draft header missing) rounds
  // to 100.00 and 99996/100001 (five missing) rounds to 100.00 as well. At the
  // 10k scale a single missing header reads 99.99 and would have failed anyway.
  const roundedDrafts = (visited: number) => {
    const expected = 100001;
    return { visitedPrefix: visited, expected, coveragePct: Math.round((visited / expected) * 10000) / 100 };
  };

  it('100000 of 100001 drafts visited (one missing, rounds to 100.00%) fails the drafts coverage row', () => {
    const coverage = { pins: { visited: 100000, expected: 100000, coveragePct: 100, hashMatch: true }, drafts: roundedDrafts(100000) };
    const result = findRow(evaluateThresholds('100k', false, GREEN_METRICS, coverage, DRAFTS_LEG, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, LOADS_LEG), (candidate) => candidate.name.includes('drafts visited exactly once'));
    expect(result.measured).toBe(100000);
    expect(result.threshold).toBe(100001);
    expect(coverage.drafts.coveragePct).toBe(100);
    expect(result.passed).toBe(false);
  });

  it('99996 of 100001 drafts visited (five missing, rounds to 100.00%) fails the drafts coverage row', () => {
    const coverage = { pins: { visited: 100000, expected: 100000, coveragePct: 100, hashMatch: true }, drafts: roundedDrafts(99996) };
    const result = findRow(evaluateThresholds('100k', false, GREEN_METRICS, coverage, DRAFTS_LEG, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, LOADS_LEG), (candidate) => candidate.name.includes('drafts visited exactly once'));
    expect(coverage.drafts.coveragePct).toBe(100);
    expect(result.passed).toBe(false);
  });

  it('the exact count passes the drafts coverage row', () => {
    const result = row(rows(GREEN_METRICS), 'drafts visited exactly once');
    expect(result.passed).toBe(true);
  });

  it('9999 of 10000 pins visited (rounds to 100.00%) fails the pins coverage row', () => {
    const coverage = { pins: { visited: 9999, expected: 10000, coveragePct: 100, hashMatch: false }, drafts: COVERAGE.drafts };
    const result = findRow(evaluateThresholds('10k', false, GREEN_METRICS, coverage, DRAFTS_LEG, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, LOADS_LEG), (candidate) => candidate.name.includes('pins visited exactly once'));
    expect(result.passed).toBe(false);
  });
});

describe('recovery legs include a real restart', () => {
  it('a failed restart leg fails the recovery row even when offline/switch/resume all pass', () => {
    const result = row(rows(GREEN_METRICS, { draftsLeg: { ...DRAFTS_LEG, restart: { match: false } } }), 'offline/restart/switch/resume');
    expect(result.threshold).toBe(RESTART_LEG_EXPECTED);
    expect(result.passed).toBe(false);
  });

  it('the restart leg is graded as its own condition, so the row needs all four legs', () => {
    const result = row(rows(GREEN_METRICS), 'offline/restart/switch/resume');
    expect(result.threshold).toBe(4);
    expect(result.passed).toBe(true);
  });
});

describe('large-body and attachment load coverage is graded, not silently dropped', () => {
  it('every load profile part is graded: a missed hash in one profile fails that profile row', () => {
    const degraded: LoadsLegInput = { profiles: LOADS_LEG.profiles.map((profile, index) => (index === 0 ? { ...profile, partsVerified: profile.partsExpected - 1 } : profile)) };
    for (const profile of LOAD_PROFILES) {
      const result = row(rows(GREEN_METRICS, { loadsLeg: degraded }), `load coverage (${profile.label})`);
      expect(result).toBeDefined();
      expect(result.threshold).toBe(profile.drafts * profile.parts.length);
      expect(result.passed).toBe(profile.label !== LOAD_PROFILES[0].label);
    }
  });

  it('a failed offline restart read-back fails the load row even when every hash matched', () => {
    const degraded: LoadsLegInput = { profiles: LOADS_LEG.profiles.map((profile) => ({ ...profile, offlineRestartReadBack: profile.partsExpected - 2 })) };
    for (const profile of LOAD_PROFILES) expect(row(rows(GREEN_METRICS, { loadsLeg: degraded }), `load coverage (${profile.label})`).passed).toBe(false);
  });

  it('a run that never measured the loads dimension cannot pass it', () => {
    const result = findRow(evaluateThresholds('10k', false, GREEN_METRICS, COVERAGE, DRAFTS_LEG, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, null), (candidate) => candidate.name.startsWith('load coverage (large-body'));
    expect(result).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('the frozen load profiles carry the prescribed seed090 scales: 16MiB body, 1MiB attachments, 64MiB large attachment', () => {
    // The frozen generation input (app/dev/runtime-v090/fixtures/seed090.json)
    // prescribes bodyBytes 2048, attachmentEvery 100, attachmentBytes 1 MiB,
    // largeBodyBytes 16 MiB and largeAttachmentBytes 64 MiB. These profiles must
    // carry those literals themselves — a smaller stand-in would leave the
    // prescribed scale unexercised, which is the coverage gap this closes.
    expect(LOAD_PROFILES.map((profile) => profile.label)).toEqual(['large-body', 'multi-part-attachment', 'oversized-draft']);
    expect(LOAD_PROFILES[0].parts[0].size).toBe(16 * 1024 * 1024);
    // The every-100th record's shape: a 2KiB body plus 1MiB attachment part(s).
    expect(LOAD_PROFILES[1].parts[0]).toMatchObject({ kind: 'body', size: 2 * 1024 });
    const attachments = LOAD_PROFILES[1].parts.filter((part) => part.kind === 'attachment');
    expect(attachments.length).toBeGreaterThanOrEqual(1);
    for (const attachment of attachments) expect(attachment.size).toBe(1024 * 1024);
    // The fixture's one oversized draft: 16MiB body plus a 64MiB attachment.
    expect(LOAD_PROFILES[2].drafts).toBe(1);
    expect(LOAD_PROFILES[2].parts.map((part) => part.size)).toEqual([16 * 1024 * 1024, 64 * 1024 * 1024]);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION REGRESSION: runLoadsLeg -> runCoverage over one shared DraftStore.
//
// The rows above hand-build a COVERAGE object, so they could not see the defect
// the review found: the load leg used to build its contexts as
// `${prefix}-load-<label>-NNNNNN`, which starts with `${prefix}-`, so the plain
// draft coverage enumeration — which filtered on that PREFIX — counted those 8
// headers as 2KiB single-body-part drafts. The exact-count coverage row then
// failed a HEALTHY run: 10009/10001 at the 10k scale and 100009/100001 at the
// 100k scale, with both load profiles importing 4/4 and 12/12 parts whose
// hashes and offline read-backs all matched. (The leg now carries a third
// profile — the fixture's prescribed oversized draft — so its own committed
// header count is derived from LOAD_PROFILES below, not frozen at 8.)
//
// This drives the REAL runDraftsLeg, the REAL runLoadsLeg and the REAL
// runCoverage through a controlled page/store double, so the two legs really do
// share one header set and the coverage enumeration really does page it.
// ---------------------------------------------------------------------------

/** The frozen 10k dataset the standard profile runs. */
const INTEGRATION_PREFIX = 'perf-10k';
const INTEGRATION_PINS = 10000;
const INTEGRATION_DRAFTS = 10001;
/** The 2KiB single-body-part size the drafts leg imports. */
const DRAFT_PART_BYTES = 2048;
/** A fixed literal scratch directory: the drafts leg writes its hash ledger here. */
const EVIDENCE_OUT = '/tmp/opencode/vis-v090-perf-regression';

// The benchmark module's own deterministic byte generator, mirrored so the
// controlled store can produce the digests the independent Node-side oracle
// expects. If that generator ever changes, this test fails loudly instead of
// quietly agreeing with itself.
const fixtureBytes = (size: number, seed = 0): Uint8Array => Uint8Array.from({ length: size }, (_, index) => (index + seed) % 251);
const digestOf = (size: number, seed = 0): string => createHash('sha256').update(fixtureBytes(size, seed)).digest('hex');

interface StoredDraft {
  context: string;
  revision: number;
  parts: WrittenPart[];
}

/**
 * A controlled double of the in-page `window.perf` bridge backed by an in-memory
 * draft header set. It models the one property that matters here: the drafts leg
 * and the loads leg commit into the SAME header set, and that set survives the
 * dispose/close/page-reload the legs perform (as IndexedDB would).
 */
const createBridge = () => {
  const drafts = new Map<string, StoredDraft>();
  // Commit order, which is the order DraftCache.pageHeaders walks.
  const order: string[] = [];
  const commit = (identity: DraftIdentity, parts: WrittenPart[]): void => {
    if (!drafts.has(identity.context)) order.push(identity.context);
    drafts.set(identity.context, { context: identity.context, revision: identity.revision, parts: [...parts] });
  };
  const bridge: PerfBridge = {
    openPins: async () => ({ ok: true }),
    enumeratePins: async (): Promise<PinEnumeration> => ({ count: INTEGRATION_PINS, pages: 100, maxLedger: 1, maxEntries: 1, enumerateMs: 1, hash: 'controlled-pin-digest' }),
    closePins: async () => ({ ok: true }),
    openDraftStore: async () => ({ ok: true }),
    closeDraftStore: async () => ({ ok: true }),
    openDraftCache: async () => ({ ok: true }),
    disposeCache: async () => ({ ok: true }),
    // The in-page bridge's own context construction, so the plain dataset is
    // created by the same rule the coverage enumeration classifies against.
    importDraftBatch: async (args): Promise<ImportedDraft[]> => {
      const imported: ImportedDraft[] = [];
      for (let offset = 0; offset < args.count; offset += 1) {
        const index = args.start + offset;
        const sha256 = digestOf(DRAFT_PART_BYTES, index % 251);
        commit({ context: FIXTURE.draftContext(args.prefix, index), clientOrigin: FIXTURE.clientOrigin, revision: 1 }, [{ name: 'body', kind: 'body', bytes: DRAFT_PART_BYTES, sha256 }]);
        imported.push({ index, storedSha256: sha256, readBackSha256: sha256, bytes: DRAFT_PART_BYTES, ms: 0 });
      }
      return imported;
    },
    cachePageHeaders: async (args): Promise<HeaderPage> => {
      const start = args.after == null ? 0 : Number(args.after);
      const contexts = order.slice(start, start + args.limit);
      const next = start + args.limit < order.length ? String(start + args.limit) : null;
      return { count: contexts.length, contexts, next, usage: { residentBytes: 0, reservedBytes: 0, entries: order.length }, ms: 0 };
    },
    cacheOpenProbe: async (args) => {
      let found = 0;
      for (let offset = 0; offset < args.count; offset += 1) {
        if (drafts.has(FIXTURE.draftContext(args.prefix, args.start + offset))) found += 1;
      }
      return { found, count: args.count, samples: Array.from({ length: args.count }, () => 0) };
    },
    cacheResumeEdit: async (args) => {
      const stored = drafts.get(args.identity.context);
      const sha256 = digestOf(args.size, args.seed);
      if (stored) {
        stored.revision = args.nextRevision;
        stored.parts = stored.parts.map((part) => (part.name === args.part ? { ...part, sha256 } : part));
      }
      return { nextHash: sha256, readHash: sha256, revision: args.nextRevision };
    },
    cacheExportPart: async (args) => {
      const part = drafts.get(args.identity.context)?.parts.find((candidate) => candidate.name === args.part);
      return part ? { digest: part.sha256, bytes: part.bytes } : { digest: null, bytes: 0 };
    },
    idbEstimate: async () => ({ usage: 0, quota: 1024 * 1024 * 1024 }),
    writeDraftPart: async (args) => ({ part: { name: args.name, kind: args.kind, bytes: args.size, sha256: digestOf(args.size, args.seed) }, ms: 0 }),
    commitDraftHeader: async (args) => {
      commit(args.identity, args.parts);
      return { revision: args.identity.revision, parts: args.parts, ms: 0 };
    },
    openTree: async () => ({ ok: true }),
    closeTree: async () => ({ ok: true }),
    // Controlled values: this regression grades the DRAFT and LOAD dimensions,
    // not the tree digests (which need the page-side folding of the seeded
    // composition and are covered by the tree rows' own unit tests above).
    enumerateTree: async (): Promise<TreeEnumeration> => ({
      worktrees: 200,
      worktreePages: 7,
      worktreeHash: 'controlled-worktree-digest',
      summaries: INTEGRATION_DRAFTS,
      summaryHash: 'controlled-summary-digest',
      categories: { opencode: 2001, codex: 2000, acp: 2000, kimiWeb: 2000, dsh: 2000 },
      groups: { globalRoots: 1001, codexThreads: 51, archived: 100, orphan: 10, child: 500 },
      distinctTimestamps: 1,
      worktreesWithSummaries: 200,
      maxSummariesPerWorktree: 60,
      enumerateMs: 1,
    }),
  };
  return { bridge, drafts, order };
};

/** The page/stack half of the double: a leg's closures run against `window.perf`. */
const createStack = (bridge: PerfBridge): PerfStack => {
  const evaluate = async <R>(fn: (argument?: unknown) => R | Promise<R>, argument?: unknown): Promise<R> => {
    const scope = globalThis as { window?: unknown };
    const previous = scope.window;
    scope.window = { perf: bridge };
    try {
      return await fn(argument);
    } finally {
      scope.window = previous;
    }
  };
  const page: PerfPage = {
    goto: async () => undefined,
    waitForFunction: async () => undefined,
    // The legs read `navigator.onLine` to record whether the offline emulation
    // took effect. Node exposes `navigator` as a getter-only global, so the double
    // defines it for the duration of the read and restores the original after.
    evaluate: async (fn) => {
      const scope = globalThis as { navigator?: unknown };
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
      try {
        return await fn();
      } finally {
        if (previous) Object.defineProperty(globalThis, 'navigator', previous);
        else delete (scope as { navigator?: unknown }).navigator;
      }
    },
  };
  return {
    origin: 'http://controlled.invalid',
    page,
    evaluate,
    collectHeap: async () => ({ usedSize: 0, totalSize: 0, sizeLimit: 0 }),
    measureRss: () => ({ rssBytes: 0, cpuJiffies: 0, processCount: 0 }),
    setNetwork: async () => undefined,
    log: () => undefined,
  };
};

describe('the load leg cannot pollute the plain draft coverage', () => {
  let draftsLeg: DraftsLegReport;
  let loadsLeg: LoadsLegReport;
  let coverage: CoverageReport;
  let committedContexts: string[];

  beforeAll(async () => {
    await mkdir(EVIDENCE_OUT, { recursive: true });
    const { bridge, order } = createBridge();
    const stack = createStack(bridge);
    // The driver's own order: drafts leg, then loads leg, then coverage. Both
    // legs write into the same in-memory header set, exactly as they write into
    // the same DraftStore IndexedDB in a real run.
    draftsLeg = await runDraftsLeg(stack, { count: INTEGRATION_DRAFTS, prefix: INTEGRATION_PREFIX, out: EVIDENCE_OUT });
    loadsLeg = await runLoadsLeg(stack, { prefix: loadDraftPrefix(INTEGRATION_PREFIX), out: EVIDENCE_OUT });
    coverage = await runCoverage(stack, { prefix: INTEGRATION_PREFIX, pins: INTEGRATION_PINS, drafts: INTEGRATION_DRAFTS });
    committedContexts = [...order];
  }, 120_000);

  afterAll(async () => {
    await rm(EVIDENCE_OUT, { recursive: true, force: true });
  });

  it('the run really is healthy: every 2KiB draft and every load part verified, offline and after a real restart', () => {
    expect(draftsLeg.import.count).toBe(INTEGRATION_DRAFTS);
    expect(draftsLeg.import.allMatch).toBe(true);
    expect(draftsLeg.offline.match).toBe(true);
    expect(draftsLeg.restart.match).toBe(true);
    expect(draftsLeg.resume.match).toBe(true);
    expect(draftsLeg.switch.found).toBeGreaterThanOrEqual(1);
    for (const profile of loadsLeg.profiles) {
      expect(profile.partsVerified).toBe(profile.partsExpected);
      expect(profile.allMatch).toBe(true);
      expect(profile.offlineRestartReadBack).toBe(profile.partsExpected);
    }
  });

  it('the load leg really did commit its headers into the SAME header set the coverage enumeration pages', () => {
    // Without this, the regression below could pass vacuously by the load leg
    // having written nothing at all. Derived from LOAD_PROFILES so the count can
    // never go stale when a profile is added — and zero committed headers fails.
    const expectedLoadHeaders = LOAD_PROFILES.reduce((total, profile) => total + profile.drafts, 0);
    const loadContexts = committedContexts.filter((context) => context.indexOf(`${INTEGRATION_PREFIX}-`) === 0 && plainDraftOrdinal(context, INTEGRATION_PREFIX) === null);
    expect(loadContexts).toHaveLength(expectedLoadHeaders);
    // Every one of them starts with the run prefix, i.e. every one of them would
    // have been swallowed by the old PREFIX-only filter.
    for (const context of loadContexts) expect(context.indexOf(`${INTEGRATION_PREFIX}-`)).toBe(0);
    // And they are exactly the contexts the load leg builds.
    for (const profile of LOAD_PROFILES) {
      for (let index = 0; index < profile.drafts; index += 1) {
        expect(committedContexts).toContain(loadDraftContext(loadDraftPrefix(INTEGRATION_PREFIX), profile.label, index));
      }
    }
  });

  it('a healthy run scores healthy: the plain coverage counts exactly the 2KiB drafts, never the load headers', () => {
    expect(coverage.drafts.visitedPrefix).toBe(INTEGRATION_DRAFTS);
    expect(coverage.drafts.expected).toBe(INTEGRATION_DRAFTS);
    expect(coverage.drafts.coveragePct).toBe(100);
  });

  it('the drafts coverage row passes on the REAL coverage the healthy run produced', () => {
    const table = evaluateThresholds('10k', false, GREEN_METRICS, coverage, draftsLeg, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, loadsLeg);
    const result = findRow(table, (candidate) => candidate.name.includes('drafts visited exactly once'));
    expect(result.measured).toBe(INTEGRATION_DRAFTS);
    expect(result.threshold).toBe(INTEGRATION_DRAFTS);
    expect(result.passed).toBe(true);
  });

  it('the load dimension is still fully graded — the fix moved its namespace, it did not hide it', () => {
    const table = evaluateThresholds('10k', false, GREEN_METRICS, coverage, draftsLeg, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, loadsLeg);
    for (const profile of LOAD_PROFILES) {
      const result = findRow(table, (candidate) => candidate.name.startsWith(`load coverage (${profile.label})`));
      expect(result.threshold).toBe(profile.drafts * profile.parts.length);
      expect(result.passed).toBe(true);
    }
  });

  it('the strict identity separates the two datasets in both directions', () => {
    for (let index = 0; index < INTEGRATION_DRAFTS; index += 1) {
      expect(plainDraftOrdinal(FIXTURE.draftContext(INTEGRATION_PREFIX, index), INTEGRATION_PREFIX)).toBe(index);
    }
    for (const profile of LOAD_PROFILES) {
      for (let index = 0; index < profile.drafts; index += 1) {
        expect(plainDraftOrdinal(loadDraftContext(loadDraftPrefix(INTEGRATION_PREFIX), profile.label, index), INTEGRATION_PREFIX)).toBeNull();
      }
    }
    // An unrelated namespace is not silently adopted either.
    expect(plainDraftOrdinal('perf-10k-load-000000', INTEGRATION_PREFIX)).toBeNull();
    expect(plainDraftOrdinal('perf-10k-abcdef', INTEGRATION_PREFIX)).toBeNull();
    expect(plainDraftOrdinal('other-10k-000000', INTEGRATION_PREFIX)).toBeNull();
    // The same separation holds at the 100k scale the stress profile runs, where
    // the old prefix-only filter produced 100009/100001.
    expect(plainDraftOrdinal(FIXTURE.draftContext('perf-100k', 100000), 'perf-100k')).toBe(100000);
    expect(plainDraftOrdinal(loadDraftContext(loadDraftPrefix('perf-100k'), LOAD_PROFILES[0].label, 0), 'perf-100k')).toBeNull();
    expect(plainDraftOrdinal(loadDraftContext(loadDraftPrefix('perf-100k'), LOAD_PROFILES[1].label, 3), 'perf-100k')).toBeNull();
  });
});
