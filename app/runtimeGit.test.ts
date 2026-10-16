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
import { ProtocolError } from '../shared/runtime/capabilities.js';
import type { TargetGitCommand } from '../bridge/runtime/targetGitCommand.js';
import type { RuntimeStore, Item } from '../bridge/runtime/storage/runtimeStore.js';

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
async function durableState(store: RuntimeStore) {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await store.page({ collection: 'operations', cursor, limit: 100 });
    items.push(...page.items);
    if (page.cursor === null) break;
    cursor = page.cursor;
  }
  // A released lease keeps its row with a null value, so only live values count as held.
  const held = (prefix: string) =>
    items.filter((item) => item.key.startsWith(prefix) && item.value != null);
  return { operations: held('git-op:'), leases: held('git-lease:') };
}
function authorizedService(store: RuntimeStore, command: TargetGitCommand) {
  const git = createGitService({ command });
  const service = createWorktreeService({ command, git, store, assertCurrent() {} });
  cleanup.push(() => service.close());
  return service;
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
  it('returns the original operation when an identical create is retried after completion', async () => {
    // Given a durable create that already completed and produced its destination.
    const f = await fixture();
    const accepted = await f.service.create({
      workspace: f.workspace,
      parent: f.ref(f.root),
      name: 'retried writer',
      idempotencyKey: 'retried',
    });
    expect((await f.service.wait(accepted.operationId)).outcome).toBe('completed');
    // When the identical request is retried while its destination exists.
    const replayed = await f.service.create({
      workspace: f.workspace,
      parent: f.ref(f.root),
      name: 'retried writer',
      idempotencyKey: 'retried',
    });
    // Then the original operation is recovered instead of a destination conflict.
    expect(replayed.operationId).toBe(accepted.operationId);
    expect(await f.service.wait(replayed.operationId)).toMatchObject({
      phase: 'terminal',
      outcome: 'completed',
    });
  });
  it('fails terminally and releases leases when the destination appears after acceptance', async () => {
    // Given a destination that another writer produces between acceptance and the send.
    const f = await fixture();
    let refusals = 0;
    const command: TargetGitCommand = {
      ...f.command,
      async destination(parent, name) {
        if (refusals++ === 0) throw new ProtocolError('conflict', 'git.destination_exists');
        return f.command.destination(parent, name);
      },
    };
    const service = authorizedService(f.store, command);
    // When the pre-send re-verification refuses the create.
    await expect(
      service.create({
        workspace: f.workspace,
        parent: f.ref(f.root),
        name: 'raced',
        idempotencyKey: 'raced',
      }),
    ).rejects.toThrow('destination_exists');
    // Then the refusal proves no mutation started: the operation is terminal and every lease is released.
    const state = await durableState(f.store);
    expect(state.operations).toMatchObject([
      { value: { kind: 'repository-operation', phase: 'terminal', outcome: 'failed' } },
    ]);
    expect(state.leases).toEqual([]);
    // And a later create with a new key still runs.
    const recovered = await service.create({
      workspace: f.workspace,
      parent: f.ref(f.root),
      name: 'after-race',
      idempotencyKey: 'after-race',
    });
    expect((await service.wait(recovered.operationId)).outcome).toBe('completed');
  });
  it('keeps an uncertain post-send failure reconciling with its leases', async () => {
    // Given a command whose mutation job loses its acknowledgement after the process exists.
    const f = await fixture();
    const command: TargetGitCommand = {
      ...f.command,
      async start(request) {
        const job = await f.command.start(request);
        if (request.args[0] !== 'worktree' || request.args[1] !== 'add') return job;
        return { ...job, async wait() { throw new Error('lost acknowledgement'); } };
      },
    };
    const service = authorizedService(f.store, command);
    // When the send result is unknown after the native process was started.
    const accepted = await service.create({
      workspace: f.workspace,
      parent: f.ref(f.root),
      name: 'uncertain',
      idempotencyKey: 'uncertain',
    });
    await expect(service.wait(accepted.operationId)).rejects.toThrow('lost acknowledgement');
    // Then the operation stays reconciling with both leases, and the next mutation is refused.
    const state = await durableState(f.store);
    expect(state.operations).toMatchObject([
      { value: { kind: 'repository-operation', phase: 'reconciling' } },
    ]);
    expect(state.leases).toHaveLength(2);
    expect(state.leases).toMatchObject([
      { value: { purpose: 'operation' } },
      { value: { purpose: 'operation' } },
    ]);
    await expect(
      service.create({
        workspace: f.workspace,
        parent: f.ref(f.root),
        name: 'blocked',
        idempotencyKey: 'blocked',
      }),
    ).rejects.toThrow('leased');
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

describe('worktree mutations across separate roots', () => {
  type Permission = 'read' | 'write' | 'command';
  // Given one main repository, two linked worktrees, and a destination parent as separate grant roots.
  async function crossRoots(repositoryPermissions: readonly Permission[]) {
    const f = await fixture();
    const linked = path.join(f.root, 'linked');
    f.gitExec(['worktree', 'add', '--detach', linked]);
    const victim = path.join(f.root, 'victim');
    f.gitExec(['worktree', 'add', '--detach', victim]);
    const parent = path.join(f.root, 'destination parent');
    await mkdir(parent);
    const writable: readonly Permission[] = ['read', 'write', 'command'];
    const command = await createTargetGitCommand({
      target,
      roots: [
        { root: f.repo, pathPolicy: f.policy, permissions: repositoryPermissions },
        { root: linked, pathPolicy: f.policy, permissions: writable },
        { root: victim, pathPolicy: f.policy, permissions: writable },
        { root: parent, pathPolicy: f.policy, permissions: writable },
      ],
      assertCurrent() {},
    });
    cleanup.push(() => command.close());
    const git = createGitService({ command });
    const service = createWorktreeService({ command, git, store: f.store, assertCurrent() {} });
    cleanup.push(() => service.close());
    return {
      ...f,
      writableCommand: f.command,
      command,
      git,
      service,
      linked,
      victim,
      parent,
      writer: f.ref(linked),
      parentRef: f.ref(parent),
    };
  }
  it('refuses a create whose repository common directory is outside the write grant', async () => {
    // Given a read-only main repository beside a writable linked worktree and destination parent.
    const f = await crossRoots(['read', 'command']);
    // Then the read-only repository itself refuses write authority.
    await expect(f.command.authorize(f.workspace, 'write')).rejects.toThrow('permission');
    // When a create is launched from the writable linked worktree.
    const outcome = await f.service
      .create({
        workspace: f.writer,
        parent: f.parentRef,
        name: 'crossed',
        idempotencyKey: 'crossed',
      })
      .then(
        async (accepted) => `completed:${(await f.service.wait(accepted.operationId)).outcome}`,
        (error: ProtocolError) => `refused:${error.code}:${error.field}`,
      );
    // Then no administrative bytes reach the read-only common directory.
    expect({
      outcome,
      adminBytes: await stat(path.join(f.repo, '.git', 'worktrees', 'crossed', 'gitdir')).then(
        () => 'written',
        () => 'absent',
      ),
      worktreeBytes: await stat(path.join(f.parent, 'crossed')).then(
        () => 'written',
        () => 'absent',
      ),
    }).toEqual({
      outcome: 'refused:unauthorized:git.permission',
      adminBytes: 'absent',
      worktreeBytes: 'absent',
    });
  });
  it('refuses a remove whose repository common directory is outside the write grant', async () => {
    // Given a read-only main repository and a clean linked worktree selected for removal.
    const f = await crossRoots(['read', 'command']);
    // When removal is launched from the writable linked worktree.
    const outcome = await f.service
      .remove({
        workspace: f.writer,
        worktree: f.ref(f.victim),
        idempotencyKey: 'crossed-remove',
      })
      .then(
        async (accepted) => `completed:${(await f.service.wait(accepted.operationId)).outcome}`,
        (error: ProtocolError) => `refused:${error.code}:${error.field}`,
      );
    // Then the administrative records and the selected worktree bytes both survive.
    expect({
      outcome,
      adminBytes: await stat(path.join(f.repo, '.git', 'worktrees', 'victim', 'gitdir')).then(
        () => 'written',
        () => 'absent',
      ),
      worktreeBytes: await stat(f.victim).then(() => 'written', () => 'absent'),
    }).toEqual({
      outcome: 'refused:unauthorized:git.permission',
      adminBytes: 'written',
      worktreeBytes: 'written',
    });
  });
  it('allows a cross-root create when the repository common directory itself is writable', async () => {
    // Given every root, including the main repository, holding write authority.
    const f = await crossRoots(['read', 'write', 'command']);
    // When a create crosses the linked worktree, the destination parent, and the repository.
    const accepted = await f.service.create({
      workspace: f.writer,
      parent: f.parentRef,
      name: 'allowed',
      idempotencyKey: 'allowed',
    });
    // Then it completes and its administrative bytes land in the writable common directory.
    expect((await f.service.wait(accepted.operationId)).outcome).toBe('completed');
    expect((await stat(path.join(f.repo, '.git', 'worktrees', 'allowed', 'gitdir'))).isFile()).toBe(
      true,
    );
    expect((await stat(path.join(f.parent, 'allowed'))).isDirectory()).toBe(true);
  });
  it('leaves no durable operation or lease when a create refusal precedes acceptance', async () => {
    // Given a read-only main repository beside a writable linked worktree and destination parent.
    const f = await crossRoots(['read', 'command']);
    // When a create is refused by the read-only repository common directory.
    const refusal = await f.service
      .create({
        workspace: f.writer,
        parent: f.parentRef,
        name: 'refused',
        idempotencyKey: 'refused',
      })
      .then(
        () => 'accepted',
        (error: ProtocolError) => `refused:${error.code}:${error.field}`,
      );
    // Then the refusal precedes acceptance, so neither an operation nor a lease is recorded.
    expect({ refusal, ...(await durableState(f.store)) }).toEqual({
      refusal: 'refused:unauthorized:git.permission',
      operations: [],
      leases: [],
    });
    // And a later create with correct write authority and a new key still runs.
    const service = authorizedService(f.store, f.writableCommand);
    const recovered = await service.create({
      workspace: f.workspace,
      parent: f.parentRef,
      name: 'recovered',
      idempotencyKey: 'recovered',
    });
    expect((await service.wait(recovered.operationId)).outcome).toBe('completed');
    expect((await stat(path.join(f.parent, 'recovered'))).isDirectory()).toBe(true);
  });
  it('leaves no durable operation or lease when a remove refusal precedes acceptance', async () => {
    // Given a read-only main repository and a clean linked worktree selected for removal.
    const f = await crossRoots(['read', 'command']);
    // When removal is refused by the read-only repository common directory.
    const refusal = await f.service
      .remove({
        workspace: f.writer,
        worktree: f.ref(f.victim),
        idempotencyKey: 'refused-remove',
      })
      .then(
        () => 'accepted',
        (error: ProtocolError) => `refused:${error.code}:${error.field}`,
      );
    // Then the refusal precedes acceptance, so neither an operation nor a lease is recorded.
    expect({ refusal, ...(await durableState(f.store)) }).toEqual({
      refusal: 'refused:unauthorized:git.permission',
      operations: [],
      leases: [],
    });
    // And a later removal with correct write authority and a new key still runs.
    const service = authorizedService(f.store, f.writableCommand);
    const removed = await service.remove({
      workspace: f.workspace,
      worktree: f.ref(f.victim),
      idempotencyKey: 'recovered-remove',
    });
    expect((await service.wait(removed.operationId)).outcome).toBe('completed');
    await expect(stat(f.victim)).rejects.toThrow('ENOENT');
  });
});
