#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expectedInventory, input, summaryAt, wireAt } from '../../app/dev/runtime-v090/fixtures/inventory.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const same = (left, right, reason) => { if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`fixture integrity: ${reason}`); };

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: input.chunkBytes })) hash.update(chunk);
  return hash.digest('hex');
}

async function* rows(file) {
  const stream = createReadStream(file);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) yield JSON.parse(line); }
  finally { lines.close(); stream.destroy(); }
}

export async function generateFixture(directory, count = 10000) {
  const expected = expectedInventory(count);
  // Exclusive creation refuses stale data and never replaces a caller-owned directory.
  await mkdir(directory);
  const files = new Map();
  const paths = ['summaries.ndjson', 'drafts.ndjson', 'bodies.bin', 'attachments.bin', ...input.sources.map((source) => `${source}.ndjson`)];
  try {
    for (const name of paths) files.set(name, openSync(path.join(directory, name), 'wx'));
    const line = (name, value) => writeSync(files.get(name), `${JSON.stringify(value)}\n`);
    const block = Buffer.alloc(input.chunkBytes);
    const offsets = { 'bodies.bin': 0, 'attachments.bin': 0 };
    const blob = (name, bytes, ordinal) => {
      const offset = offsets[name];
      const hash = createHash('sha256');
      block.fill(65 + ordinal % 26);
      for (let remaining = bytes; remaining > 0; remaining -= input.chunkBytes) {
        const chunk = block.subarray(0, Math.min(input.chunkBytes, remaining));
        writeSync(files.get(name), chunk); hash.update(chunk);
      }
      offsets[name] += bytes;
      return { file: name, offset, bytes, sha256: hash.digest('hex') };
    };
    for (let ordinal = 0; ordinal <= count; ordinal++) {
      const large = ordinal === count;
      if (!large) { const summary = summaryAt(ordinal); line('summaries.ndjson', summary); line(`${summary.source}.ndjson`, wireAt(summary)); }
      line('drafts.ndjson', { id: `draft-${ordinal}`, clientOrigin: 'seed090-client', revision: 1, synced: false,
        body: blob('bodies.bin', large ? input.largeBodyBytes : input.bodyBytes, ordinal),
        attachment: large || ordinal % input.attachmentEvery === 0 ? blob('attachments.bin', large ? input.largeAttachmentBytes : input.attachmentBytes, ordinal) : null });
    }
  } finally { for (const fd of files.values()) closeSync(fd); }
  await mkdir(path.join(directory, 'worktrees'));
  for (let i = 0; i < input.worktrees; i++) {
    const worktree = path.join(directory, 'worktrees', `wt-${i}`);
    await mkdir(worktree);
    await writeFile(path.join(worktree, 'fixture.json'), json({ canonicalPath: `/seed090/repo/worktrees/wt-${i}`, commonDir: '/seed090/repo/.git', branch: `fixture-${i}` }));
  }
  await writeFile(path.join(directory, 'expected.json'), json(expected));
  const manifest = {};
  for (const name of paths) manifest[name] = { bytes: (await stat(path.join(directory, name))).size, sha256: await hashFile(path.join(directory, name)) };
  await writeFile(path.join(directory, 'manifest.json'), json({ seed: input.seed, count, chunkBytes: input.chunkBytes, files: manifest }));
  return expected;
}

export async function checkFixture(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const expected = expectedInventory(manifest.count);
  same(JSON.parse(await readFile(path.join(directory, 'expected.json'), 'utf8')), expected, 'expected inventory does not match seed inputs');
  same(Object.keys(manifest.files).sort(), ['summaries.ndjson', 'drafts.ndjson', 'bodies.bin', 'attachments.bin', ...input.sources.map((source) => `${source}.ndjson`)].sort(), 'file inventory');
  for (const [name, metadata] of Object.entries(manifest.files)) {
    same((await stat(path.join(directory, name))).size, metadata.bytes, `${name} bytes`);
    same(await hashFile(path.join(directory, name)), metadata.sha256, `${name} hash`);
  }
  let count = 0;
  const identities = createHash('sha256');
  for await (const row of rows(path.join(directory, 'summaries.ndjson'))) {
    same(row, summaryAt(count), `summary ${count}`);
    identities.update(`${row.source}:${row.nativeSessionId}\n`); count++;
  }
  same(count, expected.sessions, 'session count');
  same(identities.digest('hex'), expected.identitiesSha256, 'identity inventory');
  for (const [sourceIndex, source] of input.sources.entries()) {
    let wireCount = 0;
    for await (const row of rows(path.join(directory, `${source}.ndjson`))) {
      same(row, JSON.parse(JSON.stringify(wireAt(summaryAt(wireCount * 5 + sourceIndex)))), `${source} wire ${wireCount}`); wireCount++;
    }
    same(wireCount, expected.sources[source], `${source} count`);
  }
  const offsets = { 'bodies.bin': 0, 'attachments.bin': 0 };
  const block = Buffer.alloc(input.chunkBytes);
  let drafts = 0;
  for await (const row of rows(path.join(directory, 'drafts.ndjson'))) {
    const large = drafts === expected.sessions;
    same([row.id, row.clientOrigin, row.revision, row.synced], [`draft-${drafts}`, 'seed090-client', 1, false], 'draft identity');
    const sizes = [large ? input.largeBodyBytes : input.bodyBytes, large ? input.largeAttachmentBytes : drafts % input.attachmentEvery === 0 ? input.attachmentBytes : 0];
    for (const [index, name] of ['bodies.bin', 'attachments.bin'].entries()) {
      const bytes = sizes[index]; const metadata = index === 0 ? row.body : row.attachment;
      if (!bytes) { same(metadata, null, 'absent attachment'); continue; }
      const expectedHash = createHash('sha256'); block.fill(65 + drafts % 26);
      for (let remaining = bytes; remaining > 0; remaining -= input.chunkBytes) expectedHash.update(block.subarray(0, Math.min(input.chunkBytes, remaining)));
      same(metadata, { file: name, offset: offsets[name], bytes, sha256: expectedHash.digest('hex') }, 'draft blob inventory');
      const actualHash = createHash('sha256');
      for await (const chunk of createReadStream(path.join(directory, name), { start: offsets[name], end: offsets[name] + bytes - 1, highWaterMark: input.chunkBytes })) actualHash.update(chunk);
      same(actualHash.digest('hex'), metadata.sha256, 'draft blob content'); offsets[name] += bytes;
    }
    drafts++;
  }
  same(drafts, expected.drafts, 'draft count');
  same(offsets, { 'bodies.bin': expected.bodyBytes, 'attachments.bin': expected.attachmentBytes }, 'blob byte inventory');
  const worktrees = await readdir(path.join(directory, 'worktrees'));
  same(worktrees.length, input.worktrees, 'worktree count');
  for (let i = 0; i < input.worktrees; i++) same(JSON.parse(await readFile(path.join(directory, 'worktrees', `wt-${i}`, 'fixture.json'), 'utf8')), { canonicalPath: `/seed090/repo/worktrees/wt-${i}`, commonDir: '/seed090/repo/.git', branch: `fixture-${i}` }, 'worktree metadata');
  return { verified: true, sessions: count, drafts, worktrees: worktrees.length, sources: input.sources.length, chunkBytes: input.chunkBytes, inventory: expected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const directory = args[args.indexOf('--out') + 1];
    if (!args.includes('--out') || !directory) throw new Error('--out is required');
    if (command === 'generate') console.log(json(await generateFixture(path.resolve(directory), args.includes('--count') ? Number(args[args.indexOf('--count') + 1]) : 10000)));
    else if (command === 'check') console.log(json(await checkFixture(path.resolve(directory))));
    else throw new Error('expected generate or check');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
