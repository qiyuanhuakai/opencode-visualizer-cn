// TypeScript declarations for the runtime-v090 performance DRIVER.
//
// The module is plain ESM JavaScript executed by Node; it is intentionally NOT
// type-checked. These declarations exist so the gate-findings tests under app/**
// can import the REAL row builder — `evaluateThresholds` — together with the
// report shapes it consumes, and drive it with a lying leg or a lying coverage
// block, without `@ts-ignore`, `as any` or an implicit `any` anywhere.
//
// The report types live in ./runtime-v090-benchmark.d.mts, next to the code that
// produces them, and are re-exported here so a caller needs one import.

import type {
  LoadProfileReport,
  TreeCoverageReport,
} from './runtime-v090-benchmark.mjs';

export type {
  CoverageReport,
  DraftCoverageReport,
  DraftsLegReport,
  LoadProfile,
  LoadProfileReport,
  LoadsLegReport,
  TreeCoverageReport,
} from './runtime-v090-benchmark.mjs';

/** The dataset label a profile selects. */
export type DatasetLabel = '10k' | '100k';

/** One graded threshold row. `measured` is null when the dimension was never measured. */
export interface ThresholdRow {
  name: string;
  measured: number | null;
  threshold: number;
  unit: string;
  passed: boolean;
  compare: '<=' | '===' | '>=';
  note: string;
}

/**
 * The per-operation latency percentiles AND the per-operation success counts.
 * The counts are what stop a fast-but-failed operation from passing its row, so
 * they are part of the measured input rather than an afterthought.
 */
export interface MetricsReport {
  warmPinsP95: number | null;
  coldPinsP95: number | null;
  coldDraftsP95: number | null;
  selectedPageP95: number | null;
  openProbeP95: number | null;
  eventVisibleP95: number | null;
  openProbeFound: number;
  openProbeExpected: number;
  selectedPageDigests: number;
  selectedPageDigestsExpected: number;
  eventVisibleSeen: number;
  eventVisibleRuns: number;
}

/** The worktree-topology latency percentiles. */
export interface TreeMetricsReport {
  worktreeWarmP95: number | null;
  worktreeColdP95: number | null;
  worktreeNodeP95: number | null;
}

/**
 * The coverage projection `evaluateThresholds` grades: the exact visited count
 * and the independent digest guard for each dataset. `runCoverage`'s full report
 * satisfies it, and a test can build a minimal one without inventing the fields
 * the row builder never reads.
 */
export interface CoverageInput {
  pins: { visited: number; expected: number; coveragePct: number | null; hashMatch: boolean };
  drafts: { visitedPrefix: number; expected: number; coveragePct: number | null };
}

/** The drafts-leg projection the import and recovery rows grade. */
export interface DraftsLegInput {
  import: { count: number; allMatch: boolean; ledgerHash: string };
  offline: { match: boolean };
  restart: { match: boolean };
  resume: { match: boolean; revision: number };
  switch: { found: number };
}

/** The loads-leg projection the per-load-type rows grade. */
export interface LoadsLegInput {
  profiles: LoadProfileReport[];
}

/** The source-error leg: three distinct visible states, none masked as complete. */
export interface SourceErrorsReport {
  distinctVisibleStates: number;
  allDistinct: boolean;
}

/**
 * Map every approved SLO to a real measured p95 and a pass/fail.
 *
 * `coverage`, `draftsLeg`, `treeCoverage` and `loadsLeg` are nullable because a
 * dimension that was never measured must emit a FAILING row rather than silently
 * dropping out of the table. `treeMetrics` and `treeCoverage` are appended
 * parameters, so an existing 8-argument caller keeps working.
 */
export declare function evaluateThresholds(
  label: DatasetLabel,
  remote: boolean,
  metrics: MetricsReport,
  coverage: CoverageInput | null,
  draftsLeg: DraftsLegInput | null,
  sourceErrors: SourceErrorsReport | null,
  heapPeakBytes: number,
  rssAdditionalBytes: number,
  treeMetrics?: TreeMetricsReport | null,
  treeCoverage?: TreeCoverageReport | null,
  loadsLeg?: LoadsLegInput | null,
): ThresholdRow[];
