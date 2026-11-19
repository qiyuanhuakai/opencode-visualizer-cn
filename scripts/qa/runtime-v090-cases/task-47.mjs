// Task 47 registered QA case: 更新v0.9版本、迁移文档和发布兼容说明 (plan task 47).
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt, re-hashes every pinned source and
// parses the written result. A task above 5 without a case module is refused by the runner, so
// loading this module is part of the contract.
//
// WHAT THIS CASE IS: task 47 is a DOCUMENTATION task, so its QA is a set of REAL CHECKERS driven
// over the real delivered bytes, plus real process spawns. Nothing here reads a manifest and
// trusts it; every claim the docs make is re-derived from the landed evidence or from the product
// modules themselves:
//
//   happy lane (what it PROVES about the delivered docs):
//     H1a package.json is 0.9.0-alpha, the lockfile specifiers match package.json, and a REAL
//         `pnpm install --lockfile-only` leaves pnpm-lock.yaml byte-identical.
//     H1b the documented bridge commands run in an ISOLATED fixture and print the release version.
//     H1c artifact-budget.json's entry-js cap is the frozen 2053120 and a REAL production build's
//         entry chunk is measured against it.
//     H2  link checker over every owned doc: every relative link resolves.
//     H3  the capability/version matrix in docs/runtime.md equals the MEASURED task-23 evidence
//         (per-source supported sets and both counts) and the version cells equal the code
//         constants (OPEN_CODE_VERSION, CODEX_PROFILE) and the measured backend docs.
//     H4  the performance table in docs/migration-v090.md equals the FROZEN task-44 report copies
//         this evidence directory carries (three profiles, every measured number re-compared, each
//         run's startedAt cited in the doc) AND states the measured configuration AND carries the
//         non-generalisation qualifier. Each frozen copy is cross-checked against the live task-44
//         report's contract (task, profile, runs, pass status, dataset, threshold names/thresholds/
//         units/flags), because the task-44 lane re-measures periodically and the measured values
//         legitimately drift between runs.
//     H5  the upgrade steps backup → bind → import → verify → cutover are complete and ordered.
//     H6  the five platform limitations are stated.
//     H7  the migration is described as in progress (task 48's legacy-routing retirement has
//         landed; App.vue not wired).
//     H8  the five backend-specific docs are preserved.
//     H9  the task states in docs/collaboration.md equal the REAL TASK_STATES imported from
//         shared/runtime/collaboration.js (the array parseTaskState enforces), so neither an
//         invented state nor a silently omitted real one survives in the doc.
//     H10 EVERY delivery-ladder sentence in the task-47 owned doc set — scanned by sentence shape
//         across all owned docs, at minimum docs/collaboration.md and CHANGELOG.md — equals the
//         REAL HANDOFF_LADDER imported from bridge/runtime/threads/handoffService.js. The doc-set
//         scan (not a one-file parse) is what lets the check see a wrong ladder in a file the
//         previous checker could not read: CHANGELOG.md's own copy of the ladder survived the
//         first fix round exactly because no checker scanned that file.
//     H11 every README/RoadMap/CHANGELOG sentence that names the plan-prescribed worktree count
//         also discloses that the composition is seeded and graded and keeps the store-substrate
//         measured configuration; the oracle is the frozen task-44 report dataset
//         {prescribed, seeded, graded} cross-checked against the frozen DATASET export and graded
//         against the plan literals, so the prescription is stated as what it really is. The
//         expectation INVERTED when task 50 seeded and graded the composition (the frozen reports
//         moved from seeded 0 / graded false to seeded 200 / graded true and the doc sentence that
//         said the composition was not seeded became false): the checker still derives its
//         expectation from the evidence and still scans the whole doc set by sentence shape, so
//         the false claim it now refuses is the not-seeded one.
//     H12 EVERY numeric-limit sentence in the task-47 owned doc set — scanned by sentence shape
//         across all owned docs — states exactly the constants IMPORTED from the product modules:
//         the tool/MCP evidence query paging (EVIDENCE_PAGE_BYTES / MAX_EVIDENCE_PAGE_BYTES, plus
//         the unpaged evidence reference list derived from the imported EVIDENCE_TOOLS schema), the
//         timeline item page (DEFAULT_TIMELINE_PAGE_LIMIT / MAX_TIMELINE_PAGE_LIMIT), the handoff
//         checkpoint budget (CHECKPOINT_MAX_BYTES / CHECKPOINT_MAX_ESTIMATED_TOKENS), the team
//         collaboration budgets (COLLABORATION_BUDGETS plus MAILBOX_LIMITS.maxMessageChars), the
//         artifact size budget (ARTIFACT_LIMITS.maxArtifactBytes) and the runtime protocol limits
//         (the nine-value LIMITS object); the inspect-state list of docs/runtime.md equals the
//         imported INSPECTION_STATES. This is the dimension no previous check read — H9 reads the
//         state list, H10 the ladder sentences, H11 the worktree-count sentences — so the bare
//         "页 100/max 200" evidence page policy the delivered collaboration.md once shipped, which
//         matches no product surface, passed every registered check until this lane.
//
//   failure lane (what it PROVES the checkers REJECT):
//     F1  a wrong version and a lockfile whose specifiers drifted from package.json.
//     F2  a tampered artifact, a size mismatch, and a missing digest, through the REAL verifyAsset
//         and sha256FromDigest product functions.
//     F3  a matrix row claiming a capability the measured evidence does not support, and a wrong
//         unsupported count.
//     F4  a new doc pointing at a wrong path.
//     F5  a miswritten performance number, a claim generalised across sources, and a dropped
//         store-substrate caveat.
//     F6  an upgrade path with the verify step removed.
//     F7  a platform limitation silently dropped.
//     F8  a doc claiming the migration is complete.
//     F9  the eight-state list the delivered doc once shipped reintroduced into a controlled copy
//         of docs/collaboration.md (invented states plus omitted real ones in one mutation), and
//         F9b the same checker rejecting a copy with a single real state swapped for an invented one.
//     F10 the five-rung ladder the delivered doc once shipped reintroduced, and F10b the same
//         checker rejecting a copy with a single real rung swapped for an invented one.
//     F10c the SAME invented ladder reintroduced into a controlled copy of CHANGELOG.md — the
//         fourth instance of the class, in the exact bare form that file once shipped — and F10d
//         the same checker rejecting that copy with a single real rung swapped for connecting.
//         Every ladder control normalises all OTHER owned-doc ladder sentences to the real ladder,
//         so each refusal deterministically names the sentence under test.
//     F11 the phantom unseeded worktree claim reintroduced by flipping the seeded-and-graded
//         disclosure of every naming sentence into a not-seeded claim — the exact shape the doc
//         set shipped before task 50 seeded the composition.
//     F12 the bare page policy "页 100/max 200" the delivered doc once shipped reintroduced into a
//         controlled copy of docs/collaboration.md (invented limits in one sentence), F12b the
//         same sentence with the single real timeline maximum 500 swapped for the phantom 200,
//         F12c a NEW wrong limit injected into a controlled copy of docs/runtime.md — a doc that
//         carried no numeric-limit sentence before the control — proving the scan is doc-set-wide,
//         F12d a wrong checkpoint budget in a controlled copy of CHANGELOG.md, F12e a wrong
//         protocol limit in a controlled copy of docs/migration-v090.md, and F12f an invented
//         inspect state in a controlled copy of docs/runtime.md. Every control leaves the other
//         owned docs at their delivered (real) bytes, so each refusal deterministically names the
//         sentence under test.
//
// THE CHECKER GAP THIS CASE CLOSED: the original lane set read migration-v090.md (H4) and resolved
// links (H2) but no checker read docs/collaboration.md's state machines or the README/RoadMap
// performance sentences, so three doc-text defects of exactly the "plausible but invented" class
// passed every registered check. H9/H10/H11 close that gap by importing the real constants and the
// real evidence oracles instead of comparing doc text against more doc text. H12 closes the last
// dimension of the same class: a bare numeric limit in doc prose has no marker at all, so H12
// deliberately scans every owned doc by sentence shape for numeric-limit claims about the known
// product surfaces and re-derives every stated number from the imported constants (plus the
// inspect-state list from INSPECTION_STATES) — the "页 100/max 200" defect survived the first gate,
// the first fix round, the checker-gap closure and the fourth-instance hunt because H9/H10/H11
// each read only their own dimension and nothing read a bare number.
//
// THE CONTROLLED BOUNDARY, stated rather than papered over:
//   * this case checks DOCS and VERSION/PACKAGING only. It does not run the product test suite,
//     drives no browser UI, performs no live SSH/Slurm run (task 46 owns it), builds no platform
//     installer (the only build is the repo's own Linux web production build), and authors NO
//     verdict about runtime behaviour beyond what the cited landed evidence already proved.
//   * the capability oracle is the LANDED task-23 evidence plus the code constants; the performance
//     oracle is the FROZEN task-44 report copies this evidence directory carries, each cross-checked
//     against the live task-44 report contract (the measurement lane re-runs periodically, so the
//     doc binds to a named run with its startedAt rather than chasing drifting live values). This
//     case re-derives the doc tables from those oracles; it does not re-measure runtime performance.
//   * every negative input is a controlled COPY built inside the case-owned run directory; no
//     delivered doc, package.json, lockfile, budget file or evidence file is modified.
//   * the five backend-specific docs are PRESERVED: hash-bound through sourceFiles and asserted to
//     exist, but their own pre-existing upstream-relative references are outside this case's link
//     scope, which is stated in the H2 surface.
//
// Process discipline: this module spawns exactly three kinds of child process, each with an
// explicit cwd: the bridge CLI in an isolated fixture, `pnpm install --lockfile-only`, and the
// artifact checker's real production build. Every temporary path is removed in the finally block.
// No git command is run by this module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';
import { verifyAsset } from '../../../electron/updateTransport.js';
import { sha256FromDigest } from '../../../electron/updatePolicy.js';
import { OPEN_CODE_VERSION } from '../../../shared/runtime/native/opencode/protocol.js';
import { CODEX_PROFILE } from '../../../shared/runtime/native/codex/capabilities.js';
import { TASK_STATES, COLLABORATION_BUDGETS } from '../../../shared/runtime/collaboration.js';
import { HANDOFF_LADDER } from '../../../bridge/runtime/threads/handoffService.js';
import { EVIDENCE_PAGE_BYTES, MAX_EVIDENCE_PAGE_BYTES, CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_ESTIMATED_TOKENS, EVIDENCE_TOOLS } from '../../../shared/runtime/context.js';
import { DEFAULT_TIMELINE_PAGE_LIMIT, MAX_TIMELINE_PAGE_LIMIT } from '../../../bridge/runtime/threads/timelineProjection.js';
import { MAILBOX_LIMITS } from '../../../bridge/runtime/collaboration/mailbox.js';
import { ARTIFACT_LIMITS } from '../../../bridge/runtime/collaboration/artifactStore.js';
import { LIMITS } from '../../../shared/runtime/protocol.js';
import { INSPECTION_STATES } from '../../../shared/runtime/harnessContract.js';
import { DATASET } from '../../../scripts/qa/runtime-v090-benchmark.mjs';

const TASK = 47;
const RELEASE_VERSION = '0.9.0-alpha';
const ENTRY_JS_CAP = 2053120;

/** The docs this task owns and the link-checker scope of H2. */
const OWNED_DOCS = Object.freeze([
  'README.md', 'RoadMap.md', 'CHANGELOG.md',
  'docs/runtime.md', 'docs/remote.md', 'docs/collaboration.md', 'docs/migration-v090.md',
  'docs/API.md', 'docs/projects.md', 'docs/testing.md', 'docs/desktop-integration.md',
]);
/** The five backend-specific docs: preserved, hash-bound, never edited by this task. */
const BACKEND_DOCS = Object.freeze(['docs/codex.md', 'docs/dsh.md', 'docs/kimi.md', 'docs/omo.md', 'docs/omp-rpc.md']);
/**
 * The product modules the state-machine checkers read at runtime. They are pinned through
 * sourceFiles so the evidence binds to the exact bytes the documented states were verified
 * against, and they are IMPORTED rather than copied so a product change moves the doc, this
 * checker and the delivered evidence together.
 */
const COLLABORATION_SOURCES = Object.freeze([
  'shared/runtime/collaboration.js',
  'bridge/runtime/threads/handoffService.js',
  'scripts/qa/runtime-v090-benchmark.mjs',
]);
/**
 * The product modules the bare numeric-limit checker reads at runtime, pinned through sourceFiles
 * exactly like COLLABORATION_SOURCES so the evidence binds to the bytes the documented limits were
 * verified against. Every expected number is IMPORTED from these modules; none is transcribed.
 */
const LIMIT_SOURCES = Object.freeze([
  'shared/runtime/context.js',
  'bridge/runtime/threads/timelineProjection.js',
  'bridge/runtime/collaboration/mailbox.js',
  'bridge/runtime/collaboration/artifactStore.js',
  'shared/runtime/protocol.js',
  'shared/runtime/harnessContract.js',
]);

export const sourceFiles = [...new Set([
  'package.json', 'pnpm-lock.yaml', 'artifact-budget.json',
  ...OWNED_DOCS, ...BACKEND_DOCS, ...COLLABORATION_SOURCES, ...LIMIT_SOURCES,
  '.omo/evidence/vis-v090/task-47/performance-reports/standard.json',
  '.omo/evidence/vis-v090/task-47/performance-reports/stress.json',
  '.omo/evidence/vis-v090/task-47/performance-reports/network100ms.json',
])];

/* ------------------------------------------------------------------ the real checkers */

/** Version checker: package.json must carry the release version. */
function checkVersion(packageText) {
  const pkg = JSON.parse(packageText);
  assert.equal(typeof pkg.version, 'string', 'package.json has no version');
  assert.equal(pkg.version, RELEASE_VERSION, `package.json version ${pkg.version} is not ${RELEASE_VERSION}`);
  return { version: pkg.version };
}

/**
 * Lockfile specifier checker: every dependency range package.json declares (dependencies,
 * devDependencies, optionalDependencies) must appear exactly as a specifier entry in the root
 * importer of pnpm-lock.yaml, with no extra entries. pnpm v9 lockfiles carry no root version, so
 * specifier parity plus a byte-identical `pnpm install --lockfile-only` is the sync proof.
 */
function checkLockfileSpecifiers(packageText, lockfileText) {
  assert.ok(lockfileText.includes("lockfileVersion: '9.0'"), 'pnpm-lock.yaml is not a v9 lockfile');
  const pkg = JSON.parse(packageText);
  const wanted = ['dependencies', 'devDependencies', 'optionalDependencies']
    .flatMap((field) => Object.entries(pkg[field] ?? {}));
  const specifiers = [...lockfileText.matchAll(/^ {8}specifier: (.+)$/gmu)].map((match) => match[1].trim());
  assert.equal(specifiers.length, wanted.length, `pnpm-lock.yaml root importer has ${specifiers.length} specifier entries, package.json declares ${wanted.length}`);
  const missing = wanted.filter(([, range]) => !specifiers.includes(range)).map(([name, range]) => `${name}@${range}`);
  assert.deepEqual(missing, [], `pnpm-lock.yaml is missing specifiers: ${missing.join(', ')}`);
  return { declared: wanted.length, specifiers: specifiers.length };
}

/**
 * Link checker. Walks the given markdown files, extracts every relative link target and resolves
 * it against the file's directory. External, mailto and pure-anchor links are skipped. Any
 * unresolved target is a refusal naming the file and the target.
 */
function checkLinks(root, files) {
  const broken = [];
  let links = 0;
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    const pattern = /\]\(([^)\s]+)\)/gu;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      links += 1;
      if (!existsSync(path.resolve(path.dirname(path.join(root, file)), clean))) broken.push({ file, target });
    }
  }
  assert.deepEqual(broken, [], `unresolved relative links: ${broken.map((entry) => `${entry.file} -> ${entry.target}`).join('; ')}`);
  return { files: files.length, links, broken: 0 };
}

/**
 * Capability/version matrix checker. Parses the per-source rows of docs/runtime.md and compares
 * them against the MEASURED task-23 evidence (the supported set and both counts) and against the
 * code constants / measured backend docs for the version cells. Returns both the doc-derived rows
 * and the independently evidence-derived expectation.
 */
function checkCapabilityMatrix(root, runtimeDocText, evidence) {
  const measured = new Map();
  for (const scenario of evidence.scenarios) {
    const found = /the (\S+) source resolves exactly its own declared native controls/u.exec(scenario.name);
    if (!found) continue;
    for (const assertion of scenario.assertions ?? []) {
      if (assertion.observed?.supported) measured.set(found[1], assertion.observed);
    }
  }
  assert.equal(measured.size, 5, `task-23 evidence carries ${measured.size} source rows, expected 5`);
  const nameOf = { OpenCode: 'opencode', Codex: 'codex', ACP: 'acp', 'Kimi Web': 'kimi-web', DSH: 'dsh' };
  const versionOf = { OpenCode: OPEN_CODE_VERSION, Codex: CODEX_PROFILE, ACP: 'v1', 'Kimi Web': '2.0.2', DSH: '0.2.0-rc.2' };
  const rows = {};
  for (const line of runtimeDocText.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    if (cells.length < 5 || !Object.hasOwn(nameOf, cells[0])) continue;
    const caps = /^(\d+)：(.+)$/u.exec(cells[2]);
    assert.ok(caps, `${cells[0]} row has no "count：names" capability cell`);
    rows[cells[0]] = {
      version: /`([^`]+)`/u.exec(cells[1])?.[1] ?? cells[1],
      supportedCount: Number(caps[1]),
      supported: caps[2].split('、').map((name) => name.trim()).filter(Boolean).sort(),
      unsupportedCount: Number(cells[3]),
    };
  }
  assert.deepEqual(Object.keys(rows).sort(), ['ACP', 'Codex', 'DSH', 'Kimi Web', 'OpenCode'], 'runtime.md matrix does not name the five sources');
  const expected = {};
  for (const [source, key] of Object.entries(nameOf)) {
    const observed = measured.get(key);
    const row = rows[source];
    assert.deepEqual(row.supported, [...observed.supported].sort(), `${source} capability set differs from the measured task-23 evidence`);
    assert.equal(row.supportedCount, observed.supportedCount, `${source} supported count differs from the measured evidence`);
    assert.equal(row.unsupportedCount, observed.unsupportedCount, `${source} unsupported count differs from the measured evidence`);
    assert.equal(row.version, versionOf[source], `${source} version cell ${row.version} is not the measured ${versionOf[source]}`);
    expected[source] = { version: versionOf[source], supportedCount: observed.supportedCount, unsupportedCount: observed.unsupportedCount };
  }
  assert.ok(readFileSync(path.join(root, 'docs/kimi-2.0.2.md'), 'utf8').includes('`2.0.2`'), 'the kimi-web measured version is not backed by docs/kimi-2.0.2.md');
  assert.ok(readFileSync(path.join(root, 'docs/dsh.md'), 'utf8').includes('0.2.0-rc.2'), 'the dsh measured version is not backed by docs/dsh.md');
  const summary = (table) => Object.fromEntries(Object.entries(table).map(([source, row]) => [source, { version: row.version, supportedCount: row.supportedCount, unsupportedCount: row.unsupportedCount }]));
  return { observed: summary(rows), expected: summary(expected) };
}

/**
 * Performance table checker. Parses the measured table of docs/migration-v090.md and re-compares
 * every number against the landed task-44 profile reports (rounded to two decimals; coverage rows
 * are compared against the report note), then requires the measured-configuration statements and
 * the non-generalisation qualifier.
 */
const PERFORMANCE_ROWS = Object.freeze([
  ['warm tree', 'warm tree'], ['cold cached topology', 'cold cached topology'],
  ['first selectable', 'first selectable'], ['selected-page', 'selected-page'],
  ['index complete', 'index complete'], ['interaction', 'interaction'],
  ['event-visible', 'event-visible'], ['renderer heap', 'renderer heap'],
  ['额外 RSS', 'bridge/renderer ADDITIONAL RSS'], ['pins 覆盖率', 'complete coverage (pins'],
]);
const CONFIG_STATEMENTS = Object.freeze([
  '真实 headless Chromium', '真实 IndexedDB', '无 store mock', '10 次独立运行', 'nearest-rank p95',
  '额外 RSS', '空 renderer 基线', 'store-substrate', '`App.vue` 尚未接入', '只对上述配置与数据集成立', '不得外推',
  // The dataset-composition disclosure (re-gate R1, re-bound by task 56): migration-v090.md's own
  // composition wording is the strongest form in the doc set, and H11's worktree-claim scan does not
  // read this file, so H4 guards the statement itself. The statement inverted when task 50 seeded
  // and graded the composition: it must now disclose the seeding instead of the former not-seeded
  // limitation. Pure addition: no control mutates this phrase.
  '已播种并已评分',
]);
const PROFILE_NAMES = Object.freeze(['standard', 'stress', 'network100ms']);
/**
 * Reads one of the FROZEN task-44 report copies this task's evidence directory carries. The doc's
 * performance table is bound to these copies (hash-bound through sourceFiles), because the task-44
 * measurement lane re-runs periodically and the live reports' measured values drift between runs;
 * binding to a named run with its startedAt keeps the doc traceable instead of chasing a moving
 * target. `crossCheckFrozenCopies` proves each copy is a genuine task-44 report of the live shape.
 */
function readProfile(root, profile) {
  const file = path.join(root, '.omo/evidence/vis-v090/task-47/performance-reports', `${profile}.json`);
  assert.ok(existsSync(file), `frozen task-44 report copy missing: ${file}`);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(report.task, 44, `${profile}.json is not a task-44 report`);
  assert.equal(report.profile, profile, `${profile}.json names another profile`);
  assert.equal(report.status, 'passed', `${profile}.json is not a passed report`);
  assert.equal(report.allPassed, true, `${profile}.json does not report allPassed`);
  assert.equal(report.runs, 10, `${profile}.json did not run 10 times`);
  return report;
}
/**
 * Proves each frozen copy is the same kind of artifact the live task-44 lane currently produces:
 * identical task, profile, run count, pass status, dataset, and an identical threshold CONTRACT
 * (names, thresholds, units, pass flags). The measured values are deliberately NOT compared, since
 * a re-measurement legitimately changes them.
 */
function crossCheckFrozenCopies(root, frozen) {
  for (const profile of PROFILE_NAMES) {
    const liveFile = path.join(root, '.omo/evidence/vis-v090/task-44', `${profile}.json`);
    assert.ok(existsSync(liveFile), `live task-44 report missing: ${liveFile}`);
    const live = JSON.parse(readFileSync(liveFile, 'utf8'));
    const copy = frozen[profile];
    for (const key of ['task', 'profile', 'status', 'allPassed', 'runs']) {
      assert.equal(copy[key], live[key], `frozen ${profile}.json ${key} ${copy[key]} differs from the live report ${live[key]}`);
    }
    assert.deepEqual(copy.dataset, live.dataset, `frozen ${profile}.json dataset differs from the live report`);
    const contract = (report) => report.thresholds.map((entry) => [entry.name, entry.threshold, entry.unit, entry.passed]);
    assert.deepEqual(contract(copy), contract(live), `frozen ${profile}.json threshold contract differs from the live report`);
    assert.ok(copy.thresholds.every((entry) => entry.passed), `frozen ${profile}.json has a failing threshold`);
  }
  return { profiles: PROFILE_NAMES.length, contractMatched: true };
}
function checkPerformanceTable(root, migrationDocText) {
  const profiles = PROFILE_NAMES.map((profile) => readProfile(root, profile));
  const table = migrationDocText.split('## 11. 性能数字的实测配置')[1] ?? '';
  assert.ok(table.length > 0, 'migration-v090.md has no performance section 11');
  let compared = 0;
  for (const line of table.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    if (cells.length < 4) continue;
    const row = PERFORMANCE_ROWS.find(([docLabel]) => cells[0].startsWith(docLabel));
    if (!row) continue;
    const [, reportPrefix] = row;
    const stated = /≤\s*([\d/]+)/u.exec(cells[0])?.[1];
    profiles.forEach((report, index) => {
      const threshold = report.thresholds.find((entry) => entry.name.startsWith(reportPrefix));
      assert.ok(threshold, `${report.profile} report has no row starting with ${reportPrefix}`);
      assert.ok(threshold.passed, `${report.profile} ${reportPrefix} did not pass`);
      if (stated) assert.ok(stated.includes(String(threshold.threshold)), `${cells[0]} states threshold ${stated} but ${report.profile} threshold is ${threshold.threshold}`);
      const cell = cells[index + 1];
      if (cell.includes('/')) {
        assert.ok(String(threshold.note).includes(cell), `${cells[0]} ${report.profile} cell ${cell} is not in the report note ${threshold.note}`);
      } else {
        const value = Number(cell.replace(/[^\d.]/gu, ''));
        assert.equal(value.toFixed(2), Number(threshold.measured).toFixed(2), `${cells[0]} ${report.profile} doc cell ${cell} != measured ${threshold.measured}`);
      }
      compared += 1;
    });
  }
  assert.equal(compared, PERFORMANCE_ROWS.length * 3, `performance table compared ${compared} cells, expected ${PERFORMANCE_ROWS.length * 3}`);
  return { cells: compared };
}
function checkPerformanceClaims(migrationDocText) {
  const missing = CONFIG_STATEMENTS.filter((statement) => !migrationDocText.includes(statement));
  assert.deepEqual(missing, [], `migration-v090.md is missing the measured-configuration statements: ${missing.join(', ')}`);
  return { statements: CONFIG_STATEMENTS.length };
}

/* ---------------------------------------------- the collaboration state machines and worktree claims */

/** The collaboration-doc section the task-state checker reads. */
const TASK_STATES_HEADING = '## 3. 任务与尝试';
const TASK_STATES_LABEL = 'docs/collaboration.md task states';
/**
 * The delivery-ladder sentence marker and the doc set the ladder scan walks. The scan is by SHAPE,
 * not by file name: every owned-doc line that writes a delivery-ladder sentence (the marker plus
 * an arrow-joined rung chain) is checked against the REAL HANDOFF_LADDER. This is the structural
 * fix for the class that produced a fourth instance after the first three were fixed: the old
 * checker parsed one section of one file, so CHANGELOG.md's own copy of the ladder — the same
 * invented rung and the same omitted rungs — passed every registered check.
 */
const DELIVERY_SENTENCE = /delivery\s*状态/u;
const DELIVERY_LADDER_DOCS = Object.freeze([...OWNED_DOCS]);
const DELIVERY_LABEL = 'the task-47 owned docs delivery ladder';
/** The docs that must keep carrying a ladder sentence: losing one is a loud failure, not a silent shrink of the scan. */
const DELIVERY_LADDER_CARRIERS = Object.freeze(['docs/collaboration.md', 'CHANGELOG.md']);
/**
 * Every doc whose sentences may name the plan-prescribed worktree count. CHANGELOG.md is checked
 * too because it already carries the correct disclosure: the check must guard the known-good form,
 * not only the two files that were wrong.
 */
const WORKTREE_CLAIM_DOCS = Object.freeze(['README.md', 'RoadMap.md', 'CHANGELOG.md']);
/**
 * The delivered migration-status statement. The doc moved from "迁移状态：进行中" to the more
 * precise "迁移状态：部分完成" when task 48 landed the legacy global-routing retirement: the
 * migration is still NOT complete (the completion-claim guard in checkMigrationInProgress is
 * unchanged and still refuses a completed claim), but part of it is done and the doc now says so.
 * The checker binds to the delivered literal, exactly like every other checker in this case binds
 * to the delivered bytes rather than to a remembered earlier phrasing.
 */
const MIGRATION_STATUS = '迁移状态：部分完成';
const SEEDED_AND_GRADED = /已播种并已评分|seeded and graded/iu;
const MEASURED_CONFIGURATION = /store-substrate/u;

/** One markdown section's body: from its heading up to the next `## ` heading. */
function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `docs/collaboration.md has no ${heading} section`);
  return text.slice(start + heading.length).split('\n## ')[0];
}

/** The single line inside a section that starts with the given prefix. */
function sectionLine(text, heading, prefix) {
  const line = sectionBody(text, heading).split('\n').find((entry) => entry.startsWith(prefix));
  assert.ok(line, `${heading} has no "${prefix}" line`);
  return line;
}

/** The backticked inline list of a doc line, split into trimmed tokens. */
function inlineList(line) {
  const quoted = /`([^`]+)`/u.exec(line);
  assert.ok(quoted, `no backticked list in: ${line}`);
  return quoted[1].split(/\s*[/→]\s*/u).map((token) => token.trim()).filter(Boolean);
}

/** Rebuilds a doc line's backticked list with a controlled list, keeping the line's own separator. */
function withInlineList(line, list) {
  const separator = line.includes('→') ? ' → ' : ' / ';
  return line.replace(/`([^`]+)`/u, `\`${list.join(separator)}\``);
}

/** The refusal text shared by a list checker and its own negative control, so both stay in step. */
function listMismatch(label, observed, expected) {
  const invented = observed.filter((value) => !expected.includes(value));
  const omitted = expected.filter((value) => !observed.includes(value));
  return `${label} ${JSON.stringify(observed)} != ${JSON.stringify([...expected])} (invented ${JSON.stringify(invented)}, omitted ${JSON.stringify(omitted)})`;
}

/**
 * Task-state checker. The states docs/collaboration.md documents must equal the REAL TASK_STATES
 * exported by shared/runtime/collaboration.js, the array parseTaskState enforces with
 * invalid_request/task_state. The constant is imported, never transcribed, so neither a plausible
 * invented state nor a silently omitted real one can survive in the doc.
 */
function checkTaskStates(docText) {
  const states = inlineList(sectionLine(docText, TASK_STATES_HEADING, '- 状态：'));
  assert.deepEqual(states, [...TASK_STATES], listMismatch(TASK_STATES_LABEL, states, TASK_STATES));
  return { states };
}

/**
 * The arrow-joined rung chain of a delivery-ladder sentence: the run of lowercase tokens joined by
 * the doc's own arrow separator, read AFTER the marker so a chain elsewhere on the line cannot be
 * mistaken for the ladder. Both delivered forms parse — the backticked spaced form of
 * docs/collaboration.md (`checkpoint → attached → ...`) and the bare form CHANGELOG.md once
 * shipped (`prepared→connecting→...`). The chain pattern deliberately accepts ANY lowercase token,
 * so an invented rung is SEEN and rejected instead of silently skipping the sentence.
 */
function deliveryLadderOf(line) {
  const marked = DELIVERY_SENTENCE.exec(line);
  assert.ok(marked, `no delivery-ladder marker in: ${line}`);
  const chain = /[a-z]+(?:\s*[→/]\s*[a-z]+)+/u.exec(line.slice(marked.index + marked[0].length));
  assert.ok(chain, `no arrow-joined ladder after the marker in: ${line}`);
  return chain[0].split(/\s*[→/]\s*/u).map((token) => token.trim()).filter(Boolean);
}

/** The delivery-ladder clause of a line: from the marker through the end of its rung chain. */
function deliveryClause(line) {
  const marked = DELIVERY_SENTENCE.exec(line);
  const rest = line.slice(marked.index + marked[0].length);
  const chain = /[a-z]+(?:\s*[→/]\s*[a-z]+)+/u.exec(rest);
  return line.slice(marked.index, marked.index + marked[0].length + chain.index + chain[0].length);
}

/** Rewrites a line's rung chain with a controlled ladder, keeping the line's own separator spacing. */
function withDeliveryLadder(line, ladder) {
  const marked = DELIVERY_SENTENCE.exec(line);
  const rest = line.slice(marked.index + marked[0].length);
  const chain = /[a-z]+(?:\s*[→/]\s*[a-z]+)+/u.exec(rest);
  const separator = chain[0].includes(' ') ? ' → ' : '→';
  const head = line.slice(0, marked.index + marked[0].length + chain.index);
  const tail = line.slice(marked.index + marked[0].length + chain.index + chain[0].length);
  return `${head}${ladder.join(separator)}${tail}`;
}

/**
 * Collects every delivery-ladder sentence of the owned doc set (controlled copies through
 * `overrides`, exactly like the worktree-claim checker), without asserting, so a negative control
 * derives its expected refusal text from the same collection the checker will make.
 */
function deliveryLadders(root, overrides) {
  const read = (file) => (overrides && Object.hasOwn(overrides, file) ? overrides[file] : readFileSync(path.join(root, file), 'utf8'));
  const sentences = [];
  for (const file of DELIVERY_LADDER_DOCS) {
    read(file).split('\n').forEach((line, index) => {
      if (!DELIVERY_SENTENCE.test(line)) return;
      sentences.push({ file, line: index + 1, ladder: deliveryLadderOf(line) });
    });
  }
  const files = [...new Set(sentences.map((entry) => entry.file))].sort();
  const offending = sentences
    .filter((entry) => entry.ladder.join(' ') !== HANDOFF_LADDER.join(' '))
    .map((entry) => `${entry.file}:${entry.line}`);
  return { docs: DELIVERY_LADDER_DOCS.length, files, sentences: sentences.length, ladders: sentences.map((entry) => [entry.file, entry.line, entry.ladder]), offending };
}

/**
 * Builds a controlled override set in which EVERY delivery-ladder sentence of the owned doc set
 * carries the REAL ladder except the sentences of `target` (null = every sentence), which carry
 * `ladder`. The control is therefore deterministic whatever the delivered bytes currently say: the
 * only possible refusal names the sentence under test, in RED and in GREEN alike.
 */
function deliveryLadderControl(root, target, ladder) {
  const overrides = {};
  for (const file of DELIVERY_LADDER_DOCS) {
    const text = readFileSync(path.join(root, file), 'utf8');
    if (!DELIVERY_SENTENCE.test(text)) continue;
    overrides[file] = text.split('\n')
      .map((line) => (DELIVERY_SENTENCE.test(line) ? withDeliveryLadder(line, file === target ? ladder : [...HANDOFF_LADDER]) : line))
      .join('\n');
  }
  return overrides;
}

/**
 * Delivery-ladder checker. EVERY delivery-ladder sentence the owned doc set carries must equal the
 * REAL HANDOFF_LADDER exported by bridge/runtime/threads/handoffService.js, whose rungs the
 * service itself walks (RUNG_PREDECESSOR maps each verb to its predecessor rung). The constant is
 * imported, never transcribed, and the whole owned doc set is scanned by sentence shape, so
 * neither an invented rung nor a silently omitted one survives in ANY owned doc — the
 * collaboration.md-only parse is what let CHANGELOG.md's identical defect ship.
 */
function checkDeliveryLadders(root, overrides) {
  const report = deliveryLadders(root, overrides);
  const missing = DELIVERY_LADDER_CARRIERS.filter((file) => !report.files.includes(file));
  assert.deepEqual(missing, [], `no delivery-ladder sentence found in: ${missing.join(', ')}`);
  for (const [file, line, ladder] of report.ladders) {
    assert.deepEqual(ladder, [...HANDOFF_LADDER], listMismatch(`${DELIVERY_LABEL} at ${file}:${line}`, ladder, HANDOFF_LADDER));
  }
  return { ...report, offending: report.offending.length };
}

/** The refusal text shared by the worktree-claim checker and its own negative control. */
function worktreeRefusal(prescribed, offending) {
  return `a sentence names ${prescribed} worktrees without the seeded-and-graded disclosure and the store-substrate measured configuration at ${offending.join(', ')}`;
}

/**
 * Worktree-claim checker. Every README/RoadMap/CHANGELOG sentence that names the plan-prescribed
 * worktree count must ALSO disclose that the composition is seeded and graded and must keep the
 * store-substrate measured configuration. The oracle is the real evidence, not the doc text: the
 * frozen task-44 reports carry dataset.worktrees {prescribed, seeded, graded}, and `prescribed` is
 * cross-checked against the frozen DATASET export, so a sentence that names the count without the
 * disclosure is exactly the phantom claim. The expectation INVERTED when task 50 seeded and graded
 * the composition: the frozen reports moved from seeded 0 / graded false to seeded 200 / graded
 * true and the doc-set sentence that said the composition was not seeded became false, so the
 * checker now refuses the not-seeded claim instead of the seeded one. The structure is unchanged —
 * the same doc-set-wide scan by sentence shape, the same prescribed-vs-frozen-export cross-check,
 * the same store-substrate requirement — only the evidence-derived expectation follows the
 * evidence, which is what this checker was built to do.
 */
function worktreeClaims(root, overrides) {
  const read = (file) => (overrides && Object.hasOwn(overrides, file) ? overrides[file] : readFileSync(path.join(root, file), 'utf8'));
  const sentences = [];
  const offending = [];
  for (const file of WORKTREE_CLAIM_DOCS) {
    read(file).split('\n').forEach((line, index) => {
      if (!new RegExp(`${DATASET['10k'].worktrees}\\s*worktrees?`, 'iu').test(line)) return;
      const entry = {
        file, line: index + 1, namesWorktreeCount: true,
        disclosesSeededAndGraded: SEEDED_AND_GRADED.test(line),
        keepsMeasuredConfiguration: MEASURED_CONFIGURATION.test(line),
      };
      sentences.push(entry);
      if (!entry.disclosesSeededAndGraded || !entry.keepsMeasuredConfiguration) offending.push(`${file}:${index + 1}`);
    });
  }
  return { sentences, offending };
}
function checkWorktreeClaims(root, reports, overrides) {
  for (const report of reports) {
    const prescribed = DATASET[report.dataset.label].worktrees;
    const worktrees = report.dataset.worktrees;
    const observed = worktrees.observed;
    assert.equal(worktrees.prescribed, prescribed, `the frozen ${report.profile} report prescribes ${worktrees.prescribed} worktrees but the frozen DATASET export prescribes ${prescribed}`);
    assert.equal(worktrees.seeded, prescribed, `the frozen ${report.profile} report claims ${worktrees.seeded} seeded worktrees but the plan prescribes ${prescribed}`);
    assert.equal(worktrees.graded, true, `the frozen ${report.profile} report claims worktrees are not graded`);
    // The oracle is the EVIDENCE, so it is not enough that the report SAYS seeded: the seeded
    // composition must really have been enumerated and graded against the plan literals.
    assert.equal(observed.worktreesEnumerated, prescribed, `the frozen ${report.profile} report enumerated ${observed.worktreesEnumerated} worktrees`);
    assert.equal(observed.worktreeCoveragePct, 100, `the frozen ${report.profile} report covered ${observed.worktreeCoveragePct}% of the seeded worktrees`);
    assert.equal(observed.worktreeDigestMatch, true, `the frozen ${report.profile} report worktree digest did not match`);
    assert.equal(observed.summariesEnumerated, report.dataset.summaries, `the frozen ${report.profile} report enumerated ${observed.summariesEnumerated} summaries`);
    assert.equal(observed.summaryCoveragePct, 100, `the frozen ${report.profile} report covered ${observed.summaryCoveragePct}% of the seeded summaries`);
    assert.equal(observed.summaryDigestMatch, true, `the frozen ${report.profile} report summary digest did not match`);
    assert.equal(observed.distinctTimestamps, 1, `the frozen ${report.profile} report seeded ${observed.distinctTimestamps} distinct timestamps`);
  }
  const { sentences, offending } = worktreeClaims(root, overrides);
  assert.ok(sentences.length >= WORKTREE_CLAIM_DOCS.length, `only ${sentences.length} sentence names the prescribed worktree count, expected at least one per owned doc`);
  assert.deepEqual(offending, [], worktreeRefusal(DATASET['10k'].worktrees, offending));
  return { sentences: sentences.length, prescribed: DATASET['10k'].worktrees, seeded: DATASET['10k'].worktrees, graded: true, offending: offending.length };
}

/* ---------------------------------------------- the bare numeric limits in doc prose */

/**
 * The doc set the bare-limit scan walks. The scan is by SHAPE, not by file name: every line of
 * every owned doc that states a limit about one of the known surfaces is collected and re-derived,
 * exactly like the delivery-ladder scan. The structural lesson of this defect class is that each
 * instance lived in a dimension the previous checker did not read, so the scan must be doc-set-wide.
 */
const NUMERIC_LIMIT_DOCS = Object.freeze([...OWNED_DOCS]);
const NUMERIC_LIMIT_LABEL = 'the task-47 owned docs numeric limit';
/** The small counts the docs spell out as Chinese numerals in prose. */
const CHINESE_NUMERALS = Object.freeze({ 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十' });
/** The inspect-state sentence marker of docs/runtime.md and its label. */
const INSPECT_STATES_ANCHOR = /inspect[`\s]*返回/u;
const INSPECT_STATES_LABEL = 'the task-47 owned docs inspect state list';

/**
 * The numeric-limit surfaces the owned docs assert. Each anchor is a NUMBER-AGNOSTIC sentence
 * shape (the subject plus a limit word, never an expected digit), and every expected value is an
 * imported constant, so a product change moves the doc, this checker and the delivered evidence
 * together. `required` is the set of numbers a claiming sentence must state somewhere across the
 * surface's sentences, and the only set of numbers such a sentence may state at all.
 */
const LIMIT_SURFACES = Object.freeze([
  {
    label: 'the tool/MCP evidence query paging',
    anchor: /证据查询|evidence query/iu,
    required: [EVIDENCE_PAGE_BYTES, MAX_EVIDENCE_PAGE_BYTES],
    // The evidence reference list is UNPAGED in the product (no limit parameter in the imported
    // schema), so the sentence must state that property alongside the byte page.
    unpaged: /不分页|无分页|不限制|no paging|unpaged/iu,
  },
  {
    label: 'the timeline item page',
    anchor: /timeline\s*条目页|timeline\s*page|timeline[^。\n]{0,12}(?:页|分页|limit)/iu,
    required: [DEFAULT_TIMELINE_PAGE_LIMIT, MAX_TIMELINE_PAGE_LIMIT],
  },
  {
    label: 'the handoff checkpoint budget',
    anchor: /checkpoint[^。\n]{0,80}(?:最多|默认|上限|最大|预算|KiB|MiB|字节|token|bytes)|(?:最多|默认|上限|最大|预算)[^。\n]{0,80}checkpoint/iu,
    required: [CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_ESTIMATED_TOKENS],
  },
  {
    label: 'the team collaboration budgets',
    anchor: /(?:attempts?|mailbox|子任务|mutation owner)[^。\n]{0,80}(?:默认|最多|上限|最大|大小|预算|深度|条|个|KiB|MiB|owner)|(?:默认|最多|上限|大小|深度)[^。\n]{0,80}(?:attempts?|mailbox|子任务)/iu,
    required: [
      COLLABORATION_BUDGETS.maxConcurrency, COLLABORATION_BUDGETS.maxSessionMutations,
      COLLABORATION_BUDGETS.maxDepth, COLLABORATION_BUDGETS.maxChildren,
      COLLABORATION_BUDGETS.maxMailbox, MAILBOX_LIMITS.maxMessageChars,
    ],
  },
  {
    label: 'the artifact size budget',
    // Subject first, then the budget/unit word — the shape both real carriers write (产物 … 预算
    // 32 MiB). The reverse order is deliberately NOT accepted: it incidentally claimed the
    // checkpoint sentence, which names `artifact` only as a content class 53 chars after "32 KiB",
    // and that cross-claim widened the checkpoint line's allowed set with the artifact ceiling.
    anchor: /(?:产物|artifact)[^。\n]{0,120}(?:预算|MiB|KiB|字节|bytes)/iu,
    required: [ARTIFACT_LIMITS.maxArtifactBytes],
  },
  {
    label: 'the runtime protocol limits',
    anchor: /限额[^。\n]{0,240}(?:MiB|KiB)|(?:MiB|KiB)[^。\n]{0,160}限额/u,
    required: [
      LIMITS.jsonBytes, LIMITS.binaryBytes, LIMITS.channelCredits, LIMITS.bulkChannels,
      LIMITS.outboundBytes, LIMITS.snapshotTtlMs, LIMITS.snapshotTokens,
      LIMITS.replayBytes, LIMITS.replayAgeMs,
    ],
  },
]);

/**
 * One numeric-limit token of a doc line: a number plus its optional unit, scaled to the constant's
 * own unit (KiB/MiB bytes, seconds/hours milliseconds). The unit is bounded by a non-word
 * character so "4 sessions" reads as the count 4, never as "4 s".
 */
const LIMIT_TOKEN = /(\d+(?:\.\d+)?)\s*(KiB|MiB|KB|MB|B|ms|s|h|token|字节|个|条|次)?(?![\w])/giu;
const LIMIT_TOKEN_SCALE = Object.freeze({ KiB: 1024, MiB: 1024 * 1024, KB: 1000, MB: 1000 * 1000, B: 1, ms: 1, s: 1000, h: 3600000 });

/** The canonical values a doc line states as numeric tokens. */
function tokenValues(text) {
  const values = [];
  for (const match of text.matchAll(LIMIT_TOKEN)) {
    values.push(Number(match[1]) * (LIMIT_TOKEN_SCALE[match[2]] ?? 1));
  }
  return values;
}

/** Whether a line states a small count as its Chinese numeral (四 for 4, 单 for 1). */
function statesChinese(text, value) {
  const numeral = CHINESE_NUMERALS[value];
  return (numeral !== undefined && text.includes(numeral)) || (value === 1 && text.includes('单'));
}

/**
 * Collects every numeric-limit sentence of the owned doc set (controlled copies through
 * `overrides`, exactly like the ladder and worktree-claim checkers) and re-derives each stated
 * number from the imported constants, reporting the failure shapes without asserting so a negative
 * control derives its expected refusal text from the same collection the checker will make:
 *   unexpected — a number no claiming surface allows (the bare 100/max 200 class);
 *   missing    — a required constant no sentence of the surface states, or the unpaged-list
 *                statement the imported EVIDENCE_TOOLS schema implies.
 */
function numericLimits(root, overrides) {
  const read = (file) => (overrides && Object.hasOwn(overrides, file) ? overrides[file] : readFileSync(path.join(root, file), 'utf8'));
  const evidenceList = EVIDENCE_TOOLS.find((tool) => tool.name === 'context.evidence.list');
  const claims = [];
  for (const file of NUMERIC_LIMIT_DOCS) {
    read(file).split('\n').forEach((text, index) => {
      const surfaces = LIMIT_SURFACES.filter((surface) => surface.anchor.test(text));
      if (surfaces.length === 0) return;
      const values = tokenValues(text);
      const allowed = [...new Set(surfaces.flatMap((surface) => surface.required))];
      claims.push({
        file, line: index + 1, text, surfaces,
        values, allowed,
        unexpected: [...new Set(values.filter((value) => !allowed.includes(value)))].sort((a, b) => a - b),
      });
    });
  }
  const surfaces = LIMIT_SURFACES.map((surface) => {
    const own = claims.filter((claim) => claim.surfaces.includes(surface));
    const required = [...new Set(surface.required)].sort((a, b) => a - b);
    const stated = [...new Set(own.flatMap((claim) => [
      ...claim.values.filter((value) => required.includes(value)),
      ...surface.required.filter((value) => statesChinese(claim.text, value)),
    ]))].sort((a, b) => a - b);
    return {
      surface: surface.label,
      sentences: own.length,
      files: [...new Set(own.map((claim) => claim.file))].sort(),
      required, stated,
      missing: required.filter((value) => !stated.includes(value)),
      unpagedRequired: surface.unpaged !== undefined,
      unpagedMissing: surface.unpaged !== undefined && !own.some((claim) => surface.unpaged.test(claim.text)),
    };
  });
  return {
    docs: NUMERIC_LIMIT_DOCS.length,
    evidenceTools: EVIDENCE_TOOLS.length,
    evidenceListPaged: evidenceList !== undefined && Object.hasOwn(evidenceList.inputSchema.properties, 'limit'),
    claims, surfaces,
    uncovered: LIMIT_SURFACES.filter((surface) => !claims.some((claim) => claim.surfaces.includes(surface))).map((surface) => surface.label),
  };
}

/** The refusal text shared by the bare-limit checker and its own negative controls. */
function numericLimitRefusal(entry) {
  if (entry.file !== undefined) {
    return `${NUMERIC_LIMIT_LABEL} at ${entry.file}:${entry.line} (${entry.surfaces.map((surface) => surface.label).join(' + ')}) states ${JSON.stringify(entry.values)}, but only ${JSON.stringify(entry.allowed)} is a real constant (unexpected ${JSON.stringify(entry.unexpected)})`;
  }
  const problems = [];
  if (entry.missing.length > 0) problems.push(`does not state ${JSON.stringify(entry.missing)}`);
  if (entry.unpagedMissing) problems.push('does not state that the evidence reference list is unpaged');
  return `${NUMERIC_LIMIT_LABEL}: ${entry.surface} ${problems.join(' and ')} (stated ${JSON.stringify(entry.stated)}, required ${JSON.stringify(entry.required)})`;
}

/**
 * The inspect-state list checker. The states docs/runtime.md documents must equal the REAL
 * INSPECTION_STATES exported by shared/runtime/harnessContract.js, the array the harness contract
 * enforces on every driver inspection, so neither an invented state nor an omitted real one
 * survives in the doc.
 */
function inspectStates(root, overrides) {
  const read = (file) => (overrides && Object.hasOwn(overrides, file) ? overrides[file] : readFileSync(path.join(root, file), 'utf8'));
  const sentences = [];
  for (const file of NUMERIC_LIMIT_DOCS) {
    read(file).split('\n').forEach((text, index) => {
      if (!INSPECT_STATES_ANCHOR.test(text)) return;
      const marked = INSPECT_STATES_ANCHOR.exec(text);
      const quoted = /`([^`]+)`/u.exec(text.slice(marked.index + marked[0].length));
      assert.ok(quoted, `no backticked inspect-state list after the marker in: ${text}`);
      sentences.push({ file, line: index + 1, states: quoted[1].split(/\s*[/、]\s*/u).map((token) => token.trim()).filter(Boolean) });
    });
  }
  return {
    docs: NUMERIC_LIMIT_DOCS.length,
    files: [...new Set(sentences.map((entry) => entry.file))].sort(),
    sentences: sentences.length,
    lists: sentences.map((entry) => [entry.file, entry.line, entry.states]),
    offending: sentences.filter((entry) => entry.states.join(' ') !== INSPECTION_STATES.join(' ')),
  };
}

/**
 * Bare-limit checker. EVERY numeric-limit sentence the owned doc set carries — the tool/MCP
 * evidence query paging, the timeline item page, the handoff checkpoint budget, the team
 * collaboration budgets, the artifact size budget and the runtime protocol limits — must state
 * exactly the constants IMPORTED from the product modules, and the inspect-state list of
 * docs/runtime.md must equal the imported INSPECTION_STATES. The defect this closes: the delivered
 * docs/collaboration.md once shipped the bare page policy "页 100/max 200", which matches no
 * product surface (the evidence reference list is unpaged, the evidence byte page is 4096/65536
 * bytes, the timeline item page is 100/500), and no registered check read a bare number in prose —
 * H9 reads only the state list, H10 only ladder-shaped sentences, H11 only worktree-count
 * sentences. The numbers are imported, never transcribed, so neither an invented limit nor a
 * silently dropped one survives in ANY owned doc.
 */
function checkNumericLimits(root, overrides) {
  const report = numericLimits(root, overrides);
  assert.equal(report.evidenceTools, 3, `the imported EVIDENCE_TOOLS carry ${report.evidenceTools} descriptors, expected the three read-only tools`);
  assert.equal(report.evidenceListPaged, false, 'context.evidence.list declares a limit parameter, so the evidence reference list is paged and the doc must state that page policy');
  for (const claim of report.claims) {
    assert.deepEqual(claim.unexpected, [], numericLimitRefusal(claim));
  }
  for (const surface of report.surfaces) {
    assert.deepEqual(surface.missing, [], numericLimitRefusal(surface));
    assert.equal(surface.unpagedMissing, false, numericLimitRefusal(surface));
  }
  assert.deepEqual(report.uncovered, [], `no numeric-limit sentence found for: ${report.uncovered.join(', ')}`);
  const inspect = inspectStates(root, overrides);
  assert.ok(inspect.sentences >= 1, 'no inspect-state sentence found in the owned docs');
  for (const [file, line, states] of inspect.lists) {
    assert.deepEqual(states, [...INSPECTION_STATES], listMismatch(`${INSPECT_STATES_LABEL} at ${file}:${line}`, states, INSPECTION_STATES));
  }
  return {
    docs: report.docs,
    surfaces: report.surfaces.map((surface) => ({
      surface: surface.surface, sentences: surface.sentences, files: surface.files,
      required: surface.required, stated: surface.stated,
      ...(surface.unpagedRequired ? { listUnpaged: !surface.unpagedMissing } : {}),
    })),
    sentences: report.claims.map((claim) => [claim.file, claim.line, claim.values]),
    inspect: { files: inspect.files, sentences: inspect.sentences, states: inspect.lists.map(([, , states]) => states) },
    evidenceTools: report.evidenceTools,
    evidenceListPaged: report.evidenceListPaged,
    offending: 0,
  };
}

/** Upgrade-path checker: backup → bind → import → verify → cutover, in order, each with content. */
function checkUpgradeSteps(migrationDocText) {
  const section = migrationDocText.split('## 10. 升级路径')[1]?.split('## 11.')[0] ?? '';
  assert.ok(section.length > 0, 'migration-v090.md has no upgrade path section 10');
  const steps = [...section.matchAll(/\d\.\s+\*\*(\w+)/gu)].map((match) => match[1]);
  assert.deepEqual(steps, ['backup', 'bind', 'import', 'verify', 'cutover'], `upgrade steps are ${JSON.stringify(steps)}, expected backup,bind,import,verify,cutover`);
  for (const step of steps) assert.ok(new RegExp(`\\*\\*${step}[^\\n]*\\*\\*[^\\n]+`, 'u').test(section), `upgrade step ${step} has no body`);
  return { steps };
}

/** Platform-limitation checker: the five disclosed limitations must be stated. */
const PLATFORM_LIMITATIONS = Object.freeze([
  '也没有声称任何 Windows 或 macOS 安装包产物',
  '真实 GitHub-release 更新下载+校验路径',
  '只在 Linux 实测',
  '没有物理 GPU',
  '只在 CI 工作流',
]);
function checkPlatformLimitations(migrationDocText) {
  const missing = PLATFORM_LIMITATIONS.filter((limitation) => !migrationDocText.includes(limitation));
  assert.deepEqual(missing, [], `migration-v090.md is missing platform limitations: ${missing.join(', ')}`);
  return { limitations: PLATFORM_LIMITATIONS.length };
}

/** Migration-status checker: the migration must be described as in progress, not complete. */
function checkMigrationInProgress(migrationDocText) {
  assert.ok(!/迁移(?:状态)?[：:]?\s*(?:已经|已)?完成/u.test(migrationDocText), 'migration-v090.md claims the migration is complete');
  for (const required of [MIGRATION_STATUS, 'task 48', '`App.vue` 尚未接入新运行时']) {
    assert.ok(migrationDocText.includes(required), `migration-v090.md must state "${required}"`);
  }
  return { status: 'in-progress' };
}

/**
 * Captures a refusal instead of throwing, so a negative control can assert the rejection itself.
 * Node's assert appends a generated diff after the first newline, so only the first line of the
 * message is kept: that line is the checker's own refusal text.
 */
async function captureRejection(run) {
  try { await run(); return { rejected: false }; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rejected: true, error: message.split('\n')[0] };
  }
}

/* ------------------------------------------------------------------ the case */

export async function run(context) {
  process.umask(0o022);
  const root = context.root;
  const evidenceRoot = context.evidenceRoot ?? path.join(root, '.omo/evidence/vis-v090/task-47');
  const evidenceDir = path.join(evidenceRoot, 'qa-cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const temporaryRoot = context.temporaryRoot ?? mkdtempSync(path.join(tmpdir(), `vis-task47-owned-${process.pid}-`));
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const startedAt = new Date().toISOString();
  const proof = { task: TASK, case: context.case, runDir, startedAt, checks };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected, surface) => {
    const left = scrub(observed); const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, `${name} (observed ${JSON.stringify(left)} != expected ${JSON.stringify(right)})`);
    scenarios.push({ name, surface, assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  persist();

  const packageText = readFileSync(path.join(root, 'package.json'), 'utf8');
  const lockfileText = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  const runtimeDoc = readFileSync(path.join(root, 'docs/runtime.md'), 'utf8');
  const migrationDoc = readFileSync(path.join(root, 'docs/migration-v090.md'), 'utf8');
  const collaborationDoc = readFileSync(path.join(root, 'docs/collaboration.md'), 'utf8');
  const happy = context.case === 'happy';

  /** Runs one child process with an explicit cwd and returns the spawnSync result. */
  const spawn = (command, args, options = {}) => spawnSync(command, args, {
    cwd: root, encoding: 'utf8', ...options, env: { ...process.env, ...options.env },
  });

  try {
    /* -------------------------------------------------- happy lane */
    if (happy) {
      // H1a: the released version, lockfile specifier parity, and a real lockfile resolution that
      // leaves the file byte-identical.
      const lockBefore = createHash('sha256').update(lockfileText).digest('hex');
      const lockfileRun = spawn('pnpm', ['install', '--lockfile-only'], { env: { CI: 'true', DEBIAN_FRONTEND: 'noninteractive' }, timeout: 120000 });
      assert.equal(lockfileRun.status, 0, `pnpm install --lockfile-only failed: ${lockfileRun.stderr ?? lockfileRun.stdout}`);
      const lockAfter = createHash('sha256').update(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')).digest('hex');
      check('H1a: package.json is 0.9.0-alpha and pnpm-lock.yaml is in sync',
        { ...checkVersion(packageText), ...checkLockfileSpecifiers(packageText, lockfileText), lockfileSha256Before: lockBefore, lockfileSha256After: lockAfter, lockfileUnchanged: lockBefore === lockAfter },
        { version: RELEASE_VERSION, declared: 58, specifiers: 58, lockfileSha256Before: lockBefore, lockfileSha256After: lockBefore, lockfileUnchanged: true },
        'real pnpm install --lockfile-only resolution over the delivered package.json + pnpm-lock.yaml');

      // H1b: the documented bridge commands really run in an isolated fixture.
      const fixture = path.join(temporaryRoot, 'bridge-fixture');
      mkdirSync(path.join(fixture, 'state'), { recursive: true });
      const fixtureEnv = { HOME: fixture, VIS_BRIDGE_STATE_DIR: path.join(fixture, 'state'), VIS_BRIDGE_CONFIG: path.join(fixture, 'bridge.json'), CI: 'true' };
      const versionRun = spawn(process.execPath, [path.join(root, 'vis_bridge.js'), '--version'], { env: fixtureEnv });
      const helpRun = spawn(process.execPath, [path.join(root, 'vis_bridge.js'), '--help'], { env: fixtureEnv });
      const updateHelpRun = spawn(process.execPath, [path.join(root, 'vis_bridge.js'), 'update', '--help'], { env: fixtureEnv });
      check('H1b: documented bridge commands run in an isolated fixture and report 0.9.0-alpha',
        { versionStatus: versionRun.status, versionStdout: versionRun.stdout.trim(), helpStatus: helpRun.status, helpMentionsStart: (helpRun.stdout ?? '').includes('vis_bridge start'), updateHelpStatus: updateHelpRun.status, updateHelpMentionsCheck: (updateHelpRun.stdout ?? '').includes('--check') },
        { versionStatus: 0, versionStdout: RELEASE_VERSION, helpStatus: 0, helpMentionsStart: true, updateHelpStatus: 0, updateHelpMentionsCheck: true },
        'real node vis_bridge.js --version/--help/update --help under an isolated HOME and state dir');

      // H1c: a REAL fresh production build of the released version, then the frozen cap measurement.
      // The artifact checker only builds when dist/index.html is missing, so the build is run
      // explicitly here: a version-string change can alter the bundle and that must be measured,
      // not inherited from a stale dist. Vite is invoked through node directly because this
      // worktree's node_modules is a shared symlink that `pnpm exec` refuses to touch.
      const budget = JSON.parse(readFileSync(path.join(root, 'artifact-budget.json'), 'utf8'));
      const buildRun = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { env: { CI: 'true', NODE_ENV: 'production' }, timeout: 170000 });
      assert.equal(buildRun.status, 0, `vite build failed: ${buildRun.stderr ?? buildRun.stdout}`);
      const reportPath = path.join(runDir, 'artifact-report.json');
      const artifactRun = spawn(process.execPath, [path.join(root, 'scripts/qa/build-artifact-check.mjs'), `--report=${reportPath}`, '--no-build'], { env: { CI: 'true', DEBIAN_FRONTEND: 'noninteractive' }, timeout: 170000 });
      assert.equal(artifactRun.status, 0, `build-artifact-check failed: ${artifactRun.stderr ?? artifactRun.stdout}`);
      const artifactReport = JSON.parse(readFileSync(reportPath, 'utf8'));
      check('H1c: artifact-budget entry-js cap is frozen and the built entry chunk is within it',
        { frozenCap: budget.criticalAssets['entry-js'].cap, capUnchanged: budget.criticalAssets['entry-js'].cap === ENTRY_JS_CAP, reportPassed: artifactReport.passed, reportFailCount: artifactReport.failCount, entryJsFile: artifactReport.criticalAssets['entry-js'].files[0], entryJsBytes: artifactReport.criticalAssets['entry-js'].maxBytes, withinCap: artifactReport.criticalAssets['entry-js'].maxBytes <= ENTRY_JS_CAP },
        { frozenCap: ENTRY_JS_CAP, capUnchanged: true, reportPassed: true, reportFailCount: 0, entryJsFile: artifactReport.criticalAssets['entry-js'].files[0], entryJsBytes: artifactReport.criticalAssets['entry-js'].maxBytes, withinCap: true },
        'real production build via scripts/qa/build-artifact-check.mjs against the frozen artifact-budget.json');
      writeJson(path.join(runDir, 'version-packaging.json'), { version: RELEASE_VERSION, lockfileUnchanged: true, entryJsBytes: artifactReport.criticalAssets['entry-js'].maxBytes, frozenCap: ENTRY_JS_CAP });

      // H2: every relative link in every owned doc resolves.
      const linkReport = checkLinks(root, OWNED_DOCS);
      writeJson(path.join(runDir, 'doc-link-report.json'), linkReport);
      check('H2: every relative link in the owned docs resolves', linkReport, { files: OWNED_DOCS.length, links: linkReport.links, broken: 0 },
        'real link walk over the 11 owned markdown files (the five backend docs are preserved and hash-bound, outside this link scope)');

      // H3: the capability/version matrix equals the measured task-23 evidence and the code constants.
      const evidence = JSON.parse(readFileSync(path.join(root, '.omo/evidence/vis-v090/task-23/happy.json'), 'utf8'));
      const matrix = checkCapabilityMatrix(root, runtimeDoc, evidence);
      writeJson(path.join(runDir, 'capability-matrix.json'), matrix);
      check('H3: the runtime.md capability/version matrix equals the measured evidence', matrix.observed, matrix.expected,
        'docs/runtime.md table re-derived from .omo/evidence/vis-v090/task-23/happy.json plus OPEN_CODE_VERSION and CODEX_PROFILE');

      // H4: the performance table equals the frozen task-44 report copies and states its configuration.
      const profiles = PROFILE_NAMES.map((profile) => readProfile(root, profile));
      const performance = { ...checkPerformanceTable(root, migrationDoc), ...checkPerformanceClaims(migrationDoc), ...crossCheckFrozenCopies(root, Object.fromEntries(PROFILE_NAMES.map((profile, index) => [profile, profiles[index]]))) };
      for (const report of profiles) {
        assert.ok(migrationDoc.includes(report.startedAt), `migration-v090.md does not cite the frozen ${report.profile} run startedAt ${report.startedAt}`);
      }
      writeJson(path.join(runDir, 'performance-crosscheck.json'), performance);
      check('H4: the migration performance table equals the task-44 reports and states the measured configuration', performance, { cells: PERFORMANCE_ROWS.length * 3, statements: CONFIG_STATEMENTS.length, profiles: PROFILE_NAMES.length, contractMatched: true },
        'docs/migration-v090.md section 11 re-derived from the frozen task-44 report copies in this evidence directory, each cross-checked against the live task-44 report contract');

      // H5/H6/H7: upgrade path, platform limitations, migration status.
      const steps = checkUpgradeSteps(migrationDoc);
      writeJson(path.join(runDir, 'upgrade-steps.json'), steps);
      check('H5: the upgrade path backup→bind→import→verify→cutover is complete and ordered', steps, { steps: ['backup', 'bind', 'import', 'verify', 'cutover'] },
        'docs/migration-v090.md section 10 parsed for the five ordered steps with bodies');
      const limitations = checkPlatformLimitations(migrationDoc);
      writeJson(path.join(runDir, 'platform-limitations.json'), limitations);
      check('H6: the five platform limitations are stated', limitations, { limitations: PLATFORM_LIMITATIONS.length },
        'docs/migration-v090.md section 9 checked for each disclosed limitation');
      const status = checkMigrationInProgress(migrationDoc);
      writeJson(path.join(runDir, 'migration-status.json'), status);
      check('H7: the migration is described as in progress', status, { status: 'in-progress' },
        'docs/migration-v090.md carries the migration-status statement (in progress, partially complete), names task 48, and claims no completion');

      // H8: the five backend-specific docs are preserved.
      const preserved = BACKEND_DOCS.map((file) => ({ file, bytes: statBytes(path.join(root, file)) }));
      check('H8: the five backend-specific docs are preserved', preserved, preserved,
        'docs/codex.md, dsh.md, kimi.md, omo.md, omp-rpc.md exist non-empty and are hash-bound via sourceFiles');

      // H9/H10: the collaboration state machines must equal the REAL product constants. These are
      // the checks the previous lane structure could not see: H2 only resolves links and H4 reads
      // only migration-v090.md, so a plausible invented task state or delivery rung passed every
      // registered checker. The constants are imported, so the doc is compared against the arrays
      // the product itself enforces. H10 scans the WHOLE owned doc set by sentence shape: the
      // collaboration.md-only parse is what let CHANGELOG.md's identical copy of the ladder ship.
      const taskStates = checkTaskStates(collaborationDoc);
      writeJson(path.join(runDir, 'collaboration-task-states.json'), taskStates);
      check('H9: the collaboration task states equal the real TASK_STATES', taskStates, { states: [...TASK_STATES] },
        'docs/collaboration.md section 3 parsed and compared against TASK_STATES imported from shared/runtime/collaboration.js');
      const ladderScan = checkDeliveryLadders(root);
      writeJson(path.join(runDir, 'delivery-ladder-scan.json'), ladderScan);
      check('H10: every delivery-ladder sentence in the owned docs equals the real HANDOFF_LADDER', ladderScan,
        { docs: ladderScan.docs, files: ladderScan.files, sentences: ladderScan.sentences, ladders: ladderScan.ladders, offending: 0 },
        'every task-47 owned doc scanned by sentence shape for the delivery-ladder marker, each arrow-joined rung chain compared against HANDOFF_LADDER imported from bridge/runtime/threads/handoffService.js; coverage requires docs/collaboration.md and CHANGELOG.md to keep carrying the ladder');

      // H11: every sentence that names the plan-prescribed worktree count must disclose the
      // seeded-and-graded composition and keep the store-substrate measured configuration. The
      // oracle is the real evidence: each frozen task-44 report carries dataset.worktrees
      // {prescribed, seeded, graded} with seeded 200 and graded true, `prescribed` is
      // cross-checked against the frozen DATASET export, and the observed composition is graded
      // against the plan literals.
      const worktreeReport = checkWorktreeClaims(root, profiles);
      writeJson(path.join(runDir, 'worktree-claims.json'), worktreeReport);
      check('H11: every worktree-count sentence discloses the seeded and graded composition', worktreeReport,
        { sentences: worktreeReport.sentences, prescribed: DATASET['10k'].worktrees, seeded: DATASET['10k'].worktrees, graded: true, offending: 0 },
        'every README/RoadMap/CHANGELOG sentence naming the prescribed worktree count checked for the seeded-and-graded disclosure and the store-substrate measured configuration, oracle: the frozen task-44 report dataset cross-checked against the frozen DATASET export and graded against the plan literals');

      // H12: every bare numeric limit in the owned docs must equal the imported product constants.
      // This is the dimension no previous check read: H9 reads the state list, H10 the ladder
      // sentences, H11 the worktree-count sentences — nothing read a bare number in prose, which is
      // how docs/collaboration.md's invented "页 100/max 200" evidence page policy (matching no
      // product surface) survived every registered check. The scan is doc-set-wide and by sentence
      // shape, and every expected number is imported, so a wrong limit, a dropped limit and a new
      // wrong limit in a file this lane has never seen are all refusals naming file and line.
      const limits = checkNumericLimits(root);
      writeJson(path.join(runDir, 'numeric-limits.json'), limits);
      check('H12: every numeric-limit sentence and the inspect-state list in the owned docs equal the imported constants', limits,
        { docs: limits.docs, surfaces: limits.surfaces.map((surface) => ({ ...surface, stated: surface.required })), sentences: limits.sentences, inspect: { ...limits.inspect, states: [[...INSPECTION_STATES]] }, evidenceTools: 3, evidenceListPaged: false, offending: 0 },
        'every task-47 owned doc scanned by sentence shape for numeric-limit claims about the tool/MCP evidence query paging, the timeline item page, the handoff checkpoint budget, the team collaboration budgets, the artifact size budget and the runtime protocol limits, each stated number re-derived from the constants imported from shared/runtime/context.js, bridge/runtime/threads/timelineProjection.js, shared/runtime/collaboration.js, bridge/runtime/collaboration/mailbox.js, bridge/runtime/collaboration/artifactStore.js and shared/runtime/protocol.js, plus the docs/runtime.md inspect-state list re-derived from INSPECTION_STATES imported from shared/runtime/harnessContract.js; the evidence reference list is asserted unpaged from the imported EVIDENCE_TOOLS schema');
    }

    /* -------------------------------------------------- failure lane: the checkers must REJECT */
    if (!happy) {
      const rejection = async (name, run, expectedError, surface) => {
        const observed = await captureRejection(run);
        check(name, observed, { rejected: true, error: expectedError }, surface);
      };

      // F1: a wrong version and a lockfile whose specifiers drifted from package.json.
      await rejection('F1: a wrong version is rejected', () => {
        checkVersion(JSON.stringify({ version: '0.9.1' }));
      }, 'package.json version 0.9.1 is not 0.9.0-alpha', 'the version checker driven over a controlled wrong package.json');
      const specifiers = [...lockfileText.matchAll(/^ {8}specifier: (.+)$/gmu)].map((match) => match[1].trim());
      const drifted = specifiers.find((range) => specifiers.filter((other) => other === range).length === 1);
      assert.ok(drifted, 'no uniquely-occurring specifier to drift');
      const driftedNames = ['dependencies', 'devDependencies', 'optionalDependencies']
        .flatMap((field) => Object.entries(JSON.parse(packageText)[field] ?? {}))
        .filter(([, range]) => range === drifted).map(([name]) => `${name}@${drifted}`);
      await rejection('F1b: a lockfile whose specifiers drifted from package.json is rejected', () => {
        checkLockfileSpecifiers(packageText, lockfileText.replace(`specifier: ${drifted}`, 'specifier: ^0.0.0-stale'));
      }, `pnpm-lock.yaml is missing specifiers: ${driftedNames.join(', ')}`,
        'the lockfile specifier checker driven over a controlled drifted lockfile');

      // F2: wrong checksum / wrong size / missing digest through the REAL product verifiers.
      const assetDir = path.join(temporaryRoot, 'asset');
      mkdirSync(assetDir, { recursive: true });
      const assetPath = path.join(assetDir, 'VisBridge-0.9.0-alpha-x64-Linux.deb');
      const assetBytes = Buffer.from('vis-bridge-packaged-artifact-bytes');
      writeFileSync(assetPath, assetBytes);
      const assetDigest = createHash('sha256').update(assetBytes).digest('hex');
      const releaseAsset = { name: 'VisBridge-0.9.0-alpha-x64-Linux.deb', size: assetBytes.length, digest: assetDigest };
      await rejection('F2: a tampered artifact fails the real SHA-256 verification', async () => {
        writeFileSync(assetPath, Buffer.from('vis-bridge-packaged-artifact-byteX'));
        await verifyAsset(assetPath, releaseAsset, assetDigest, 'sha256');
      }, 'Downloaded asset VisBridge-0.9.0-alpha-x64-Linux.deb failed SHA256 verification', 'the real electron/updateTransport.js verifyAsset over controlled bytes');
      await rejection('F2b: a size mismatch fails the real verification', async () => {
        writeFileSync(assetPath, assetBytes);
        await verifyAsset(assetPath, { ...releaseAsset, size: assetBytes.length + 1 }, assetDigest, 'sha256');
      }, 'Downloaded asset VisBridge-0.9.0-alpha-x64-Linux.deb has an unexpected size', 'the real verifyAsset size guard');
      await rejection('F2c: a release asset without a valid digest is rejected', () => {
        sha256FromDigest({ name: releaseAsset.name, digest: null });
      }, 'Release asset VisBridge-0.9.0-alpha-x64-Linux.deb has no valid SHA-256 digest', 'the real electron/updatePolicy.js sha256FromDigest');
      writeJson(path.join(runDir, 'checksum-rejections.json'), { tampered: true, sizeMismatch: true, missingDigest: true });

      // F3: a matrix row claiming a capability the measured evidence does not support.
      const evidence = JSON.parse(readFileSync(path.join(root, '.omo/evidence/vis-v090/task-23/happy.json'), 'utf8'));
      const kimiRow = runtimeDoc.split('\n').find((line) => line.includes('| Kimi Web |'));
      assert.ok(kimiRow, 'runtime.md has no Kimi Web matrix row');
      await rejection('F3: a matrix row claiming an unmeasured capability is rejected', () => {
        checkCapabilityMatrix(root, runtimeDoc.replace(kimiRow, kimiRow.replace('5：getGlobalConfig', '6：setProviderAuth、getGlobalConfig')), evidence);
      }, 'Kimi Web capability set differs from the measured task-23 evidence', 'the capability matrix checker over a controlled row that adds setProviderAuth to kimi-web');
      await rejection('F3b: a wrong unsupported count is rejected', () => {
        checkCapabilityMatrix(root, runtimeDoc.replace(kimiRow, kimiRow.replace('| 24 |', '| 23 |')), evidence);
      }, 'Kimi Web unsupported count differs from the measured evidence', 'the capability matrix checker over a controlled wrong count');

      // F4: a new doc pointing at a wrong path.
      writeFileSync(path.join(runDir, 'wrong-path.md'), '# controlled\n\n[broken](./does-not-exist-v090.md)\n');
      await rejection('F4: a new doc pointing at a wrong path is rejected', () => {
        checkLinks(runDir, ['wrong-path.md']);
      }, 'unresolved relative links: wrong-path.md -> ./does-not-exist-v090.md', 'the link checker over a controlled doc with a broken relative link');

      // F5: a miswritten performance number, a generalised claim, and a dropped substrate caveat.
      // The mutation targets the warm-tree row's first measured cell whatever its current value, so
      // the negative control stays valid across a re-measurement of the landed reports.
      const warmTreeMeasured = readProfile(root, 'standard').thresholds.find((entry) => entry.name.startsWith('warm tree')).measured;
      const warmRow = migrationDoc.split('\n').find((line) => line.startsWith('| warm tree'));
      assert.ok(warmRow && /\| [\d.]+ ms \|/u.test(warmRow), 'migration-v090.md has no warm tree row to mutate');
      await rejection('F5: a miswritten performance number is rejected', () => {
        checkPerformanceTable(root, migrationDoc.replace(warmRow, warmRow.replace(/\| [\d.]+ ms \|/u, '| 59 ms |')));
      }, `warm tree ≤ 500 ms standard doc cell 59 ms != measured ${warmTreeMeasured}`, 'the performance table checker over a controlled mutated number');
      await rejection('F5b: a performance claim generalised across sources is rejected', () => {
        checkPerformanceClaims(migrationDoc.replace('只对上述配置与数据集成立', '对所有来源均成立'));
      }, 'migration-v090.md is missing the measured-configuration statements: 只对上述配置与数据集成立', 'the performance claims checker over a controlled generalised claim');
      await rejection('F5c: dropping the store-substrate caveat is rejected', () => {
        checkPerformanceClaims(migrationDoc.replace('store-substrate', 'store-render'));
      }, 'migration-v090.md is missing the measured-configuration statements: store-substrate', 'the performance claims checker over a controlled copy that papers over the substrate caveat');

      // F6: an upgrade path with the verify step removed.
      await rejection('F6: an upgrade path missing the verify step is rejected', () => {
        checkUpgradeSteps(migrationDoc.replace(/\d\.\s+\*\*verify（校验）\*\*[^\n]*\n(?:[^\n]*\n)*?(?=\d\.\s+\*\*cutover)/u, ''));
      }, 'upgrade steps are ["backup","bind","import","cutover"], expected backup,bind,import,verify,cutover', 'the upgrade steps checker over a controlled copy without verify');

      // F7: a platform limitation silently dropped.
      await rejection('F7: a dropped platform limitation is rejected', () => {
        checkPlatformLimitations(migrationDoc.replace('4. **没有物理 GPU**：GRES 经 Slurm 真实 generic-GRES 记账演练（两个真实设备文件使 slurmd 真实报告 `gpu:2`），无真实 NVIDIA 设备。', '4. GPU 支持完整。'));
      }, 'migration-v090.md is missing platform limitations: 没有物理 GPU', 'the platform limitation checker over a controlled copy that claims GPU support');

      // F8: a doc claiming the migration is complete.
      // F8: a doc claiming the migration is complete. The mutation targets the delivered status
      // line whatever its current wording, so the negative control stays valid across a reword.
      const statusLine = migrationDoc.split('\n').find((line) => line.startsWith(`**${MIGRATION_STATUS}`));
      assert.ok(statusLine, 'migration-v090.md has no migration-status line to mutate');
      await rejection('F8: a doc claiming the migration is complete is rejected', () => {
        checkMigrationInProgress(migrationDoc.replace(statusLine, statusLine.replace(MIGRATION_STATUS, '迁移状态：已完成')));
      }, 'migration-v090.md claims the migration is complete', 'the migration status checker over a controlled complete-claim copy');

      // F9/F10: a plausible-but-invented task state and a plausible-but-invented delivery rung.
      // F9 and F10 reintroduce the EXACT lists the delivered doc once carried (invented states AND
      // omitted real ones in one mutation); F9b and F10b then derive a single-token swap from the
      // real constants so the controls stay valid if the product state machine itself changes.
      const statesLine = sectionLine(collaborationDoc, TASK_STATES_HEADING, '- 状态：');
      const historicalStates = ['pending', 'blocked', 'running', 'reconciling', 'completed', 'failed', 'cancelled', 'interrupted'];
      await rejection('F9: the invented task-state list is rejected', () => {
        checkTaskStates(collaborationDoc.replace(statesLine, withInlineList(statesLine, historicalStates)));
      }, listMismatch(TASK_STATES_LABEL, historicalStates, TASK_STATES), 'the task-state checker over a controlled copy of docs/collaboration.md carrying the eight-state list the doc once shipped');
      const swappedStates = [...TASK_STATES];
      swappedStates[1] = 'blocked';
      await rejection('F9b: a single invented task state is rejected', () => {
        checkTaskStates(collaborationDoc.replace(statesLine, withInlineList(statesLine, swappedStates)));
      }, listMismatch(TASK_STATES_LABEL, swappedStates, TASK_STATES), 'the task-state checker over a controlled copy of docs/collaboration.md with one real state swapped for the invented state blocked');
      // F10/F10b: the invented ladder reintroduced into controlled copies of docs/collaboration.md
      // (the file the first fix round corrected). F10c/F10d then reintroduce the SAME class into a
      // controlled copy of CHANGELOG.md — the fourth instance, in the exact bare form that file
      // once shipped — because the defect survived the first round precisely there: the old
      // checker parsed only collaboration.md, so no registered check ever read CHANGELOG's ladder.
      // Each control normalises every OTHER owned-doc ladder sentence to the real ladder, so the
      // refusal deterministically names the sentence under test whatever the delivered bytes say.
      const collaborationControl = deliveryLadderControl(root, 'docs/collaboration.md', ['prepared', 'connecting', 'delivered', 'observed', 'active']);
      assert.ok(Object.hasOwn(collaborationControl, 'docs/collaboration.md'), 'docs/collaboration.md has no delivery-ladder sentence to mutate');
      const historicalLadder = ['prepared', 'connecting', 'delivered', 'observed', 'active'];
      const collaborationOffending = deliveryLadders(root, collaborationControl).offending[0];
      await rejection('F10: the invented delivery ladder is rejected', () => {
        checkDeliveryLadders(root, collaborationControl);
      }, listMismatch(`${DELIVERY_LABEL} at ${collaborationOffending}`, historicalLadder, HANDOFF_LADDER), 'the delivery-ladder checker over a controlled copy of docs/collaboration.md carrying the five-rung ladder the doc once shipped, every other owned-doc ladder sentence normalised to the real ladder');
      const swappedLadder = [...HANDOFF_LADDER];
      swappedLadder[1] = 'connecting';
      const swappedControl = deliveryLadderControl(root, 'docs/collaboration.md', swappedLadder);
      const swappedOffending = deliveryLadders(root, swappedControl).offending[0];
      await rejection('F10b: a single invented delivery rung is rejected', () => {
        checkDeliveryLadders(root, swappedControl);
      }, listMismatch(`${DELIVERY_LABEL} at ${swappedOffending}`, swappedLadder, HANDOFF_LADDER), 'the delivery-ladder checker over a controlled copy of docs/collaboration.md with one real rung swapped for the invented rung connecting, every other owned-doc ladder sentence normalised to the real ladder');
      // F10c reintroduces the EXACT sentence CHANGELOG.md once shipped — bare, unbackticked,
      // unspaced — as a controlled copy written inside the case-owned run directory, and drives the
      // SAME doc-set checker over those bytes.
      const changelogText = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
      const changelogLadderLine = changelogText.split('\n').find((line) => DELIVERY_SENTENCE.test(line));
      assert.ok(changelogLadderLine, 'CHANGELOG.md has no delivery-ladder sentence to mutate');
      const controlledChangelogPath = path.join(runDir, 'controlled-changelog.md');
      writeFileSync(controlledChangelogPath, changelogText.replace(deliveryClause(changelogLadderLine), `delivery 状态 ${historicalLadder.join('→')}`));
      const changelogControl = { ...deliveryLadderControl(root, null), 'CHANGELOG.md': readFileSync(controlledChangelogPath, 'utf8') };
      const changelogOffending = deliveryLadders(root, changelogControl).offending[0];
      await rejection('F10c: the invented delivery ladder in a controlled CHANGELOG.md copy is rejected', () => {
        checkDeliveryLadders(root, changelogControl);
      }, listMismatch(`${DELIVERY_LABEL} at ${changelogOffending}`, historicalLadder, HANDOFF_LADDER), 'the delivery-ladder checker over a controlled copy of CHANGELOG.md written inside the case-owned run directory, carrying the exact five-rung bare ladder that file once shipped, every other owned-doc ladder sentence normalised to the real ladder');
      // F10d: the same CHANGELOG surface with one real rung swapped for the invented rung.
      const changelogSwappedControl = deliveryLadderControl(root, 'CHANGELOG.md', swappedLadder);
      const changelogSwappedOffending = deliveryLadders(root, changelogSwappedControl).offending[0];
      await rejection('F10d: a single invented delivery rung in a controlled CHANGELOG.md copy is rejected', () => {
        checkDeliveryLadders(root, changelogSwappedControl);
      }, listMismatch(`${DELIVERY_LABEL} at ${changelogSwappedOffending}`, swappedLadder, HANDOFF_LADDER), 'the delivery-ladder checker over a controlled copy of CHANGELOG.md with one real rung swapped for the invented rung connecting, every other owned-doc ladder sentence normalised to the real ladder');

      // F11: the phantom unseeded worktree claim, reintroduced by flipping the seeded-and-graded
      // disclosure of every naming sentence into a not-seeded claim — the exact sentence shape the
      // doc set shipped before task 50 seeded the composition. The mutation is derived from the
      // delivered text, so the control fails for the same reason the shipped doc once did.
      const phantom = {};
      for (const file of WORKTREE_CLAIM_DOCS) {
        phantom[file] = readFileSync(path.join(root, file), 'utf8')
          .replace(/已播种并已评分/gu, '未播种、未报告、未评分')
          .replace(/seeded and graded/giu, 'not seeded');
      }
      const phantomReport = worktreeClaims(root, phantom);
      await rejection('F11: a phantom unseeded worktree claim is rejected', () => {
        checkWorktreeClaims(root, PROFILE_NAMES.map((profile) => readProfile(root, profile)), phantom);
      }, worktreeRefusal(DATASET['10k'].worktrees, phantomReport.offending), 'the worktree-claim checker over controlled copies of README/RoadMap/CHANGELOG whose seeded-and-graded disclosure is flipped into a not-seeded claim');

      // F12/F12b: the invented evidence page limit the delivered doc once shipped, reintroduced
      // into a controlled copy of docs/collaboration.md, and the same sentence with one real page
      // maximum swapped for the phantom 200. F12c proves the scan is doc-set-wide: a NEW wrong
      // limit injected into a controlled copy of docs/runtime.md — a doc that carried no
      // numeric-limit sentence before this control — is refused and named. F12d/F12e prove the
      // checkpoint and protocol surfaces are scanned beyond their first carrier, and F12f the
      // inspect-state list guard. No control normalises the other docs: the delivered bytes are
      // already real, so the only possible refusal names the sentence under test.
      const evidenceLine = collaborationDoc.split('\n').find((line) => /证据查询/u.test(line));
      assert.ok(evidenceLine, 'docs/collaboration.md has no evidence-query sentence to mutate');
      const historicalEvidenceLine = '- **不转发 API key 或环境机密，不复制完整 transcript**；tool/MCP 证据查询按 Thread、环境、参与者授权，页 100/max 200。';
      const evidenceControl = { 'docs/collaboration.md': collaborationDoc.replace(evidenceLine, historicalEvidenceLine) };
      const evidenceOffending = numericLimits(root, evidenceControl).claims.find((claim) => claim.unexpected.length > 0);
      assert.ok(evidenceOffending, 'the controlled copy states no unexpected numeric limit');
      await rejection('F12: the invented evidence page limit is rejected', () => {
        checkNumericLimits(root, evidenceControl);
      }, numericLimitRefusal(evidenceOffending), 'the bare-limit checker over a controlled copy of docs/collaboration.md carrying the verbatim page 100/max 200 sentence the doc once shipped');
      const swappedEvidenceControl = { 'docs/collaboration.md': collaborationDoc.replace(evidenceLine, evidenceLine.replace('上限 500', '上限 200')) };
      const swappedEvidenceOffending = numericLimits(root, swappedEvidenceControl).claims.find((claim) => claim.unexpected.length > 0);
      assert.ok(swappedEvidenceOffending, 'the swapped controlled copy states no unexpected numeric limit');
      await rejection('F12b: a single wrong page limit is rejected', () => {
        checkNumericLimits(root, swappedEvidenceControl);
      }, numericLimitRefusal(swappedEvidenceOffending), 'the bare-limit checker over a controlled copy of docs/collaboration.md with the real timeline page maximum 500 swapped for the phantom 200, every other stated number left real');
      const injectedRuntimeDoc = `${runtimeDoc.replace(/\n$/, '')}\n- timeline 条目页默认 100、上限 200。\n`;
      const runtimeLimitControl = { 'docs/runtime.md': injectedRuntimeDoc };
      const runtimeLimitOffending = numericLimits(root, runtimeLimitControl).claims.find((claim) => claim.unexpected.length > 0);
      assert.ok(runtimeLimitOffending, 'the injected controlled copy states no unexpected numeric limit');
      await rejection('F12c: a new wrong limit in a doc with no limit sentence is rejected', () => {
        checkNumericLimits(root, runtimeLimitControl);
      }, numericLimitRefusal(runtimeLimitOffending), 'the bare-limit checker over a controlled copy of docs/runtime.md — a doc that carried no numeric-limit sentence before this control — with a new timeline page sentence stating the wrong maximum 200');
      const changelogForLimits = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
      const checkpointLimitControl = { 'CHANGELOG.md': changelogForLimits.replace('最多 32KiB', '最多 64KiB') };
      const checkpointLimitOffending = numericLimits(root, checkpointLimitControl).claims.find((claim) => claim.unexpected.length > 0);
      assert.ok(checkpointLimitOffending, 'the controlled CHANGELOG copy states no unexpected numeric limit');
      await rejection('F12d: a wrong checkpoint budget in a second doc is rejected', () => {
        checkNumericLimits(root, checkpointLimitControl);
      }, numericLimitRefusal(checkpointLimitOffending), 'the bare-limit checker over a controlled copy of CHANGELOG.md with the real checkpoint ceiling 32 KiB swapped for 64 KiB, proving the checkpoint surface is scanned beyond docs/collaboration.md');
      const protocolLimitControl = { 'docs/migration-v090.md': migrationDoc.replace('64 MiB', '128 MiB') };
      const protocolLimitOffending = numericLimits(root, protocolLimitControl).claims.find((claim) => claim.unexpected.length > 0);
      assert.ok(protocolLimitOffending, 'the controlled migration copy states no unexpected numeric limit');
      await rejection('F12e: a wrong protocol limit is rejected', () => {
        checkNumericLimits(root, protocolLimitControl);
      }, numericLimitRefusal(protocolLimitOffending), 'the bare-limit checker over a controlled copy of docs/migration-v090.md with the real append/replay log ceiling 64 MiB swapped for 128 MiB');
      const inspectStatesControl = { 'docs/runtime.md': runtimeDoc.replace('`supported/disabled/missing/auth-required/starting/ready/failed`', '`supported/disabled/missing/auth-required/starting/booting/failed`') };
      const inspectStatesOffending = inspectStates(root, inspectStatesControl).offending[0];
      assert.ok(inspectStatesOffending, 'the controlled runtime copy states no invented inspect state');
      await rejection('F12f: an invented inspect state is rejected', () => {
        checkNumericLimits(root, inspectStatesControl);
      }, listMismatch(`${INSPECT_STATES_LABEL} at ${inspectStatesOffending.file}:${inspectStatesOffending.line}`, inspectStatesOffending.states, INSPECTION_STATES), 'the inspect-state checker over a controlled copy of docs/runtime.md with the real state ready swapped for the invented state booting');
      writeJson(path.join(runDir, 'failure-rejections.json'), { scenarios: scenarios.map((scenario) => scenario.name) });
    }
  } catch (error) {
    proof.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
    persist();
    throw error;
  } finally {
    for (const name of ['version-packaging.json', 'doc-link-report.json', 'capability-matrix.json', 'performance-crosscheck.json', 'upgrade-steps.json', 'platform-limitations.json', 'migration-status.json', 'failure-rejections.json', 'checksum-rejections.json', 'artifact-report.json', 'collaboration-task-states.json', 'delivery-ladder-scan.json', 'worktree-claims.json', 'numeric-limits.json']) {
      const file = path.join(runDir, name);
      if (existsSync(file) && statSync(file).size > 0) artifacts.push(artifact(file, name.replace('.json', '')));
    }
    // The proof file is registered LAST, after its final write: the runner re-hashes every
    // registered artifact, so registering it before the last persist() would read as "changed".
    proof.cleanup = { temporaryRoot, removed: true };
    persist();
    rmSync(temporaryRoot, { recursive: true, force: true });
    proof.cleanupRemoved = !existsSync(temporaryRoot);
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'));
  }

  return {
    scenarios,
    artifacts,
    versions: { node: process.version, package: JSON.parse(packageText).version },
    cleanup: { temporaryRoot, removed: proof.cleanupRemoved },
    evidenceBoundary: `This case checks the DELIVERED DOCUMENTATION and version/packaging bytes of task 47 only. The happy lane re-derives every doc claim from landed evidence (the task-23 measured capability sets in .omo/evidence/vis-v090/task-23/happy.json, the frozen task-44 report copies in .omo/evidence/vis-v090/task-47/performance-reports/ each cross-checked against the live task-44 report contract) or from the product modules themselves (OPEN_CODE_VERSION, CODEX_PROFILE, the TASK_STATES array of shared/runtime/collaboration.js, the HANDOFF_LADDER array of bridge/runtime/threads/handoffService.js, the frozen DATASET export of scripts/qa/runtime-v090-benchmark.mjs, the EVIDENCE_PAGE_BYTES/MAX_EVIDENCE_PAGE_BYTES/CHECKPOINT_MAX_BYTES/CHECKPOINT_MAX_ESTIMATED_TOKENS constants and the EVIDENCE_TOOLS descriptors of shared/runtime/context.js, the DEFAULT_TIMELINE_PAGE_LIMIT/MAX_TIMELINE_PAGE_LIMIT constants of bridge/runtime/threads/timelineProjection.js, the COLLABORATION_BUDGETS object of shared/runtime/collaboration.js, the MAILBOX_LIMITS object of bridge/runtime/collaboration/mailbox.js, the ARTIFACT_LIMITS object of bridge/runtime/collaboration/artifactStore.js, the nine-value LIMITS object of shared/runtime/protocol.js, the INSPECTION_STATES array of shared/runtime/harnessContract.js, electron/updateTransport.js verifyAsset, electron/updatePolicy.js sha256FromDigest, scripts/qa/build-artifact-check.mjs over a real production build, a real pnpm --lockfile-only resolution, and the real vis_bridge.js CLI in an isolated fixture). The five UI-TREE render metrics remain graded at the store-substrate level because App.vue is not yet wired to the runtime; this case claims nothing about running-app rendering. No product test suite is run, no browser UI is driven, no live SSH/Slurm run is performed (task 46 owns it), no platform installer is built (the only build is the repo's own Linux web production build), and NO PASS verdict is authored here. The failure lane drives the SAME checkers over controlled negative copies built inside the case-owned run directory and asserts the real rejection messages; no delivered file, lockfile, budget file or evidence file is modified.`,
  };
}

/** Byte size of a preserved doc, refusing a missing or empty file. */
function statBytes(file) {
  assert.ok(existsSync(file), `preserved doc missing: ${file}`);
  const size = statSync(file).size;
  assert.ok(size > 0, `preserved doc is empty: ${file}`);
  return size;
}
