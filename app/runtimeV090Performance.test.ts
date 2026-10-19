// @vitest-environment node
// Task 50 / IS-2 — the performance SCORING must not pass a run whose operations
// actually failed. The review found that cacheOpenProbe records a duration even
// when it finds no draft, cacheExportBatch records a duration and a null digest
// after catching, and event-visible returns seen=false with a fast duration —
// while openProbeFound / selectedPageDigests / eventVisible.seen never entered
// any scoring condition, so a run passed on latency alone even when open/export
// failed or the event was invisible. These tests drive the REAL row builder with
// a failed-but-fast run and require every one of those rows to FAIL.
import { describe, expect, it } from 'vitest';
import { evaluateThresholds } from '../scripts/qa/runtime-v090-performance.mjs';
import { LOAD_PROFILES, RESTART_LEG_EXPECTED } from '../scripts/qa/runtime-v090-benchmark.mjs';

// A run whose LATENCIES are all fast (well inside every SLO) but whose
// OPERATIONS failed: no open probe found its draft, every export produced a null
// digest, and no event ever became visible.
const FAST_METRICS = {
  warmPinsP95: 10, coldPinsP95: 20, coldDraftsP95: 30, selectedPageP95: 40, openProbeP95: 5, eventVisibleP95: 7,
  openProbeFound: 0, openProbeExpected: 30,
  selectedPageDigests: 0, selectedPageDigestsExpected: 10,
  eventVisibleSeen: 0, eventVisibleRuns: 10,
  worktreeWarmP95: 10, worktreeColdP95: 20, worktreeNodeP95: 5,
};
const GREEN_METRICS = { ...FAST_METRICS, openProbeFound: 30, selectedPageDigests: 10, eventVisibleSeen: 10 };
const COVERAGE = {
  pins: { visited: 10000, expected: 10000, coveragePct: 100, hashMatch: true },
  drafts: { visitedPrefix: 10001, expected: 10001, coveragePct: 100 },
};
const DRAFTS_LEG = {
  import: { count: 10001, allMatch: true, ledgerHash: 'a'.repeat(64) },
  offline: { match: true }, resume: { match: true, revision: 2 }, switch: { found: 1 },
  restart: { match: true },
};
const SOURCE_ERRORS = { distinctVisibleStates: 3, allDistinct: true };
const TREE_COVERAGE = {
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
const TREE_METRICS = { worktreeWarmP95: 10, worktreeColdP95: 20, worktreeNodeP95: 5 };
const LOADS_LEG = {
  profiles: LOAD_PROFILES.map((profile) => ({
    label: profile.label,
    drafts: profile.drafts,
    partsVerified: profile.drafts * profile.parts.length,
    partsExpected: profile.drafts * profile.parts.length,
    allMatch: true,
    offlineRestartReadBack: profile.drafts * profile.parts.length,
  })),
};

const rows = (metrics, extra = {}) => evaluateThresholds('10k', false, metrics, COVERAGE, { ...DRAFTS_LEG, ...extra.draftsLeg }, SOURCE_ERRORS, 64 * 1024 * 1024, 16 * 1024 * 1024, TREE_METRICS, TREE_COVERAGE, extra.loadsLeg ?? LOADS_LEG);
const row = (rows_, name) => rows_.find((r) => r.name.includes(name));

describe('performance scoring cannot pass a failed operation', () => {
  it('a run whose open probes found NO draft fails the interaction row despite a fast p95', () => {
    const result = row(rows(FAST_METRICS), 'interaction (open draft handle)');
    expect(result).toBeDefined();
    expect(result.measured).toBeLessThanOrEqual(result.threshold);
    expect(result.passed).toBe(false);
  });

  it('a run whose exports all returned a null digest fails the selected-page row despite a fast p95', () => {
    const result = row(rows(FAST_METRICS), 'selected-page');
    expect(result.measured).toBeLessThanOrEqual(result.threshold);
    expect(result.passed).toBe(false);
  });

  it('a run whose event never became visible fails the event-visible row despite a fast p95', () => {
    const result = row(rows(FAST_METRICS), 'event-visible');
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
  const roundedDrafts = (visited) => {
    const expected = 100001;
    return { visitedPrefix: visited, expected, coveragePct: Math.round((visited / expected) * 10000) / 100 };
  };

  it('100000 of 100001 drafts visited (one missing, rounds to 100.00%) fails the drafts coverage row', () => {
    const coverage = { pins: { visited: 100000, expected: 100000, coveragePct: 100, hashMatch: true }, drafts: roundedDrafts(100000) };
    const result = evaluateThresholds('100k', false, GREEN_METRICS, coverage, DRAFTS_LEG, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, LOADS_LEG).find((r) => r.name.includes('drafts visited exactly once'));
    expect(result.measured).toBe(100000);
    expect(result.threshold).toBe(100001);
    expect(coverage.drafts.coveragePct).toBe(100);
    expect(result.passed).toBe(false);
  });

  it('99996 of 100001 drafts visited (five missing, rounds to 100.00%) fails the drafts coverage row', () => {
    const coverage = { pins: { visited: 100000, expected: 100000, coveragePct: 100, hashMatch: true }, drafts: roundedDrafts(99996) };
    const result = evaluateThresholds('100k', false, GREEN_METRICS, coverage, DRAFTS_LEG, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, LOADS_LEG).find((r) => r.name.includes('drafts visited exactly once'));
    expect(coverage.drafts.coveragePct).toBe(100);
    expect(result.passed).toBe(false);
  });

  it('the exact count passes the drafts coverage row', () => {
    const result = row(rows(GREEN_METRICS), 'drafts visited exactly once');
    expect(result.passed).toBe(true);
  });

  it('9999 of 10000 pins visited (rounds to 100.00%) fails the pins coverage row', () => {
    const coverage = { pins: { visited: 9999, expected: 10000, coveragePct: 100, hashMatch: false }, drafts: COVERAGE.drafts };
    const result = evaluateThresholds('10k', false, GREEN_METRICS, coverage, DRAFTS_LEG, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, LOADS_LEG).find((r) => r.name.includes('pins visited exactly once'));
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
    const degraded = { profiles: LOADS_LEG.profiles.map((profile, index) => (index === 0 ? { ...profile, partsVerified: profile.partsExpected - 1 } : profile)) };
    for (const profile of LOAD_PROFILES) {
      const result = row(rows(GREEN_METRICS, { loadsLeg: degraded }), `load coverage (${profile.label})`);
      expect(result).toBeDefined();
      expect(result.threshold).toBe(profile.drafts * profile.parts.length);
      expect(result.passed).toBe(profile.label !== LOAD_PROFILES[0].label);
    }
  });

  it('a failed offline restart read-back fails the load row even when every hash matched', () => {
    const degraded = { profiles: LOADS_LEG.profiles.map((profile) => ({ ...profile, offlineRestartReadBack: profile.partsExpected - 2 })) };
    for (const profile of LOAD_PROFILES) expect(row(rows(GREEN_METRICS, { loadsLeg: degraded }), `load coverage (${profile.label})`).passed).toBe(false);
  });

  it('a run that never measured the loads dimension cannot pass it', () => {
    const result = evaluateThresholds('10k', false, GREEN_METRICS, COVERAGE, DRAFTS_LEG, SOURCE_ERRORS, 1, 1, TREE_METRICS, TREE_COVERAGE, null).find((r) => r.name.startsWith('load coverage (large-body'));
    expect(result).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('the frozen load profiles carry both a large single body and multi-part attachments', () => {
    expect(LOAD_PROFILES.map((profile) => profile.label)).toEqual(['large-body', 'multi-part-attachment']);
    expect(LOAD_PROFILES[0].parts[0].size).toBeGreaterThan(256 * 1024);
    expect(LOAD_PROFILES[1].parts.filter((part) => part.kind === 'attachment').length).toBeGreaterThanOrEqual(2);
  });
});
