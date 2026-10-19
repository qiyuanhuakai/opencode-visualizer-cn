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
/**
 * The paths this PR's registrations reference that a STACKED branch delivers, anchored to the
 * supplier's head. PR #203 (feat/v090-task-56-evidence-backfill) at e2517a5a6 delivers all
 * four; the review confirmed that supply, and this set is what the reviewer's "state precisely
 * what this PR still needs" answer rests on — this PR itself needs nothing more, the stack
 * merges in order. The set is deliberately a literal: a new gap that is not declared here
 * still fails the reality test, so the carve-out cannot silently absorb one.
 */
const STACKED_SUPPLY = new Set([
  'scripts/qa/runtime-v090-faults.mjs',
  'scripts/qa/runtime-v090-system.mjs',
  'app/dev/runtime-v090/system43-mapping.mjs',
  'app/runtime/system.integration.test.ts',
]);
/**
 * EVERY static import a registration declares, resolved against the checkout —
 * enumerated by reading the source, NOT by evaluating the module.
 *
 * This is the whole point of the function. Node's ERR_MODULE_NOT_FOUND names only
 * the FIRST missing import it hits, so when the first one happens to be a
 * reviewer-confirmed stacked supply the whitelist accepts the failure and the
 * module never loads — which means `sourceFiles` is never checked and any FURTHER
 * missing dependency behind it passes silently. The reviewer reproduced exactly
 * that: with the allowlisted faults.mjs missing first, a second undelivered import
 * AND an undelivered sourceFile both slipped through with exit 0; the control that
 * delivered faults.mjs exposed the second import and failed correctly.
 *
 * A static scan cannot be fooled that way, because it never depends on the module
 * having loaded. Only literal relative specifiers are collected: a bare package
 * specifier resolves through node_modules (which the clean checkout symlinks in),
 * and a dynamic import() cannot be resolved from source alone, so neither is a
 * delivery gap this smoke can legitimately judge.
 */
const staticImportsOf = (source) => {
  const found = source.match(/^\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/gm) ?? [];
  const specifiers = found.map((statement) => /['"](\.[^'"]+)['"]/.exec(statement)?.[1]).filter((specifier) => specifier !== undefined);
  return [...new Set(specifiers)];
};

/**
 * Resolve one relative specifier to a CHECKOUT-relative path, or null when it
 * climbs out of the checkout (a specifier may not escape the tree it is declared
 * in, so there is nothing for this smoke to check).
 *
 * The anchor is the checkout, never the repository: the clean checkout — and every
 * synthetic negative-control checkout — lives at an arbitrary path, so anchoring
 * to the repo would resolve every specifier to a `../..` escape and silently check
 * nothing.
 */
const resolveRelative = (fromFile, specifier) => {
  // `<checkout>/scripts/qa/runtime-v090-cases/verify-Fx.mjs` -> the checkout root.
  let anchor = fromFile;
  for (let depth = 0; depth < 4; depth += 1) anchor = path.dirname(anchor);
  const relative = path.relative(anchor, path.resolve(path.dirname(fromFile), specifier)).split(path.sep).join('/');
  return relative.startsWith('..') ? null : relative;
};

/** The extensions a real delivery would carry for one specifier. */
const CANDIDATE_SUFFIXES = ['', '.mjs', '.js', '.ts', '.json'];

/** Every repo-relative path a registration's static imports name, resolved against `checkout`. */
const declaredDependenciesOf = (checkout, verify) => {
  const registration = path.join(checkout, 'scripts/qa/runtime-v090-cases', `verify-${verify}.mjs`);
  const source = readFileSync(registration, 'utf8');
  const dependencies = [];
  for (const specifier of staticImportsOf(source)) {
    const relative = resolveRelative(registration, specifier);
    if (relative === null) continue;
    // An extension-less specifier resolves to a real file OR to a directory index.
    if (!path.extname(relative)) {
      const resolved = CANDIDATE_SUFFIXES.map((suffix) => `${relative}${suffix}`).find((candidate) => existsSync(path.join(checkout, candidate)));
      if (resolved !== undefined) { dependencies.push(resolved); continue; }
      if (existsSync(path.join(checkout, relative, 'index.mjs'))) { dependencies.push(`${relative}/index.mjs`); continue; }
    }
    dependencies.push(relative);
  }
  return dependencies;
};

/**
 * The source files a registration DECLARES, read from its source when the module
 * cannot be imported. The declared array is a literal, so a conservative
 * string-literal scan recovers it; the evaluated module is always preferred, and
 * this exists only so a registration that fails to load is still checked against
 * the sources it claims.
 */
const staticSourceFilesOf = (registration) => {
  const source = readFileSync(registration, 'utf8');
  const start = source.indexOf('sourceFiles');
  if (start === -1) return [];
  const arrayStart = source.indexOf('[', start);
  if (arrayStart === -1) return [];
  const arrayEnd = source.indexOf(']', arrayStart);
  if (arrayEnd === -1) return [];
  const literals = source.slice(arrayStart + 1, arrayEnd).match(/'[^']+'|"[^"]+"/g) ?? [];
  return literals.map((literal) => literal.slice(1, -1)).filter((entry) => /^[\w./-]+$/.test(entry));
};
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

/**
 * The smoke's reality logic, as ONE function over one checkout.
 *
 * Extracted so the negative controls below exercise the SAME code path the real
 * test does. A private copy would let the controls pass while the production path
 * regressed, which is precisely the class of false-green this file exists to
 * prevent.
 *
 * Returns `{ failures, stacked }`, where `failures` is the non-empty list that
 * makes the smoke FAIL.
 */
async function realityGapsOf(checkout) {
  const failures = [];
  const stacked = [];
  for (const verify of VERIFIERS) {
    const registration = path.join(checkout, 'scripts/qa/runtime-v090-cases', `verify-${verify}.mjs`);
    assert.ok(existsSync(registration), `verify-${verify}.mjs is not registered in this tree`);

    // ── the static dependency scan, independent of whether the module evaluates ──
    // This runs FIRST and unconditionally, so a registration that cannot load at
    // all (its first missing import being a reviewer-confirmed stacked supply) is
    // still checked for every OTHER dependency it declares. Before this, the scan
    // only ran inside the try, so an accepted module-not-found short-circuited it
    // and concealed any further gap behind it.
    const declared = declaredDependenciesOf(checkout, verify);
    const missingImports = declared.filter((rel) => !existsSync(path.join(checkout, rel)));

    // ── the declared source files, checked whether or not the module loaded ──
    let registered = null;
    let loadError = null;
    try {
      registered = await import(pathToFileURL(registration).href);
    } catch (error) { loadError = error; }
    const missingSources = registered
      ? (registered.sourceFiles ?? []).filter((rel) => !existsSync(path.join(checkout, rel)))
      : staticSourceFilesOf(registration).filter((rel) => !existsSync(path.join(checkout, rel)));

    for (const rel of missingImports) {
      if (STACKED_SUPPLY.has(rel)) stacked.push(`${verify}: ${rel} (delivered by the stacked #203 branch at e2517a5a6)`);
      else failures.push(`${verify}: references a path this stack does not deliver: ${rel}`);
    }
    for (const rel of missingSources) {
      if (STACKED_SUPPLY.has(rel)) stacked.push(`${verify}: ${rel} (delivered by the stacked #203 branch at e2517a5a6)`);
      else failures.push(`${verify}: registers a source file this stack does not deliver: ${rel}`);
    }
    if (registered) {
      assert.equal(typeof registered.run, 'function', `${verify} registration has no run()`);
      if (!Array.isArray(registered.sourceFiles) || registered.sourceFiles.length === 0) failures.push(`${verify}: registers no sourceFiles`);
    } else if (missingImports.every((rel) => STACKED_SUPPLY.has(rel)) && missingSources.every((rel) => STACKED_SUPPLY.has(rel))) {
      // The module cannot load, and every reason we can see is a declared stacked
      // supply: acceptable at this head, recorded as such.
      stacked.push(`${verify}: cannot load in a clean checkout — ${loadError !== null && typeof loadError === 'object' && loadError.code === 'ERR_MODULE_NOT_FOUND' ? String(loadError.message).split('\n')[0] : (loadError instanceof Error ? loadError.message : String(loadError))}`);
    } else {
      failures.push(`${verify}: cannot load in a clean checkout for a reason this stack does not supply — ${loadError instanceof Error ? loadError.message : String(loadError)}`);
    }
  }
  return { failures, stacked };
}

test('every registered verifier loads from a clean checkout and its declared sources exist there', async () => {
  const checkout = cleanCheckout();
  const { failures } = await realityGapsOf(checkout);
  assert.deepEqual(failures, [], 'a registered verifier references a path neither this tree nor the declared stacked supplier delivers');
  // The carve-out must not be broader than reality: every declared stacked path must actually be
  // referenced by a registration (a static scan, because Node's module-not-found names only the
  // FIRST missing import — it cannot enumerate the rest), otherwise the set has drifted into
  // absorbing gaps nobody asked it to absorb.
  for (const rel of STACKED_SUPPLY) {
    if (existsSync(path.join(checkout, rel))) continue;
    const referenced = VERIFIERS.some((verify) => {
      const source = readFileSync(path.join(checkout, 'scripts/qa/runtime-v090-cases', `verify-${verify}.mjs`), 'utf8');
      return source.includes(rel) || source.includes(rel.replace(/^scripts\/qa\//, './').replace(/^app\//, '../'));
    });
    assert.ok(referenced, `STACKED_SUPPLY declares ${rel} but no registration references it — the declared supplier set has drifted`);
  }
});

test('no verifier registration hardcodes a personal absolute path', () => {
  for (const verify of VERIFIERS) {
    const source = readFileSync(path.join(repoRoot, 'scripts/qa/runtime-v090-cases', `verify-${verify}.mjs`), 'utf8');
    assert.ok(!source.includes('/home/qiyuaner'), `verify-${verify}.mjs still references a personal absolute path`);
  }
});

// ── the masking negative controls ────────────────────────────────────────────
// The whitelist accepts a missing path only when it is one of the four the
// stacked #203 branch delivers. The review found that acceptance CONCEALED a
// further gap: Node's ERR_MODULE_NOT_FOUND names only the FIRST missing import,
// so when that one is the allowlisted faults.mjs the module never loads, the
// `sourceFiles` check never runs, and a SECOND missing dependency behind it
// passes the smoke with exit 0.
//
// These two controls put exactly that shape into a synthetic checkout and require
// the smoke to FAIL. They are the guard on the static scan above: if the scan
// regresses to depending on a successful import, both go red.
//
// Both use the SAME synthetic registration as the detection test above, so the
// only variable is which dependency is missing.
function maskingCheckout({ allowlistedImportMissing, secondImportMissing, secondSourceMissing }) {
  const checkout = path.join(temporaryDirectory(), 'masking');
  for (const rel of RUNNER_MODULES) {
    const destination = path.join(checkout, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repoRoot, rel), destination);
  }
  const cases = path.join(checkout, 'scripts/qa/runtime-v090-cases');
  mkdirSync(cases, { recursive: true });
  writeFileSync(path.join(cases, 'verify-F3.mjs'), [
    "import { artifact } from '../runtime-v090-evidence.mjs';",
    // The FIRST static import is the allowlisted stacked supply, exactly as the
    // real F3's first missing import is runtime-v090-faults.mjs.
    ...(allowlistedImportMissing ? [] : ["import { runFaults } from '../runtime-v090-faults.mjs';"]),
    ...(secondImportMissing ? ["import { notDelivered } from '../second-undelivered-module.mjs';"] : []),
    "export const sourceFiles = ['package.json'",
    secondSourceMissing ? ", 'app/runtime/second-undelivered.test.ts'" : '',
    '];',
    'export async function run() { return { scenarios: [] }; }',
  ].join('\n'));
  for (const rel of ['scripts/qa/runtime-v090-evidence.mjs']) {
    const destination = path.join(checkout, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repoRoot, rel), destination);
  }
  writeFileSync(path.join(checkout, 'package.json'), '{}\n');
  // The other three registrations are complete and deliverable, so the only gap
  // under test is the synthetic F3's.
  for (const verify of ['F1', 'F2', 'F4']) {
    writeFileSync(path.join(cases, `verify-${verify}.mjs`), "export const sourceFiles = ['package.json'];\nexport async function run() { return { scenarios: [] }; }\n");
  }
  return checkout;
}

test('a second missing dependency behind an allowlisted one is NOT concealed', async () => {
  // Control first: with the allowlisted module delivered, nothing is missing and
  // the smoke is green — proving the synthetic registration is otherwise sound.
  const clean = maskingCheckout({ allowlistedImportMissing: false });
  try {
    assert.deepEqual((await realityGapsOf(clean)).failures, [], 'the synthetic registration should be fully deliverable when nothing is missing');
  } finally { rmSync(path.dirname(clean), { recursive: true, force: true }); }

  // Negative control 1: the allowlisted import is missing FIRST, and a second
  // undelivered import sits behind it. Node names only the first, so the old
  // logic accepted the failure and never saw the second.
  const secondImport = maskingCheckout({ allowlistedImportMissing: true, secondImportMissing: true });
  try {
    assert.ok((await realityGapsOf(secondImport)).failures.some((gap) => gap.startsWith('F3:') && gap.includes('second-undelivered-module.mjs')), 'a second missing import behind an allowlisted one must fail the smoke, not pass it');
  } finally { rmSync(path.dirname(secondImport), { recursive: true, force: true }); }

  // Negative control 2: the same, but the second gap is an undelivered source
  // file — the check the old logic skipped entirely because the module never
  // loaded, so `registered.sourceFiles` was never available.
  const secondSource = maskingCheckout({ allowlistedImportMissing: true, secondSourceMissing: true });
  try {
    assert.ok((await realityGapsOf(secondSource)).failures.some((gap) => gap.startsWith('F3:') && gap.includes('app/runtime/second-undelivered.test.ts')), 'a missing source file behind an allowlisted missing import must fail the smoke, not pass it');
  } finally { rmSync(path.dirname(secondSource), { recursive: true, force: true }); }
});
