/**
 * Task 56 — clean-checkout smoke for the browser kernel the QA drivers load.
 *
 * The system/faults harnesses used to import the browser kernel from a personal
 * absolute path (an author-machine skill cache). A clean checkout — CI, a fresh
 * clone, any temporary directory — does not have that file, so the browser legs
 * died with a bare ERR_MODULE_NOT_FOUND and the personal cache silently became
 * the default run contract.
 *
 * This smoke pins the replacement contract:
 *   1. the version-pinned kernel delivered in this repository loads and exposes
 *      the `connectPipe` surface the drivers call;
 *   2. it loads from an ARBITRARY temporary checkout path (nothing is coupled to
 *      one machine's directory layout);
 *   3. an explicit VIS_BROWSER_KERNEL configuration wins over the vendored copy;
 *   4. a missing kernel fails with a LOCATED prerequisite message, never a bare
 *      module-not-found;
 *   5. the vendored copy's manifest digests are enforced (the pin is real);
 *   6. no QA driver hardcodes a personal absolute path any more.
 *
 * Run: node --test scripts/qa/runtime-v090-browser-kernel.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadBrowserKernel, VENDORED_KERNEL_ROOT } from './runtime-v090-browser-kernel.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cleanup = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vis-v090-kernel-'));
  cleanup.push(directory);
  return directory;
};
process.on('exit', () => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); });

test('the vendored kernel loads and exposes the connectPipe surface', async () => {
  const kernel = await loadBrowserKernel();
  assert.equal(kernel.kernelSource, 'vendored');
  assert.ok(kernel.entry.startsWith(VENDORED_KERNEL_ROOT), `entry ${kernel.entry} is not the vendored copy`);
  assert.equal(typeof kernel.omowright.connectPipe, 'function');
});

test('the kernel loads from an arbitrary temporary checkout path', async () => {
  // A fresh clone at a different absolute path: only the loader module and the
  // vendored kernel are copied, exactly what a clean checkout contains.
  const checkout = path.join(temporaryDirectory(), 'somewhere-else', 'opencode-visualizer-cn');
  mkdirSync(path.join(checkout, 'scripts', 'qa'), { recursive: true });
  cpSync(path.join(repoRoot, 'scripts', 'qa', 'vendor'), path.join(checkout, 'scripts', 'qa', 'vendor'), { recursive: true });
  cpSync(path.join(repoRoot, 'scripts', 'qa', 'runtime-v090-browser-kernel.mjs'), path.join(checkout, 'scripts', 'qa', 'runtime-v090-browser-kernel.mjs'));
  const loader = await import(pathToFileURL(path.join(checkout, 'scripts', 'qa', 'runtime-v090-browser-kernel.mjs')).href);
  const kernel = await loader.loadBrowserKernel();
  assert.equal(kernel.kernelSource, 'vendored');
  assert.ok(kernel.entry.startsWith(path.join(checkout, 'scripts', 'qa', 'vendor')), 'the kernel must resolve relative to the checkout, not to a fixed machine path');
  assert.equal(typeof kernel.omowright.connectPipe, 'function');
});

test('an explicit VIS_BROWSER_KERNEL configuration wins over the vendored copy', async () => {
  const configured = path.join(temporaryDirectory(), 'configured-kernel');
  cpSync(VENDORED_KERNEL_ROOT, configured, { recursive: true });
  const kernel = await loadBrowserKernel({ VIS_BROWSER_KERNEL: configured });
  assert.equal(kernel.kernelSource, 'VIS_BROWSER_KERNEL');
  assert.ok(kernel.entry.startsWith(configured), `entry ${kernel.entry} is not inside the configured kernel root`);
  assert.match(kernel.entry, /runtime[/\\]omowright[/\\]index\.js$/);
  assert.equal(typeof kernel.omowright.connectPipe, 'function');
});

test('a missing kernel fails with a located prerequisite message', async () => {
  await assert.rejects(
    () => loadBrowserKernel({}, { vendoredRoot: path.join(temporaryDirectory(), 'absent') }),
    (error) => {
      assert.match(error.message, /prerequisite missing: the browser kernel \(omowright\) is not available/);
      assert.match(error.message, /VIS_BROWSER_KERNEL/);
      return true;
    },
  );
});

test('a configured path that holds no kernel is reported as such', async () => {
  await assert.rejects(
    () => loadBrowserKernel({ VIS_BROWSER_KERNEL: path.join(temporaryDirectory(), 'empty') }),
    (error) => {
      assert.match(error.message, /VIS_BROWSER_KERNEL=.*does not contain the browser kernel/);
      return true;
    },
  );
});

test('the vendored copy is digest-pinned: a modified kernel file is refused', async () => {
  const tampered = path.join(temporaryDirectory(), 'tampered-kernel');
  cpSync(VENDORED_KERNEL_ROOT, tampered, { recursive: true });
  writeFileSync(path.join(tampered, 'runtime', 'omowright', 'index.js'), '// tampered\n');
  await assert.rejects(
    () => loadBrowserKernel({ VIS_BROWSER_KERNEL: tampered }),
    (error) => {
      assert.match(error.message, /digest mismatch|manifest/);
      return true;
    },
  );
});

test('no QA driver hardcodes a personal absolute browser-skill path', () => {
  for (const driver of ['runtime-v090-system.mjs', 'runtime-v090-faults.mjs']) {
    const source = readFileSync(path.join(repoRoot, 'scripts', 'qa', driver), 'utf8');
    assert.ok(!source.includes('/home/qiyuaner'), `${driver} still references a personal absolute path`);
    assert.match(source, /loadBrowserKernel/, `${driver} must load the kernel through the shared loader`);
  }
});
