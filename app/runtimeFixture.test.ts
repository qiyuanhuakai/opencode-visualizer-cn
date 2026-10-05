// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const generator = path.join(root, 'scripts/qa/runtime-v090-fixtures.mjs');
const benchmark = path.join(root, 'scripts/qa/runtime-v090-benchmark.mjs');
const temporary = mkdtempSync(path.join(tmpdir(), 'vis-runtime-fixtures-'));
const standard = path.join(temporary, 'standard');
const run = (args: readonly string[]) => execFileSync(process.execPath, [generator, ...args], { encoding: 'utf8' });
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
beforeAll(() => run(['generate', '--out', standard, '--count', '10000']), 120_000);

describe('runtime seed090 fixture', () => {
  it('reproduces all inventory hashes when the standard input is generated twice', () => {
    // Given: the fixed standard seed and a second isolated output.
    const second = path.join(temporary, 'second');
    // When: generating the same input again.
    run(['generate', '--out', second, '--count', '10000']);
    // Then: independent inventories and every generated file hash agree.
    expect(readFileSync(path.join(second, 'expected.json'), 'utf8')).toBe(readFileSync(path.join(standard, 'expected.json'), 'utf8'));
    expect(readFileSync(path.join(second, 'manifest.json'), 'utf8')).toBe(readFileSync(path.join(standard, 'manifest.json'), 'utf8'));
    expect(JSON.parse(run(['check', '--out', second]))).toMatchObject({ verified: true, sessions: 10000, drafts: 10001, worktrees: 200, sources: 5 });
    rmSync(second, { recursive: true, force: true });
  }, 120_000);

  it('verifies 100k summaries and complete chunked bodies and attachments when the stress profile is generated', () => {
    // Given: the 100k stress input.
    const stress = path.join(temporary, 'stress');
    // When: generating and checking the full content without loading the dataset into memory.
    run(['generate', '--out', stress, '--count', '100000']);
    const result: unknown = JSON.parse(run(['check', '--out', stress]));
    // Then: all counts, boundary groups, per-draft hashes and file hashes are verified.
    expect(result).toMatchObject({ verified: true, sessions: 100000, drafts: 100001, worktrees: 200, sources: 5, chunkBytes: 65536 });
    rmSync(stress, { recursive: true, force: true });
  }, 120_000);

  it('failure rejects a deleted fixture record even when a success message is printed', () => {
    // Given: one missing record in a previously valid fixture.
    const file = path.join(standard, 'summaries.ndjson');
    const original = readFileSync(file);
    try {
      writeFileSync(file, original.subarray(original.indexOf(10) + 1));
      // When: the checker runs against the damaged file.
      const wrapper = `console.log('fixture verified: true'); const { spawnSync } = require('node:child_process'); const result = spawnSync(process.execPath, process.argv.slice(1), { encoding: 'utf8' }); process.stderr.write(result.stderr); process.exit(result.status ?? 1);`;
      const result = spawnSync(process.execPath, ['-e', wrapper, generator, 'check', '--out', standard], { encoding: 'utf8' });
      // Then: process failure, rather than an unrelated success-looking log, is authoritative.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('integrity');
      expect(result.stdout).toContain('fixture verified: true');
    } finally { writeFileSync(file, original); }
  });

  it('failure rejects an incorrect expected count', () => {
    // Given: tampered independent expected inventory.
    const file = path.join(standard, 'expected.json');
    const original = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, original.replace('"sessions": 10000', '"sessions": 9999'));
      // When: checking the independent inventory.
      const result = spawnSync(process.execPath, [generator, 'check', '--out', standard], { encoding: 'utf8' });
      // Then: the mismatch is rejected.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('inventory');
    } finally { writeFileSync(file, original); }
  });

  it('failure rejects corrupted generated attachment bytes', () => {
    // Given: a one-byte attachment mutation.
    const fd = openSync(path.join(standard, 'attachments.bin'), 'r+');
    const original = Buffer.alloc(1);
    readSync(fd, original, 0, 1, 0);
    try {
      writeSync(fd, Buffer.from([original[0] === 0 ? 1 : 0]), 0, 1, 0);
      // When: checking the dataset.
      const result = spawnSync(process.execPath, [generator, 'check', '--out', standard], { encoding: 'utf8' });
      // Then: corruption cannot produce a success exit.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('integrity');
    } finally { writeSync(fd, original, 0, 1, 0); closeSync(fd); }
  });

  it('failure preserves stale or dirty output instead of overwriting it', () => {
    // Given: an existing directory with caller-owned data.
    const marker = path.join(standard, 'caller-owned.txt');
    writeFileSync(marker, 'preserve me');
    // When: generation targets that existing directory.
    const result = spawnSync(process.execPath, [generator, 'generate', '--out', standard], { encoding: 'utf8' });
    // Then: generation refuses and preserves the bytes.
    expect(result.status).not.toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('preserve me');
  });

  it.each(['slow', 'error'])('failure rejects complete timing when the source is %s', (state) => {
    // Given: an incomplete source carrying misleading completion timing.
    const file = path.join(temporary, `sample-${state}.json`);
    writeFileSync(file, JSON.stringify({ sourceState: state, completeMs: 1 }));
    // When: validating the measurement boundary.
    const result = spawnSync(process.execPath, [benchmark, '--check-sample', file], { encoding: 'utf8' });
    // Then: incomplete input is never recorded as complete.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('incomplete');
  });
});
