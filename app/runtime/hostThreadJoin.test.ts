// @vitest-environment node
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import { unavailableRegistration } from '../../bridge/runtime/runtimeDriverFactories.js';
import { decodeRepoKey, parseSessionRef, parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import type { HostMutationCall } from '../../shared/runtime/hostWire.js';
import { hostObject, hostString } from './hostCollaborationViews';

it('probes only the authorized joining workspace and accepts another worktree of the bound repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vis-thread-join-'));
  const repository = path.join(root, 'repository'), worktree = path.join(root, 'worktree'), other = path.join(root, 'other');
  for (const directory of [repository, other]) {
    execFileSync('git', ['init', '--quiet', directory]);
    execFileSync('git', ['-C', directory, '-c', 'user.name=Vis QA', '-c', 'user.email=qa@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base']);
  }
  execFileSync('git', ['-C', repository, 'worktree', 'add', '--quiet', '-b', 'participant', worktree]);
  const directories = [repository, worktree, other];
  const services = await createRuntimeServices({
    environmentId: randomUUID(), stateRoot: root, role: 'local',
    roots: directories.map(directory => ({ root: directory, permissions: ['read', 'write', 'command'] })),
    config: { version: 1, nativeServices: { codex: true, opencode: false, 'kimi-web': false, dsh: false }, acpAgents: [] },
    nativeSupervisor: { start: async () => [], stop: async () => {}, getStatus: () => [] },
    acpManager: { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach() { throw new Error('ACP is disabled'); } },
    runtime: { mutate: action => action() },
    factories: { codex: async context => {
      const identity = { environmentId: parseEnvironmentId(context.environmentId), harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId), kind: 'codex' as const };
      const empty = unavailableRegistration(identity, 'starting');
      return { registration: {
        manifest: { ...empty.manifest, core: { ...empty.manifest.core, inspect: { state: 'supported' }, listSessionPage: { state: 'supported' } } },
        driver: { native: {}, core: {
          inspect: () => ({ state: 'ready' }),
          listSessionPage: () => ({ items: directories.map((cwd, index) => ({ session: { environmentId: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, nativeSessionId: `member-${index}` }, cwd, title: `Member ${index}` })), cursor: null, completeness: 'complete' }),
        } },
      }, close: async () => {} };
    } },
  });
  try {
    await services.start();
    const context = { target: services.target, permissions: services.grant.permissions, workspaceKeys: services.grant.workspaceKeys };
    const mutate = async (call: HostMutationCall) => hostObject((await services.hostServices.mutate(call, { ...context, idempotencyKey: randomUUID(), onAccepted() {} })).value);
    const manifest = services.registry.list().find(item => item.kind === 'codex');
    if (!manifest) throw new Error('Missing source');
    const sessions = directories.map((_, index) => parseSessionRef({ environmentId: services.target, harnessInstanceId: manifest.harnessInstanceId, nativeSessionId: `member-${index}` }));
    const roots = () => services.store.page({ collection: 'workspaces', limit: 20 });
    const initial = await roots();
    expect(initial.items.every(row => hostObject(row.value).gitKind !== 'git')).toBe(true);
    const info = hostObject(await services.hostServices.read({ domain: 'thread', operation: 'repository', args: { session: sessions[0]! } }, context));
    const repo = decodeRepoKey(hostString(info.repoKey));
    const bound = await mutate({ domain: 'thread', operation: 'bind', args: { session: sessions[0]!, repo } });
    const threadId = hostString(bound.threadId);
    const before = await roots();
    const joined = await mutate({ domain: 'thread', operation: 'join', args: { threadId, session: sessions[1]!, repo } });
    expect(joined.session).toEqual(sessions[1]);
    const after = await roots();
    expect(after.items.filter(row => hostObject(row.value).gitKind === 'git')).toHaveLength(2);
    const changed = after.items.filter(row => before.items.find(prior => prior.key === row.key)?.revision !== row.revision);
    expect(changed).toHaveLength(1);
    await expect(mutate({ domain: 'thread', operation: 'join', args: { threadId, session: { ...sessions[2]!, environmentId: parseEnvironmentId(randomUUID()) }, repo } })).rejects.toThrow();
    expect(await roots()).toEqual(after);
    await expect(mutate({ domain: 'thread', operation: 'join', args: { threadId, session: sessions[2]!, repo } })).rejects.toThrow('host.session_repository');
    expect((await roots()).items.filter(row => hostObject(row.value).gitKind === 'git')).toHaveLength(3);
    const snapshot = hostObject(await services.hostServices.read({ domain: 'thread', operation: 'snapshot', args: { threadId } }, context));
    expect(hostObject(snapshot.thread).participants).toHaveLength(2);
  } finally { await services.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
