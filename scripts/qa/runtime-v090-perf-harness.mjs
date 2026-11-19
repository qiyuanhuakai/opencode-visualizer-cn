import { fork, spawn, execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedInventory, summaryAt } from '../../app/dev/runtime-v090/fixtures/inventory.mjs';
import { readProcessTreeRss } from './runtime-v090-benchmark.mjs';

export const repository = fileURLToPath(new URL('../..', import.meta.url));
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export async function until(predicate, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
export async function prepareFixture(count, output) {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-production-perf-'));
  await mkdir(path.join(root, 'worktrees', 'wt-0'), { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: path.join(root, 'worktrees', 'wt-0'), stdio: 'pipe' });
  git(['init', '--quiet']);
  git(['-c', 'user.name=Vis QA', '-c', 'user.email=qa@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'seed090']);
  for (let index = 1; index < 200; index++) git(['worktree', 'add', '--quiet', '--detach', path.join(root, 'worktrees', `wt-${index}`)]);
  const receipt = { root, count, expected: expectedInventory(count), worktrees: git(['worktree', 'list', '--porcelain']).toString(), createdAt: new Date().toISOString() };
  await writeFile(path.join(output, 'fixture.json'), json(receipt));
  return root;
}
export async function startNative(root, count, output) {
  const stream = createWriteStream(path.join(output, 'native.log'));
  const child = spawn(process.execPath, ['scripts/qa/runtime-v090-perf-native.mjs', root, String(count)], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid })));
  const close = async () => {
    child.kill('SIGTERM');
    const exit = await exited;
    stream.end();
    return exit;
  };
  try {
    const descriptor = await until(async () => {
      if (child.exitCode !== null) throw new Error(`Native fixture exited ${child.exitCode}`);
      try { return JSON.parse(await readFile(path.join(root, 'native.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'native descriptor');
    return { child, exited, descriptor, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function startBridge(root, stateRoot, output, empty = false) {
  const stream = createWriteStream(`${output}.log`);
  const launched = performance.now();
  const child = fork(path.join(repository, 'scripts/qa/runtime-v090-perf-bridge.mjs'), [root, stateRoot, ...(empty ? ['--empty'] : [])], { cwd: repository, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  const messages = [];
  child.on('message', (message) => messages.push({ ...message, sinceSpawnMs: performance.now() - launched }));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid })));
  const descriptor = await until(() => {
    if (child.exitCode !== null) throw new Error(`Bridge exited ${child.exitCode}: ${output}.log`);
    return messages.find((message) => message.type === 'ready');
  }, 'Bridge ready');
  return { child, descriptor, messages, launched,
    indexed: () => until(() => messages.find((message) => message.type === 'indexed'), 'production native indexing', 600000),
    rss: () => {
      const all = readProcessTreeRss(child.pid);
      let peers = [];
      try { peers = readFileSync(path.join(root, 'native-pids.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const native = peers.map(({ pid }) => readProcessTreeRss(pid)).filter((entry) => entry.processCount);
      return { ...all, rssBytes: all.rssBytes - native.reduce((sum, entry) => sum + entry.rssBytes, 0), cpuJiffies: all.cpuJiffies - native.reduce((sum, entry) => sum + entry.cpuJiffies, 0), excludedNative: native };
    },
    close: async () => { child.kill('SIGTERM'); const exit = await exited; stream.end(); await writeFile(`${output}-messages.json`, json(messages)); return exit; },
  };
}
export function indexInventory(stateRoot, count) {
  const database = new DatabaseSync(path.join(stateRoot, 'runtime', 'runtime.db'), { readOnly: true, timeout: 5000 });
  try {
    database.exec('BEGIN');
    const harnesses = database.prepare('SELECT value FROM harnesses').all().map((row) => JSON.parse(row.value));
    const kind = new Map(harnesses.map((row) => [row.harnessInstanceId, row.kind]));
    const expected = expectedInventory(count);
    const sources = {}, groups = { archived: 0, orphan: 0, child: 0 };
    const identities = [];
    const sample = [];
    for (const row of database.prepare('SELECT value FROM session_summaries ORDER BY key').iterate()) {
      const value = JSON.parse(row.value), source = kind.get(value.session.harnessInstanceId);
      sources[source] = (sources[source] ?? 0) + 1;
      identities.push(`${source}:${value.session.nativeSessionId}`);
      if (value.archived) groups.archived++;
      if (!value.workspaceKey) groups.orphan++;
      if (value.parentSession) groups.child++;
      if (sample.length < 5) sample.push(value);
    }
    const actualHash = createHash('sha256').update(identities.sort().join('\n')).digest('hex');
    const oracle = Array.from({ length: count }, (_, ordinal) => { const row = summaryAt(ordinal); return `${row.source}:${row.nativeSessionId}`; }).sort();
    return { integrity: database.prepare('PRAGMA integrity_check').get(), count: identities.length, expectedCount: count, sources, groups, sample, expected,
      hash: actualHash, expectedHash: createHash('sha256').update(oracle.join('\n')).digest('hex'),
      coverage: identities.length === count && actualHash === createHash('sha256').update(oracle.join('\n')).digest('hex'),
      workspaces: database.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count,
      harnesses: harnesses.map((row) => ({ kind: row.kind, id: row.harnessInstanceId, discovery: row.indexDiscovery, support: row.manifest?.core?.listSessionPage })),
    };
  } finally { database.close(); }
}
