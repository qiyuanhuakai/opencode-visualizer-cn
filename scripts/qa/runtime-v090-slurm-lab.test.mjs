/**
 * Task 56 — the lab's completion marker must be THIS startup's, not the host's.
 *
 * The review of head e2601cb3b found the readiness residue in the native duplicate-start
 * path: `awaitLabReady` accepts `test -f /run/lab-setup-complete`, a FIXED path. The docker
 * runtime gets a fresh container per run, so the file is always this run's; the native
 * runtime runs the setup script on the REUSED isolated runner, where the previous run's
 * marker and its idle slurm daemons survive. `stopLab` never removed the marker, and the
 * setup script's own `rm -f` sits at line 287, right next to its own `touch` — after a long
 * apt install — while `awaitLabReady` has been polling since `startLab` returned. So a
 * native host that already holds `yes` plus two idle nodes reports ready while THIS round's
 * setup has barely begun.
 *
 * Three guards, all static because a privileged native restart is not available on a dev
 * host (the real native lane runs on the isolated CI runner):
 *
 *   1. the marker path carries a per-startup token, so a leftover marker from an earlier
 *      run cannot satisfy this run's readiness — `awaitLabReady` REJECTS when only the
 *      legacy path is present;
 *   2. the marker is written AFTER the version record it certifies, so `readLabDescriptor`
 *      never reads an empty or partial `/tmp/lab-versions.txt`;
 *   3. `stopLab` removes this startup's marker, so teardown leaves nothing behind.
 *
 * The negative controls are the current code's own shapes: a fixed `/run/lab-setup-complete`
 * check returns ready from a stale marker, and a `touch` that precedes the version writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { awaitLabReady, labSetupScript, stopLab } from './runtime-v090-slurm-lab.mjs';

const LEGACY_MARKER = '/run/lab-setup-complete';
/** The per-startup marker this run owns; the legacy path must never stand in for it. */
const THIS_STARTUP_MARKER = `${LEGACY_MARKER}-tok`;

test('a stale marker from an earlier startup never satisfies this startup\'s readiness', async () => {
  const markerPath = THIS_STARTUP_MARKER;
  const lab = { runtime: 'native', markerPath };
  // The reused native host still holds the PREVIOUS run's marker and its idle daemons.
  const probe = async (_lab, command) => {
    const script = command[command.length - 1];
    // Only the FIXED legacy path is present on the reused host; this startup's own
    // token-specific marker is not (its setup has barely begun).
    if (script === `test -f ${LEGACY_MARKER} && echo yes || echo no`) return { exitCode: 0, stdout: 'yes\n' };
    return { exitCode: 0, stdout: 'vislab-cn1 idle;vislab-cn2 idle\n' };
  };
  await assert.rejects(
    () => awaitLabReady(lab, 10, probe),
    /did not become ready/,
    'a fixed /run/lab-setup-complete check returns ready from a previous run\'s marker',
  );
});

test('this startup\'s own marker does satisfy readiness', async () => {
  // The positive control: the guard above must not pass by simply never becoming ready.
  const markerPath = THIS_STARTUP_MARKER;
  const lab = { runtime: 'native', markerPath };
  const probe = async (_lab, command) => {
    const script = command[command.length - 1];
    if (script === `test -f ${markerPath} && echo yes || echo no`) return { exitCode: 0, stdout: 'yes\n' };
    if (script === `test -f ${LEGACY_MARKER} && echo yes || echo no`) return { exitCode: 0, stdout: 'no\n' };
    return { exitCode: 0, stdout: 'vislab-cn1 idle;vislab-cn2 idle\n' };
  };
  await awaitLabReady(lab, 5000, probe);
});

test('the completion marker follows every command writing the version record', () => {
  const script = labSetupScript('tok');
  const marker = `touch ${LEGACY_MARKER}-tok`;
  const writes = (value) => value.split('\n').filter(line =>
    !line.trimStart().startsWith('#') && />{1,2} \/tmp\/lab-versions\.txt(?: |$)/.test(line));
  const versions = writes(script);
  assert.equal(versions.length, 5, 'the setup must emit all five version commands');
  const markerFollowsWrites = (value) => {
    const lines = value.split('\n');
    const markerAt = lines.indexOf(marker);
    return markerAt !== -1 && writes(value).every(line => lines.lastIndexOf(line) < markerAt);
  };
  assert.ok(markerFollowsWrites(script), 'readiness must follow completion of the version record');
  const lastWrite = versions.at(-1);
  const reordered = script.replace(marker, '').replace(lastWrite, `${marker}\n${lastWrite}`);
  assert.equal(markerFollowsWrites(reordered), false, 'the gate must reject a marker preceding the last write');
});

test('the setup script sweeps stale markers before it installs anything', () => {
  const script = labSetupScript('tok');
  const sweepAt = script.search(/rm -f \/run\/lab-setup-complete/);
  const installAt = script.indexOf('apt-get install');
  assert.ok(sweepAt !== -1, 'the setup script must sweep leftover markers');
  assert.ok(
    sweepAt < installAt,
    'the sweep runs after the install, so a stale marker outlives most of this startup\'s setup',
  );
});

test('teardown removes this startup\'s completion marker', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vis-v090-lab-marker-'));
  const markerPath = path.join(dir, 'lab-setup-complete-tok');
  writeFileSync(markerPath, '');
  await stopLab({ runtime: 'native', markerPath, workdir: path.join(dir, 'workdir'), keep: true });
  assert.equal(existsSync(markerPath), false, 'stopLab left the completion marker behind on the reused host');
  rmSync(dir, { recursive: true, force: true });
});
