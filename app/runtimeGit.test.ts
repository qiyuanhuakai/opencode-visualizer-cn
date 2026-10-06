// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorktrees } from '../bridge/runtime/gitOutputParser.js';
import { createTargetGitCommand } from '../bridge/runtime/targetGitCommand.js';
import { createGitService } from '../bridge/runtime/gitService.js';
import { createWorktreeService } from '../bridge/runtime/worktreeService.js';
import { createWorkspaceCatalog } from '../bridge/runtime/workspaceCatalog.js';
import { createRuntimeStore } from '../bridge/runtime/storage/runtimeStore.js';
import { createRepositoryOperation } from '../bridge/runtime/repositoryOperation.js';
import {
  encodeWorkspaceKey,
  encodeRepoKey,
  parseEnvironmentId,
} from '../shared/runtime/identity.js';
import type { WorkspaceRef, PathPolicy } from '../shared/runtime/identity.js';

const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const foreign = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const epoch = '33333333-3333-4333-8333-333333333333';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-git-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo with spaces');
  await mkdir(repo);
  const gitExec = (args: readonly string[], cwd = repo) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  gitExec(['init', '--quiet']);
  gitExec([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  ]);
  const policy: PathPolicy = {
    platform: 'posix',
    volumeId: String((await stat(root)).dev),
    caseSensitive: true,
  };
  const ref = (canonicalPath: string): WorkspaceRef => ({
    environmentId: target,
    canonicalPath,
    pathPolicy: policy,
  });
  const command = await createTargetGitCommand({
    target,
    roots: [{ root, pathPolicy: policy, permissions: ['read', 'write', 'command'] }],
    assertCurrent() {},
  });
  cleanup.push(() => command.close());
  const store = createRuntimeStore({
    stateDirectory: path.join(root, 'state'),
    environmentId: target,
    ownerId: '44444444-4444-4444-8444-444444444444',
    epoch,
  });
  await store.ready;
  cleanup.push(() => store.close());
  const git = createGitService({ command });
  const service = createWorktreeService({ command, git, store, assertCurrent() {} });
  cleanup.push(() => service.close());
  return { root, repo, ref, policy, gitExec, command, store, git, service, workspace: ref(repo) };
}
describe('target Git topology', () => {
  it('parses literal NUL paths and flags when names contain spaces and newlines', () => {
    // Given machine-delimited output, including text that resembles another record.
    const head = 'a'.repeat(40);
    const text = `worktree /x space\nHEAD fake\0HEAD ${head}\0detached\0locked reason\ncontinued\0\0worktree /bare\0bare\0\0worktree /gone\0HEAD ${head}\0branch refs/heads/main\0prunable missing directory\0\0`;
    // When parsing the native record boundaries.
    const rows = parseWorktrees(text);
    // Then embedded newlines remain path/reason data.
    expect(rows).toEqual([
      {
        path: '/x space\nHEAD fake',
        head,
        detached: true,
        bare: false,
        locked: 'reason\ncontinued',
      },
      { path: '/bare', bare: true, detached: false },
      {
        path: '/gone',
        head,
        branch: 'refs/heads/main',
        prunable: 'missing directory',
        bare: false,
        detached: false,
      },
    ]);
  });
  it('rejects truncated and oversized machine output when records are incomplete', () => {
    // Given incomplete or over-budget output.
    // When parsing it, then no partial topology escapes.
    expect(() => parseWorktrees('worktree /x\0')).toThrow('terminator');
    expect(() => parseWorktrees('worktree /x\0\0', 2)).toThrow('output_size');
  });
  it('groups real linked worktrees while isolating another environment', async () => {
    // Given a real linked worktree with a newline in its name.
    const f = await fixture();
    const linked = path.join(f.root, 'linked \n name\n');
    f.gitExec(['worktree', 'add', '--detach', linked]);
    // When probing both paths.
    const [a, b] = await Promise.all([f.git.probe(f.workspace), f.git.probe(f.ref(linked))]);
    // Then common-dir identity is shared only in the same environment.
    expect(a.kind).toBe('git');
    expect(b.kind).toBe('git');
    if (a.kind !== 'git' || b.kind !== 'git') throw new Error('Expected Git fixture');
    expect(a.repoKey).toBe(b.repoKey);
    expect(b.branch).toBe(null);
    expect(encodeRepoKey({ ...a.repo, environmentId: foreign })).not.toBe(a.repoKey);
  });
  it('retains non-Git metadata when 200 workspaces and five sources are registered lazily', async () => {
    // Given metadata-only paths, including an orphan.
    const f = await fixture();
    let probes = 0;
    const catalog = createWorkspaceCatalog({
      store: f.store,
      git: {
        ...f.git,
        async probe(ref) {
          probes++;
          return f.git.probe(ref);
        },
      },
    });
    const harnesses = ['opencode', 'codex', 'kimi', 'dsh', 'acp'] as const;
    for (let i = 0; i < 200; i++)
      await catalog.register({
        workspace: f.ref(path.join(f.root, `metadata-${i}`)),
        harnessInstanceId: foreign,
        harness: 'codex',
        orphan: true,
      });
    for (const [index, harness] of harnesses.entries())
      await catalog.register({
        workspace: f.workspace,
        harnessInstanceId: `55555555-5555-4555-8555-55555555555${index}`,
        harness,
      });
    // When browsing metadata and explicitly selecting a real workspace.
    const page = await catalog.page({ limit: 200 });
    expect(probes).toBe(0);
    await catalog.probe(encodeWorkspaceKey(f.workspace), { selected: true });
    // Then only selection probes Git and all five sources were retained.
    expect(page.items).toHaveLength(200);
    expect(page.cursor).not.toBeNull();
    expect(probes).toBe(1);
    const item = await f.store.get({
      collection: 'workspaces',
      key: encodeWorkspaceKey(f.workspace),
    });
    expect(item?.value).toMatchObject({
      sources: harnesses.map((harness, index) => ({
        harness,
        harnessInstanceId: `55555555-5555-4555-8555-55555555555${index}`,
      })),
    });
    expect((await f.git.probe(f.ref(f.root))).kind).toBe('non-git');
  });
  it('requires visibility before metadata can trigger Git', async () => {
    // Given a registered workspace.
    const f = await fixture();
    const catalog = createWorkspaceCatalog({ store: f.store, git: f.git });
    const key = await catalog.register({
      workspace: f.workspace,
      harnessInstanceId: foreign,
      harness: 'codex',
    });
    // When no selection or visibility was supplied, then it rejects.
    await expect(catalog.probe(key)).rejects.toThrow('visibility');
  });
  it('rejects foreign targets and destination parents outside write grants', async () => {
    // Given command authority for the source only.
    const f = await fixture();
    const limited = await createTargetGitCommand({
      target,
      roots: [{ root: f.repo, pathPolicy: f.policy, permissions: ['command'] }],
      assertCurrent() {},
    });
    cleanup.push(() => limited.close());
    // When a request crosses a target or independent destination grant.
    await expect(
      f.command.run({ workspace: { ...f.workspace, environmentId: foreign }, args: ['status'] }),
    ).rejects.toThrow('target');
    await expect(limited.destination(f.ref(f.root), 'not-authorized')).rejects.toThrow(
      'permission',
    );
    // Then no destination exists.
    await expect(stat(path.join(f.root, 'not-authorized'))).rejects.toThrow('ENOENT');
  });
  it('reports missing Git and corrupt repositories as distinct failures', async () => {
    // Given one absent executable and one corrupt .git marker.
    const f = await fixture();
    const missing = await createTargetGitCommand({
      target,
      roots: [{ root: f.root, pathPolicy: f.policy, permissions: ['command'] }],
      assertCurrent() {},
      gitBinary: path.join(f.root, 'missing-git'),
    });
    cleanup.push(() => missing.close());
    const corrupt = path.join(f.root, 'corrupt');
    await mkdir(corrupt);
    await writeFile(path.join(corrupt, '.git'), 'gitdir: /missing/target');
    // When those paths are probed, then errors stay explicit.
    await expect(missing.run({ workspace: f.workspace, args: ['status'] })).rejects.toMatchObject({
      reason: 'missing',
    });
    await expect(f.git.probe(f.ref(corrupt))).rejects.toMatchObject({ reason: 'corrupt' });
  });
  it('keeps stdout separate and rejects overflow instead of parsing truncated output', async () => {
    // Given actual child output with a small bound.
    const f = await fixture();
    const command = await createTargetGitCommand({
      target,
      roots: [{ root: f.root, pathPolicy: f.policy, permissions: ['command'] }],
      assertCurrent() {},
      gitBinary: process.execPath,
      maxBytes: 64,
    });
    cleanup.push(() => command.close());
    // When stdout and stderr are emitted independently.
    const result = await command.run({
      workspace: f.workspace,
      args: ['-e', 'process.stdout.write("out");process.stderr.write("err")'],
    });
    // Then only stdout reaches the machine parser, and either stream overflow fails.
    expect([result.stdout, result.stderr]).toEqual(['out', 'err']);
    await expect(
      command.run({
        workspace: f.workspace,
        args: ['-e', 'process.stdout.write("x".repeat(1000))'],
      }),
    ).rejects.toMatchObject({ reason: 'stdout_overflow' });
    await expect(
      command.run({
        workspace: f.workspace,
        args: ['-e', 'process.stderr.write("x".repeat(1000))'],
      }),
    ).rejects.toMatchObject({ reason: 'stderr_overflow' });
  });
  it('deduplicates concurrent workspace probes and common-dir topology', async () => {
    // Given two linked paths and an instrumented real command adapter.
    const f = await fixture();
    const linked = path.join(f.root, 'second');
    f.gitExec(['worktree', 'add', '--detach', linked]);
    const calls: string[][] = [];
    const git = createGitService({
      command: {
        ...f.command,
        async run(request) {
          calls.push([...request.args]);
          return f.command.run(request);
        },
      },
    });
    // When the visible demand overlaps across workspace and repository.
    await Promise.all([git.probe(f.workspace), git.probe(f.workspace), git.probe(f.ref(linked))]);
    // Then one topology command covers both paths and one status covers each.
    expect(calls.filter((args) => args[0] === 'worktree')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'status')).toHaveLength(2);
  });
});
describe('durable worktree mutations', () => {
  it('creates a detached writer with a persisted base and lease then removes after release', async () => {
    // Given a clean repository and authorized destination parent.
    const f = await fixture();
    const destination = f.ref(path.join(f.root, 'writer space'));
    // When a durable create completes and its writer explicitly releases ownership.
    const accepted = await f.service.create({
      workspace: f.workspace,
      parent: f.ref(f.root),
      name: 'writer space',
      idempotencyKey: 'create',
    });
    const terminal = await f.service.wait(accepted.operationId);
    // Then its durable base and lease identify the actual workspace, never a fake session.
    expect(terminal).toMatchObject({
      phase: 'terminal',
      outcome: 'completed',
      workspace: destination,
      baseCommit: f.gitExec(['rev-parse', 'HEAD']).trim(),
    });
    expect(await f.service.leases.read(encodeWorkspaceKey(destination))).toMatchObject({
      value: { owner: accepted.operationId, purpose: 'writer' },
    });
    await expect(
      f.service.remove({ workspace: f.workspace, worktree: destination, idempotencyKey: 'leased' }),
    ).rejects.toThrow('leased');
    await f.service.releaseWriter(destination, accepted.operationId);
    const removed = await f.service.remove({
      workspace: f.workspace,
      worktree: destination,
      idempotencyKey: 'remove',
    });
    expect((await f.service.wait(removed.operationId)).outcome).toBe('completed');
    await expect(stat(destination.canonicalPath)).rejects.toThrow('ENOENT');
  });
  it.each(['tracked', 'untracked'])('preserves %s bytes when removal is dirty', async (kind) => {
    // Given user-owned content in a linked worktree.
    const f = await fixture();
    const linked = path.join(f.root, 'dirty');
    f.gitExec(['worktree', 'add', '--detach', linked]);
    const file = path.join(linked, 'file');
    await writeFile(file, 'original');
    if (kind === 'tracked') {
      f.gitExec(['add', 'file'], linked);
      f.gitExec(
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'tracked'],
        linked,
      );
    }
    await writeFile(file, 'user bytes');
    // When removal is requested, then it rejects without changing bytes.
    await expect(
      f.service.remove({ workspace: f.workspace, worktree: f.ref(linked), idempotencyKey: kind }),
    ).rejects.toThrow('dirty');
    expect(await readFile(file, 'utf8')).toBe('user bytes');
  });
  it('treats hostile names as one literal argument and rejects traversal and NUL', async () => {
    // Given a name that would execute shell syntax if interpolated.
    const f = await fixture();
    const name = '$(touch INJECTED); --force';
    // When worktree creation uses direct argv.
    const op = await f.service.create({
      workspace: f.workspace,
      parent: f.ref(f.root),
      name,
      idempotencyKey: 'literal',
    });
    await f.service.wait(op.operationId);
    // Then the exact directory exists without executing embedded syntax.
    expect((await stat(path.join(f.root, name))).isDirectory()).toBe(true);
    await expect(stat(path.join(f.repo, 'INJECTED'))).rejects.toThrow('ENOENT');
    await expect(f.command.destination(f.ref(f.root), '../escape')).rejects.toThrow('destination');
    await expect(f.command.run({ workspace: f.workspace, args: ['status', '\0'] })).rejects.toThrow(
      'argv',
    );
  });
  it('retains durable leases and refuses replay after an uncertain send across adapter reconstruction', async () => {
    // Given a persisted repository operation before launch.
    const f = await fixture();
    const info = await f.git.repository(f.workspace);
    if (info.kind !== 'git') throw new Error('Expected Git fixture');
    const journal = createRepositoryOperation({ store: f.store, assertCurrent() {} });
    const input = {
      repoKey: info.repoKey,
      workspace: f.workspace,
      idempotencyKey: 'unknown',
      method: 'worktree.create',
      payload: {},
      baseCommit: f.gitExec(['rev-parse', 'HEAD']).trim(),
    };
    const accepted = await journal.accept(input);
    let sends = 0;
    // When transport dies after the sent marker and a fresh adapter reconnects.
    await expect(
      journal.launch(accepted.operationId, async () => {
        sends++;
        throw new Error('lost acknowledgement');
      }),
    ).rejects.toThrow('lost acknowledgement');
    const reconnect = createRepositoryOperation({ store: f.store, assertCurrent() {} });
    await expect(
      reconnect.launch(accepted.operationId, async () => {
        sends++;
      }),
    ).rejects.toThrow('reconcile_required');
    // Then the durable state prevents a second send and a competing common-dir owner.
    expect(sends).toBe(1);
    expect((await reconnect.get(accepted.operationId)).phase).toBe('reconciling');
    await expect(reconnect.accept({ ...input, idempotencyKey: 'competing' })).rejects.toThrow(
      'leased',
    );
  });
});

describe('Git topology refresh and retention', () => {
  it('refreshes external worktree changes after the bounded topology cache expires', async () => {
    // Given an observed repository followed by an external native mutation.
    const f = await fixture();
    let now = 0;
    const git = createGitService({ command: f.command, now: () => now });
    await git.probe(f.workspace);
    const linked = path.join(f.root, 'external');
    f.gitExec(['worktree', 'add', '--detach', linked]);
    now = 1001;
    // When the selected workspace is probed again after expiry.
    const result = await git.probe(f.workspace);
    // Then the external worktree is discoverable without restarting the service.
    expect(result.kind === 'git' && result.worktrees.some((item) => item.path === linked)).toBe(
      true,
    );
  });
  it('preserves ignored user files when removal would otherwise look clean', async () => {
    // Given an ignored untracked draft in a linked worktree.
    const f = await fixture();
    const directory = path.join(f.root, 'ignored');
    f.gitExec(['worktree', 'add', '--detach', directory]);
    await writeFile(path.join(f.root, 'excludes'), 'draft\n');
    f.gitExec(['config', 'core.excludesFile', path.join(f.root, 'excludes')]);
    await writeFile(path.join(directory, 'draft'), 'ignored user bytes');
    // When removal reaches its final safety check, then ignored bytes survive too.
    await expect(
      f.service.remove({
        workspace: f.workspace,
        worktree: f.ref(directory),
        idempotencyKey: 'ignored',
      }),
    ).rejects.toThrow('dirty');
    expect(await readFile(path.join(directory, 'draft'), 'utf8')).toBe('ignored user bytes');
  });
});

describe('target-authoritative common directory policy', () => {
  it('uses common-directory volume policy when linked workspaces have different volume identities', async () => {
    // Given host-probed policies for source and linked workspace volumes.
    const f = await fixture();
    const linked = path.join(f.root, 'other-volume');
    f.gitExec(['worktree', 'add', '--detach', linked]);
    const otherPolicy = { ...f.policy, volumeId: 'target-probed-other-volume' };
    const command = await createTargetGitCommand({
      target,
      roots: [
        { root: f.repo, pathPolicy: f.policy, permissions: ['command'] },
        { root: linked, pathPolicy: otherPolicy, permissions: ['command'] },
      ],
      assertCurrent() {},
    });
    cleanup.push(() => command.close());
    const git = createGitService({ command });
    // When both Git workspaces resolve their actual common directory.
    const [a, b] = await Promise.all([
      git.repository(f.workspace),
      git.repository({ ...f.ref(linked), pathPolicy: otherPolicy }),
    ]);
    // Then workspace volume policy does not split the same repository.
    expect(a.kind === 'git' && b.kind === 'git' && a.repoKey === b.repoKey).toBe(true);
  });
});

describe('repository mutation races', () => {
  it('allows only one concurrent common-dir operation across different destination workspaces', async () => {
    // Given two independent operations targeting the same repository.
    const f = await fixture();
    const info = await f.git.repository(f.workspace);
    if (info.kind !== 'git') throw new Error('Expected Git fixture');
    // When both intents contend before either native command starts.
    const results = await Promise.allSettled(
      ['a', 'b'].map((name) =>
        f.service.journal.accept({
          repoKey: info.repoKey,
          workspace: f.ref(path.join(f.root, name)),
          idempotencyKey: name,
          method: 'worktree.create',
          payload: { name },
          baseCommit: f.gitExec(['rev-parse', 'HEAD']).trim(),
        }),
      ),
    );
    // Then exactly one durable intent owns the common directory.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'fulfilled')
        expect(await f.service.leases.read(info.repoKey)).toMatchObject({
          value: { owner: result.value.operationId },
        });
  });
  it('serializes non-Git writers with the same durable WorkspaceKey', async () => {
    // Given a non-Git workspace identity.
    const f = await fixture();
    const key = encodeWorkspaceKey(f.ref(f.root));
    await f.service.leases.acquire(key, 'first-writer', 'no-git');
    // When another writer competes, then the first owner survives unchanged.
    await expect(f.service.leases.acquire(key, 'second-writer', 'no-git')).rejects.toThrow(
      'leased',
    );
    expect(await f.service.leases.read(key)).toMatchObject({ value: { owner: 'first-writer' } });
  });
});
