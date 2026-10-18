// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeServices } from '../bridge/runtime/runtimeServices.js';
import { decodeRepoKey } from '../shared/runtime/identity.js';
import type { PathPolicy } from '../shared/runtime/identity.js';

const supervisor = { start: async () => [], stop: async () => {}, getStatus: () => [] };
const acpManager = { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach: (): never => { throw new Error('this lane registers no ACP harness'); } };

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

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
describe('the seeded workspace catalog carries the repo identity the Host Thread gates on (F3-P2-2)', () => {
  it('probes every granted root at catalog-seed time, so a real repository resolves and a non-repository answers non-git', async () => {
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

    // When: the runtime starts (which is where the catalog is seeded).
    await services.start();

    // Then: the catalog entry for the real repository carries gitKind and a
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

    // And: a granted root that is not a repository is probed honestly as
    // non-git with no repoKey, rather than being left undescribed.
    const plainEntry = byPath.get(await realpath(plain));
    expect(plainEntry).toBeDefined();
    expect(plainEntry!.gitKind).toBe('non-git');
    expect(plainEntry!.repoKey ?? null).toBeNull();
  });
});
