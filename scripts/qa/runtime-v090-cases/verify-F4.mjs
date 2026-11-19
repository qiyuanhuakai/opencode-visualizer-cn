// F4 joins the plan citations and the reviewer assessment for the current
// candidate. The negative lane checks that missing plan evidence is detected.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifact, validateEvidence } from '../runtime-v090-evidence.mjs';

export const sourceFiles = [
  'scripts/qa/runtime-v090.mjs',
  'scripts/qa/runtime-v090-evidence.mjs',
  'scripts/qa/runtime-v090-cases/verify-F4.mjs',
];

const WORKTREES = '/home/qiyuaner/apps/vis_app/vis-wt';
const PLAN_LINE = 'Success criteria table (plan lines 793-802)';

// The eight rows verbatim from the plan's Success criteria table (plan lines 793-802).
const ROWS = Object.freeze([
  { is: 'IS-1', title: '一次连接，按 repository/worktree 浏览全部已支持来源，显示 Harness 标识；非 Git、孤立、归档和原生子会话可发现', paths: ['task-13/happy.json', 'task-14/happy.json', 'task-21/', 'task-43/happy.json', 'final/F3.json'] },
  { is: 'IS-2', title: '1 万会话/200 worktree/5 类来源渐进可用，10 万压力档缓存有界；完整性、错误与加载状态真实', paths: ['task-12/', 'task-18/failure.json', 'task-20/', 'task-44/standard.json', 'task-44/stress.json'] },
  { is: 'IS-3', title: '多会话同时运行；发送、权限、模型、附件、取消、历史始终属于正确的会话和环境', paths: ['task-15/', 'task-22/', 'task-43/failure.json', 'final/F2.json'] },
  { is: 'IS-4', title: '旧历史、草稿、收藏、辅助元数据完整迁移；备份、重试、恢复和歧义绑定可验证', paths: ['task-11/', 'task-12/', 'task-20/', 'task-24/', 'task-36/', 'task-44/', 'task-45/', 'final/F3.json'] },
  { is: 'IS-5', title: 'Local/direct/SSH/Slurm 可用；断线与作业退出分离；文件、Git、PTY、工具在同一目标环境', paths: ['task-26/', 'task-28/', 'task-29/', 'task-46/ssh.json', 'task-46/slurm.json', 'final/F3.json'] },
  { is: 'IS-6', title: '原生能力保留，驱动有契约/能力声明；缺失能力、来源故障和版本不兼容明确呈现', paths: ['task-4/', 'task-13/', 'task-14/', 'task-15/', 'task-16/', 'task-17/', 'task-23/', 'task-27/', 'task-43/', 'task-47/'] },
  { is: 'IS-7', title: '一个 Host Thread 可加入多 Harness 并接力，原生会话绑定独立；上下文有预算、来源和按需证据', paths: ['task-31/', 'task-33/', 'task-34/', 'task-35/', 'final/F3.json'] },
  { is: 'IS-8', title: 'fan-out、Lead/Worker、Team/Task/Attempt 并发协作，有恢复、取消、审查与隔离改动集成', paths: ['task-37/', 'task-38/', 'task-39/', 'task-40/', 'task-41/', 'task-42/', 'task-43/', 'final/F2.json', 'final/F3.json'] },
]);
const UNIQUE_PATHS = [...new Set(ROWS.flatMap((row) => row.paths))];
const TOTAL_CITATIONS = ROWS.reduce((sum, row) => sum + row.paths.length, 0);
const PASSING = new Set(['passed', 'recorded', 'done']);

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Resolution: the given root first, then the owning task worktree (live root only). */
function resolve(rel, root, evidenceRoot) {
  const local = path.join(root, rel);
  if (existsSync(local)) return { found: true, abs: local, origin: root === evidenceRoot ? 'integration-worktree' : 'negative-copy' };
  if (root === evidenceRoot) {
    const match = /^task-(\d+)\//.exec(rel);
    if (match) {
      const taskWorktree = path.join(WORKTREES, `vis-v090-task-${match[1]}`, '.omo/evidence/vis-v090', rel);
      if (existsSync(taskWorktree)) return { found: true, abs: taskWorktree, origin: `worktree vis-v090-task-${match[1]}` };
    }
  }
  return { found: false, abs: local, origin: null };
}

function probe(file) {
  let status = null; let scenarios = null; let assertions = null; let parseError = null;
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    status = manifest.status ?? null;
    scenarios = manifest.scenarioCount ?? (Array.isArray(manifest.scenarios) ? manifest.scenarios.length : null);
    assertions = manifest.assertions ?? manifest.assertionCount ?? null;
  } catch (error) { parseError = error instanceof Error ? error.message : String(error); }
  return { status, scenarios, assertions, parseError };
}

/** The join itself: every cited path resolved, hashed and classified; the verdict is derived. */
function runJoin(root, evidenceRoot) {
  const rows = [];
  const missing = [];
  for (const row of ROWS) {
    const proofs = [];
    for (const rel of row.paths) {
      const resolved = resolve(rel, root, evidenceRoot);
      if (!resolved.found) { missing.push(`${row.is}:${rel}`); proofs.push({ path: rel, present: false, proof: false, reason: 'absent' }); continue; }
      const isDirectory = statSync(resolved.abs).isDirectory();
      const entry = { path: rel, present: true, origin: resolved.origin, sha256: isDirectory ? null : sha256(resolved.abs), bytes: isDirectory ? null : statSync(resolved.abs).size };
      if (isDirectory) { entry.proof = true; entry.kind = 'directory'; } else {
        const observed = probe(resolved.abs);
        Object.assign(entry, observed);
        entry.kind = 'manifest';
        // A cited MANIFEST proves its row only when it parses AND carries a status
        // in the PASSING set. The previous rule was
        // `observed.status === null ? true : PASSING.has(observed.status)`, so a
        // manifest whose `status` key was deleted — or which failed to parse at
        // all, which `probe` used to swallow into the same `status === null` —
        // passed by default. That is a never-true branch, the same structural
        // family as a check whose expected block mirrors its own observation.
        // Presence alone is the proof for a DIRECTORY (graded by kind above),
        // never for a manifest.
        entry.proof = observed.parseError === null && observed.status !== null && PASSING.has(observed.status);
        if (!entry.proof) missing.push(`${row.is}:${rel}(status=${observed.status}${observed.parseError === null ? '' : ',unparseable'})`);
      }
      proofs.push(entry);
    }
    rows.push({ is: row.is, title: row.title, proofs, rowComplete: proofs.every((proof) => proof.proof) });
  }
  const allComplete = rows.every((row) => row.rowComplete);
  return { label: root === evidenceRoot ? 'live' : 'negative-copy', verdict: allComplete ? 'PASS' : 'REJECT', rows, missing, generatedAt: new Date().toISOString() };
}

export function assertFinalVerifierReceipt(receipt, root, revision, verifier) {
  validateEvidence(receipt, root);
  assert.equal(receipt.productionRevision, revision, `${verifier} belongs to a different candidate`);
  assert.equal(receipt.selector.verify, verifier, `expected a ${verifier} receipt`);
  assert.equal(receipt.selector.case, 'happy', `${verifier} requires an explicit --case happy receipt`);
}

export async function run(context) {
  assert(context.verify === 'F4', 'this module is the F4 verifier registration');
  const lane = context.case ?? (/F4-negative/.test(path.basename(context.out)) ? 'failure' : 'happy');
  assert(['happy', 'failure'].includes(lane), 'unknown F4 lane');
  const root = context.root;
  const evidenceRoot = context.evidenceRoot ?? path.join(root, '.omo/evidence/vis-v090');
  const detailDir = path.join(root, '.omo/evidence/vis-v090/task-54/verify-F4');
  mkdirSync(detailDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const check = (name, observed, expected, surface) => {
    const left = JSON.parse(JSON.stringify(observed));
    const right = JSON.parse(JSON.stringify(expected));
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface, assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };

  if (lane === 'happy') {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const revision = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'F4 requires the tracked candidate checkout');
    const assessmentPath = path.join(evidenceRoot, 'final', 'F4-assessment.json');
    const assessment = JSON.parse(readFileSync(assessmentPath, 'utf8'));
    check('the assessment binds the current candidate', { revision: assessment.productionRevision, tree: assessment.productionTree }, { revision, tree }, assessmentPath);
    artifacts.push(artifact(assessmentPath, 'f4-reviewer-assessment'));
    for (const verifier of ['F1', 'F2', 'F3']) {
      const file = path.join(evidenceRoot, 'final', `${verifier}.json`);
      const receipt = JSON.parse(readFileSync(file, 'utf8'));
      assertFinalVerifierReceipt(receipt, root, revision, verifier);
      check(`the candidate has a genuine ${verifier} happy receipt`, { revision: receipt.productionRevision, verifier: receipt.selector.verify, lane: receipt.selector.case }, { revision, verifier, lane: 'happy' }, file);
      artifacts.push(artifact(file, 'f4-final-verifier'));
    }
    assert.equal(typeof assessment.reviewer, 'string', 'reviewer identity required');
    assert(assessment.reviewer.trim(), 'reviewer identity required');
    assert.deepEqual(assessment.rows.map((row) => row.id).sort(), ROWS.map((row) => row.is), 'review must cover all eight IS rows');
    for (const row of assessment.rows) {
      assert(typeof row.finding === 'string' && row.finding.trim(), `${row.id} requires a reviewer finding`);
      assert(Array.isArray(row.proofs) && row.proofs.length > 0, `${row.id} requires release proof files`);
      const expected = ROWS.find((entry) => entry.is === row.id).paths.filter((file) => !file.startsWith('final/'));
      let covered = false;
      for (const proof of row.proofs) {
        assert(typeof proof.path === 'string' && !path.isAbsolute(proof.path), `${row.id} requires an evidence-relative path`);
        const file = path.resolve(evidenceRoot, proof.path);
        assert(!path.relative(evidenceRoot, file).startsWith('..'), `${row.id} proof is outside the evidence root`);
        const relative = path.relative(evidenceRoot, file).split(path.sep).join('/');
        covered ||= expected.some((citation) => citation.endsWith('/') ? relative.startsWith(citation) : relative === citation);
        assert(statSync(file).isFile(), `${row.id} requires a proof file`);
        const bound = artifact(file, 'f4-reviewed-proof');
        assert.equal(bound.sha256, proof.sha256, `${row.id} proof digest mismatch: ${proof.path}`);
        artifacts.push(bound);
      }
      assert(covered, `${row.id} requires a file from its own plan citations`);
      check(`${row.id} meets the plan in the reviewer assessment`, row.verdict, 'met', assessmentPath);
    }
    const join = runJoin(evidenceRoot, evidenceRoot);
    const fileProofs = join.rows.flatMap((row) => row.proofs).filter((proof) => proof.kind === 'manifest');
    check('the join table is the plan\'s Success criteria table exactly: eight IS rows, every cited path present in the table with no invented or dropped citation', { rows: ROWS.length, uniquePaths: UNIQUE_PATHS.length, totalCitations: TOTAL_CITATIONS, rowIds: ROWS.map((row) => row.is) }, { rows: 8, uniquePaths: 43, totalCitations: 52, rowIds: ['IS-1', 'IS-2', 'IS-3', 'IS-4', 'IS-5', 'IS-6', 'IS-7', 'IS-8'] }, PLAN_LINE);
    check('every cited proof resolves and passes on the live tree: all 43 cited paths exist (a task lane\'s path resolves in its own worktree when absent from the integration root), every QA manifest among them carries a passing status, and the join verdict is therefore PASS with no missing entry', { verdict: join.verdict, missing: join.missing, rowsComplete: join.rows.filter((row) => row.rowComplete).length, rowsIncomplete: join.rows.filter((row) => !row.rowComplete).map((row) => row.is), fileProofs: fileProofs.length, directoryProofs: join.rows.flatMap((row) => row.proofs).filter((proof) => proof.kind === 'directory').length }, { verdict: 'PASS', missing: [], rowsComplete: 8, rowsIncomplete: [], fileProofs: fileProofs.length, directoryProofs: join.rows.flatMap((row) => row.proofs).filter((proof) => proof.kind === 'directory').length }, 'the eight-row join over the live evidence tree: every path resolved, hashed and status-classified');
    check('every file proof carries its sha256 and byte size, so the join binds the eight rows to the final artifact hashes and not to bare paths; the 16 file citations resolve to exactly the 11 distinct files the frozen table names (final/F3.json is cited by five rows, final/F2.json and the task-13/14 happy manifests by two each), and no two distinct files share a hash', { fileProofsWithHash: fileProofs.every((proof) => typeof proof.sha256 === 'string' && /^[0-9a-f]{64}$/.test(proof.sha256)), fileProofsWithBytes: fileProofs.every((proof) => Number.isInteger(proof.bytes) && proof.bytes > 0), fileCitations: fileProofs.length, distinctHashes: new Set(fileProofs.map((proof) => proof.sha256)).size, distinctFilePaths: UNIQUE_PATHS.filter((rel) => !rel.endsWith('/')).length }, { fileProofsWithHash: true, fileProofsWithBytes: true, fileCitations: 16, distinctHashes: 11, distinctFilePaths: 11 }, 'sha256 + byte size recorded for every file proof in the join, with the distinct-hash count equal to the distinct file paths the frozen Success-criteria table names');

    const perIsEvaluation = assessment;
    const report = { lane: 'happy', join: { verdict: join.verdict, missing: join.missing, rows: join.rows.map((row) => ({ is: row.is, complete: row.rowComplete, proofs: row.proofs.map((proof) => ({ path: proof.path, present: proof.present, proof: proof.proof, kind: proof.kind ?? null, status: proof.status ?? null, sha256: proof.sha256, bytes: proof.bytes, origin: proof.origin })) })) }, perIsEvaluation };
    writeFileSync(path.join(detailDir, 'happy-join.json'), `${JSON.stringify(report, null, 2)}\n`);
    artifacts.push(artifact(path.join(detailDir, 'happy-join.json'), 'f4-happy-join'));
    return {
      scenario: 'F4 ideal-state fidelity — the eight IS rows joined to the final artifact hashes',
      checkerVerdict: join.verdict,
      fidelityVerdict: perIsEvaluation,
      perIsEvaluation,
      scenarios,
      artifacts,
      versions: { node: process.version },
    };
  }

  // ── failure lane: delete/corrupt IS proofs in a self-contained copy and require rejection ────
  const scratch = path.join(context.temporaryRoot ?? mkdtempSync(path.join(tmpdir(), 'vis-f4-negative-')), 'f4-negative');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const copyRoot = path.join(scratch, 'evidence');
  // The copy is self-contained: every cited path is copied in at the same relative layout, so the
  // join's worktree fallback (live root only) cannot mask a deletion inside it.
  const copySources = UNIQUE_PATHS.map((rel) => ({ rel, resolved: resolve(rel, evidenceRoot, evidenceRoot) }));
  for (const entry of copySources) {
    assert(entry.resolved.found, `cited path ${entry.rel} did not resolve on the live tree — the copy cannot be built`);
    const destination = path.join(copyRoot, entry.rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (statSync(entry.resolved.abs).isDirectory()) mkdirSync(destination, { recursive: true });
    else copyFileSync(entry.resolved.abs, destination);
  }

  const baseline = runJoin(copyRoot, evidenceRoot);
  check('the copy is self-contained and faithful: with every cited path present the copy\'s join reproduces the live PASS verdict, so a later rejection is attributable to the injected deletion', { verdict: baseline.verdict, missing: baseline.missing, rowsComplete: baseline.rows.filter((row) => row.rowComplete).length }, { verdict: 'PASS', missing: [], rowsComplete: 8 }, 'the eight-row join over the negative copy before any mutation');

  // Every expectation is a frozen literal derived from the plan's table: which rows cite the path,
  // how many missing entries the mutation must produce, and which rows must flip to INCOMPLETE.
  //
  // The last two mutation classes are the ones the ORIGINAL proof rule could not reject: it read
  // `observed.status === null ? true : PASSING.has(observed.status)`, so deleting a manifest's
  // `status` key — or replacing the file with bytes that do not parse, which `probe()` used to
  // swallow into the same `status === null` — left the row PROVEN by default. Both are registered
  // here so a regression to that rule fails this lane instead of silently passing.
  const MUTATIONS = Object.freeze([
    { id: 'delete-task-44-standard', rel: 'task-44/standard.json', kind: 'delete', expectedMissing: 'IS-2:task-44/standard.json', missingCount: 1, rowsIncomplete: ['IS-2'] },
    { id: 'delete-final-F3', rel: 'final/F3.json', kind: 'delete', expectedMissing: 'IS-1:final/F3.json', missingCount: 5, rowsIncomplete: ['IS-1', 'IS-4', 'IS-5', 'IS-7', 'IS-8'] },
    { id: 'delete-task-43-happy', rel: 'task-43/happy.json', kind: 'delete', expectedMissing: 'IS-1:task-43/happy.json', missingCount: 1, rowsIncomplete: ['IS-1'] },
    { id: 'delete-task-37-directory', rel: 'task-37/', kind: 'delete', expectedMissing: 'IS-8:task-37/', missingCount: 1, rowsIncomplete: ['IS-8'] },
    { id: 'corrupt-task-44-stress-status', rel: 'task-44/stress.json', kind: 'corrupt-status', expectedMissing: 'IS-2:task-44/stress.json(status=failed)', missingCount: 1, rowsIncomplete: ['IS-2'] },
    { id: 'delete-task-44-standard-status-key', rel: 'task-44/standard.json', kind: 'delete-status', expectedMissing: 'IS-2:task-44/standard.json(status=null)', missingCount: 1, rowsIncomplete: ['IS-2'] },
    { id: 'corrupt-task-43-failure-unparseable', rel: 'task-43/failure.json', kind: 'corrupt-json', expectedMissing: 'IS-3:task-43/failure.json(status=null,unparseable)', missingCount: 1, rowsIncomplete: ['IS-3'] },
  ]);
  const results = [];
  for (const mutation of MUTATIONS) {
    const target = path.join(copyRoot, mutation.rel);
    const liveSource = copySources.find((entry) => entry.rel === mutation.rel).resolved.abs;
    const before = statSync(target).isDirectory() ? null : readFileSync(target);
    if (mutation.kind === 'delete') rmSync(target, { recursive: true, force: true });
    else if (mutation.kind === 'delete-status') {
      const manifest = JSON.parse(readFileSync(target, 'utf8'));
      delete manifest.status;
      writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (mutation.kind === 'corrupt-json') {
      writeFileSync(target, '{ this is not valid json');
    } else {
      const manifest = JSON.parse(readFileSync(target, 'utf8'));
      manifest.status = 'failed';
      writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const mutated = runJoin(copyRoot, evidenceRoot);
    const hit = mutated.missing.includes(mutation.expectedMissing);
    results.push({ id: mutation.id, rel: mutation.rel, verdict: mutated.verdict, expectedMissing: mutation.expectedMissing, detected: hit, missingCount: mutated.missing.length, rowsIncomplete: mutated.rows.filter((row) => !row.rowComplete).map((row) => row.is) });
    assert.equal(mutated.verdict, 'REJECT', `mutation ${mutation.id} was NOT rejected — the join ignored the tampered copy`);
    assert.ok(hit, `mutation ${mutation.id} did not produce the expected missing entry ${mutation.expectedMissing}; observed ${JSON.stringify(mutated.missing)}`);
    // Restore the copy from the live bytes and prove the join returns to its baseline.
    if (mutation.kind === 'delete') { mkdirSync(path.dirname(target), { recursive: true }); if (before === null) mkdirSync(target, { recursive: true }); else copyFileSync(liveSource, target); } else copyFileSync(liveSource, target);
    const restored = runJoin(copyRoot, evidenceRoot);
    assert.equal(restored.verdict, 'PASS', `restoring ${mutation.rel} did not return the copy to its baseline PASS verdict`);
    assert.deepEqual(restored.missing, [], `restoring ${mutation.rel} left missing entries ${JSON.stringify(restored.missing)}`);
  }
  check('every IS-proof deletion/corruption in the copy is rejected with the exact missing entry, and restoring the live bytes returns the copy to its baseline PASS — so the rejection is caused by the removed proof, not by a broken copy', results, MUTATIONS.map((mutation) => ({ id: mutation.id, rel: mutation.rel, verdict: 'REJECT', expectedMissing: mutation.expectedMissing, detected: true, missingCount: mutation.missingCount, rowsIncomplete: mutation.rowsIncomplete })), 'seven isolated mutations over the self-contained copy, each rejected by the join and then restored — including the two the old never-true proof rule could not reject (a deleted status key and an unparseable manifest)');

  const liveAfter = runJoin(evidenceRoot, evidenceRoot);
  check('the live evidence tree was never touched by the failure lane: its join still PASSes with no missing entry after every copy mutation', { verdict: liveAfter.verdict, missing: liveAfter.missing }, { verdict: 'PASS', missing: [] }, 'the eight-row join over the live evidence tree after the failure lane');

  const report = { lane: 'failure', baseline: { verdict: baseline.verdict, missing: baseline.missing }, mutations: results, liveAfter: { verdict: liveAfter.verdict, missing: liveAfter.missing } };
  writeFileSync(path.join(detailDir, 'failure-join.json'), `${JSON.stringify(report, null, 2)}\n`);
  artifacts.push(artifact(path.join(detailDir, 'failure-join.json'), 'f4-failure-join'));
  rmSync(scratch, { recursive: true, force: true });
  return {
      scenario: 'F4 ideal-state fidelity — negative controls over a mutated evidence copy',
      checkerVerdict: 'REJECTED (every injected IS-proof deletion/corruption rejected, then restored)',
      mutationCount: MUTATIONS.length,
    scenarios,
    artifacts,
    versions: { node: process.version },
  };
}
