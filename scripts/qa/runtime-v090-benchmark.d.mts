// TypeScript declarations for the runtime-v090 performance CORE.
//
// The module itself is plain ESM JavaScript that Node executes against a real
// headless Chromium; it is intentionally NOT type-checked. These declarations
// exist so the gate-findings tests under app/** can import the REAL engine —
// the row builder, the leg orchestration and the frozen profiles — and drive it
// against controlled responses, without `@ts-ignore`, `as any` or an implicit
// `any` anywhere. Every shape below is the subset those tests actually observe;
// what they do not read is absent rather than loosened.

/** One part of a frozen load profile. `size` and `seed` are plan literals. */
export interface LoadProfilePart {
  readonly name: string;
  readonly kind: 'body' | 'attachment';
  readonly size: number;
  readonly seed: number;
}

/** One frozen load profile: how many drafts, and which parts each carries. */
export interface LoadProfile {
  readonly label: string;
  readonly drafts: number;
  readonly parts: readonly LoadProfilePart[];
}

/** The frozen recovery-leg count, including the REAL restart leg. */
export declare const RESTART_LEG_EXPECTED: number;

/** The load leg's namespace segment — a child of the run prefix. */
export declare const LOAD_NAMESPACE: string;

/** The prefix the load leg owns: `${prefix}-load`. */
export declare function loadDraftPrefix(prefix: string): string;

/** One load draft's context: `${prefix}-load-<label>-NNNNNN`. */
export declare function loadDraftContext(prefix: string, label: string, index: number): string;

/**
 * The STRICT identity of the plain 2KiB single-body-part drafts dataset: the
 * zero-based ordinal imported under `prefix`, or null when the context belongs
 * to another dataset (the load leg's, or an unknown one).
 */
export declare function plainDraftOrdinal(context: string, prefix: string): number | null;

/** Identity/draft fixtures — deterministic, byte-identical to the in-page bridge. */
export declare const FIXTURE: {
  readonly profileId: string;
  readonly environmentId: string;
  readonly clientOrigin: string;
  draftContext(prefix: string, index: number): string;
  draftIdentity(prefix: string, index: number): { context: string; clientOrigin: string; revision: number };
};

/** The frozen load profiles the load dimension must exercise. */
export declare const LOAD_PROFILES: readonly LoadProfile[];

// ---------------------------------------------------------------------------
// The measurement stack's contract. The real stack is Vite + Chromium + CDP;
// the tests substitute a controlled double that speaks the same shape, so the
// declarations describe the INTERFACE rather than the implementation.
// ---------------------------------------------------------------------------

/** CDP network emulation conditions. */
export interface NetworkConditions {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
}

/** One page of draft headers, as `DraftCache.pageHeaders` returns it. */
export interface HeaderPage {
  count: number;
  contexts: string[];
  next: string | null;
  usage: { residentBytes: number; reservedBytes: number; entries: number };
  ms: number;
}

/** One draft imported end-to-end, with both the stored and read-back digests. */
export interface ImportedDraft {
  index: number;
  storedSha256: string;
  readBackSha256: string;
  bytes: number;
  ms: number;
}

/** Opening `count` distinct draft handles, with the per-open latency array. */
export interface OpenProbe {
  found: number;
  count: number;
  samples: number[];
}

/** One exported draft part: the folded digest plus the byte count. */
export interface ExportPart {
  digest: string | null;
  bytes: number;
}

/** A resume-edit that replaced a segment at the next revision. */
export interface ResumeEdit {
  nextHash: string | null;
  readHash: string | null;
  revision: number;
}

/** A part streamed into the store, as `writePart` returns it. */
export interface WrittenPart {
  name: string;
  kind: string;
  bytes: number;
  sha256: string;
}

export interface WriteDraftPartResult {
  part: WrittenPart;
  ms: number;
}

export interface CommitDraftHeaderResult {
  revision: number;
  parts: WrittenPart[];
  ms: number;
}

export interface IdbEstimate {
  usage: number;
  quota: number;
}

/** The full pin-set enumeration, with the in-page folded digest. */
export interface PinEnumeration {
  count: number;
  pages: number;
  maxLedger: number;
  maxEntries: number;
  enumerateMs: number;
  hash: string;
}

/** The frozen tree generation input handed to the page. */
export interface TreeInput {
  seed: number;
  sources: readonly string[];
  worktrees: number;
  timestamp: string;
}

/** The seeded worktree/summary composition as the page enumerated it. */
export interface TreeEnumeration {
  worktrees: number;
  worktreePages: number;
  worktreeHash: string;
  summaries: number;
  summaryHash: string;
  categories: Record<string, number>;
  groups: Record<string, number>;
  distinctTimestamps: number;
  worktreesWithSummaries: number;
  maxSummariesPerWorktree: number;
  enumerateMs: number;
}

/** The plan-prescribed tree dimension as `runCoverage` grades it. */
export interface TreeCoverageReport {
  worktrees: {
    visited: number;
    expected: number;
    coveragePct: number;
    pages: number;
    hash?: string;
    expectedHash?: string;
    hashMatch: boolean;
  };
  summaries: {
    visited: number;
    expected: number;
    coveragePct: number | null;
    hash?: string;
    expectedHash?: string;
    hashMatch: boolean;
    categories: Record<string, number>;
    expectedCategories: Record<string, number>;
    groups: Record<string, number>;
    expectedGroups: Record<string, number>;
    distinctTimestamps: number;
    worktreesWithSummaries: number;
    maxSummariesPerWorktree: number;
  };
  enumerateMs: number;
}

/** A CDP heap snapshot after a forced collection. */
export interface HeapUsage {
  usedSize: number;
  totalSize: number;
  sizeLimit: number;
}

/** A /proc probe over the browser process tree. */
export interface RssUsage {
  rssBytes: number;
  cpuJiffies: number;
  processCount: number;
}

/** A draft identity as the in-page bridge receives it. */
export interface DraftIdentity {
  context: string;
  clientOrigin: string;
  revision: number;
}

/**
 * The JSON-safe primitive surface the in-page `window.perf` bridge exposes. A
 * leg's closures are evaluated against it, so a controlled double only has to
 * satisfy this shape.
 */
export interface PerfBridge {
  openPins(): Promise<unknown>;
  enumeratePins(profileId: string): Promise<PinEnumeration>;
  closePins(): Promise<unknown>;
  openDraftStore(): Promise<unknown>;
  closeDraftStore(): Promise<unknown>;
  openDraftCache(): Promise<unknown>;
  disposeCache(): Promise<unknown>;
  importDraftBatch(args: { prefix: string; start: number; count: number }): Promise<ImportedDraft[]>;
  cachePageHeaders(args: { limit: number; after?: string }): Promise<HeaderPage>;
  cacheOpenProbe(args: { prefix: string; start: number; count: number }): Promise<OpenProbe>;
  cacheResumeEdit(args: { identity: DraftIdentity; part: string; nextRevision: number; index: number; size: number; seed: number }): Promise<ResumeEdit>;
  cacheExportPart(args: { identity: DraftIdentity; part: string }): Promise<ExportPart>;
  idbEstimate(): Promise<IdbEstimate>;
  writeDraftPart(args: { identity: DraftIdentity; name: string; kind: string; size: number; seed: number }): Promise<WriteDraftPartResult>;
  commitDraftHeader(args: { identity: DraftIdentity; parts: WrittenPart[] }): Promise<CommitDraftHeaderResult>;
  openTree(): Promise<unknown>;
  closeTree(): Promise<unknown>;
  enumerateTree(input: TreeInput): Promise<TreeEnumeration>;
}

/** The page half of the stack. */
export interface PerfPage {
  goto(url: string, options?: { waitUntil?: 'networkidle' | 'domcontentloaded' }): Promise<unknown>;
  waitForFunction(fn: () => boolean): Promise<unknown>;
  evaluate(fn: () => unknown): Promise<unknown>;
}

/** The measurement stack a leg is driven through. */
export interface PerfStack {
  readonly origin: string;
  readonly page: PerfPage;
  evaluate<R>(fn: (argument?: unknown) => R | Promise<R>, argument?: unknown): Promise<R>;
  collectHeap(): Promise<HeapUsage>;
  measureRss(): RssUsage;
  setNetwork(conditions: NetworkConditions): Promise<void>;
  log(step: string, detail?: Record<string, unknown>): void;
}

/** What `runCoverage` reports for the plain-draft dataset. */
export interface DraftCoverageReport {
  visitedPrefix: number;
  expected: number;
  coveragePct: number | null;
  pages: number;
  maxLedger: number;
  maxEntries: number;
  enumerateMs: number;
}

/** What `runCoverage` reports overall. */
export interface CoverageReport {
  scenario: 'coverage';
  pins: {
    visited: number;
    expected: number;
    coveragePct: number | null;
    pages: number;
    maxLedger: number;
    maxEntries: number;
    enumerateMs: number;
    hash: string;
    expectedHash: string;
    expectedHashInKeyOrder: string;
    hashMatch: boolean;
  };
  drafts: DraftCoverageReport;
  tree: TreeCoverageReport;
  heap: HeapUsage;
  rss: RssUsage;
}

/** What `runDraftsLeg` reports for the import and recovery legs. */
export interface DraftsLegReport {
  scenario: 'drafts-leg';
  count: number;
  prefix: string;
  import: { count: number; allMatch: boolean; ledgerHash: string; importMsTotal: number; importMsPerDraft: number | null };
  loadWithDrafts: { headers: number; prefixHeaders: number; pages: number; maxLedger: number; maxEntries: number; loadMs: number; coveragePct: number | null };
  heapWithDrafts: HeapUsage;
  rssWithDrafts: RssUsage;
  idbBytesWithDrafts: number;
  switch: { found: number; count: number; samples: number[] };
  resume: ResumeEdit & { expected: string; match: boolean };
  offline: { online: boolean | undefined; digest: string | null; expected: string; match: boolean };
  restart: { online: boolean | undefined; digest: string | null; bytes: number; expected: string; match: boolean };
}

/** One load profile as `runLoadsLeg` reports it. */
export interface LoadProfileReport {
  label: string;
  partsVerified: number;
  partsExpected: number;
  allMatch: boolean;
  /** Display-only: the per-part import average the row's note reports. */
  importMsPerPart?: number | null;
  /** How many parts were read back byte-identical after the real restart. */
  offlineRestartReadBack?: number;
  /** The frozen parts this profile carries, when the reporter includes them. */
  parts?: { name: string; kind: string; size: number }[];
}

/** What `runLoadsLeg` reports. */
export interface LoadsLegReport {
  scenario: 'loads-leg';
  prefix: string;
  ledgerHash: string;
  restartOnline: boolean | undefined;
  profiles: LoadProfileReport[];
}

/** Options for `runDraftsLeg`. */
export interface RunDraftsLegOptions {
  count: number;
  prefix: string;
  out: string;
}

/** Options for `runLoadsLeg`. */
export interface RunLoadsLegOptions {
  prefix: string;
  out: string;
}

/** Options for `runCoverage`. */
export interface RunCoverageOptions {
  prefix: string;
  pins: number;
  drafts: number;
}

export declare function runDraftsLeg(stack: PerfStack, options: RunDraftsLegOptions): Promise<DraftsLegReport>;
export declare function runLoadsLeg(stack: PerfStack, options: RunLoadsLegOptions): Promise<LoadsLegReport>;
export declare function runCoverage(stack: PerfStack, options: RunCoverageOptions): Promise<CoverageReport>;
