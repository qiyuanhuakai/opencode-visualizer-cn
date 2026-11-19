/**
 * Task 56 — the Windows installer QA helper must propagate native failures.
 *
 * The review found a failure-masking path in scripts/qa/vis-bridge-installer-windows.ps1: it
 * runs vis_bridge and several `node ... assert-*` commands without checking each exit code.
 * PowerShell's default native-error setting does not make a non-zero native exit throw, and
 * GitHub's pwsh wrapper propagates only the FINAL exit code, so an earlier failing assertion
 * (assert-pty exiting 1, say) followed by later successful steps made the whole job report
 * green. That is a false green on a packaged-artifact acceptance lane.
 *
 * This test is the machine-visible guard for that class. It is static because this repository
 * has no PowerShell runtime on its Linux CI/dev hosts: it asserts the helper's STRUCTURE —
 * every native invocation goes through the checked Invoke-Native wrapper, and the wrapper
 * itself fails on a non-zero $LASTEXITCODE — so a raw native call re-added to the helper fails
 * here instead of silently restoring the mask. The behavioural negative control (a failing
 * command followed by a succeeding one must leave the step red) is exercised by the real
 * Windows packaged-QA job, which is the only place a PowerShell runtime exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'vis-bridge-installer-windows.ps1');
const source = readFileSync(helperPath, 'utf8');

test('every native invocation in the helper goes through the checked wrapper', () => {
  // A raw `vis_bridge ...` or `node ...` statement is exactly the shape that let a non-zero
  // exit pass unnoticed. The wrapper's own definition is the only allowed mention at
  // statement position.
  const rawCalls = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /^(vis_bridge|node)\s/.test(line));
  assert.deepEqual(rawCalls, [], `the helper still calls a native command without checking its exit code: ${rawCalls.map((entry) => `${entry.number}: ${entry.line}`).join('; ')}`);
});

test('the wrapper fails loudly on a non-zero native exit', () => {
  assert.match(source, /function Invoke-Native/, 'the helper defines no Invoke-Native wrapper');
  assert.match(source, /\$LASTEXITCODE -ne 0/, 'the wrapper never inspects $LASTEXITCODE');
  assert.match(source, /throw "native command failed/, 'the wrapper does not throw on a non-zero exit');
  // The thrown message must name WHICH command failed, or a masked failure is still undebuggable.
  assert.match(source, /\$what/, 'the wrapper does not name the failing command in its error');
});

test('every QA step in the helper is a checked call', () => {
  // The labels the acceptance lane grades. Each must appear as an Invoke-Native label, so
  // dropping one back to a raw call fails this test by name.
  const required = [
    'vis_bridge --help',
    'vis_bridge start --port 23199',
    'installer assert-pty',
    'installer spawn (first install)',
    'installer assert-stopped (after reinstall)',
    'installer spawn (before uninstall)',
    'installer assert-stopped (after uninstall)',
  ];
  const labels = [...source.matchAll(/-Label '([^']+)'/g)].map((match) => match[1]);
  for (const label of required) {
    assert.ok(labels.includes(label), `the helper no longer checks '${label}' through Invoke-Native (labels: ${labels.join(', ')})`);
  }
  assert.ok(labels.includes('vis_bridge stop'), 'the cleanup stop is unchecked, so a failed stop during cleanup is invisible');
});
