// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['before', 'after'])(
  'recovers a durable writer allocation after process exit %s Git worktree creation without dispatching a native turn',
  async (phase) => {
    const root = await mkdtemp(path.join(tmpdir(), 'vis-writer-recovery-'));
    roots.push(root);
    const repository = path.join(root, 'repository');
    execFileSync('git', ['init', repository], { stdio: 'ignore' });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('config', 'user.name', 'Recovery Test');
    git('config', 'user.email', 'recovery@localhost');
    git('commit', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
    const script = path.join(root, 'scenario.mjs');
    await writeFile(
      script,
      `
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createWriterLeaseService, createWorktreeCreator, createGitRunner } from ${JSON.stringify(new URL('bridge/runtime/collaboration/writerLeases.js', new URL('file://' + sourceRoot)).href)};
import { createHostPersistence } from ${JSON.stringify(new URL('bridge/runtime/hostPersistence.js', new URL('file://' + sourceRoot)).href)};
import { createRuntimeStore } from ${JSON.stringify(new URL('bridge/runtime/storage/runtimeStore.js', new URL('file://' + sourceRoot)).href)};
const [mode, root, environmentId, taskId, phase] = process.argv.slice(2);
const prior = mode === 'recover' ? JSON.parse(await readFile(path.join(root, 'fence.json'), 'utf8')) : null;
const store = createRuntimeStore({ stateDirectory: root, environmentId, ownerId: randomUUID(), epoch: randomUUID(), ...(prior ? { takeover: { expectedFence: prior.fence } } : {}) });
const inspection = await store.ready;
let persistence;
const realCreate = createWorktreeCreator(createGitRunner());
const writer = createWriterLeaseService({ writersRoot: path.join(root, 'writers'),
  beforeCreate: async lease => { await persistence.flush(); await writeFile(path.join(root, 'fence.json'), JSON.stringify({ fence: inspection.fence, lease })); if (mode === 'crash' && phase === 'before') process.exit(92); },
  createWorktree: async input => { await realCreate(input); if (mode === 'crash') process.exit(93); },
});
persistence = createHostPersistence({ store, domains: { writer: { collection: 'artifacts', id: value => value.leaseId, export: writer.exportRecords, restore: writer.restoreRecords } } });
await persistence.restore();
if (mode === 'crash') await writer.allocate({ taskId, ownerId: 'host-recovery', repository: path.join(root, 'repository') });
else {
  const [lease] = writer.leases();
  const original = { ...lease };
  const check = await writer.reconcile({ leaseId: lease.leaseId });
  const recovered = phase === 'before' ? await writer.reconcile({ leaseId: lease.leaseId, createMissing: true }) : check;
  await persistence.flush();
  let duplicate = false;
  try { await writer.allocate({ taskId, ownerId: 'host-recovery', repository: path.join(root, 'repository') }); } catch(error) { duplicate = error.field === 'writer_lease_task'; }
  const operations = await store.page({ collection: 'operations', limit: 100 });
  console.log(JSON.stringify({ original, check, recovered, duplicate, nativeOperations: operations.items.length, worktreeExists: (await lstat(recovered.worktree)).isDirectory() }));
  writer.close(); await store.close();
}
`,
    );
    const environmentId = randomUUID(),
      taskId = randomUUID();
    const crashed = spawnSync(
      process.execPath,
      [script, 'crash', root, environmentId, taskId, phase],
      { encoding: 'utf8' },
    );
    expect(crashed.status, crashed.stderr).toBe(phase === 'before' ? 92 : 93);
    const recovered = spawnSync(
      process.execPath,
      [script, 'recover', root, environmentId, taskId, phase],
      { encoding: 'utf8' },
    );
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      original: { state: 'allocating', taskId, repository, baseCommit: base },
      recovered: { state: 'active', taskId, repository, baseCommit: base },
      duplicate: true,
      nativeOperations: 0,
      worktreeExists: true,
    });
    if (phase === 'before')
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        check: { recovery: 'worktree_missing' },
      });
    expect(git('status', '--porcelain')).toBe('');
    if (process.env.VIS_RUNTIME_QA_EVIDENCE)
      await writeFile(
        path.join(process.env.VIS_RUNTIME_QA_EVIDENCE, `writer-recovery-${phase}.json`),
        JSON.stringify(
          {
            crashExit: crashed.status,
            recoveryExit: recovered.status,
            result: JSON.parse(recovered.stdout),
          },
          null,
          2,
        ),
      );
  },
);
