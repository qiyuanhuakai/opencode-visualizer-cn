#!/usr/bin/env node
// Task 44 — runtime-v090 performance DRIVER.
//
// Registered profile invocations (plan vis-v090, task 44 Happy QA):
//   node scripts/qa/runtime-v090-performance.mjs --profile standard --runs 10 --out .omo/evidence/vis-v090/task-44/standard.json
//   node scripts/qa/runtime-v090-performance.mjs --profile stress             --out .omo/evidence/vis-v090/task-44/stress.json
//   node scripts/qa/runtime-v090-performance.mjs --profile network100ms       --out .omo/evidence/vis-v090/task-44/network100ms.json
//
// Each profile measures the REAL runtime store substrate against a REAL
// IndexedDB in a REAL headless Chromium via CDP + the OS, over `--runs`
// independent iterations, and reports every approved task-44 threshold as a
// nearest-rank p95 with a real measured number. No threshold is inferred; a
// miss is a bottleneck to fix, never a goalpost to move.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createStack,
  runBaseline,
  seedPins,
  runDraftsLeg,
  runLoadsLeg,
  runSubstrateSample,
  runCoverage,
  runSourceErrors,
  nearestRankP95,
  describeEnvironment,
  SLO,
  DATASET,
  TREE,
  LOAD_PROFILES,
  RESTART_LEG_EXPECTED,
} from './runtime-v090-benchmark.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const MiB = 1024 * 1024;

// Profile -> dataset + network shape. SLO thresholds are the frozen approved
// values; the profile only selects which dataset/network is exercised.
const PROFILES = {
  standard: { label: '10k', dataset: DATASET['10k'], pins: 10000, network: 'local', rtt: 0 },
  stress: { label: '100k', dataset: DATASET['100k'], pins: 100000, network: 'local', rtt: 0 },
  network100ms: { label: '10k', dataset: DATASET['10k'], pins: 10000, network: 'remote', rtt: 100 },
};

// The frozen draft count each dataset label MUST import — a LITERAL, never a value
// this driver just measured or requested (gate finding GATE-F3). These are the
// same literals the registered case's H4 grades from the landed reports:
// standard 10001, stress 100001, network100ms 10001.
const EXPECTED_DRAFTS = Object.freeze({ '10k': 10001, '100k': 100001 });

// The frozen recovery-leg count, including the REAL restart leg (destroy the
// store/cache and the page, rebuild, read back offline). The row used to be
// graded over three legs while its name promised four; the restart is now a
// graded condition of its own.
const RECOVERY_LEGS_EXPECTED = RESTART_LEG_EXPECTED;

// The profile's network shape, so the driver can RE-APPLY it before the formal
// sampling: runDraftsLeg resets the emulated network to unlimited at its end,
// which used to leave the network100ms profile's formal samples measuring an
// unlimited network while the report still labelled them 100ms-RTT.
const networkConditions = (profile) => (profile.network === 'remote'
  ? { offline: false, latency: profile.rtt, downloadThroughput: 20_000_000 / 8, uploadThroughput: 20_000_000 / 8 }
  : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

function parseArgs(argv) {
  const args = argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const profile = value('--profile');
  if (!profile || !PROFILES[profile]) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(' | ')}`);
  if (!args.includes('--out')) throw new Error('--out is required');
  const runs = value('--runs');
  return {
    profile,
    out: path.resolve(value('--out')),
    runs: runs ? Number(runs) : 10,
    remote: profile === 'network100ms',
  };
}

// Map each approved SLO name to a real measured p95 and a pass/fail. The measured
// value is a substrate analogue of the UI-tree metric (documented per row); the
// App.vue UI-tree render is integrated by a later task, so these grade the store
// substrate that backs it.
//
// Exported so the gate findings lane can drive the REAL row builder against a
// lying draftsLeg and prove the rows have teeth; the module's main guard below
// keeps importing it side-effect-free, exactly as runtime-v090-benchmark.mjs
// does for its own CLI.
//
// The trailing treeMetrics / treeCoverage parameters are the task-50 (IS-2)
// dimension: the plan-prescribed 200-worktree / five-category composition that
// the frozen DATASET always prescribed and that nothing seeded or graded before.
// They are appended, so an existing 8-argument caller keeps working.
export function evaluateThresholds(label, remote, metrics, coverage, draftsLeg, sourceErrors, heapPeakBytes, rssAdditionalBytes, treeMetrics = null, treeCoverage = null, loadsLeg = null) {
  const rows = [];
  const add = (name, measured, threshold, unit, note, also = true) => rows.push({ name, measured, threshold, unit, passed: measured != null && measured <= threshold && also, compare: '<=', note });
  const exact = (name, observed, expected, unit, note, also = true) => rows.push({ name, measured: observed, threshold: expected, unit, passed: observed === expected && also, compare: '===', note });
  const atLeast = (name, observed, floor, unit, note, also = true) => rows.push({ name, measured: observed, threshold: floor, unit, passed: observed != null && observed >= floor && also, compare: '>=', note });

  add('warm tree (warm re-page of the identity/draft set)', metrics.warmPinsP95, SLO.warmTreeMs, 'ms', 'substrate: warm store re-page p95');
  add('cold cached topology (cold first page)', metrics.coldPinsP95, SLO.coldCachedTopologyMs, 'ms', 'substrate: cold first page p95');
  add('first selectable (time to first page)', metrics.coldDraftsP95, SLO.firstSelectableMs, 'ms', 'substrate: cold first header page p95');
  // The three rows below grade a latency percentile AND that the operation
  // actually succeeded. The review found that cacheOpenProbe records a duration
  // even when it finds no draft, cacheExportBatch records a duration and a null
  // digest after catching, and event-visible returns seen=false with a fast
  // duration — while openProbeFound / selectedPageDigests / eventVisible.seen
  // never entered any scoring condition, so a run passed on latency alone even
  // when open/export failed or the event was invisible. The observed success
  // counts are now part of each row's pass condition AND part of its note, so a
  // failed operation fails the row instead of hiding behind a fast percentile.
  add('selected-page (open draft + read body page)', metrics.selectedPageP95, remote ? SLO.selectedPageMsRemote : SLO.selectedPageMsLocal, 'ms', `substrate: cacheOpen + exportPart p95 (${remote ? 'remote/100ms-RTT' : 'local'}); ${metrics.selectedPageDigests ?? 0}/${metrics.selectedPageDigestsExpected ?? 0} body exports returned a real digest — a fast export that read nothing cannot pass the row`, (metrics.selectedPageDigests ?? 0) === (metrics.selectedPageDigestsExpected ?? 0) && (metrics.selectedPageDigestsExpected ?? 0) > 0);
  add('index complete (full enumeration)', coverage ? coverage.pins.enumerateMs : null, remote ? SLO.indexCompleteMsRemote : SLO.indexCompleteMsLocal, 'ms', `substrate: full pin-set enumeration (${remote ? 'remote' : 'local'})`);
  add('interaction (open draft handle)', metrics.openProbeP95, SLO.interactionMs, 'ms', `substrate: cacheOpen p95; ${metrics.openProbeFound ?? 0}/${metrics.openProbeExpected ?? 0} probes found their draft handle — a fast probe that found no handle cannot pass the row`, (metrics.openProbeFound ?? 0) === (metrics.openProbeExpected ?? 0) && (metrics.openProbeExpected ?? 0) > 0);
  add('event-visible (commit -> header visible)', metrics.eventVisibleP95, SLO.eventVisibleMs, 'ms', `substrate: commit -> next page p95; ${metrics.eventVisibleSeen ?? 0}/${metrics.eventVisibleRuns ?? 0} runs actually saw the new header — an event that never became visible cannot pass the row on a fast page walk`, (metrics.eventVisibleSeen ?? 0) === (metrics.eventVisibleRuns ?? 0) && (metrics.eventVisibleRuns ?? 0) > 0);

  const heapMiB = heapPeakBytes == null ? null : Math.round((heapPeakBytes / MiB) * 100) / 100;
  const rssMiB = rssAdditionalBytes == null ? null : Math.round((rssAdditionalBytes / MiB) * 100) / 100;
  rows.push({ name: 'renderer heap peak (CDP collectGarbage)', measured: heapMiB, threshold: SLO.rendererHeapMiB[label], unit: 'MiB', passed: heapMiB != null && heapMiB <= SLO.rendererHeapMiB[label], note: 'CDP HeapProfiler.collectGarbage + Runtime.getHeapUsage; performance.memory cross-check' });
  rows.push({ name: 'bridge/renderer ADDITIONAL RSS peak (/proc, empty-renderer baseline subtracted)', measured: rssMiB, threshold: SLO.bridgeRssMiB[label], unit: 'MiB', passed: rssMiB != null && rssMiB <= SLO.bridgeRssMiB[label], note: '/proc VmRSS over the Vis-owned browser tree MINUS the empty-renderer baseline (Chromium base footprint excluded); native vis_bridge process is out of this browser harness scope (task 45/46)' });

  if (coverage) {
    // The exact visited count decides; the rounded percentage is display-only.
    // The drafts row used to read `coveragePct === 100`, and coveragePct is
    // rounded to two decimals, so at the 100k scale 99996/100001 (five draft
    // headers missing) rounds to 100.00 and still passed the row. The pins row
    // had the independent digest as its exact guard; it now carries the
    // explicit count too.
    rows.push({ name: 'complete coverage (pins visited exactly once)', measured: coverage.pins.visited, threshold: coverage.pins.expected, unit: 'pins', passed: coverage.pins.visited === coverage.pins.expected && coverage.pins.hashMatch === true, compare: '===', note: `visited ${coverage.pins.visited}/${coverage.pins.expected} exactly once; the EXACT count decides and the ${coverage.pins.coveragePct}% figure is display-only; independent digest match ${coverage.pins.hashMatch}` });
    rows.push({ name: 'complete coverage (drafts visited exactly once)', measured: coverage.drafts.visitedPrefix, threshold: coverage.drafts.expected, unit: 'draft headers', passed: coverage.drafts.visitedPrefix === coverage.drafts.expected && coverage.drafts.coveragePct === 100, compare: '===', note: `visited ${coverage.drafts.visitedPrefix}/${coverage.drafts.expected} 2KiB single-body-part draft headers exactly once; the EXACT count decides and the ${coverage.drafts.coveragePct}% figure is display-only (it is rounded to two decimals, so a rounded 100.00 is not a pass); large-body and attachment loads are graded by their own load rows below` });
  }
  if (draftsLeg) {
    // GATE-F3: the draft count is graded against the FROZEN literal for this
    // dataset label, never against the value this driver just measured. This row
    // used to read `measured: draftsLeg.import.count, threshold:
    // draftsLeg.import.count`, so `count <= count` could not fail — the exact
    // FLT-03 pattern (an expected block mirroring its own observation). The
    // allMatch companion predicate is KEPT, so the row is now gated twice.
    const expectedDrafts = EXPECTED_DRAFTS[label];
    rows.push({
      name: 'drafts imported one-by-one, every hash verified',
      measured: draftsLeg.import.count,
      threshold: expectedDrafts,
      unit: 'drafts',
      passed: draftsLeg.import.count === expectedDrafts && draftsLeg.import.allMatch === true,
      note: `the frozen ${label} dataset requires ${expectedDrafts} drafts imported one-by-one with every hash verified; imported ${draftsLeg.import.count}; ledgerHash ${draftsLeg.import.ledgerHash.slice(0, 16)}…; every stored+read-back sha256 equals the independent node oracle`,
    });
    // GATE-F3: the recovery row used to read `measured: 1, threshold: 1`, so
    // `1 <= 1` could not fail either. The measured value is the number of
    // recovery legs ACTUALLY proven, graded against the frozen expectation of
    // all of them, so a single failed leg fails the row instead of hiding
    // behind the companion predicates.
    // The restart is one of those legs now: the row was named
    // "offline/restart/switch/resume" while only three legs were proven — the
    // offline read-back ran with the store/cache still open and disposed only
    // AFTER the read, so no restart was ever executed. runDraftsLeg now
    // destroys the cache, the store and the page, rebuilds and reads back
    // offline, and this row grades that leg on its own.
    const recoveryLegs = [
      draftsLeg.offline.match === true,
      draftsLeg.restart.match === true,
      draftsLeg.resume.match === true,
      draftsLeg.switch.found >= 1,
    ];
    const recoveryLegsProven = recoveryLegs.filter(Boolean).length;
    rows.push({
      name: 'offline/restart/switch/resume hash stability WITH drafts',
      measured: recoveryLegsProven,
      threshold: RECOVERY_LEGS_EXPECTED,
      unit: 'legs',
      passed: recoveryLegsProven === RECOVERY_LEGS_EXPECTED,
      note: `offline ${draftsLeg.offline.match}; restart (cache+store+page destroyed, rebuilt, read back offline) ${draftsLeg.restart.match}; resume rev${draftsLeg.resume.revision} ${draftsLeg.resume.match}; switch found ${draftsLeg.switch.found} — ${recoveryLegsProven} of ${RECOVERY_LEGS_EXPECTED} recovery legs proven against the frozen expectation`,
    });
  }
  if (sourceErrors) {
    rows.push({ name: 'real source timeout/error/partial not masked (distinct visible states)', measured: sourceErrors.distinctVisibleStates, threshold: 3, unit: 'states', passed: sourceErrors.allDistinct === true, compare: '===', note: 'error=503, slow=timeout, partial=truncated body are three distinct observed states; none reported as complete' });
  }
  // ── the plan-prescribed tree composition (task 50, closes IS-2) ──────────────
  // Every measured value below is OBSERVED from the seeded composition in the
  // real Chromium/IndexedDB world; every threshold is a PLAN LITERAL from the
  // frozen generation input (seed090). No approved SLO is raised and no fixture
  // is deleted: these rows ADD the dimension the frozen DATASET `worktrees: 200`
  // always prescribed and that nothing measured before.
  //
  // The dimension can never pass by NOT being measured: a missing enumeration
  // or a missing latency pool emits a failing row instead of silently dropping
  // the dimension from the table.
  if (!treeCoverage) {
    rows.push({ name: 'plan-prescribed tree composition enumerated and graded (200 worktrees / five categories)', measured: null, threshold: TREE.input.worktrees, unit: 'worktrees', passed: false, compare: '===', note: 'the seeded composition was never enumerated in this run, so the IS-2 tree dimension is UNGRADED — a report that does not measure the dimension cannot pass it' });
  }
  if (treeCoverage) {
    const worktrees = treeCoverage.worktrees;
    const summaries = treeCoverage.summaries;
    const categories = summaries.categories ?? {};
    const observedCategories = Object.keys(categories).length;
    const categoriesMatching = Object.keys(summaries.expectedCategories ?? {}).filter((source) => categories[source] === summaries.expectedCategories[source]).length;
    const groups = summaries.groups ?? {};
    const expectedGroups = summaries.expectedGroups ?? {};
    const groupDimensions = TREE.groupsRequired.filter((name) => groups[name] === expectedGroups[name] && groups[name] > 0).length;
    exact('worktree topology seeded and enumerated exactly once (plan: 200 worktrees)', worktrees.visited, worktrees.expected, 'worktrees', `the seeded composition carries ${worktrees.visited} worktree records in ${worktrees.pages} page(s) (the last page is the terminating empty page); visited ${worktrees.visited}/${worktrees.expected} exactly once with coverage ${worktrees.coveragePct}% and the independent node-side digest over the same canonicalPath/commonDir/branch encoding matching (${worktrees.hashMatch})`, worktrees.hashMatch === true && worktrees.coveragePct === 100);
    exact('five-category composition (plan: summaries evenly split over five categories)', categoriesMatching, observedCategories, 'categories', `observed per-category summary counts ${JSON.stringify(categories)} against the plan derivation ${JSON.stringify(summaries.expectedCategories)}; ${categoriesMatching} of ${observedCategories} categories carry exactly the plan count`, observedCategories === TREE.input.sources.length);
    exact('summary composition enumerated exactly once (plan: one summary per dataset summary)', summaries.visited, summaries.expected, 'summaries', `visited ${summaries.visited}/${summaries.expected} seeded summaries exactly once with coverage ${summaries.coveragePct}% and the independent node-side digest over the same source/nativeSessionId/title/worktree/global/archived/parentId/updatedAt encoding matching (${summaries.hashMatch}); ${summaries.worktreesWithSummaries} of ${worktrees.expected} worktrees hold at least one summary, largest node ${summaries.maxSummariesPerWorktree} summaries`, summaries.hashMatch === true && summaries.coveragePct === 100);
    atLeast('Global roots in the seeded composition (plan: 1001+)', groups.globalRoots, TREE.globalRootsAtLeast, 'roots', `observed ${groups.globalRoots} Global roots against the plan derivation ${expectedGroups.globalRoots} (a Global root is the first category's session that is not a child)`, groups.globalRoots === expectedGroups.globalRoots);
    atLeast('Codex threads in the seeded composition (plan: 51+)', groups.codexThreads, TREE.codexThreadsAtLeast, 'threads', `observed ${groups.codexThreads} Codex threads against the plan derivation ${expectedGroups.codexThreads}`, groups.codexThreads === expectedGroups.codexThreads);
    exact('archive / orphan / child members present in the seeded composition (plan: all three)', groupDimensions, TREE.groupsRequired.length, 'groups', `observed archived ${groups.archived} (plan ${expectedGroups.archived}), orphan ${groups.orphan} (plan ${expectedGroups.orphan}), child ${groups.child} (plan ${expectedGroups.child}); an orphan is a summary with no worktree, so it is not reachable through the worktree index and is counted in the full enumeration`);
    exact('equal timestamps across the seeded composition (plan: one shared timestamp)', summaries.distinctTimestamps, TREE.distinctTimestampsExpected, 'timestamps', `observed ${summaries.distinctTimestamps} distinct updatedAt value(s) across ${summaries.visited} seeded summaries; the plan prescribes one shared timestamp`);
  }
  if (!treeMetrics) {
    rows.push({ name: 'plan-prescribed tree composition latency measured (warm tree / cold topology / node expansion)', measured: null, threshold: SLO.interactionMs, unit: 'ms', passed: false, compare: '<=', note: 'no worktree latency samples were pooled in this run, so the tree dimension carries no measured p95 — a report that does not measure the dimension cannot pass it' });
  }
  if (treeMetrics) {
    // These three grade the tree dimension against the SAME frozen SLO values the
    // plan approved for the tree metrics (warm tree 500ms, cold cached topology
    // 1000ms, interaction 100ms) — applied to the newly seeded surface, never
    // raised. The layer is stated per row: the composition lives in the
    // harness-owned vis-runtime-perf-tree store, because no browser-side product
    // store carries worktree topology in this substrate harness.
    add('warm tree (warm re-page of the 200-worktree topology)', treeMetrics.worktreeWarmP95, SLO.warmTreeMs, 'ms', 'composition store (harness-owned vis-runtime-perf-tree): warm re-page of the seeded 200-worktree topology p95');
    add('cold cached topology (cold first page of the 200-worktree topology)', treeMetrics.worktreeColdP95, SLO.coldCachedTopologyMs, 'ms', 'composition store (harness-owned vis-runtime-perf-tree): cold first page of the seeded 200-worktree topology p95');
    add('interaction (expand one worktree node)', treeMetrics.worktreeNodeP95, SLO.interactionMs, 'ms', 'composition store (harness-owned vis-runtime-perf-tree): page one worktree node summaries through the worktree index p95');
  }
  // ── the load dimension: large bodies and multi-part attachments ────────────
  // The task-44 draft leg only ever imported 2KiB single-`body`-part drafts, so
  // large content and attachments had no coverage at all. Each frozen
  // LOAD_PROFILES entry is graded on its own row: every part imported with its
  // stored AND read-back sha256 equal to the independent Node-side oracle, and
  // every part read back again after a REAL restart with the network cut.
  // A dimension that is not measured cannot pass — the row is emitted failing.
  for (const profile of LOAD_PROFILES) {
    const observed = loadsLeg?.profiles?.find((entry) => entry.label === profile.label) ?? null;
    const partsExpected = profile.drafts * profile.parts.length;
    if (!observed) {
      rows.push({ name: `load coverage (${profile.label}): every part imported, hash-verified and read back offline after a real restart`, measured: null, threshold: partsExpected, unit: 'parts', passed: false, compare: '===', note: `the ${profile.label} load (${profile.drafts} drafts x ${profile.parts.length} part(s): ${profile.parts.map((part) => `${part.name}/${part.kind}/${part.size}B`).join(', ')}) was never measured in this run, so the load dimension is UNGRADED — a report that does not measure a dimension cannot pass it` });
      continue;
    }
    rows.push({
      name: `load coverage (${profile.label}): every part imported, hash-verified and read back offline after a real restart`,
      measured: observed.partsVerified,
      threshold: partsExpected,
      unit: 'parts',
      passed: observed.partsVerified === partsExpected && observed.allMatch === true && observed.offlineRestartReadBack === partsExpected,
      compare: '===',
      note: `${observed.partsVerified}/${partsExpected} parts of the ${profile.label} load (${profile.drafts} drafts x ${profile.parts.length} part(s): ${profile.parts.map((part) => `${part.name}/${part.kind}/${part.size}B`).join(', ')}) matched the independent Node-side hash oracle on import, and ${observed.offlineRestartReadBack ?? 0}/${partsExpected} were read back byte-identical after the cache, store and page were destroyed and rebuilt with the network cut; import ${observed.importMsPerPart == null ? 'n/a' : `${Math.round(observed.importMsPerPart * 100) / 100}ms per part`}`,
    });
  }
  return rows;
}

async function run() {
  const { profile, out: outFile, runs, remote } = parseArgs(process.argv);
  const config = PROFILES[profile];
  // --out is the profile report JSON file; supporting evidence (lifecycle, draft
  // hash ledger, logs, CPU/bytes/db record, source-errors, raw samples) lands in
  // a per-profile directory under implementation/ so the three profiles never
  // clobber each other.
  const out = path.join(path.dirname(outFile), 'implementation', profile);
  await mkdir(out, { recursive: true });
  const logs = [];
  const log = (step, detail) => { const entry = { at: new Date().toISOString(), step, ...detail }; logs.push(entry); console.log(`[${entry.at}] ${step}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
  const prefix = `perf-${config.label}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const stack = await createStack({ out, log });
  const cpuBefore = stack.measureRss();
  let baseline; let coverage; let draftsLeg; let loadsLeg; let sourceErrors; let seeded;
  const samples = [];
  let bottleneck = null;
  let networkVerification = null;
  try {
    if (remote) {
      await stack.setNetwork(networkConditions(config));
      log('network-emulated', { rtt: config.rtt, mbps: 20 });
    }

    baseline = await runBaseline(stack);
    log('baseline-done', { firstScreenMs: baseline.firstScreenMs });

    const seedReceipt = await seedPins(stack, { pins: config.pins });
    seeded = seedReceipt;
    log('pins-seeded', { pins: config.pins, tree: { prescribed: seeded.tree.prescribed, seededWorktrees: seeded.tree.seededWorktrees, seededSummaries: seeded.tree.seededSummaries, seedMs: seeded.tree.seedMs, derivationAgreesWithFrozenFixtureOracle: seeded.tree.frozenOracleAgreement } });

    // Load-bearing drafts leg: import EVERY draft one-by-one with each hash
    // verified, then offline-restart / switch / resume WITH the drafts present.
    draftsLeg = await runDraftsLeg(stack, { count: config.dataset.drafts, prefix, out });
    log('drafts-leg-done', { count: draftsLeg.import.count, allMatch: draftsLeg.import.allMatch, offline: draftsLeg.offline.match, restart: draftsLeg.restart.match, resume: draftsLeg.resume.match });

    // Load-bearing loads leg: the large-body and multi-part-attachment
    // dimension the 2KiB single-part drafts leg never covered, graded on its
    // own rows with per-load-type reporting. Both recovery legs reset the
    // emulated network to unlimited at their end, so for a remote profile the
    // conditions are re-applied and VERIFIED after them with a real measured
    // round trip (an emulated RTT cannot be beaten) — that verification is the
    // state the formal samples below are actually taken under, and a failed
    // verification throws instead of silently labelling unlimited-network
    // samples as remote.
    loadsLeg = await runLoadsLeg(stack, { prefix: `${prefix}-load`, out });
    log('loads-leg-done', { profiles: loadsLeg.profiles.map((entry) => `${entry.label}:${entry.partsVerified}/${entry.partsExpected}`) });
    if (remote) {
      await stack.setNetwork(networkConditions(config));
      const observedRoundTripMs = await stack.measureRoundTripMs();
      networkVerification = { profile: config.network, configuredRttMs: config.rtt, observedRoundTripMs, verified: stack.verifyNetworkLatency(observedRoundTripMs, config.rtt), stage: 'after the drafts and loads legs, immediately before the formal sampling' };
      log('network-reasserted-before-sampling', networkVerification);
      if (!networkVerification.verified) throw new Error(`network verification failed: the emulated ${config.rtt}ms RTT was not in effect before the formal sampling (observed round trip ${observedRoundTripMs}ms) — refusing to label unlimited-network samples as ${config.network}`);
    }

    // Independent per-run latency samples (fast ops; the dataset is present).
    for (let iteration = 0; iteration < runs; iteration += 1) {
      const sample = await runSubstrateSample(stack, { prefix });
      sample.iteration = iteration;
      samples.push(sample);
      log('substrate-sample', { iteration, coldPinsMs: Math.round(sample.pins.coldFirstPageMs * 100) / 100, coldDraftsMs: Math.round(sample.drafts.coldFirstPageMs * 100) / 100, selectedMs: Math.round((sample.drafts.selectedPageSamples?.[0] ?? 0) * 100) / 100 });
    }

    coverage = await runCoverage(stack, { prefix, pins: config.pins, drafts: config.dataset.drafts });
    log('coverage-done', { pinCoveragePct: coverage.pins.coveragePct, draftCoveragePct: coverage.drafts.coveragePct, pinHashMatch: coverage.pins.hashMatch });

    sourceErrors = await runSourceErrors(stack, { out });
    log('source-errors-done', { distinct: sourceErrors.distinctVisibleStates });

    if (remote) await stack.setNetwork({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  } finally {
    const cpuAfter = stack.measureRss();
    bottleneck = { cpuBefore, cpuAfter };
    await stack.close();
  }

  // Aggregate per-op latency arrays across the runs and compute nearest-rank p95.
  const pool = (pick) => samples.flatMap((sample) => { const value = pick(sample); return Array.isArray(value) ? value : [value]; }).filter((value) => Number.isFinite(value));
  // The per-op SUCCESS counts behind those latencies. The review found that a
  // failed operation still recorded a duration (a probe that found no draft, an
  // export that returned a null digest after catching, an event that never
  // became visible), and none of these counts entered the scoring — so a run
  // passed on latency alone. They are aggregated here and graded by
  // evaluateThresholds next to each row's percentile.
  const openProbeFound = samples.reduce((sum, sample) => sum + (sample.drafts.openProbeFound ?? 0), 0);
  const openProbeExpected = samples.reduce((sum, sample) => sum + (sample.drafts.openProbeSamples?.length ?? 0), 0);
  const selectedPageDigests = samples.reduce((sum, sample) => sum + (sample.drafts.selectedPageDigests ?? []).filter((digest) => digest != null).length, 0);
  const selectedPageDigestsExpected = samples.reduce((sum, sample) => sum + (sample.drafts.selectedPageDigests ?? []).length, 0);
  const eventVisibleSeen = samples.filter((sample) => sample.drafts.eventVisible?.seen === true).length;
  const eventVisibleRuns = samples.filter((sample) => sample.drafts.eventVisible != null).length;
  const metrics = {
    coldPinsP95: nearestRankP95(samples.map((s) => s.pins.coldFirstPageMs)),
    warmPinsP95: nearestRankP95(pool((s) => s.pins.warmRepageSamples)),
    coldDraftsP95: nearestRankP95(samples.map((s) => s.drafts.coldFirstPageMs)),
    warmDraftsP95: nearestRankP95(pool((s) => s.drafts.warmRepageSamples)),
    openProbeP95: nearestRankP95(pool((s) => s.drafts.openProbeSamples)),
    selectedPageP95: nearestRankP95(pool((s) => s.drafts.selectedPageSamples)),
    eventVisibleP95: nearestRankP95(samples.map((s) => s.drafts.eventVisible?.ms).filter((v) => Number.isFinite(v))),
    eventVisibleSamples: samples.map((s) => s.drafts.eventVisible?.ms).filter((v) => Number.isFinite(v)),
    coldPinsSamples: samples.map((s) => s.pins.coldFirstPageMs),
    warmPinsSamples: pool((s) => s.pins.warmRepageSamples),
    coldDraftsSamples: samples.map((s) => s.drafts.coldFirstPageMs),
    warmDraftsSamples: pool((s) => s.drafts.warmRepageSamples),
    openProbeSamples: pool((s) => s.drafts.openProbeSamples),
    selectedPageSamples: pool((s) => s.drafts.selectedPageSamples),
    // The plan-prescribed tree composition (task 50): the 200-worktree topology
    // page, its warm re-pages and the per-worktree node expansions, pooled across
    // the runs so each percentile rests on a real sample count.
    worktreeColdP95: nearestRankP95(samples.map((s) => s.tree.worktreeColdFirstPageMs)),
    worktreeWarmP95: nearestRankP95(pool((s) => s.tree.worktreeWarmRepageSamples)),
    worktreeNodeP95: nearestRankP95(pool((s) => s.tree.worktreeNodeSamples)),
    worktreeColdSamples: samples.map((s) => s.tree.worktreeColdFirstPageMs),
    worktreeWarmSamples: pool((s) => s.tree.worktreeWarmRepageSamples),
    worktreeNodeSamples: pool((s) => s.tree.worktreeNodeSamples),
    worktreeNodeReturned: pool((s) => s.tree.worktreeNodeReturned),
    // The per-op success counts (see the aggregate above): a fast operation
    // that did not actually happen cannot pass its row.
    openProbeFound,
    openProbeExpected,
    selectedPageDigests,
    selectedPageDigestsExpected,
    eventVisibleSeen,
    eventVisibleRuns,
  };

  // Heap + RSS peaks across the runs, coverage and drafts leg.
  const heapPeakBytes = Math.max(
    ...samples.map((s) => s.heap.usedSize),
    coverage?.heap.usedSize ?? 0,
    draftsLeg?.heapWithDrafts.usedSize ?? 0,
  );
  const rssPeakBytes = Math.max(
    ...samples.map((s) => s.rss.rssBytes),
    coverage?.rss.rssBytes ?? 0,
    draftsLeg?.rssWithDrafts.rssBytes ?? 0,
  );
  const idbBytesPeak = Math.max(...samples.map((s) => s.idbBytes ?? 0), draftsLeg?.idbBytesWithDrafts ?? 0);
  // Bridge/renderer RSS: the plan measures ADDITIONAL RSS with the empty-renderer
  // baseline subtracted (Chromium's own base footprint is not "Vis").
  const baselineRssBytes = baseline?.rss?.rssBytes ?? 0;
  const rssAdditionalBytes = Math.max(0, rssPeakBytes - baselineRssBytes);
  // Longtask: sum the per-run long-task counts observed in the page (each run
  // starts a fresh page, so counts are per-run, not cumulative across runs).
  const longTaskTotal = samples.reduce((sum, s) => sum + (s.longTaskCount ?? 0), 0);
  const longTaskMaxPerRun = samples.reduce((max, s) => Math.max(max, s.longTaskCount ?? 0), 0);

  // The plan-prescribed tree composition observed by this run (task 50, IS-2).
  const treeCoverage = coverage?.tree ?? null;
  const thresholds = evaluateThresholds(config.label, remote, metrics, coverage, draftsLeg, sourceErrors, heapPeakBytes, rssAdditionalBytes, metrics, treeCoverage, loadsLeg);
  const allPassed = thresholds.every((row) => row.passed);

  // CPU% over the measured window from the /proc jiffy delta of the browser tree.
  const cpuWindow = bottleneck;
  const cpuDeltaJiffies = cpuWindow.cpuAfter.cpuJiffies - cpuWindow.cpuBefore.cpuJiffies;
  const elapsedSec = (Date.now() - startedMs) / 1000;
  const cpu = {
    method: '/proc utime+stime jiffy delta over the Vis-owned browser tree / wall-clock window',
    cpuDeltaJiffies,
    elapsedSec: Math.round(elapsedSec * 100) / 100,
    cpuPctOfOneCore: elapsedSec > 0 ? Math.round((cpuDeltaJiffies / 100 / elapsedSec) * 100) / 100 : null,
    processCountPeak: Math.max(cpuWindow.cpuBefore.processCount, cpuWindow.cpuAfter.processCount),
  };

  const report = {
    task: 44,
    profile,
    status: allPassed ? 'passed' : 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedSec: Math.round(elapsedSec * 100) / 100,
    environment: describeEnvironment(),
    invocation: process.argv,
    runs,
    remote,
    dataset: {
      label: config.label,
      summaries: config.dataset.summaries,
      drafts: config.dataset.drafts,
      pins: config.pins,
      // GATE-F4 → task 50 (IS-2): the plan-prescribed 200-worktree / five-category
      // composition is now SEEDED and GRADED with real observed numbers. Before,
      // this block read {prescribed: 200, seeded: 0, graded: false} with a note
      // admitting nothing seeded or graded the tree dimension while the frozen
      // export's `worktrees: 200` made the fixture look verified. Every number
      // below is OBSERVED in this run (real IndexedDB, real Chromium); every
      // threshold it is graded against is a plan literal. The frozen DATASET
      // export itself is untouched and still prescribes 200.
      worktrees: {
        prescribed: config.dataset.worktrees,
        seeded: treeCoverage?.worktrees?.visited ?? null,
        graded: treeCoverage != null,
        seed: TREE.input.seed,
        categories: TREE.input.sources,
        seedReceipt: {
          worktreesSeeded: seeded?.tree?.seededWorktrees ?? null,
          summariesSeeded: seeded?.tree?.seededSummaries ?? null,
          seedMs: seeded?.tree?.seedMs ?? null,
          derivationAgreesWithFrozenFixtureOracle: seeded?.tree?.frozenOracleAgreement ?? null,
        },
        observed: treeCoverage ? {
          worktreesEnumerated: treeCoverage.worktrees.visited,
          worktreePages: treeCoverage.worktrees.pages,
          worktreeCoveragePct: treeCoverage.worktrees.coveragePct,
          worktreeDigestMatch: treeCoverage.worktrees.hashMatch,
          summariesEnumerated: treeCoverage.summaries.visited,
          summaryCoveragePct: treeCoverage.summaries.coveragePct,
          summaryDigestMatch: treeCoverage.summaries.hashMatch,
          perCategorySummaries: treeCoverage.summaries.categories,
          groups: treeCoverage.summaries.groups,
          planGroups: treeCoverage.summaries.expectedGroups,
          distinctTimestamps: treeCoverage.summaries.distinctTimestamps,
          worktreesWithSummaries: treeCoverage.summaries.worktreesWithSummaries,
          maxSummariesPerWorktree: treeCoverage.summaries.maxSummariesPerWorktree,
          enumerateMs: treeCoverage.enumerateMs,
        } : null,
        latency: {
          worktreeColdFirstPageP95Ms: metrics.worktreeColdP95,
          worktreeWarmRepageP95Ms: metrics.worktreeWarmP95,
          worktreeNodeP95Ms: metrics.worktreeNodeP95,
          sampleCounts: {
            worktreeColdFirstPage: metrics.worktreeColdSamples.length,
            worktreeWarmRepage: metrics.worktreeWarmSamples.length,
            worktreeNode: metrics.worktreeNodeSamples.length,
          },
        },
        layer: TREE.note,
        note: `the plan fixture (vis-v090 verification strategy, performance profile) is 10k summaries evenly split over five categories / 200 worktrees with 1001+ Global roots, 51+ Codex threads, equal timestamps and archive/orphan/child members, seed ${TREE.input.seed}. This run seeds that composition into ${TREE.database} (stores worktrees + summaries) in the same real Chromium/IndexedDB world as the pin and draft substrate, keys the pin identity set by the same five-category composition, and grades every dimension against the plan literals above with the observed numbers in this block. The five UI-TREE render metrics remain graded at the substrate/store layer because the running app render is owned by the App.vue integration lane; the tree dimension here is the seeded composition itself, not a product module.`,
      },
    },
    slo: SLO,
    thresholds,
    allPassed,
    metrics,
    coverage,
    draftsLeg: draftsLeg ? {
      count: draftsLeg.import.count,
      allMatch: draftsLeg.import.allMatch,
      ledgerHash: draftsLeg.import.ledgerHash,
      importMsPerDraft: draftsLeg.import.importMsPerDraft,
      loadWithDrafts: draftsLeg.loadWithDrafts,
      heapWithDraftsMiB: Math.round((draftsLeg.heapWithDrafts.usedSize / MiB) * 100) / 100,
      rssWithDraftsMiB: Math.round((draftsLeg.rssWithDrafts.rssBytes / MiB) * 100) / 100,
      idbBytesWithDrafts: draftsLeg.idbBytesWithDrafts,
      switch: draftsLeg.switch,
      resume: draftsLeg.resume,
      offline: draftsLeg.offline,
    } : null,
    sourceErrors: sourceErrors ? { distinctVisibleStates: sourceErrors.distinctVisibleStates, allDistinct: sourceErrors.allDistinct, results: sourceErrors.results } : null,
    // The large-body / multi-part-attachment load dimension, reported per load
    // type and never pooled with the 2KiB single-part drafts above.
    loadsLeg: loadsLeg ? {
      ledgerHash: loadsLeg.ledgerHash,
      profiles: loadsLeg.profiles.map((entry) => ({
        label: entry.label,
        drafts: entry.drafts,
        parts: entry.parts,
        partsVerified: entry.partsVerified,
        partsExpected: entry.partsExpected,
        allMatch: entry.allMatch,
        offlineRestartReadBack: entry.offlineRestartReadBack,
        importMsPerPart: entry.importMsPerPart,
      })),
    } : null,
    // The observed network state the formal samples were taken under, measured
    // (not labelled): for a remote profile this is a real round-trip observation
    // proving the emulated RTT was in effect, recorded after the drafts and
    // loads legs reset it.
    networkVerification,
    baseline: baseline ? { firstScreenMs: baseline.firstScreenMs, heapMiB: Math.round((baseline.heap.usedSize / MiB) * 100) / 100, sourceState: baseline.sourceState } : null,
    os: {
      heapPeakMiB: Math.round((heapPeakBytes / MiB) * 100) / 100,
      rssPeakMiB: Math.round((rssPeakBytes / MiB) * 100) / 100,
      rssBaselineMiB: Math.round((baselineRssBytes / MiB) * 100) / 100,
      rssAdditionalMiB: Math.round((rssAdditionalBytes / MiB) * 100) / 100,
      // The RAW byte values behind the four rounded MiB figures above, so a consumer
      // can re-derive the deduction exactly instead of subtracting two already-rounded
      // display values (which can disagree by 0.01 MiB — the latent precision defect
      // the registered case's H6 hit on freshly measured data). Additive only: no
      // existing value moved.
      rssPeakBytes,
      rssBaselineBytes: baselineRssBytes,
      rssAdditionalBytes,
      idbBytesPeak,
      cpu,
      longTask: { total: longTaskTotal, maxPerRun: longTaskMaxPerRun, note: 'PerformanceObserver longtask entries per run (fresh page each run); raw samples carry the full per-run arrays' },
    },
    rawSampleCount: samples.length,
    // The sample count behind EVERY percentile in this report. Task 44's own
    // self-correction proved that a nearest-rank p95 over 10 samples IS the max,
    // so one GC pause reads as a bottleneck; the n behind each statistic is
    // therefore recorded here and the raw arrays are in metrics.*Samples plus
    // raw-samples.json.
    percentileSampleCounts: {
      rule: 'nearest-rank: ascending[ceil(p*n)-1]; n is the pooled real sample count, never a requested value',
      runs,
      coldPins: metrics.coldPinsSamples.length,
      warmPins: metrics.warmPinsSamples.length,
      coldDrafts: metrics.coldDraftsSamples.length,
      warmDrafts: metrics.warmDraftsSamples.length,
      openProbe: metrics.openProbeSamples.length,
      selectedPage: metrics.selectedPageSamples.length,
      eventVisible: metrics.eventVisibleSamples.length,
      worktreeColdFirstPage: metrics.worktreeColdSamples.length,
      worktreeWarmRepage: metrics.worktreeWarmSamples.length,
      worktreeNode: metrics.worktreeNodeSamples.length,
      longTaskTotal,
    },
    evidenceDir: out,
    evidence: {
      lifecycle: `${out}/lifecycle.json`,
      draftImportHashLedger: `${out}/draft-import-hash-ledger.json`,
      sourceErrors: `${out}/source-errors.json`,
      logs: `${out}/run-log.json`,
      cpuBytesDbLongtask: `${out}/cpu-bytes-db-longtask.json`,
      rawSamples: `${out}/raw-samples.json`,
    },
  };

  await writeFile(path.join(out, 'run-log.json'), json(logs));
  await writeFile(path.join(out, 'cpu-bytes-db-longtask.json'), json({ cpu, heapPeakMiB: report.os.heapPeakMiB, rssPeakMiB: report.os.rssPeakMiB, idbBytesPeak, baseline }));
  await writeFile(path.join(out, 'raw-samples.json'), json(samples));
  await writeFile(outFile, json(report));

  const failed = thresholds.filter((row) => !row.passed);
  console.log(`\n=== task-44 profile ${profile} (${config.label}, ${remote ? '100ms RTT' : 'local'}) — ${allPassed ? 'PASSED' : 'FAILED'} ===`);
  for (const row of thresholds) console.log(`  [${row.passed ? 'PASS' : 'FAIL'}] ${row.name}: ${row.measured} ${row.unit} (<= ${row.threshold}) — ${row.note}`);
  if (!allPassed) {
    console.log(`\n  ${failed.length} threshold(s) missed — bottleneck implicated, NOT a goalpost move.`);
    process.exitCode = 2;
  }
}

// Main guard, the same shape runtime-v090-benchmark.mjs uses: the registered
// invocations run this file directly, while an importer (the gate-findings probe
// that drives evaluateThresholds) gets the exports without a measurement run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
