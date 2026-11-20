import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { digest, productionSource, sourceSnapshot } from './runtime-v090-evidence.mjs';

const git = (root, args, options = {}) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, ...options });

export function committedPerfSource(root, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/, 'production revision required');
  const tree = git(root, ['ls-tree', '-rz', revision], { encoding: 'utf8' });
  const files = tree.split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, separator).split(' ');
    assert(type === 'blob' && (mode === '100644' || mode === '100755'), 'unsupported production tree entry');
    return { oid, path: entry.slice(separator + 1) };
  });
  assert(files.length > 0, 'production source inventory is empty');

  const records = git(root, ['cat-file', '--batch'], {
    input: files.map(file => file.oid).join('\n') + '\n',
    maxBuffer: 128 * 1024 * 1024,
  });
  let offset = 0;
  const sourceHashes = Object.fromEntries(files.map(file => {
    const end = records.indexOf(10, offset);
    assert(end >= offset, 'missing Git blob header');
    const [oid, type, sizeField] = records.toString('ascii', offset, end).split(' ');
    assert(oid === file.oid && type === 'blob' && /^\d+$/.test(sizeField), 'unexpected Git blob header');
    const size = Number(sizeField);
    const start = end + 1;
    offset = start + size + 1;
    assert(Number.isSafeInteger(size) && records[offset - 1] === 10, 'invalid Git blob length');
    return [file.path, digest(records.subarray(start, offset - 1))];
  }));
  assert.equal(offset, records.length, 'unexpected trailing Git blob data');
  return { sourceHashes, identity: productionSource(root, sourceHashes, revision) };
}

export function assertPerfCheckout(root, revision, sourceHashes) {
  assert.equal(git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), revision, 'benchmark revision changed');
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }), '', 'benchmark requires a clean candidate checkout');
  const actual = sourceSnapshot(root, Object.keys(sourceHashes));
  for (const [file, hash] of Object.entries(sourceHashes)) {
    assert.equal(actual[file], hash, `benchmark source differs from candidate blob: ${file}`);
  }
}
