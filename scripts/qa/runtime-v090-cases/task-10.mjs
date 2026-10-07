import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTargetGitCommand } from '../../../bridge/runtime/targetGitCommand.js';
import { createGitService } from '../../../bridge/runtime/gitService.js';
import { createWorktreeService } from '../../../bridge/runtime/worktreeService.js';
import { createWorkspaceCatalog } from '../../../bridge/runtime/workspaceCatalog.js';
import { createRepositoryOperation } from '../../../bridge/runtime/repositoryOperation.js';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { parseWorktrees } from '../../../bridge/runtime/gitOutputParser.js';
import { encodeWorkspaceKey, encodeRepoKey } from '../../../shared/runtime/identity.js';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';

export const sourceFiles = [
  'gitService',
  'workspaceCatalog',
  'worktreeService',
  'gitOutputParser',
  'targetGitCommand',
  'repositoryOperation',
  'worktreeLease',
]
  .flatMap((name) => [`bridge/runtime/${name}.js`, `bridge/runtime/${name}.d.ts`])
  .concat([
    'bridge/runtime/storage/runtimeStore.js',
    'bridge/runtime/storage/runtimeDatabaseWorker.mjs',
    'bridge/runtime/operationJournal.js',
    'shared/runtime/identity.js',
    'app/runtimeGit.test.ts',
  ]);
const target = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function dead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

export async function run(context) {
  const root = await mkdtemp(path.join(context.temporaryRoot, 'git topology '));
  const repo = path.join(root, 'repo with spaces');
  await mkdir(repo);
  const native = (args, cwd = repo) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  native(['init', '--quiet']);
  await writeFile(path.join(repo, 'tracked'), 'base content');
  native(['add', '--', 'tracked']);
  native([
    '-c',
    'user.name=QA',
    '-c',
    'user.email=qa@example.com',
    'commit',
    '--quiet',
    '-m',
    'base',
  ]);
  const baseCommit = native(['rev-parse', 'HEAD']).trim();
  const policy = {
    platform: 'posix',
    volumeId: String((await stat(root)).dev),
    caseSensitive: true,
  };
  const ref = (canonicalPath) => ({ environmentId: target, canonicalPath, pathPolicy: policy });
  const workspace = ref(repo);
  const options = {
    target,
    roots: [{ root, pathPolicy: policy, permissions: ['read', 'command', 'write'] }],
    assertCurrent() {},
  };
  const command = await createTargetGitCommand(options);
  const commands = [];
  const pids = [];
  const traced = {
    ...command,
    async run(request) {
      commands.push({ cwd: request.workspace.canonicalPath, args: request.args });
      return command.run(request);
    },
    async start(request) {
      commands.push({ cwd: request.workspace.canonicalPath, args: request.args });
      const job = await command.start(request);
      if (job.pid) pids.push(job.pid);
      return job;
    },
  };
  const git = createGitService({ command: traced });
  const storeOptions = {
    stateDirectory: path.join(root, 'state'),
    environmentId: target,
    ownerId,
    epoch,
  };
  let store = createRuntimeStore(storeOptions);
  await store.ready;
  pids.push(store.pid);
  const service = createWorktreeService({ command: traced, git, store, assertCurrent() {} });
  const additional = [];
  const scenarios = [];
  const artifacts = [];
  const check = (name, observed, expected) => {
    assert.deepEqual(observed, expected, name);
    scenarios.push({ name, assertions: [{ name, observed, expected, passed: true }] });
    console.log(`PASS ${name}`);
  };
  async function reject(name, callback, pattern) {
    await assert.rejects(callback, pattern);
    check(name, true, true);
  }
  try {
    if (context.case === 'happy') {
      const linked = path.join(root, 'linked space\n');
      native(['worktree', 'add', '--detach', '--', linked]);
      const [first, second] = await Promise.all([git.probe(workspace), git.probe(ref(linked))]);
      check(
        'real linked worktrees share canonical common-dir including trailing newline path',
        [
          first.kind,
          second.kind,
          first.repoKey === second.repoKey,
          second.worktrees.some((item) => item.path === linked),
        ],
        ['git', 'git', true, true],
      );
      check(
        'same path in another environment has a separate RepoKey',
        encodeRepoKey({ ...first.repo, environmentId: foreign }) === first.repoKey,
        false,
      );
      check(
        'detached and branch state come from native Git',
        [second.branch, typeof first.branch],
        [null, 'string'],
      );
      const nonGit = path.join(root, 'no git');
      await mkdir(nonGit);
      check(
        'non-Git directory remains discoverable',
        (await git.probe(ref(nonGit))).kind,
        'non-git',
      );
      const catalog = createWorkspaceCatalog({ store, git });
      const before = commands.length;
      for (let i = 0; i < 200; i++) {
        const directory = path.join(root, `metadata-${i}`);
        native(['worktree', 'add', '--quiet', '--detach', '--', directory]);
        await catalog.register({
          workspace: ref(directory),
          harnessInstanceId: foreign,
          harness: 'codex',
        });
      }
      await catalog.register({
        workspace: ref(path.join(root, 'orphan')),
        harnessInstanceId: foreign,
        harness: 'dsh',
        orphan: true,
      });
      const harnesses = ['opencode', 'codex', 'kimi', 'dsh', 'acp'];
      for (const [i, harness] of harnesses.entries())
        await catalog.register({
          workspace,
          harnessInstanceId: `55555555-5555-4555-8555-55555555555${i}`,
          harness,
        });
      await catalog.register({
        workspace: ref(nonGit),
        harnessInstanceId: foreign,
        harness: 'codex',
      });
      const firstPage = await catalog.page({ limit: 200 });
      const nextPage = await catalog.page({ cursor: firstPage.cursor });
      check(
        '200 worktree metadata and orphan pages perform zero eager Git commands',
        [commands.length - before, firstPage.items.length + nextPage.items.length],
        [0, 203],
      );
      const workspaceKey = encodeWorkspaceKey(workspace);
      git.invalidate(first.repoKey);
      const topologyBefore = commands.filter((call) => call.args[0] === 'worktree').length;
      await Promise.all([
        catalog.probe(workspaceKey, { selected: true }),
        catalog.probe(workspaceKey, { visible: true }),
      ]);
      check(
        'selected and visible demand reuse common-dir topology',
        commands.filter((call) => call.args[0] === 'worktree').length - topologyBefore,
        1,
      );
      const stored = await store.get({ collection: 'workspaces', key: workspaceKey });
      check(
        'all five harness sources persist one repository mapping',
        [stored.value.sources.map((source) => source.harness), stored.value.repoKey],
        [harnesses, first.repoKey],
      );
      await writeFile(path.join(repo, 'tracked'), 'modified content');
      check(
        'production diff reflects actual tracked file content',
        (await git.diff(workspace)).includes('+modified content'),
        true,
      );
      await writeFile(path.join(repo, 'tracked'), 'base content');
      const hooks = path.join(root, 'hooks');
      await mkdir(hooks);
      await writeFile(
        path.join(hooks, 'post-checkout'),
        `#!${process.execPath}\nsetTimeout(() => process.exit(0), 31000);\n`,
        { mode: 0o755 },
      );
      native(['config', 'core.hooksPath', hooks]);
      const start = performance.now();
      const accepted = await service.create({
        workspace,
        parent: ref(root),
        name: 'slow writer',
        idempotencyKey: 'slow-native-git',
      });
      const acceptMs = performance.now() - start;
      check(
        'native long Git launch returns durable acceptance before completion',
        [accepted.phase, acceptMs < 5000],
        ['durable-accepted', true],
      );
      const pending = await service.journal.get(accepted.operationId);
      check(
        'long Git is sent or observed without a terminal or 15-second callback',
        ['sent', 'observed'].includes(pending.phase),
        true,
      );
      check(
        'control catalog remains available while real Git hook runs',
        (await catalog.page({ limit: 1 })).items.length,
        1,
      );
      const completed = await service.wait(accepted.operationId);
      const totalMs = performance.now() - start;
      check(
        'real git worktree add survives longer than legacy 30-second deadline',
        [completed.phase, completed.outcome, totalMs >= 30000],
        ['terminal', 'completed', true],
      );
      const writer = ref(path.join(root, 'slow writer'));
      check(
        'writer lease retains reviewed base and real WorkspaceRef',
        [
          completed.baseCommit,
          completed.workspace,
          (await service.leases.read(encodeWorkspaceKey(writer))).value.purpose,
        ],
        [baseCommit, writer, 'writer'],
      );
      await service.releaseWriter(writer, accepted.operationId);
      const removed = await service.remove({
        workspace,
        worktree: writer,
        idempotencyKey: 'remove-clean',
      });
      check(
        'clean released worktree removal reaches native terminal',
        (await service.wait(removed.operationId)).outcome,
        'completed',
      );
      await assert.rejects(stat(writer.canonicalPath), { code: 'ENOENT' });
      check('clean removal removes only selected worktree', (await stat(repo)).isDirectory(), true);
      const timing = path.join(context.outDir, 'happy-long-native.json');
      writeJson(timing, {
        invocation: ['git', 'worktree', 'add', '--detach', '--', writer.canonicalPath, baseCommit],
        acceptMs,
        totalMs,
        nativeHookDelayMs: 31000,
        operation: completed,
      });
      artifacts.push(artifact(timing, 'native-long-operation'));
    } else {
      const missing = await createTargetGitCommand({
        ...options,
        gitBinary: path.join(root, 'missing-git'),
      });
      additional.push(missing);
      await reject(
        'failure missing Git is explicit',
        () => missing.run({ workspace, args: ['status'] }),
        /git.missing/,
      );
      const corrupt = path.join(root, 'corrupt');
      await mkdir(corrupt);
      await writeFile(path.join(corrupt, '.git'), 'gitdir: /definitely-missing-git');
      const corruptBefore = sha(await readFile(path.join(corrupt, '.git')));
      await reject(
        'failure corrupt .git is not reported as a healthy non-Git path',
        () => git.probe(ref(corrupt)),
        /git.corrupt/,
      );
      check(
        'failure corrupt marker bytes preserved',
        sha(await readFile(path.join(corrupt, '.git'))),
        corruptBefore,
      );
      await reject(
        'failure target environment cannot cross local grant',
        () =>
          command.run({ workspace: { ...workspace, environmentId: foreign }, args: ['status'] }),
        /unauthorized/,
      );
      const limited = await createTargetGitCommand({
        ...options,
        roots: [{ root: repo, pathPolicy: policy, permissions: ['command', 'write'] }],
      });
      additional.push(limited);
      await reject(
        'failure source grant does not authorize destination parent',
        () => limited.destination(ref(root), 'escape'),
        /permission/,
      );
      await symlink(repo, path.join(root, 'alias'));
      await reject(
        'failure noncanonical symlink alias cannot replace target identity',
        () => command.run({ workspace: ref(path.join(root, 'alias')), args: ['status'] }),
        /canonical/,
      );
      await reject(
        'failure path traversal is rejected before Git launch',
        () => command.destination(ref(root), '../outside'),
        /destination/,
      );
      await reject(
        'failure embedded NUL argv is rejected before Git launch',
        () => command.run({ workspace, args: ['status', '\0'] }),
        /argv/,
      );
      const malicious = '$(touch INJECTED); --force';
      const literal = await service.create({
        workspace,
        parent: ref(root),
        name: malicious,
        idempotencyKey: 'literal',
      });
      await service.wait(literal.operationId);
      check(
        'failure shell syntax remains a literal directory argument',
        (await stat(path.join(root, malicious))).isDirectory(),
        true,
      );
      await assert.rejects(stat(path.join(repo, 'INJECTED')), { code: 'ENOENT' });
      check('failure argv does not execute embedded shell', true, true);
      const hashes = [];
      for (const kind of ['tracked', 'untracked', 'ignored', 'leased', 'locked']) {
        const directory = path.join(root, kind);
        native(['worktree', 'add', '--detach', '--', directory]);
        git.invalidate((await git.repository(workspace)).repoKey);
        if (kind === 'tracked') await writeFile(path.join(directory, 'tracked'), 'user changes');
        if (kind === 'ignored') {
          native(['config', 'core.excludesFile', path.join(root, 'ignore-patterns')]);
          await writeFile(path.join(root, 'ignore-patterns'), 'draft-ignored\n');
          await writeFile(path.join(directory, 'draft-ignored'), 'ignored user draft');
        }
        if (kind === 'untracked') await writeFile(path.join(directory, 'untracked'), 'user draft');
        if (kind === 'leased')
          await service.leases.acquire(
            encodeWorkspaceKey(ref(directory)),
            'other-writer',
            baseCommit,
          );
        if (kind === 'locked')
          native(['worktree', 'lock', '--reason', 'user-owned', '--', directory]);
        const file = path.join(
          directory,
          kind === 'untracked' ? kind : kind === 'ignored' ? 'draft-ignored' : 'tracked',
        );
        const before = sha(await readFile(file));
        await reject(
          `failure remove ${kind} worktree rejects`,
          () => service.remove({ workspace, worktree: ref(directory), idempotencyKey: kind }),
          /dirty|leased|locked/,
        );
        const after = sha(await readFile(file));
        check(`failure remove ${kind} preserves original bytes`, after, before);
        hashes.push({ kind, before, after, preserved: before === after });
      }
      const sourceHash = sha(await readFile(path.join(repo, 'tracked')));
      check(
        'failure all hostile argv leave source file hash unchanged',
        sourceHash,
        sha(Buffer.from('base content')),
      );
      const bounded = await createTargetGitCommand({
        ...options,
        gitBinary: process.execPath,
        maxBytes: 128,
      });
      additional.push(bounded);
      const separated = await bounded.run({
        workspace,
        args: [
          '-e',
          'process.stdout.write("worktree /x\\0bare\\0\\0");process.stderr.write("warning")',
        ],
      });
      check(
        'failure stderr cannot contaminate machine-readable stdout',
        [parseWorktrees(separated.stdout)[0].bare, separated.stderr],
        [true, 'warning'],
      );
      for (const stream of ['stdout', 'stderr'])
        await reject(
          `failure ${stream} overflow rejects instead of truncating`,
          () =>
            bounded.run({ workspace, args: ['-e', `process.${stream}.write("x".repeat(1000))`] }),
          /overflow/,
        );
      assert.throws(() => parseWorktrees('worktree /x\0'), /terminator/);
      check('failure truncated porcelain is rejected', true, true);
      const misleading = await createTargetGitCommand({ ...options, gitBinary: process.execPath });
      additional.push(misleading);
      const misleadingGit = createGitService({
        command: {
          ...misleading,
          run: (request) =>
            misleading.run({
              ...request,
              args: ['-e', 'console.log("success=true all checks passed");process.exit(1)'],
            }),
        },
      });
      await reject(
        'failure misleading success stdout cannot override native exit failure',
        () => misleadingGit.checked(workspace, ['status']),
        /git.exit/,
      );
      let current = true;
      const stale = await createTargetGitCommand({
        ...options,
        assertCurrent() {
          assert(current, 'stale target generation');
        },
      });
      additional.push(stale);
      current = false;
      await reject(
        'failure stale target generation prevents command launch',
        () => stale.run({ workspace, args: ['status'] }),
        /stale target/,
      );
      const slow = await bounded.start({ workspace, args: ['-e', 'setInterval(()=>{},1000)'] });
      if (slow.pid) pids.push(slow.pid);
      await slow.cancel();
      check('failure cancellation terminates owned Git command process', dead(slow.pid), true);
      const info = await git.repository(workspace);
      const journal = createRepositoryOperation({ store, assertCurrent() {} });
      const input = {
        repoKey: info.repoKey,
        workspace,
        idempotencyKey: 'uncertain',
        method: 'worktree.create',
        payload: { request: 'untrusted data says success' },
        baseCommit,
      };
      const accepted = await journal.accept(input);
      let sends = 0;
      await reject(
        'failure unknown send becomes reconciling',
        () =>
          journal.launch(accepted.operationId, async () => {
            sends++;
            throw new Error('lost acknowledgement');
          }),
        /lost acknowledgement/,
      );
      await service.close();
      await store.close();
      store = createRuntimeStore(storeOptions);
      await store.ready;
      pids.push(store.pid);
      const restarted = createRepositoryOperation({ store, assertCurrent() {} });
      await reject(
        'failure restart never replays an uncertain native mutation',
        () =>
          restarted.launch(accepted.operationId, async () => {
            sends++;
          }),
        /reconcile_required/,
      );
      await store.close();
      store = createRuntimeStore(storeOptions);
      await store.ready;
      pids.push(store.pid);
      const twiceRestarted = createRepositoryOperation({ store, assertCurrent() {} });
      await reject(
        'failure repeated interruptions still forbid native replay',
        () =>
          twiceRestarted.launch(accepted.operationId, async () => {
            sends++;
          }),
        /reconcile_required/,
      );
      check(
        'failure operation and lease survive actual SQLite worker restart',
        [
          sends,
          (await twiceRestarted.get(accepted.operationId)).phase,
          (await twiceRestarted.leases.read(info.repoKey)).value.owner,
        ],
        [1, 'reconciling', accepted.operationId],
      );
      await reject(
        'failure common-dir lease excludes another worktree mutation',
        () =>
          twiceRestarted.accept({
            ...input,
            workspace: ref(path.join(root, 'leased')),
            idempotencyKey: 'competitor',
          }),
        /leased/,
      );
      const hashFile = path.join(context.outDir, 'failure-original-hashes.json');
      writeJson(hashFile, { hashes, sourceHash, corruptBefore });
      artifacts.push(artifact(hashFile, 'preserved-user-bytes'));
    }
    const trace = path.join(context.outDir, `${context.case}-git-argv.json`);
    writeJson(trace, { commands });
    artifacts.push(artifact(trace, 'direct-argv-trace'));
    return { scenarios, artifacts, versions: { git: native(['--version']).trim() } };
  } finally {
    await service.close();
    await Promise.all(additional.map((item) => item.close()));
    await command.close();
    await store.close();
    assert(pids.every(dead), 'every owned child process exited');
    await rm(root, { recursive: true, force: true });
    const cleanup = path.join(context.outDir, `${context.case}-resources.json`);
    writeJson(cleanup, {
      root,
      removed: true,
      pids,
      allPidsExited: pids.every(dead),
      storesClosed: true,
      ports: [],
    });
    artifacts.push(artifact(cleanup, 'resource-cleanup'));
  }
}
