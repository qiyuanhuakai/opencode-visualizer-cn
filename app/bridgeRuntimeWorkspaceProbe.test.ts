// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeServices } from '../bridge/runtime/runtimeServices.js';
import type { RuntimeServices } from '../bridge/runtime/runtimeServices.js';
import { decodeRepoKey, encodeSessionKey, parseSessionRef } from '../shared/runtime/identity.js';
import type { PathPolicy } from '../shared/runtime/identity.js';

const supervisor = { start: async () => [], stop: async () => {}, getStatus: () => [] };
const acpManager = { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach: (): never => { throw new Error('this lane registers no ACP harness'); } };

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function probeSelectedSession(services: RuntimeServices, directory: string) {
  const canonical = await realpath(directory);
  const workspace = services.workspace.workspaces.find(root => root.root === canonical);
  if (!workspace) throw new Error('Missing granted workspace');
  const session = parseSessionRef({ environmentId: services.target, harnessInstanceId: randomUUID(), nativeSessionId: 'selected-session' });
  await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(session), value: { session, directory: canonical, workspaceKey: workspace.key } }] });
  return services.hostServices.read({ domain: 'thread', operation: 'repository', args: { session } }, { target: services.target, permissions: services.grant.permissions, workspaceKeys: services.grant.workspaceKeys });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-workspace-probe-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const plain = path.join(root, 'plain');
  await mkdir(repo);
  await mkdir(plain);
  const gitExec = (args: readonly string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  gitExec(['init', '--quiet'], repo);
  gitExec(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base'], repo);
  const policy: PathPolicy = {
    platform: 'posix',
    volumeId: String((await stat(root)).dev),
    caseSensitive: true,
  };
  return { root, repo, plain, policy };
}
describe('the selected workspace catalog carries the repo identity the Host Thread gates on (F3-P2-2)', () => {
  it('seeds unknown roots without eager probes, then resolves git and non-git through selected-session requests', async () => {
    // Given: one granted root that IS a real git repository and one that is not.
    const { repo, plain } = await fixture();
    const stateRoot = path.join(await mkdtemp(path.join(tmpdir(), 'runtime-workspace-probe-state-')), 'state');
    await mkdir(stateRoot, { recursive: true });
    cleanups.push(() => rm(path.dirname(stateRoot), { recursive: true, force: true }));
    const services = await createRuntimeServices({
      environmentId: randomUUID(),
      stateRoot,
      role: 'local',
      roots: [
        { root: repo, permissions: ['read', 'write', 'command', 'pty', 'reverse'] },
        { root: plain, permissions: ['read', 'write', 'command', 'pty', 'reverse'] },
      ],
      config: { version: 1, nativeServices: { opencode: false, codex: false, 'kimi-web': false, dsh: false }, acpAgents: [] },
      nativeSupervisor: supervisor,
      acpManager,
      runtime: { mutate: async <T,>(operation: () => Promise<T>): Promise<T> => operation() },
      factories: {},
    });
    cleanups.push(async () => { await services.close(); });

    // Startup stays progressive: no Git scan of every registered root.
    await services.start();
    const initial = await services.index.topology({ collection: 'workspaces' });
    expect(initial.items).toHaveLength(2);
    expect(initial.items.every(item => (item.value as { gitKind?: string }).gitKind === 'unknown')).toBe(true);
    await probeSelectedSession(services, repo);
    const selected = await services.index.topology({ collection: 'workspaces' });
    const changed = selected.items.filter(item => initial.items.find(prior => prior.key === item.key)?.revision !== item.revision);
    expect(changed).toHaveLength(1);
    expect((changed[0]!.value as { workspace: { canonicalPath: string } }).workspace.canonicalPath).toBe(await realpath(repo));
    expect(await probeSelectedSession(services, plain)).toBeNull();

    // Then: the selected real repository carries gitKind and a
    // repoKey — the exact two fields `repoForSession` (App.vue) reads to decide
    // whether a Host Thread can be opened for a session in that directory.
    const page = await services.index.topology({ collection: 'workspaces' });
    const byPath = new Map(page.items.map((item) => {
      const value = item.value as { workspace: { canonicalPath: string }; gitKind?: string; repoKey?: string | null };
      return [value.workspace.canonicalPath, value];
    }));
    const seeded = byPath.get(await realpath(repo));
    expect(seeded).toBeDefined();
    expect(seeded!.gitKind).toBe('git');
    expect(typeof seeded!.repoKey).toBe('string');
    // And: the repoKey decodes to the REAL repository the runtime authorized,
    // not a placeholder — its canonical common dir is this repo's own.
    const decoded = decodeRepoKey(seeded!.repoKey!);
    expect(decoded.canonicalCommonDir).toBe(await realpath(path.join(repo, '.git')));
    expect(decoded.environmentId).toBe(services.target);

    // And: the selected root that is not a repository is probed honestly as
    // non-git with no repoKey, rather than being left undescribed.
    const plainEntry = byPath.get(await realpath(plain));
    expect(plainEntry).toBeDefined();
    expect(plainEntry!.gitKind).toBe('non-git');
    expect(plainEntry!.repoKey ?? null).toBeNull();
  });
});

describe('a read-only root is a capability limit, not a startup failure (F3-P2-3)', () => {
  async function gitRepo(root: string, name: string): Promise<string> {
    const repo = path.join(root, name);
    await mkdir(repo);
    const gitExec = (args: readonly string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    gitExec(['init', '--quiet']);
    gitExec(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base']);
    return repo;
  }

  it('starts with mixed-permission roots and probes only the selected authorized one, refusing read-only commands', async () => {
    // Given: a root granted the full permission set and a second, equally real
    // repository granted READ ONLY — the runtime may read it but is not
    // permitted to run git commands in it, which is a legitimate capability
    // limit rather than a broken repository.
    const root = await mkdtemp(path.join(tmpdir(), 'runtime-workspace-probe-mixed-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const authorized = await gitRepo(root, 'authorized');
    const readonly = await gitRepo(root, 'readonly');
    const stateRoot = path.join(await mkdtemp(path.join(tmpdir(), 'runtime-workspace-probe-state-')), 'state');
    await mkdir(stateRoot, { recursive: true });
    cleanups.push(() => rm(path.dirname(stateRoot), { recursive: true, force: true }));
    const services = await createRuntimeServices({
      environmentId: randomUUID(),
      stateRoot,
      role: 'local',
      roots: [
        { root: authorized, permissions: ['read', 'write', 'command', 'pty', 'reverse'] },
        { root: readonly, permissions: ['read'] },
      ],
      config: { version: 1, nativeServices: { opencode: false, codex: false, 'kimi-web': false, dsh: false }, acpAgents: [] },
      nativeSupervisor: supervisor,
      acpManager,
      runtime: { mutate: async <T,>(operation: () => Promise<T>): Promise<T> => operation() },
      factories: {},
    });
    cleanups.push(async () => { await services.close(); });

    // Both start unknown; only an explicit selection probes a repository.
    await services.start();
    const initial = await services.index.topology({ collection: 'workspaces' });
    expect(initial.items.every(item => (item.value as { gitKind?: string }).gitKind === 'unknown')).toBe(true);
    await probeSelectedSession(services, authorized);
    await expect(probeSelectedSession(services, readonly)).rejects.toThrow('git.permission');

    // Then: the startup completed — the read-only root did not block it — and
    // the catalog still describes BOTH granted roots.
    const page = await services.index.topology({ collection: 'workspaces' });
    const byPath = new Map(page.items.map((item) => {
      const value = item.value as { workspace: { canonicalPath: string }; gitKind?: string; repoKey?: string | null };
      return [value.workspace.canonicalPath, value];
    }));

    // The selected authorized root is probed for real; lazy discovery cannot
    // be implemented by permanently skipping every probe.
    const authorizedEntry = byPath.get(await realpath(authorized));
    expect(authorizedEntry).toBeDefined();
    expect(authorizedEntry!.gitKind).toBe('git');
    expect(typeof authorizedEntry!.repoKey).toBe('string');

    // And: the read-only root is explicitly UNKNOWN with no repoKey: the
    // runtime did not silently claim non-git for a real repository, and did not
    // leave the root undescribed either. `repoForSession` refuses a Host Thread
    // for it because the repo identity genuinely cannot be derived.
    const readonlyEntry = byPath.get(await realpath(readonly));
    expect(readonlyEntry).toBeDefined();
    expect(readonlyEntry!.gitKind).toBe('unknown');
    expect(readonlyEntry!.repoKey ?? null).toBeNull();
    const readonlyInitial = initial.items.find(row => (row.value as { workspace: { canonicalPath: string } }).workspace.canonicalPath === readonlyEntry!.workspace.canonicalPath);
    expect(page.items.find(item => item.key === readonlyInitial?.key)).toEqual(readonlyInitial);
  });
});
