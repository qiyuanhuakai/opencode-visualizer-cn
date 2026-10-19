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
 * The stacked-supply carve-out accepts a load failure ONLY when the error is a
 * module-not-found, at least one path is ACTUALLY missing, and every missing
 * path is one the stacked branch delivers. The review found the old bare
 * `missing.every(...)` pair absorbing three classes it had no business
 * explaining — an empty missing set (`[].every` is vacuously true, so a scan
 * that found nothing reported success), a side-effect import the binding-form
 * regex never collected, and a SyntaxError or top-level throw that is not a
 * module-not-found at all — plus a masking fixture whose inverted flag left the
 * existing controls unable to exercise the path they guard. The negative
 * controls at the end of this file fail before that fix and pass after it.
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
 * The ONE load-failure shape the stacked-supply carve-out may explain.
 *
 * Anything else — a SyntaxError, a top-level throw, any other exception — is a
 * broken registration, not a dependency the stacked branch delivers. The old
 * acceptance tested nothing about the error at all: combined with an empty
 * missing set (on which `every` is vacuously true) it absorbed a registration
 * that could not load for a reason no whitelist entry covers, and reported the
 * smoke green.
 */
const isModuleNotFound = (error) => error !== null && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND';
/**
 * The checkout-relative path of the module Node actually failed to resolve,
 * or null when the error names none this checkout contains.
 *
 * `error.url` is the file:// URL of the module whose resolution FAILED — the one
 * Node's resolver aborted on — and every ERR_MODULE_NOT_FOUND for a relative
 * specifier carries it on this Node version (verified empirically on Node 24).
 * The message repeats that path in absolute form, so it is the fallback for a
 * Node that omits `url`. A bare specifier is deliberately left unbound: its
 * error carries no file URL and its message reads "Cannot find package", not
 * "Cannot find module", so this returns null and the carve-out cannot fire —
 * the conservative direction, because a gap that cannot be bound to an
 * allowlisted path is a gap this stack does not supply.
 *
 * THIS is what the carve-out must be bound to. Testing only the error's CODE
 * let an unrelated allowlisted `sourceFiles` gap explain a load failure whose
 * failing module is not one the stacked branch delivers: the reviewer's two
 * controls placed a missing allowlisted source beside a genuinely undelivered
 * dynamic import and beside a genuinely undelivered transitive import, and both
 * reported `failures=[]`. Node names only the FIRST missing module, so the set
 * the scan can see and the module the error failed on are different facts, and
 * the carve-out has to be constrained by the second as well as the first.
 */
const missingModuleOf = (checkout, error) => {
  const candidates = [];
  if (error !== null && typeof error === 'object' && typeof error.url === 'string' && error.url.startsWith('file:')) {
    try { candidates.push(fileURLToPath(error.url)); } catch { /* not a file URL after all */ }
  }
  const named = /Cannot find module '([^']+)'/.exec(error instanceof Error ? error.message : String(error));
  if (named !== null) candidates.push(named[1]);
  for (const candidate of candidates) {
    const relative = path.relative(checkout, path.resolve(candidate)).split(path.sep).join('/');
    if (!relative.startsWith('..')) return relative;
  }
  return null;
};

/**
 * Whether the stacked-supply carve-out may explain THIS load error: the module
 * the error actually failed to resolve must be one the stacked branch delivers.
 * An error failing on any other module — a dynamic import, a transitive
 * dependency, a bare specifier — is a gap this stack does not supply, however
 * many allowlisted paths happen to be missing beside it.
 */
const stackedSupplyExplains = (checkout, error) => {
  const missing = missingModuleOf(checkout, error);
  return missing !== null && STACKED_SUPPLY.has(missing);
};
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
  // TWO statement shapes carry a literal relative specifier and BOTH must be
  // collected. The binding form (`import … from '<spec>'`) was the only one the
  // scan saw, so a side-effect import (`import '<spec>';`, no `from` clause) of
  // an undelivered module was invisible: the module could not load, the scan
  // reported nothing missing, and the vacuous `every` below accepted it as
  // declared stacked supply. The side-effect form cannot match a dynamic
  // `import(` call — it requires whitespace and then a quote — and a dynamic
  // import() stays out of scope, because it cannot be resolved from source.
  const found = [
    ...(source.match(/^\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/gm) ?? []),
    ...(source.match(/^\s*import\s+['"](\.[^'"]+)['"]/gm) ?? []),
  ];
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
    } else if (isModuleNotFound(loadError) && (missingImports.length > 0 || missingSources.length > 0) && missingImports.every((rel) => STACKED_SUPPLY.has(rel)) && missingSources.every((rel) => STACKED_SUPPLY.has(rel)) && stackedSupplyExplains(checkout, loadError)) {
      // The module cannot load, and every reason we can see is a declared stacked
      // supply: acceptable at this head, recorded as such. The acceptance is
      // constrained four ways, because the old bare `every` pair absorbed
      // failures it had no business explaining:
      //   * the error must be the module-not-found shape. A SyntaxError or a
      //     top-level throw is a broken registration, never a dependency the
      //     stacked branch delivers;
      //   * at least one path must ACTUALLY be missing. Two empty arrays make
      //     `every` vacuously true, so a scan that found nothing — including one
      //     that could not see the dependency at all — used to report success;
      //   * every missing path must be one the stacked branch delivers, which
      //     was already true and stays true;
      //   * the module the error FAILED ON must be one of those same paths. The
      //     three above constrain what the scan can see, but Node names only the
      //     first missing module and that one can sit outside the scan's reach —
      //     a dynamic import() cannot be resolved from source, and a transitive
      //     dependency is another module's import, not this registration's. With
      //     an unrelated allowlisted `sourceFiles` gap supplying the non-empty
      //     missing set, both shapes satisfied the three checks above while the
      //     load error failed on a module nobody promised to supply, so the
      //     smoke reported green on a gap. This fourth constraint binds the
      //     exception to the path it actually misses.
      stacked.push(`${verify}: cannot load in a clean checkout — ${isModuleNotFound(loadError) ? String(loadError.message).split('\n')[0] : (loadError instanceof Error ? loadError.message : String(loadError))}`);
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
function maskingCheckout({ allowlistedImportMissing, secondImportMissing, secondSourceMissing, f3Body, extras }) {
  const checkout = path.join(temporaryDirectory(), 'masking');
  for (const rel of RUNNER_MODULES) {
    const destination = path.join(checkout, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repoRoot, rel), destination);
  }
  const cases = path.join(checkout, 'scripts/qa/runtime-v090-cases');
  mkdirSync(cases, { recursive: true });
  writeFileSync(path.join(cases, 'verify-F3.mjs'), f3Body ?? [
    "import { artifact } from '../runtime-v090-evidence.mjs';",
    // The FIRST static import is the allowlisted stacked supply, exactly as the
    // real F3's first missing import is runtime-v090-faults.mjs.
    //
    // `allowlistedImportMissing` means THE MODULE IS ABSENT FROM THE CHECKOUT,
    // which requires the import STATEMENT to be present — that is what makes
    // Node's ERR_MODULE_NOT_FOUND name faults.mjs FIRST, the exact shape that
    // used to short-circuit the scan and conceal whatever sat behind it. The
    // inverted form (omitting the statement when the module is missing) let
    // Node name the second dependency directly, so neither masking control
    // could exercise the path they exist to guard: they passed against logic
    // with and without the static scan alike. The checkout never copies
    // faults.mjs, so a declared import is a genuinely missing module.
    ...(allowlistedImportMissing ? ["import { runFaults } from '../runtime-v090-faults.mjs';"] : []),
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
  // Extra files a control needs PRESENT in the checkout — a module the synthetic
  // F3 can import that itself imports something absent, which is how the
  // transitive-dependency shape is built without touching the fixture's flags.
  for (const [rel, content] of Object.entries(extras ?? {})) {
    const destination = path.join(checkout, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  // When the allowlisted module is NOT missing, the checkout delivers a
  // self-contained stub for it (no imports of its own, so no further closure is
  // needed). That keeps the control honest: with the statement present and the
  // module delivered, nothing is missing, which is what "the synthetic
  // registration is otherwise sound" means.
  if (!allowlistedImportMissing) {
    writeFileSync(path.join(checkout, 'scripts/qa/runtime-v090-faults.mjs'), 'export const runFaults = () => {};\n');
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

// ── the absorption negative controls ─────────────────────────────────────────
// The masking controls above guard ONE facet: a gap hidden BEHIND an allowlisted
// module-not-found. The review found three further classes the smoke still let
// through, all of them the same root cause — the carve-out accepted a load
// failure on `missing.every(...)` alone:
//
//   A. an EMPTY missing set. `[].every(...)` is vacuously true, so a scan that
//      found nothing — including one that could not see the dependency at all —
//      reported success;
//   B. a side-effect import. `import './x.mjs';` has no `from` clause, so the
//      binding-form-only regex never collected it and the set stayed empty;
//   C. an unconstrained exception. A SyntaxError or a top-level throw is not a
//      module-not-found at all, yet the carve-out explained it away as stacked
//      supply;
//   D. the masking fixture's own flag was inverted, so the controls above could
//      not exercise the path they exist to guard.
//
// Each control below fails the smoke BEFORE the fix and passes after it. They
// drive the SAME realityGapsOf the real test drives — a private copy would let
// the controls pass while the production path regressed.
test('a load failure the scan cannot explain does not pass on an empty every', async () => {
  // A dynamic import() is deliberately outside the static scan (it cannot be
  // resolved from source), so a missing dynamic dependency leaves BOTH missing
  // sets EMPTY while the module genuinely cannot load.
  const checkout = maskingCheckout({ f3Body: [
    "import { artifact } from '../runtime-v090-evidence.mjs';",
    "await import('../dynamically-undelivered.mjs');",
    "export const sourceFiles = ['package.json'];",
    'export async function run() { return { scenarios: [] }; }',
  ].join('\n') });
  try {
    const { failures } = await realityGapsOf(checkout);
    assert.ok(failures.some((gap) => gap.startsWith('F3:')), 'a registration that cannot load with nothing missing must FAIL the smoke — an empty set must not pass on a vacuous every');
  } finally { rmSync(path.dirname(checkout), { recursive: true, force: true }); }
});

test('a side-effect import of an undelivered module is scanned', async () => {
  const checkout = maskingCheckout({ f3Body: [
    "import { artifact } from '../runtime-v090-evidence.mjs';",
    "import '../side-effect-undelivered.mjs';",
    "export const sourceFiles = ['package.json'];",
    'export async function run() { return { scenarios: [] }; }',
  ].join('\n') });
  try {
    const { failures } = await realityGapsOf(checkout);
    assert.ok(failures.some((gap) => gap.startsWith('F3:') && gap.includes('side-effect-undelivered.mjs')), 'a side-effect import names a real dependency: the scan must collect it and the smoke must fail');
  } finally { rmSync(path.dirname(checkout), { recursive: true, force: true }); }
});

test('a SyntaxError or a top-level throw is never absorbed by the carve-out', async () => {
  // Neither leaves a missing path behind, so the old unconstrained acceptance
  // explained both away as "declared stacked supply".
  const broken = [
    ['syntax-error', [
      "import { artifact } from '../runtime-v090-evidence.mjs';",
      "export const sourceFiles = ['package.json'];",
      'export async function run() { return { scenarios: [] }; }',
      'const broken = ;',
    ].join('\n')],
    ['top-level-throw', [
      "import { artifact } from '../runtime-v090-evidence.mjs';",
      "export const sourceFiles = ['package.json'];",
      "throw new Error('a registration that throws at module scope is broken, not supplied by another branch');",
      'export async function run() { return { scenarios: [] }; }',
    ].join('\n')],
  ];
  for (const [label, body] of broken) {
    const checkout = maskingCheckout({ f3Body: body });
    try {
      const { failures } = await realityGapsOf(checkout);
      assert.ok(failures.some((gap) => gap.startsWith('F3:')), `a ${label} must FAIL the smoke — only a module-not-found for a declared stacked path may be accepted`);
    } finally { rmSync(path.dirname(checkout), { recursive: true, force: true }); }
  }
});

test('the masking fixture declares the allowlisted import while withholding its module', async () => {
  // The flag means "the allowlisted MODULE is missing", which requires the
  // import STATEMENT to be present and the FILE absent — the real F3 shape,
  // where Node names faults.mjs FIRST. The inverted form omitted the statement,
  // so Node named the second dependency directly and both masking controls
  // passed against logic with and without the static scan alike.
  const checkout = maskingCheckout({ allowlistedImportMissing: true });
  try {
    const registration = path.join(checkout, 'scripts/qa/runtime-v090-cases/verify-F3.mjs');
    const source = readFileSync(registration, 'utf8');
    assert.match(source, /import \{ runFaults \} from '\.\.\/runtime-v090-faults\.mjs';/, 'the allowlisted import must be DECLARED when its module is missing, or Node never names it first and the masking path is not exercised');
    assert.ok(!existsSync(path.join(checkout, 'scripts/qa/runtime-v090-faults.mjs')), 'the allowlisted module must be ABSENT from the checkout for the masking path to exist');
    let error = null;
    try { await import(pathToFileURL(registration).href); } catch (thrown) { error = thrown; }
    assert.ok(isModuleNotFound(error), 'the synthetic registration must fail to load with a module-not-found, or the masking path is not exercised');
    assert.match(String(error.message), /runtime-v090-faults\.mjs/, 'Node must name the allowlisted module FIRST — that ordering is what used to let an accepted module-not-found conceal the gap behind it');
  } finally { rmSync(path.dirname(checkout), { recursive: true, force: true }); }
});

// ── the unbound-exception negative controls ──────────────────────────────────
// The masking and absorption controls above constrain the carve-out by the paths
// the STATIC SCAN can see. The review found the residual: the carve-out was
// still not bound to the module the load error ACTUALLY fails on. Node's
// ERR_MODULE_NOT_FOUND names only the FIRST missing module, and that module can
// sit entirely outside the scan's reach — a dynamic import() cannot be resolved
// from source, and a transitive dependency is another module's import, not this
// registration's. Put an unrelated allowlisted `sourceFiles` gap beside either
// one and it supplies the non-empty missing set the acceptance requires, every
// path the scan CAN see is allowlisted, the error code is module-not-found — so
// all the constraints above were satisfied while the load failed on a module
// nobody promised to supply. Both controls reported `failures=[]`.
//
// Each control below fails the smoke BEFORE the fix and passes after it. The
// third is the positive control: when the module the error fails on IS the
// allowlisted one, the carve-out must still explain it — without it the fix
// could go green by deleting the carve-out, which would break the real
// stacked-supply case the carve-out exists for.
test('the module-missing exception is bound to the module the error actually fails on', async () => {
  // Negative control 1: a top-level dynamic import of a module that is NOT
  // allowlisted, beside an allowlisted `sourceFiles` gap. The scan cannot see
  // the dynamic import at all, so the only missing path it finds is the
  // allowlisted source — and the load error fails on `dynamically-unlisted-missing.mjs`.
  const dynamic = maskingCheckout({ f3Body: [
    "import { artifact } from '../runtime-v090-evidence.mjs';",
    "await import('../dynamically-unlisted-missing.mjs');",
    "export const sourceFiles = ['app/runtime/system.integration.test.ts'];",
    'export async function run() { return { scenarios: [] }; }',
  ].join('\n') });
  try {
    const { failures } = await realityGapsOf(dynamic);
    assert.ok(failures.some((gap) => gap.startsWith('F3:') && gap.includes('dynamically-unlisted-missing.mjs')), 'a load failure on a non-allowlisted module must FAIL the smoke, even when every path the scan can see is allowlisted');
  } finally { rmSync(path.dirname(dynamic), { recursive: true, force: true }); }

  // Negative control 2: a static import of a PRESENT module that itself
  // statically imports a nonexistent one, beside the same allowlisted source
  // gap. The registration's own import resolves, so the scan finds NOTHING
  // missing — the failure lives one hop away, in the transitive dependency.
  // This is why the residual is not limited to the dynamic-import scan scope.
  const transitive = maskingCheckout({
    extras: { 'scripts/qa/present.mjs': "export const present = true;\nimport '../transitively-unlisted-missing.mjs';\n" },
    f3Body: [
      "import { artifact } from '../runtime-v090-evidence.mjs';",
      "import { present } from '../present.mjs';",
      "export const sourceFiles = ['app/runtime/system.integration.test.ts'];",
      'export async function run() { return { scenarios: [] }; }',
    ].join('\n'),
  });
  try {
    const { failures } = await realityGapsOf(transitive);
    assert.ok(failures.some((gap) => gap.startsWith('F3:') && gap.includes('transitively-unlisted-missing.mjs')), 'a load failure on a non-allowlisted TRANSITIVE dependency must FAIL the smoke, even when the registration\'s own imports all resolve');
  } finally { rmSync(path.dirname(transitive), { recursive: true, force: true }); }

  // Positive control: the same allowlisted source gap, but the module the error
  // fails on IS the allowlisted stacked supply. `allowlistedImportMissing` keeps
  // the fixture's faults.mjs stub UNWRITTEN, so the import is genuinely missing
  // and the module genuinely cannot load — without that flag the module loads
  // and the carve-out branch is never reached, which would prove nothing. The
  // carve-out must still fire, so the fix binds the exception to the failing
  // path instead of deleting it.
  const allowlisted = maskingCheckout({ allowlistedImportMissing: true, f3Body: [
    "import { artifact } from '../runtime-v090-evidence.mjs';",
    "import { runFaults } from '../runtime-v090-faults.mjs';",
    "export const sourceFiles = ['app/runtime/system.integration.test.ts'];",
    'export async function run() { return { scenarios: [] }; }',
  ].join('\n') });
  try {
    const { failures, stacked } = await realityGapsOf(allowlisted);
    assert.deepEqual(failures, [], 'a registration whose only missing import is the allowlisted stacked supply must still be carved out');
    assert.ok(stacked.some((entry) => entry.startsWith('F3: cannot load in a clean checkout')), 'the carve-out must still record the accepted load failure, so the exception survives the binding');
  } finally { rmSync(path.dirname(allowlisted), { recursive: true, force: true }); }
});
