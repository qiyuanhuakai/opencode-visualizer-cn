/**
 * Task 56 — the browser kernel loader for the QA drivers.
 *
 * The system/faults harnesses drive a REAL headless Chromium through the omowright
 * browser kernel. That kernel used to be imported from a personal absolute path
 * (an author-machine skill cache), which made a clean checkout — CI, a fresh clone,
 * any temporary directory — unable to run the browser legs, and turned one
 * machine's cache directory into the default run contract.
 *
 * The kernel is not published to any registry, so this repository DELIVERS the
 * version-pinned copy under `vendor/omowright/` (wrapper + guard + runtime, with
 * the runtime's `manifest.json` as the pin). Resolution order:
 *
 *   1. `VIS_BROWSER_KERNEL`  — an explicit, documented configuration (wins);
 *   2. the vendored copy shipped in this repository (the default);
 *   3. nothing — a LOCATED prerequisite error naming what to configure.
 *
 * The vendored runtime's per-file sha256 digests are verified against its
 * manifest before import, so the pin is enforced rather than decorative. The
 * wrapper's own `OMOWRIGHT_ROOT` staging variable keeps working because the
 * vendored wrapper is the kernel's own loader, byte-for-byte.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The version-pinned kernel this repository delivers. */
export const VENDORED_KERNEL_ROOT = path.resolve(here, 'vendor', 'omowright');

const WRAPPER = 'scripts/omowright.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Enforces the vendored runtime's manifest pin. `root` is a kernel root holding
 * `runtime/omowright/{index.js,page-bundle.js,manifest.json}`; a digest mismatch
 * means the copy was edited without re-pinning, so it is refused rather than
 * silently trusted.
 */
export function verifyKernelDigests(root) {
  const manifestPath = path.join(root, 'runtime', 'omowright', 'manifest.json');
  if (!existsSync(manifestPath)) return { verified: false, reason: `no manifest at ${manifestPath}` };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const [name, expected] of Object.entries(manifest.files ?? {})) {
    const file = path.join(root, 'runtime', 'omowright', name);
    if (!existsSync(file)) throw new Error(`browser kernel pin: ${name} is missing from ${root} (manifest lists it)`);
    const actual = sha256(readFileSync(file));
    if (actual !== expected) {
      throw new Error(`browser kernel digest mismatch for ${name}: manifest pins ${expected}, the copy hashes ${actual} — re-pin the vendored kernel deliberately instead of editing it in place`);
    }
  }
  return { verified: true, version: manifest.version, sourceDigest: manifest.sourceDigest };
}

/**
 * Resolves the kernel root: explicit configuration first, the vendored copy
 * second. Returns `{ root, source }`, or `null` when nothing resolves. An
 * explicitly configured path that holds no kernel is reported as `invalid`, so
 * the caller can say the configuration is wrong rather than that nothing exists.
 */
export function resolveBrowserKernel(env = process.env, options = {}) {
  const vendoredRoot = options.vendoredRoot ?? VENDORED_KERNEL_ROOT;
  const configured = env.VIS_BROWSER_KERNEL;
  if (configured !== undefined && configured !== '') {
    const root = path.resolve(configured);
    if (!existsSync(path.join(root, WRAPPER))) return { root, source: 'VIS_BROWSER_KERNEL', invalid: true };
    return { root, source: 'VIS_BROWSER_KERNEL' };
  }
  if (existsSync(path.join(vendoredRoot, WRAPPER))) return { root: vendoredRoot, source: 'vendored' };
  return null;
}

/**
 * Loads the guarded kernel the QA drivers call. Never throws a bare
 * ERR_MODULE_NOT_FOUND: a missing or misconfigured kernel is a prerequisite
 * problem and says exactly what to configure.
 */
export async function loadBrowserKernel(env = process.env, options = {}) {
  const resolved = resolveBrowserKernel(env, options);
  if (resolved === null) {
    throw new Error([
      'prerequisite missing: the browser kernel (omowright) is not available in this checkout.',
      `Set VIS_BROWSER_KERNEL to a directory holding ${WRAPPER}, browser-engine-guard.mjs and runtime/omowright/{index.js,page-bundle.js,manifest.json},`,
      'or restore the version-pinned copy this repository delivers under scripts/qa/vendor/omowright/.',
    ].join(' '));
  }
  if (resolved.invalid) {
    throw new Error([
      `VIS_BROWSER_KERNEL=${resolved.root} does not contain the browser kernel (expected ${WRAPPER} there).`,
      'Point it at a kernel root holding omowright.mjs, browser-engine-guard.mjs and runtime/omowright/{index.js,page-bundle.js,manifest.json}, or unset it to use the vendored copy.',
    ].join(' '));
  }
  const pin = verifyKernelDigests(resolved.root);
  const wrapper = await import(pathToFileURL(path.join(resolved.root, WRAPPER)).href);
  const loaded = await wrapper.loadOmowright(env);
  return { ...loaded, kernelRoot: resolved.root, kernelSource: resolved.source, kernelPin: pin };
}
