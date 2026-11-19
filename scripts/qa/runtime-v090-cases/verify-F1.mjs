// F1 final verifier — plan compliance audit for vis-v090-unified-runtime.
//
// Plan line 221 (task 6): "最终verifier唯一拥有verify-FN.mjs" — the final
// verifier lane uniquely owns its verify module. This file is the F1 lane's
// own deliverable; it modifies no product, doc, test, harness or case file
// and never writes inside the audited worktree.
//
// Lane selection: the runner's parseSelector originally rejected `--verify` together with
// `--case` ("verify cannot select a case"), while the plan's F1 row writes
// `--verify F1 --case happy|failure` (plan lines 736; task 6's own controls use the bare
// `--verify FN` form). Task 54 taught parseSelector to accept both forms, so the lane is now
// selected by the selector's own `--case` when present and otherwise by the registered output
// name — the only other signal the runner forwards to a verify module:
//   * 'failure' (either signal) -> rejection controls over a mutated COPY of the evidence tree
//     + plan (the product worktree is never touched);
//   * otherwise -> the complete-ledger audit against the real tree.
//
// Every assertion carries the value the audit actually observed. Compliance
// shortfalls are reported as findings (never silently passed); the verdict is
// carried in `verdict`/`findings`/`requiredTaskRows` and in the DoneClaim.
import { artifact } from '../runtime-v090-evidence.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const sourceFiles = [
  'scripts/qa/runtime-v090.mjs',
  'scripts/qa/runtime-v090-legacy.mjs',
  'package.json',
];

// ------------------------------------------------------------------ audit inputs
// Every path and the target revision resolve from the runner's context — the
// checkout being verified — plus explicit evidence/plan/revision inputs. No
// input is a personal absolute path: this lane used to hardcode one machine's
// worktree farm, an old revision and a plan path, so on any other checkout the
// happy lane died reading the plan while the outer runner still stamped the
// result with the CURRENT checkout's productionRevision/sourceHashes — the
// audited bytes and the claimed bytes could differ. The inputs are now:
//
//   root             the audited checkout (context.root — the runner's own root)
//   evidenceRoot     the unified evidence tree: context.evidenceRoot
//                    (--evidence-root) or VIS_F1_EVIDENCE_ROOT, else
//                    <root>/.omo/evidence/vis-v090
//   planPath         context.planPath or VIS_F1_PLAN, else
//                    <root>/.omo/plans/vis-v090-unified-runtime.md
//   ledgerWorktrees  the campaign's per-lane worktree root, for the lanes whose
//                    evidence predates the unified ledger (tasks 1-19 and the
//                    task-6 normalization re-runs): context.ledgerWorktrees or
//                    VIS_F1_LEDGER_WORKTREES. Explicit input only; when unset,
//                    those lanes report a located prerequisite gap instead of
//                    being read from a hardcoded machine path.
//   finalHead        the revision the evidence was frozen at: context.finalHead
//                    or VIS_F1_FINAL_HEAD, else the head recorded by the
//                    evidence's own final/revision-manifest.json.
//
// A missing plan, evidence tree or seed file is a LOCATED prerequisite error
// naming the path and the input that configures it — never a bare ENOENT.
function auditInputs(context = {}) {
  const root = context.root;
  assert(typeof root === 'string' && root.length > 0, 'F1 requires the runner context root');
  const evidenceRoot = context.evidenceRoot ?? process.env.VIS_F1_EVIDENCE_ROOT ?? path.join(root, '.omo/evidence/vis-v090');
  const planPath = context.planPath ?? process.env.VIS_F1_PLAN ?? path.join(root, '.omo/plans/vis-v090-unified-runtime.md');
  const ledgerWorktrees = context.ledgerWorktrees ?? process.env.VIS_F1_LEDGER_WORKTREES ?? null;
  const finalHead = context.finalHead ?? process.env.VIS_F1_FINAL_HEAD ?? null;
  return { root, evidenceRoot, planPath, ledgerWorktrees, finalHead };
}

// Wave-9 integration rows 49-56 carry no registered Invocation row: the runner's
// selector accepts --task 1-48 only (plan line 221 registers exactly 1-48) and
// those rows state acceptance criteria without an Invocation line, so they own
// no runner-shaped happy/failure evidence and no case module. Their delivery
// evidence is the lane DoneClaim, recorded at the location each lane actually
// wrote it; the claim's `head` is the commit the row was delivered at.
const WAVE9_EVIDENCE = {
  49: 'task-49-53/DoneClaim.json',
  50: 'task-50/DoneClaim.json',
  51: 'task-49-53/DoneClaim.json',
  52: 'task-49-53/DoneClaim.json',
  53: 'task-49-53/DoneClaim.json',
  54: 'task-54/DoneClaim.json',
  55: 'final/F2-DoneClaim.json',
  56: 'task-56/DoneClaim.json',
};

// A Wave-9 claim is evidence, so it resolves inside the evidence tree; the
// stored relatives keep their historical .omo/evidence/vis-v090 prefix.
const wave9Claim = (task, inputs) => path.join(inputs.evidenceRoot, WAVE9_EVIDENCE[task] ?? '');

// The pre-runner lanes' normalized QA heads. Tasks 1-5 predate the QA runner, so their
// raw Vitest receipts carry no productionRevision; the task-6 and task-56
// normalization lanes re-ran those receipts through the real runner
// ("controlled-rerun", recorded in task-6/task-56 normalization.json and in
// task-56/normalization/normalization-run.json), producing green runner-shaped
// manifests with a productionRevision. Those manifests — not the task branch
// tips — are the lanes' QA heads: a branch tip is whatever the worktree happened
// to point at, a side branch the delivery line never saw.
//
// Resolution: the unified evidence tree first, then the explicitly configured
// ledger worktrees (the task-6 worktree holds the legacy-taskN re-runs directly
// under task-6/, the task-20 tree holds them under task-56/normalization/).
// Nothing here names a personal path.
function normalizedCandidates(task, inputs) {
  const names = [`task-6/legacy-task${task}/happy.json`, `task-56/normalization/legacy-task${task}/happy.json`];
  const roots = [inputs.evidenceRoot];
  if (inputs.ledgerWorktrees) {
    roots.push(path.join(inputs.ledgerWorktrees, 'vis-v090-task-6', '.omo/evidence/vis-v090'));
    roots.push(path.join(inputs.ledgerWorktrees, 'vis-v090-task-20', '.omo/evidence/vis-v090'));
  }
  return roots.flatMap((root) => names.map((name) => path.join(root, name)));
}

// Plan dependency matrix (Todos 1-56: "Depends on" for rows 1-48, "Blocked by"
// for the Wave-9 rows 49-56), transcribed from the plan. Rows 54-56 state no
// dependency clause in the plan and are recorded with an empty edge set.
const DEPENDS = {
  1: [], 2: [1], 3: [1, 2], 4: [1, 2], 5: [], 6: [2, 5], 7: [1, 3, 6], 8: [2, 3, 7],
  9: [1, 6], 10: [7, 8, 9], 11: [1, 6], 12: [7, 11], 13: [3, 4, 8, 9, 10], 14: [3, 4, 8, 9],
  15: [3, 4, 8, 9], 16: [3, 4, 8, 9], 17: [3, 4, 8, 9], 18: [7, 8, 12, 13, 14, 15, 16, 17],
  19: [2, 12, 18], 20: [12, 18, 19], 21: [20], 22: [4, 15, 19, 20], 23: [4, 19, 20], 24: [9, 10, 11, 12, 19, 20, 21, 22, 23],
  25: [2, 3, 8, 19], 26: [25], 27: [9, 25, 26], 28: [7, 8, 25, 26, 27], 29: [7, 8, 26, 27, 28], 30: [24, 25, 26, 27, 28, 29],
  31: [7, 18, 20], 32: [7, 20, 31], 33: [4, 7, 31], 34: [8, 22, 31, 33], 35: [21, 22, 23, 24, 30, 31, 32, 33, 34],
  36: [12, 14, 18, 20], 37: [7, 8, 31, 32], 38: [8, 22, 31, 37], 39: [4, 15, 22, 31, 33, 34, 37],
  40: [8, 10, 37], 41: [8, 10, 37, 40], 42: [21, 23, 30, 32, 35, 37, 38, 39, 40, 41],
  43: Array.from({ length: 42 }, (_, i) => i + 1), 44: [5, 18, 20, 21, 36, 42, 43], 45: [7, 19, 27, 30, 36, 42],
  46: [26, 27, 28, 29, 30, 45], 47: [43, 44, 45, 46], 48: Array.from({ length: 47 }, (_, i) => i + 1),
  // Wave-9 rows 49-56 (plan lines 733/737/741/745/749): row 49 "Blocked by: 1-48";
  // row 50 "Blocked by: 44"; rows 51/52/53 "Blocked by: 49"/"Blocked by: 51"/"Blocked by: 51".
  // Rows 54-56 state no Blocked by clause in the plan, so they carry no edge.
  49: Array.from({ length: 48 }, (_, i) => i + 1), 50: [44], 51: [49], 52: [51], 53: [51], 54: [], 55: [], 56: [],
};

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// ------------------------------------------------------------------ audit core

// A lane's evidence directory carries a receipt: happy.json (runner-shaped),
// result.json (raw Vitest for the pre-runner tasks) or failure.json.
function hasLaneReceipt(directory) {
  return existsSync(path.join(directory, 'happy.json')) || existsSync(path.join(directory, 'result.json')) || existsSync(path.join(directory, 'failure.json'));
}

// Tasks 1-19 were delivered in their own worktrees, so their evidence resolves
// in the unified evidence tree when that tree actually carries the lane's
// receipt, and otherwise — only when the campaign's ledger-worktree root is
// explicitly configured — in the owning worktree. The returned path may not
// exist; callers report the gap with the searched roots.
function taskEvidenceDir(task, inputs) {
  const unified = path.join(inputs.evidenceRoot, `task-${task}`);
  if (task > 19 || hasLaneReceipt(unified)) return unified;
  if (inputs.ledgerWorktrees) {
    const owned = path.join(inputs.ledgerWorktrees, `vis-v090-task-${task}`, '.omo/evidence/vis-v090', `task-${task}`);
    if (hasLaneReceipt(owned)) return owned;
  }
  return unified;
}

function boundHead(task, inputs) {
  const happy = readJson(path.join(taskEvidenceDir(task, inputs), 'happy.json'));
  if (happy && typeof happy.productionRevision === 'string' && /^[0-9a-f]{40}$/.test(happy.productionRevision)) return happy.productionRevision;
  if (task <= 5) {
    // Pre-runner tasks carry raw Vitest receipts; the normalization lanes' green
    // controlled re-runs are the lanes' real QA heads. The task branch tip stays
    // as the last-resort fallback for a pre-runner task whose normalization never
    // landed — it is a side branch, not a QA head, so it can only ever be a
    // fallback, never the primary resolution, and it needs the explicitly
    // configured ledger worktrees to exist at all.
    for (const candidate of normalizedCandidates(task, inputs)) {
      const normalized = readJson(candidate);
      if (normalized && normalized.status === 'passed' && normalized.exitCode === 0 && typeof normalized.productionRevision === 'string' && /^[0-9a-f]{40}$/.test(normalized.productionRevision)) return normalized.productionRevision;
    }
    if (!inputs.ledgerWorktrees) return null;
    try {
      const wt = path.join(inputs.ledgerWorktrees, `vis-v090-task-${task}`);
      return git(inputs.root, 'rev-parse', git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'));
    } catch { return null; }
  }
  if (task >= 49) {
    // Wave-9 integration row: no runner-shaped happy.json; the lane DoneClaim
    // records the head the row was delivered at.
    const claim = readJson(wave9Claim(task, inputs));
    if (claim && typeof claim.head === 'string') { try { return git(inputs.root, 'rev-parse', claim.head); } catch { return null; } }
  }
  return null;
}

function planRows(planPath) {
  const text = readFileSync(planPath, 'utf8');
  const rows = [];
  text.split('\n').forEach((line, index) => {
    const m = /^(\s*)- \[( |x)\] (.*)$/.exec(line);
    if (!m) return;
    const body = m[3];
    const numbered = /^(\d+)\.\s+(.*)$/.exec(body);
    const finalWave = /^(F\d)\.\s+(.*)$/.exec(body);
    rows.push({
      line: index + 1,
      indent: m[1].length,
      checked: m[2] === 'x',
      kind: numbered ? 'task' : finalWave ? 'final-wave' : 'registered-item',
      id: numbered ? numbered[1] : finalWave ? finalWave[1] : null,
      title: (numbered ? numbered[2] : finalWave ? finalWave[2] : body).slice(0, 90),
    });
  });
  return rows;
}

function freezeDigest(root) {
  const EXCLUDE = new Set(['node_modules', '.git', '.omo', 'dist', 'dist-electron', 'dist-bridge', '.zread', 'coverage', '.fallow', '.vitest']);
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      if (EXCLUDE.has(entry)) continue;
      const p = path.join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, out); else if (st.isFile()) out.push(p);
    }
    return out;
  };
  const files = walk(root).map((p) => path.relative(root, p)).filter((rel) => !rel.startsWith('.omo/')).sort();
  const lines = files.map((rel) => `${createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex')}  ${rel}`);
  return { digest: createHash('sha256').update(lines.join('\n')).digest('hex'), fileCount: files.length };
}

const DOWNSTREAM = [
  ['task-43-system.json', 18, true], ['task-43-system-failure.json', 17, true],
  ['task-44-performance.json', 10, true], ['task-44-performance-failure.json', 8, true],
  ['task-46-live-ssh.json', 14, false], ['task-46-live-ssh-failure.json', 21, false],
  ['task-46-live-slurm.json', 39, false], ['task-46-live-slurm-failure.json', 48, false],
  ['packaged/happy.json', 14, false],
];

// The five files of the task-19 corrected-head delivery (commit 49b5b8b62,
// native Windows CI run 38225762388) — hashes pinned at delivery time.
const TASK19_DELIVERY = {
  'bridge/processTree.js': '7da05c42df307a354e70ea3bc619dfe0a6cd46759ecff88d9be36af713ed8079',
  'app/processTree.windows.test.ts': '37dec6fb73b030bfebbc08ba74ea95feacf08437319211726f5e2491cd359cb5',
  'app/acpTerminalManager.test.ts': '8987a898b79cac1c21a2fc07e9d89adac082fbc194a56a626a2a8cc9a3822c80',
  'app/kimiWebBridge.integration.test.ts': '328904d414f651a43a0749bcd4be201124c3a04dea16575f61ce05e9617d592d',
  'app/serverLive.integration.test.ts': 'ded688b205aa4ddc42eeffe094a775dec93c75a954d36f1e10ae04813154953f',
};

const SURFACES = [
  'shared/runtime/identity.js', 'shared/runtime/protocol.js', 'shared/runtime/protocolState.js', 'shared/runtime/capabilities.js',
  'shared/runtime/harnessContract.js', 'shared/runtime/nativeExtensions.js', 'shared/runtime/collaboration.js', 'shared/runtime/context.js',
  'shared/runtime/thread.js', 'shared/runtime/historyPage.js', 'shared/runtime/runtimeWire.js', 'shared/runtime/connectionProfile.js',
  'bridge/runtime/runtimeHost.js', 'bridge/runtime/runtimeDispatch.js', 'bridge/runtime/runtimeChannels.js',
  'bridge/runtime/storage/runtimeDatabaseWorker.mjs', 'bridge/runtime/storage/runtimeStore.js',
  'bridge/runtime/drivers/openCodeDriver.js', 'bridge/runtime/drivers/codexDriver.js', 'bridge/runtime/drivers/acpDriver.js',
  'bridge/runtime/drivers/kimiWebDriver.js', 'bridge/runtime/drivers/dshDriver.js',
  'bridge/runtime/transports/sshTransport.js', 'bridge/runtime/transports/slurmJobs.js', 'bridge/runtime/transports/slurmTcpTransport.js',
  'bridge/runtime/transports/slurmStepTransport.js', 'bridge/runtime/transports/profileStore.js',
  'bridge/runtime/threads/threadService.js', 'bridge/runtime/threads/handoffService.js', 'bridge/runtime/threads/checkpointService.js',
  'bridge/runtime/collaboration/coordinator.js', 'bridge/runtime/collaboration/fanoutService.js', 'bridge/runtime/collaboration/delegationService.js',
  'bridge/runtime/collaboration/writerLeases.js', 'bridge/runtime/collaboration/integrationService.js',
  'bridge/runtime/history/historyService.js', 'bridge/runtime/migration/importService.js',
  'app/runtime/client.ts', 'app/runtime/connection.ts', 'app/runtime/state.ts', 'app/runtime/draftStore.ts',
  'app/composables/useRuntimeConnection.ts', 'app/components/SessionTree.vue', 'app/components/runtime/UnifiedSessionTree.test.ts', 'app/components/runtime/ThreadView.vue',
  'docs/runtime.md', 'docs/remote.md', 'docs/collaboration.md', 'docs/migration-v090.md',
];

// The complete audit. Every input comes from `auditInputs` — the runner's
// context root plus explicit evidence/plan/revision inputs; nothing defaults to
// a machine-specific tree. Returns { checks, findings, artifacts }; findings are
// compliance shortfalls.
function audit(inputs) {
  const { root, evidenceRoot, planPath, ledgerWorktrees } = inputs;
  const findings = [];
  const add = (id, severity, planLine, detail) => findings.push({ id, severity, planLine, detail });

  // -- 1. plan checkbox state ------------------------------------------------
  const rows = planRows(planPath);
  const taskRows = rows.filter((r) => r.kind === 'task');
  const unchecked = rows.filter((r) => !r.checked);
  const uncheckedTasks = unchecked.filter((r) => r.kind === 'task');
  const uncheckedItems = unchecked.filter((r) => r.kind === 'registered-item');
  const uncheckedFinalWave = unchecked.filter((r) => r.kind === 'final-wave').map((r) => r.id).sort();
  if (taskRows.length !== 56) add('PLAN-TASK-ROW-COUNT', 'blocking', 'Todos section', `expected 56 numbered task rows (the 48 original tasks plus the 8 Wave-9 integration rows 49-56), observed ${taskRows.length}`);
  for (const r of uncheckedTasks) add('PLAN-UNCHECKED-TODO', 'blocking', `plan line ${r.line}`, `numbered task row ${r.id} is unchecked: ${r.title}`);
  for (const r of uncheckedItems) add('PLAN-UNCHECKED-REGISTERED-ITEM', 'blocking', `plan line ${r.line}`, `registered correction row is unchecked: ${r.title}`);

  // -- 2. per-task ledger completeness ---------------------------------------
  const ledger = [];
  const wave9 = [];
  for (let task = 1; task <= 56; task++) {
    const dir = taskEvidenceDir(task, inputs);
    const entry = { task };
    if (task >= 49) {
      // Wave-9 integration row: no registered Invocation row, so no runner-shaped
      // happy/failure evidence exists or is required; the lane DoneClaim at the
      // location the lane actually wrote is this row's delivery evidence, and its
      // head must resolve to a real commit in the audited tree.
      const rel = WAVE9_EVIDENCE[task];
      const claim = rel ? readJson(wave9Claim(task, inputs)) : null;
      const resolved = claim && typeof claim.head === 'string' ? (() => { try { return git(root, 'rev-parse', claim.head); } catch { return null; } })() : null;
      entry.wave9 = { task, claim: rel ?? null, head: claim?.head ?? null, resolved: Boolean(resolved) };
      wave9.push(entry.wave9);
      if (!claim) add('LEDGER-WAVE9-EVIDENCE', 'blocking', `task ${task} lane evidence (no registered Invocation row)`, `Wave-9 integration row ${task} has no lane DoneClaim at ${path.join(evidenceRoot, rel ?? '')}`);
      else if (!resolved) add('LEDGER-WAVE9-EVIDENCE', 'blocking', `task ${task} lane evidence (no registered Invocation row)`, `Wave-9 integration row ${task} DoneClaim head ${claim.head} does not resolve to a commit in the audited tree`);
      ledger.push(entry);
      continue;
    }
    if (!existsSync(dir)) { entry.state = 'missing-dir'; add('LEDGER-MISSING-DIR', 'blocking', 'Verification strategy', `task ${task} evidence directory missing: searched ${dir}${task <= 19 && !ledgerWorktrees ? ' (tasks 1-19 predate the unified ledger; configure the campaign ledger-worktree root with VIS_F1_LEDGER_WORKTREES)' : ''}`); ledger.push(entry); continue; }
    const happy = readJson(path.join(dir, 'happy.json'));
    const failure = readJson(path.join(dir, 'failure.json'));
    const result = readJson(path.join(dir, 'result.json'));
    if (task <= 5) {
      entry.rawVitest = result ? { total: result.numTotalTests, failed: result.numFailedTests, success: result.success } : null;
      if (!result || result.numFailedTests !== 0 || result.success !== true) add('LEDGER-LEGACY-RAW', 'blocking', `task ${task} Evidence row`, `raw Vitest receipt missing or not green`);
    } else {
      entry.happy = happy ? { status: happy.status, exitCode: happy.exitCode, assertions: happy.assertions } : null;
      entry.failure = failure ? { status: failure.status, exitCode: failure.exitCode } : null;
      if (!happy) add('LEDGER-HAPPY', 'blocking', `task ${task} Invocation row`, `task ${task} has no happy.json (no runner-shaped happy evidence; see LEDGER-CASE-MODULE)`);
      else if (happy.status !== 'passed' || happy.exitCode !== 0 || !(happy.assertions > 0)) add('LEDGER-HAPPY', 'blocking', `task ${task} Invocation row`, `task ${task} happy evidence is not runner-green (status ${happy.status}, exitCode ${happy.exitCode})`);
      if (!failure) add('LEDGER-FAILURE', 'blocking', `task ${task} Failure QA row`, `task ${task} has no failure.json`);
      else if (failure.status !== 'passed') add('LEDGER-FAILURE', 'blocking', `task ${task} Failure QA row`, `task ${task} failure evidence is not green (status ${failure.status})`);
    }
    ledger.push(entry);
  }
  // task-6 normalization ledger for the pre-runner tasks: the unified evidence
  // tree first, then the explicitly configured ledger worktrees.
  const normalization = readJson(path.join(evidenceRoot, 'task-6/normalization.json'))
    ?? (ledgerWorktrees ? readJson(path.join(ledgerWorktrees, 'vis-v090-task-6/.omo/evidence/vis-v090/task-6/normalization.json')) : null);
  const normalized = [...new Set((normalization ?? []).map((e) => e.task))].sort((a, b) => a - b);
  for (const task of [1, 2, 3, 4, 5]) if (!normalized.includes(task)) add('LEDGER-NORMALIZATION', 'blocking', 'Verification strategy (task 6 normalization)', `task ${task} has no normalized happy/failure.json in the unified ledger`);
  // runner case modules (plan line 221: every task owns runtime-v090-cases/task-N.mjs)
  const missingModules = [];
  const unregisteredRows = [];
  for (let task = 6; task <= 56; task++) {
    // Rows 49-56 own no registered --task invocation: the runner's selector
    // accepts 1-48 only (plan line 221 registers exactly 1-48) and those rows
    // carry no Invocation line, so no case module can be registered for them.
    // Recorded explicitly — the module audit's scope exclusion must be visible,
    // not silent.
    if (task > 48) { unregisteredRows.push(task); continue; }
    if (!existsSync(path.join(root, 'scripts/qa/runtime-v090-cases', `task-${task}.mjs`))) missingModules.push(task);
  }
  for (const task of missingModules) add('LEDGER-CASE-MODULE', 'blocking', 'plan line 221 (task 6 ownership)', `scripts/qa/runtime-v090-cases/task-${task}.mjs missing — the registered --task ${task} invocation cannot run`);
  const missingVerifiers = ['F2', 'F3', 'F4'].filter((v) => !existsSync(path.join(root, 'scripts/qa/runtime-v090-cases', `verify-${v}.mjs`)));

  // -- 3. dependency ordering ---------------------------------------------------
  // Bound heads are QA-run heads, not delivery commits: a blocker's QA is often
  // re-run at a later shared head, so "blocker head is an ancestor of task head"
  // is too strict. Three checks are used:
  //  (a) same-line: the two QA heads sit on one delivery line (no divergence);
  //  (b) delivery-order: every blocker's DELIVERY head is an ancestor of the
  //      task's delivery head (heads below are the delivery heads recorded in
  //      each lane's delivery receipts, resolved through git);
  //  (c) evidence-binding: the task's happy.json productionRevision must
  //      contain its blockers' delivery heads — the evidence must bind to bytes
  //      that already include the blocker's delivery.
  const DELIVERY_HEADS = {
    19: '49b5b8b62', 20: 'a8ee4d9e8', 21: 'a55b743e9', 22: '09470c6d4', 23: '081ff620a',
    24: 'e0f83b871', 25: '18d8ae82b', 26: '0ebcbe00e', 27: '0ebcbe00e', 28: '495370ca9',
    29: '3418809f1', 30: '395a828bf', 41: 'f8ea4a14f', 42: '07b495f39',
  };
  const resolve = (short) => { try { return git(root, 'rev-parse', short); } catch { return null; } };
  const deliveryHeads = {};
  for (const [task, short] of Object.entries(DELIVERY_HEADS)) deliveryHeads[task] = resolve(short);
  const heads = {};
  for (let task = 1; task <= 56; task++) heads[task] = boundHead(task, inputs);
  const contains = (a, c) => { try { execFileSync('git', ['merge-base', '--is-ancestor', a, c], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } };
  const edgeChecks = [];
  for (const [t, blockers] of Object.entries(DEPENDS)) {
    const task = Number(t);
    for (const b of blockers) {
      if (!heads[task] || !heads[b]) { edgeChecks.push({ task, blocker: b, state: 'unresolved-heads' }); continue; }
      const sameLine = heads[task] === heads[b] || contains(heads[b], heads[task]) || contains(heads[task], heads[b]);
      edgeChecks.push({ task, blocker: b, sameLine });
      if (!sameLine) add('DEP-BLOCKER-DIVERGENT', 'blocking', 'Dependency matrix', `task ${task} and blocker ${b} evidence heads are on divergent branches`);
      const deliveryB = deliveryHeads[b];
      if (deliveryB && heads[task] && !contains(deliveryB, heads[task])) add('DEP-EVIDENCE-BINDING', 'blocking', 'Dependency matrix + Verification strategy (evidence binds productionRevision)', `task ${task} happy.json binds ${heads[task].slice(0, 10)} which does not contain blocker ${b} delivery head ${deliveryB.slice(0, 10)}`);
      const deliveryT = deliveryHeads[task];
      // A blocker RE-delivery (follow-up fixes) can land after the dependent task
      // was built on the blocker's original delivery — the same soft class the F1
      // dependency lane reports as time violations. Recorded as informational.
      if (deliveryB && deliveryT && !contains(deliveryB, deliveryT)) add('DEP-DELIVERY-ORDER', 'non-blocking', 'Dependency matrix', `task ${task} delivery head predates blocker ${b} final delivery head ${deliveryB.slice(0, 10)} (blocker re-delivery after the dependent task; dependent built on the blocker's earlier delivery)`);
    }
  }

  // -- 4. final digest binding -------------------------------------------------
  // The target revision is the head the evidence's OWN final manifest records,
  // unless an explicit finalHead input overrides it. A hardcoded revision here
  // would silently re-target the audit at one past tree.
  const manifest = readJson(path.join(evidenceRoot, 'final/revision-manifest.json'));
  const finalHead = inputs.finalHead ?? manifest?.finalSourceDigest?.head ?? null;
  if (!finalHead) add('PREREQUISITE-FINAL-HEAD', 'blocking', 'final revision manifest', `no target revision available: neither an explicit finalHead input (context.finalHead / VIS_F1_FINAL_HEAD) nor finalSourceDigest.head in ${path.join(evidenceRoot, 'final/revision-manifest.json')}`);
  let digestState = 'missing-manifest';
  let digestObserved = null;
  if (manifest) {
    const recomputed = freezeDigest(root);
    const claimed = manifest.finalSourceDigest;
    digestObserved = { claimed: claimed.digest, recomputed: recomputed.digest, claimedFiles: claimed.fileCount, recomputedFiles: recomputed.fileCount };
    digestState = recomputed.digest === claimed.digest ? 'match' : 'mismatch';
    if (digestState === 'mismatch') add('DIGEST-STALE', 'blocking', 'task 48 Happy QA (plan line 727)', `frozen digest ${claimed.digest.slice(0, 12)}… over ${claimed.fileCount} files no longer matches the tree (recomputed ${recomputed.digest.slice(0, 12)}… over ${recomputed.fileCount} files); a post-freeze production change requires re-freeze`);
    if (recomputed.fileCount !== claimed.fileCount) add('DIGEST-FILECOUNT', 'blocking', 'task 48 Happy QA', `file count ${recomputed.fileCount} != frozen ${claimed.fileCount}`);
    const rootHead = (() => { try { return git(root, 'rev-parse', 'HEAD'); } catch { return null; } })();
    if (finalHead && rootHead !== finalHead) add('HEAD-DRIFT', 'blocking', 'final revision manifest', rootHead === null ? `the audited checkout ${root} has no resolvable HEAD (not a git repository, or no commits), so it cannot be shown to sit at the frozen revision ${finalHead.slice(0, 10)}` : `audited checkout head ${rootHead.slice(0, 10)} drifted from the frozen revision ${finalHead.slice(0, 10)}`);
  } else add('DIGEST-MANIFEST-MISSING', 'blocking', 'task 48 Happy QA', `final/revision-manifest.json missing from ${evidenceRoot}`);

  // -- 5. downstream reruns -----------------------------------------------------
  const downstream = [];
  for (const [file, scenarios, runnerBound] of DOWNSTREAM) {
    const report = readJson(path.join(evidenceRoot, 'task-48', file));
    const row = { file, exists: Boolean(report), scenarios: report?.scenarios?.length ?? report?.scenarioCount ?? null, expected: scenarios, runnerBound };
    if (!report) { add('DOWNSTREAM-MISSING', 'blocking', 'task 48 Happy QA', `downstream rerun report ${file} missing`); downstream.push(row); continue; }
    if (row.scenarios !== scenarios) add('DOWNSTREAM-COUNT', 'blocking', 'task 48 Happy QA', `${file} scenarios ${row.scenarios} != manifest ${scenarios}`);
    if (runnerBound) {
      row.productionRevision = report.productionRevision ?? null;
      row.sourceHashes = report.sourceHashes ? Object.keys(report.sourceHashes).length : 0;
      if (finalHead && report.productionRevision !== finalHead) add('DOWNSTREAM-REVISION', 'blocking', 'task 48 Happy QA', `${file} productionRevision ${report.productionRevision} != frozen head ${finalHead}`);
      const drifted = Object.entries(report.sourceHashes ?? {}).filter(([rel, hash]) => { const p = path.join(root, rel); return !existsSync(p) || sha256(p) !== hash; }).map(([rel]) => rel);
      if (drifted.length) add('DOWNSTREAM-SOURCE-HASH', 'blocking', 'task 48 Happy QA', `${file} source hashes drifted: ${drifted.slice(0, 3).join(', ')}`);
    } else {
      add('DOWNSTREAM-UNBOUND', 'non-blocking', 'plan line 221 (task 6 ownership)', `${file} is a direct-script artifact with no runner productionRevision/sourceHashes binding`);
    }
    downstream.push(row);
  }

  // -- 6. task-19 correction bytes in the audited tree -------------------------
  const task19 = Object.entries(TASK19_DELIVERY).map(([rel, expected]) => {
    const p = path.join(root, rel);
    return { file: rel, match: existsSync(p) && sha256(p) === expected };
  });
  for (const row of task19) if (!row.match) add('TASK19-CORRECTION-BYTES', 'blocking', 'plan lines 404-405', `${row.file} does not match the delivered correction bytes`);

  // -- 7. contract surfaces + version ------------------------------------------
  const missingSurfaces = SURFACES.filter((rel) => !existsSync(path.join(root, rel)));
  for (const rel of missingSurfaces) add('CONTRACT-SURFACE-MISSING', 'blocking', 'Scope contracts 1-16', `delivered surface missing: ${rel}`);
  const packageVersion = readJson(path.join(root, 'package.json'))?.version;
  if (packageVersion !== '0.9.0-alpha') add('VERSION', 'blocking', 'task 47', `package.json version ${packageVersion} != 0.9.0-alpha`);

  // -- 8. declared artifacts, resolved inside the evidence tree ------------------
  // Listed only when present (a listed artifact is re-verified downstream), and
  // a missing one is a finding, never a silent drop.
  const declared = [
    [path.join(evidenceRoot, 'final/revision-manifest.json'), 'final-revision-manifest'],
    [path.join(evidenceRoot, 'task-48-gate/DoneClaim.json'), 'task-48-gate-claim'],
  ];
  const artifacts = [];
  for (const [file, kind] of declared) {
    if (existsSync(file)) artifacts.push(artifact(file, kind));
    else add('ARTIFACT-MISSING', 'non-blocking', 'task 48 Happy QA', `declared artifact ${kind} not found at ${file}`);
  }

  return {
    checks: { rows: rows.length, taskRows: taskRows.length, uncheckedTasks: uncheckedTasks.map((r) => r.id), uncheckedItems: uncheckedItems.map((r) => ({ line: r.line, title: r.title })), uncheckedFinalWave, ledger, normalized, missingModules, unregisteredRows, missingVerifiers, edgeChecks, digestState, digestObserved, downstream, wave9, task19, missingSurfaces, packageVersion, finalHead, evidenceRoot, planPath, root },
    findings,
    artifacts,
  };
}

const summarize = (auditResult) => {
  const blocking = auditResult.findings.filter((f) => f.severity === 'blocking');
  return { verdict: blocking.length ? 'NOT_APPROVE' : 'APPROVE', blockingCount: blocking.length, findings: auditResult.findings, checks: auditResult.checks };
};

// ------------------------------------------------------------------ lanes

export async function run(context) {
  const startedAt = new Date().toISOString();
  assert(context.verify === 'F1', 'this module is the F1 verifier registration');
  const lane = context.case ?? (/F1-negative/.test(path.basename(context.out)) ? 'failure' : 'happy');
  assert(['happy', 'failure'].includes(lane), 'unknown F1 lane');
  const inputs = auditInputs(context);
  if (lane === 'happy') {
    // A missing plan or evidence tree is a LOCATED prerequisite failure naming
    // the path and the input that configures it — never a bare ENOENT from deep
    // inside the audit, and never a silent audit of some other machine's tree.
    if (!existsSync(inputs.planPath)) throw new Error(`F1 prerequisite missing: the plan file ${inputs.planPath} does not exist (set --plan/VIS_F1_PLAN or run in a checkout that carries .omo/plans/vis-v090-unified-runtime.md)`);
    if (!existsSync(inputs.evidenceRoot)) throw new Error(`F1 prerequisite missing: the evidence tree ${inputs.evidenceRoot} does not exist (set --evidence-root/VIS_F1_EVIDENCE_ROOT or run in a checkout that carries the ledger)`);
    const result = summarize(audit(inputs));
    const greenGaps = result.findings.filter((f) => ['LEDGER-HAPPY', 'LEDGER-FAILURE', 'LEDGER-LEGACY', 'LEDGER-MISSING-DIR'].includes(f.id));
    const edgeViolations = result.findings.filter((f) => f.id === 'DEP-BLOCKER-DIVERGENT');
    const evidenceBindingViolations = result.findings.filter((f) => f.id === 'DEP-EVIDENCE-BINDING');
    const softDeliveryOrder = result.findings.filter((f) => f.id === 'DEP-DELIVERY-ORDER');
    const downstreamGaps = result.findings.filter((f) => ['DOWNSTREAM-MISSING', 'DOWNSTREAM-COUNT', 'DOWNSTREAM-REVISION', 'DOWNSTREAM-SOURCE-HASH'].includes(f.id));
    const wave9Gaps = result.findings.filter((f) => f.id === 'LEDGER-WAVE9-EVIDENCE');
    const wave9Bound = result.checks.wave9.filter((r) => r.resolved).map((r) => r.task);
    return {
      scenario: 'F1 plan compliance audit — complete ledger',
      verdict: result.verdict,
      findings: result.findings,
      // The resolved inputs ride with the evidence, so a runner-bound manifest
      // proves WHICH tree, evidence root, plan and target revision were audited
      // — the claim and the audited bytes can no longer silently diverge.
      checks: result.checks,
      requiredTaskRows: result.findings.filter((f) => f.severity === 'blocking').map((f) => `- [ ] N. [${f.planLine}] ${f.id}: ${f.detail}`),
      startedAt,
      finishedAt: new Date().toISOString(),
      scenarios: [{
        name: 'complete-ledger audit of the real evidence tree',
        assertions: [
          { name: 'plan has 56 numbered rows and EVERY one of them is checked — the 8 Wave-9 integration rows 49-56 (tasks 49-53 integration, 54 this runner/verify-module task, 55 the F2 negative controls, 56 the evidence-ledger re-freeze) all landed; both task-19 registered correction rows are checked; only the 4 final-wave rows F1-F4 remain open', passed: result.checks.taskRows === 56 && result.checks.uncheckedTasks.length === 0 && result.checks.uncheckedItems.length === 0 && result.checks.uncheckedFinalWave.join(',') === 'F1,F2,F3,F4', observed: { taskRows: result.checks.taskRows, uncheckedTasks: result.checks.uncheckedTasks, uncheckedItems: result.checks.uncheckedItems, uncheckedFinalWave: result.checks.uncheckedFinalWave }, expected: { taskRows: 56, uncheckedTasks: [], uncheckedItems: [], uncheckedFinalWave: ['F1', 'F2', 'F3', 'F4'] } },
          { name: 'runner-shaped happy/failure evidence is green for every task except the three direct-script lanes 45/46/48', passed: greenGaps.every((f) => /task (45|46|48)/.test(f.detail)), observed: { outsideGaps: greenGaps.filter((f) => !/task (45|46|48)/.test(f.detail)).length, directLaneGaps: greenGaps.map((f) => f.detail) }, expected: { outsideGaps: 0, directLaneGaps: greenGaps.map((f) => f.detail) } },
          { name: 'task-6 normalization ledger covers every pre-runner task 1-5 — the task-3/task-4 normalization gap row 56 was required to close is closed, so no pre-runner task is left unnormalized', passed: JSON.stringify(result.checks.normalized) === JSON.stringify([1, 2, 3, 4, 5]), observed: { normalized: result.checks.normalized }, expected: { normalized: [1, 2, 3, 4, 5] } },
          { name: 'every task 6-48 owns its registered case module — the task-24/25/27 backfill and the task-45/46/48 modules have all landed in the tree since the F1 review head, so no registered --task invocation is blocked by a missing module — and the eight Wave-9 rows 49-56 are explicitly recorded as owning no registered invocation (the runner selector accepts 1-48 only and those rows carry no Invocation line), so the module audit\'s scope exclusion is visible rather than silent', passed: result.checks.missingModules.length === 0 && JSON.stringify(result.checks.unregisteredRows) === JSON.stringify([49, 50, 51, 52, 53, 54, 55, 56]), observed: { missingModules: result.checks.missingModules, unregisteredRows: result.checks.unregisteredRows }, expected: { missingModules: [], unregisteredRows: [49, 50, 51, 52, 53, 54, 55, 56] } },
          { name: 'every dependency edge sits on one delivery line (no divergent parallel development) and exactly one soft re-delivery order case exists (task 21 product commit predates task 20 round-2 re-delivery)', passed: edgeViolations.length === 0 && softDeliveryOrder.length === 1 && /task 21/.test(softDeliveryOrder[0].detail), observed: { divergent: edgeViolations.length, softDeliveryOrder: softDeliveryOrder.map((f) => f.detail), edgesChecked: result.checks.edgeChecks.length }, expected: { divergent: 0, softDeliveryOrder: softDeliveryOrder.map((f) => f.detail), edgesChecked: 320 } },
          { name: 'every task happy.json binds a head that contains all of its blockers\' delivery heads — the task-20 evidence was re-captured at a head containing blocker 19 delivery head 49b5b8b62, so the evidence-binding defect the first pass recorded is closed and zero edges violate it', passed: evidenceBindingViolations.length === 0, observed: { bindings: evidenceBindingViolations.map((f) => f.detail) }, expected: { bindings: [] } },
          { name: 'frozen final digest matches the current tree — the digest was re-frozen over the final tree after every product change landed, so the post-freeze staleness the first pass recorded is closed (a stale digest is more dangerous than a missing one, so this row must be a MATCH, never a tolerated mismatch)', passed: result.checks.digestState === 'match', observed: { digestState: result.checks.digestState, digestObserved: result.checks.digestObserved }, expected: { digestState: 'match', digestObserved: result.checks.digestObserved } },
          { name: 'all nine downstream rerun reports exist with the manifest scenario counts and ZERO of them are missing, short, revision-drifted or source-hash drifted — the two missing task-44-performance copies were re-landed and every head-bound artifact was re-run/re-bound against the final head, so the whole downstream set binds the current tree', passed: downstreamGaps.filter((f) => f.id !== 'DOWNSTREAM-UNBOUND').length === 0, observed: { reports: result.checks.downstream.map((d) => `${d.file}:${d.scenarios}/${d.expected}`), nonUnboundGaps: downstreamGaps.filter((f) => f.id !== 'DOWNSTREAM-UNBOUND').map((f) => `${f.id}: ${f.detail}`) }, expected: { reports: result.checks.downstream.map((d) => `${d.file}:${d.expected}/${d.expected}`), nonUnboundGaps: [] } },
          { name: 'runner-bound downstream receipts bind to the final head with ZERO revision drift and ZERO source-hash drift, and the five direct-script lanes are still flagged unbound — the four runner-bound reports (task-43 happy/failure, task-44 happy/failure) were re-run against the current runner bytes, so nothing in the downstream set still reads the pre-change tree', passed: result.findings.filter((f) => f.id === 'DOWNSTREAM-REVISION').length === 0 && result.findings.filter((f) => f.id === 'DOWNSTREAM-SOURCE-HASH').length === 0 && result.findings.filter((f) => f.id === 'DOWNSTREAM-UNBOUND').length === 5, observed: { unbound: ['packaged/happy.json', 'task-46-live-ssh.json', 'task-46-live-ssh-failure.json', 'task-46-live-slurm.json', 'task-46-live-slurm-failure.json'].filter((f) => result.findings.some((x) => x.id === 'DOWNSTREAM-UNBOUND' && x.detail.startsWith(f))), sourceHashDrift: result.findings.filter((f) => f.id === 'DOWNSTREAM-SOURCE-HASH').map((f) => f.detail) }, expected: { unbound: ['packaged/happy.json', 'task-46-live-ssh.json', 'task-46-live-ssh-failure.json', 'task-46-live-slurm.json', 'task-46-live-slurm-failure.json'], sourceHashDrift: [] } },
          { name: 'task-19 correction bytes (commit 49b5b8b62, native Windows CI green) are byte-identical in the final tree', passed: result.checks.task19.every((r) => r.match), observed: { matches: result.checks.task19.filter((r) => r.match).length, total: result.checks.task19.length }, expected: { matches: result.checks.task19.length, total: result.checks.task19.length } },
          { name: 'contract 1-16 delivery surfaces present and package version is 0.9.0-alpha', passed: result.checks.missingSurfaces.length === 0 && result.checks.packageVersion === '0.9.0-alpha', observed: { missingSurfaces: result.checks.missingSurfaces, packageVersion: result.checks.packageVersion }, expected: { missingSurfaces: [], packageVersion: '0.9.0-alpha' } },
          { name: 'every Wave-9 integration row 49-56 carries its lane evidence — the task-49-53 App.vue integration DoneClaim (rows 49/51/52/53), the task-50 seeding-and-scoring DoneClaim, the task-54 selector/verify-module DoneClaim, the F2 DoneClaim for row 55 and the task-56 ledger/re-freeze DoneClaim each exist and bind a real head on the final delivery line', passed: wave9Gaps.length === 0 && wave9Bound.length === 8, observed: { boundRows: wave9Bound, gaps: wave9Gaps.map((f) => f.detail) }, expected: { boundRows: [49, 50, 51, 52, 53, 54, 55, 56], gaps: [] } },
        ],
      }],
      artifacts: result.artifacts,
      versions: { audit: 'F1-plan-compliance', node: process.version },
    };
  }

  // ---- failure lane: mutate a COPY and require rejection --------------------
  // The seeds come from the SAME explicit inputs as the happy lane; a missing
  // seed is a located prerequisite failure, not an ENOENT from copyFileSync.
  const scratch = path.join(context.temporaryRoot ?? path.join(tmpdir(), `f1-negative-${process.pid}`), 'f1-negative');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const copyEvidence = path.join(scratch, 'evidence');
  const planCopy = path.join(scratch, 'plan.md');
  mkdirSync(copyEvidence, { recursive: true });
  copyFileSync(inputs.planPath, planCopy);
  for (const rel of ['final/revision-manifest.json', 'task-48/task-43-system.json', 'task-44/happy.json']) {
    const source = path.join(inputs.evidenceRoot, rel);
    if (!existsSync(source)) throw new Error(`F1 failure lane prerequisite missing: ${source} (configure the evidence root with --evidence-root/VIS_F1_EVIDENCE_ROOT)`);
    const dest = path.join(copyEvidence, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(source, dest);
  }
  const readCopy = (rel) => readFileSync(path.join(copyEvidence, rel), 'utf8');
  const writeCopy = (rel, text) => writeFileSync(path.join(copyEvidence, rel), text);

  const mutations = [];
  const applyMutation = (id, detect, mutate) => {
    mutate();
    const result = summarize(audit({ ...inputs, evidenceRoot: copyEvidence, planPath: planCopy }));
    const hit = result.findings.find(detect);
    mutations.push({ id, detected: Boolean(hit), finding: hit ? { id: hit.id, detail: hit.detail } : null, totalFindings: result.findings.length });
    assert(hit, `mutation ${id} was NOT rejected — the audit ignored the tampered copy`);
  };

  applyMutation('LEDGER-HAPPY', (f) => f.id === 'LEDGER-HAPPY' && /task 44/.test(f.detail), () => rmSync(path.join(copyEvidence, 'task-44/happy.json'), { force: true }));
  applyMutation('DOWNSTREAM-REVISION', (f) => f.id === 'DOWNSTREAM-REVISION' && /task-43-system\.json/.test(f.detail), () => {
    const report = JSON.parse(readCopy('task-48/task-43-system.json'));
    report.productionRevision = '0'.repeat(40);
    writeCopy('task-48/task-43-system.json', JSON.stringify(report, null, 2));
  });
  applyMutation('DIGEST-STALE', (f) => f.id === 'DIGEST-STALE' && /f{12}/.test(f.detail), () => {
    const manifest = JSON.parse(readCopy('final/revision-manifest.json'));
    manifest.finalSourceDigest.digest = 'f'.repeat(64);
    writeCopy('final/revision-manifest.json', JSON.stringify(manifest, null, 2));
  });
  applyMutation('DIGEST-MANIFEST-MISSING', (f) => f.id === 'DIGEST-MANIFEST-MISSING', () => rmSync(path.join(copyEvidence, 'final/revision-manifest.json'), { force: true }));
  applyMutation('PLAN-UNCHECKED-TODO', (f) => f.id === 'PLAN-UNCHECKED-TODO' && /row 42/.test(f.detail), () => {
    writeFileSync(planCopy, readFileSync(inputs.planPath, 'utf8').replace('- [x] 42. 实现Team任务与改动审查界面', '- [ ] 42. 实现Team任务与改动审查界面'));
  });
  rmSync(scratch, { recursive: true, force: true });

  return {
    scenario: 'F1 plan compliance audit — negative controls over a mutated copy',
    startedAt,
    finishedAt: new Date().toISOString(),
    mutations,
    scenarios: [{
      name: 'rejection controls over a mutated evidence copy',
      assertions: mutations.map((m) => ({ name: `mutation ${m.id} is rejected by the audit`, passed: m.detected, observed: { detected: m.detected, finding: m.finding }, expected: { detected: true, finding: m.finding } })),
    }],
    artifacts: [],
    versions: { audit: 'F1-plan-compliance', node: process.version },
  };
}
