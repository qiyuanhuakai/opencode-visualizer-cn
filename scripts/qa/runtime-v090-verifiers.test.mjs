/**
 * Task 54 — clean-checkout smoke for the registered final verifiers.
 *
 * The first F2/F3 delivery gap was invisible to the existing tests: the runner
 * accepted a legal `--verify F3` selector, then died at import with a bare
 * ERR_MODULE_NOT_FOUND (F3 statically imports modules the tree did not
 * deliver) or at realpathSync with ENOENT (F2 registered a source file absent
 * from the tree). The selector tests only checked parseSelector's return value,
 * so nothing caught it. This smoke closes that class:
 *
 *   1. DETECTION — a synthetic registration that references undelivered files
 *      makes the runner fail with its LOCATED prerequisite message naming each
 *      missing file, not a bare module-not-found. Green at every head; it
 *      guards the runner's prerequisite resolution itself.
 *   2. REALITY — every registered verifier (F1-F4) is imported from a CLEAN
 *      temporary checkout at an arbitrary path, with no author-machine worktree
 *      farm beside it, and every declared source file must exist there. When a
 *      registration references something this tree does not deliver, this test
 *      FAILS naming it — that is the point: the gap must be machine-visible,
 *      not discovered at lane runtime.
 *
 * Scope: this proves the registrations LOAD and their declared inputs resolve.
 * Each lane's full execution carries its own documented prerequisites (F1 needs
 * the campaign plan + evidence tree, F3 needs the browser kernel and a real
 * browser); those are the lanes' business, not this smoke's.
 *
 * Run: node --test scripts/qa/runtime-v090-verifiers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cleanup = [];
process.on('exit', () => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); });
const temporaryDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vis-v090-verifiers-'));
  cleanup.push(directory);
  return directory;
};

/** The runner's own module set, enough to reach the prerequisite resolution. */
const RUNNER_MODULES = [
  'scripts/qa/runtime-v090.mjs',
  'scripts/qa/runtime-v090-process.mjs',
  'scripts/qa/runtime-v090-evidence.mjs',
  'scripts/qa/runtime-v090-legacy.mjs',
];

/**
 * A clean checkout: the tracked sources at an ARBITRARY path with no
 * author-machine worktree farm beside it, plus the installed dependencies
 * (what `pnpm install` produces). Heavy local-only directories are excluded;
 * everything a registration can reference is present, so a missing reference
 * is a real delivery gap, not an artifact of a partial copy.
 */
function cleanCheckout() {
  const checkout = path.join(temporaryDirectory(), 'somewhere-else', 'opencode-visualizer-cn');
  mkdirSync(checkout, { recursive: true });
  const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'dist-bridge', '.omo', 'coverage', '.zread', '.fallow', '.vitest']);
  cpSync(repoRoot, checkout, {
    recursive: true,
    filter: (source) => !EXCLUDED.has(path.basename(source)),
  });
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
  return checkout;
}

const VERIFIERS = ['F1', 'F2', 'F3', 'F4'];

test('a registration referencing undelivered files fails with the runner\'s located prerequisite message', () => {
  const checkout = path.join(temporaryDirectory(), 'synthetic');
  for (const rel of RUNNER_MODULES) {
    const destination = path.join(checkout, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repoRoot, rel), destination);
  }
  const cases = path.join(checkout, 'scripts/qa/runtime-v090-cases');
  mkdirSync(cases, { recursive: true });
  // A registered --task selector (the selector accepts 1-48) whose case module
  // statically imports a module the tree does not deliver.
  writeFileSync(path.join(cases, 'task-7.mjs'), [
    "import { artifact } from '../runtime-v090-evidence.mjs';",
    "import { notDelivered } from '../this-module-does-not-exist.mjs';",
    "export const sourceFiles = ['package.json'];",
    'export async function run() { return { scenarios: [] }; }',
  ].join('\n'));

  const out = path.join(temporaryDirectory(), 'synthetic-result.json');
  const result = spawnSync(process.execPath, [path.join(checkout, 'scripts/qa/runtime-v090.mjs'), '--task', '7', '--case', 'happy', '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 1, `the runner must refuse an unexecutable selector, got exit ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /prerequisite missing: scripts\/qa\/runtime-v090-cases\/task-7\.mjs cannot load in this tree/);
  assert.match(result.stderr, /this-module-does-not-exist\.mjs/);
});

test('every registered verifier loads from a clean checkout and its declared sources exist there', async () => {
  const checkout = cleanCheckout();
  const failures = [];
  for (const verify of VERIFIERS) {
    const registration = path.join(checkout, 'scripts/qa/runtime-v090-cases', `verify-${verify}.mjs`);
    assert.ok(existsSync(registration), `verify-${verify}.mjs is not registered in this tree`);
    try {
      const registered = await import(pathToFileURL(registration).href);
      assert.equal(typeof registered.run, 'function', `${verify} registration has no run()`);
      const missing = (registered.sourceFiles ?? []).filter((rel) => !existsSync(path.join(checkout, rel)));
      if (missing.length > 0) failures.push(`${verify}: registers source file(s) absent from this tree: ${missing.join(', ')}`);
      if (!Array.isArray(registered.sourceFiles) || registered.sourceFiles.length === 0) failures.push(`${verify}: registers no sourceFiles`);
    } catch (error) {
      const head = error !== null && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND'
        ? String(error.message).split('\n')[0]
        : (error instanceof Error ? error.message : String(error));
      failures.push(`${verify}: cannot load in a clean checkout — ${head}`);
    }
  }
  assert.deepEqual(failures, [], 'registered verifiers cannot execute from a clean checkout; deliver the referenced files in this stack (a stacked branch may legitimately supply them — merge in order) or re-point the registration');
});

test('no verifier registration hardcodes a personal absolute path', () => {
  for (const verify of VERIFIERS) {
    const source = readFileSync(path.join(repoRoot, 'scripts/qa/runtime-v090-cases', `verify-${verify}.mjs`), 'utf8');
    assert.ok(!source.includes('/home/qiyuaner'), `verify-${verify}.mjs still references a personal absolute path`);
  }
});
