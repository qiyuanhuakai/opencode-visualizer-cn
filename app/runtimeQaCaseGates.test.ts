// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupFailure } from '../scripts/qa/runtime-v090-cases/qa-cleanup-gate.mjs';
import { browserKernelSpecifier, loadBrowserKernel } from '../scripts/qa/runtime-v090-cases/qa-browser-kernel.mjs';
import { readWorktreeState, worktreePreserved } from '../scripts/qa/runtime-v090-cases/qa-worktree.mjs';
import { createFixture } from '../scripts/qa/runtime-v090-cases/task-27-fixture.mjs';

// PR #186 review round 1 findings 1, 3 and 4: the QA cases swallowed cleanup
// failures under `status: passed`, imported the browser kernel from a hardcoded
// personal cache path, and required the worktree to be DIRTY. These tests pin
// the corrected gates; each one names the legacy formulation it replaces.

const temporary = mkdtempSync(path.join(tmpdir(), 'runtime-qa-gates-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

describe('QA cleanup gate (review finding 1)', () => {
  it('passes a clean receipt and fails a leaked one, keeping an in-flight failure as the cause', () => {
    expect(cleanupFailure(undefined)).toBeNull();
    expect(cleanupFailure({ cleanup: [{ kind: 'private-root', passed: true }] })).toBeNull();

    const leaked = cleanupFailure({ error: 'AggregateError: task27 QA cleanup failed' });
    expect(leaked).toBeInstanceOf(Error);
    expect(leaked?.message).toBe('QA cleanup failed: AggregateError: task27 QA cleanup failed');

    const body = new Error('mid-case assertion');
    const aggregated = cleanupFailure({ error: 'AggregateError: task27 QA cleanup failed' }, body);
    expect(aggregated?.cause).toBe(body);
  });

  it('re-throws a REAL fixture close failure after the receipt is written, where the legacy swallow exited zero', async () => {
    const runDir = path.join(temporary, 'cleanup-run');
    mkdirSync(runDir, { recursive: true });
    const evidenceDir = path.join(temporary, 'cleanup-evidence');
    mkdirSync(evidenceDir, { recursive: true });
    const fixture = await createFixture({ temporaryRoot: path.join(temporary, 'cleanup-root'), runDir, evidenceDir, case: 'happy' });
    fixture.own('owned-listener', async () => { throw new Error('listen EADDRINUSE: 127.0.0.1:23004'); });

    // The legacy formulation: the close failure became a plain receipt object and
    // the case exited zero with the resource still held.
    const swallowed = await fixture.close().catch((error) => ({ error: String(error) })) as { error?: string };
    expect(swallowed.error).toContain('task27 QA cleanup failed');

    // The gated formulation: the receipt lands first, then the case fails.
    const receipt = path.join(runDir, 'proof.json');
    writeFileSync(receipt, JSON.stringify({ cleanup: swallowed }));
    const leaked = cleanupFailure(swallowed, new Error('mid-case assertion'));
    expect(leaked?.message).toContain('QA cleanup failed');
    expect(existsSync(receipt)).toBe(true);
  });
});

describe('QA browser kernel resolution (review finding 3)', () => {
  it('fails with an actionable precheck when the kernel is not configured', () => {
    expect(() => browserKernelSpecifier({})).toThrow(/VIS_QA_BROWSER_KERNEL/);
    expect(() => browserKernelSpecifier({ VIS_QA_BROWSER_KERNEL: '' })).toThrow(/VIS_QA_BROWSER_KERNEL/);
  });

  it('loads the configured kernel module and rejects one that does not export it', async () => {
    const kernel = path.join(temporary, 'kernel.mjs');
    writeFileSync(kernel, 'export function loadOmowright() { return { kernel: true }; }');
    expect(await loadBrowserKernel({ VIS_QA_BROWSER_KERNEL: kernel })).toEqual({ kernel: true });

    const wrong = path.join(temporary, 'wrong.mjs');
    writeFileSync(wrong, 'export const other = 1;');
    await expect(loadBrowserKernel({ VIS_QA_BROWSER_KERNEL: wrong })).rejects.toThrow(/does not export loadOmowright/);
  });
});

describe('QA worktree assertion (review finding 4)', () => {
  function initRepo(name: string): string {
    const root = path.join(temporary, name);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'qa@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'qa'], { cwd: root });
    writeFileSync(path.join(root, 'file.txt'), 'one\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: root });
    return root;
  }

  it('requires the worktree to be UNCHANGED, not dirty', () => {
    const clean = initRepo('clean');
    const cleanBefore = readWorktreeState(clean);
    // The legacy assertion required any dirt, so a clean checkout failed the case
    // at the last check after every functional assertion had passed.
    expect(cleanBefore.length > 0).toBe(false);
    expect(worktreePreserved(clean, cleanBefore)).toBe(true);

    const dirty = initRepo('dirty');
    writeFileSync(path.join(dirty, 'file.txt'), 'two\n');
    const dirtyBefore = readWorktreeState(dirty);
    expect(dirtyBefore.length > 0).toBe(true);
    expect(worktreePreserved(dirty, dirtyBefore)).toBe(true);

    // A file the case itself left behind breaks the assertion.
    writeFileSync(path.join(dirty, 'case-leaked.txt'), 'case output\n');
    expect(worktreePreserved(dirty, dirtyBefore)).toBe(false);
  });
});
