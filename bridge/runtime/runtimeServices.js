import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createRuntimeStore } from './storage/runtimeStore.js';
import { createWorkspaceService } from './workspaceService.js';
import { createTargetGitCommand } from './targetGitCommand.js';
import { createGitService } from './gitService.js';
import { createWorkspaceCatalog } from './workspaceCatalog.js';
import { createSessionIndex } from './sessionIndex.js';
import { createRuntimeAcceptance } from './runtimeAcceptance.js';
import { loadRuntimeRegistrations } from './runtimeRegistrations.js';
import { createRuntimeDriverFactories } from './runtimeDriverFactories.js';
import { decodeWorkspaceKey } from '../../shared/runtime/identity.js';
import { RUNTIME_WIRE_METHODS, parseRuntimeResult } from '../../shared/runtime/runtimeWire.js';
import { requireValue } from '../../shared/runtime/capabilities.js';

export async function createRuntimeServices(options) {
  const epoch = randomUUID(), instanceId = randomUUID();
  const keys = ['opencode', 'codex', 'kimi-web', 'dsh', ...(options.config.acpAgents.length ? options.config.acpAgents.map(agent => 'acp:' + agent.id) : ['acp:unconfigured'])];
  const registrations = await loadRuntimeRegistrations(options.stateRoot, keys);
  let active = true, closed;
  const store = createRuntimeStore({ stateDirectory: options.stateRoot, environmentId: options.environmentId, ownerId: instanceId, epoch });
  const cleanup = [];
  try {
    cleanup.push(() => store.close());
    await store.ready;
    const roots = options.role === 'manager' ? [] : options.roots;
    const workspace = await createWorkspaceService({ target: options.environmentId, epoch, roots });
    cleanup.push(() => workspace.close());
    const command = await createTargetGitCommand({ target: options.environmentId, roots: workspace.workspaces.map((entry, index) => ({ root: entry.root, pathPolicy: entry.pathPolicy, permissions: roots[index].permissions.filter(permission => ['read', 'write', 'command'].includes(permission)) })), assertCurrent: () => requireValue(active, 'runtime.closed', 'source_unavailable') });
    cleanup.push(() => command.close());
    const catalog = createWorkspaceCatalog({ store, git: createGitService({ command }) });
    const acceptance = createRuntimeAcceptance({ store });
    cleanup.push(() => acceptance.close());
    // Authorization resolves a directory to the granted root that contains it (an existing
    // root resolves to itself). A workspaceKey is therefore always one of the grant's roots,
    // so discovery, the grant and dispatch all agree on the same authorized root scope even
    // when a native session lives in a subdirectory. realpath() collapses symlinks first, so
    // an adjacent sibling or a symlink escape finds no containing root and is refused.
    const authorizeDirectory = async (directory) => {
      const canonical = await realpath(directory);
      const root = workspace.workspaces.find(entry => entry.root === canonical)
        ?? workspace.workspaces.find(entry => {
          const relative = path.relative(entry.root, canonical);
          return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
        });
      requireValue(root, 'runtime.workspace', 'unauthorized');
      return { environmentId: options.environmentId, canonicalPath: root.root, pathPolicy: root.pathPolicy };
    };
    const drivers = createRuntimeDriverFactories({ ...options, epoch, workspace, store: acceptance.store, registrations: registrations.harnesses, isCurrent: () => active, authorizeDirectory });
    cleanup.push(() => drivers.close());
    const index = createSessionIndex({ store, registry: drivers.registry, catalog, resolveWorkspace: input => authorizeDirectory(input.directory) });
    cleanup.push(() => index.close());
    const methods = options.role === 'manager' ? ['runtime.inspect', 'runtime.target.attach', 'runtime.target.detach'] : Object.keys(RUNTIME_WIRE_METHODS);
    const capabilities = Object.freeze({ methods, extensions: [] });
    const permissions = options.permissions ?? ['runtime:read', 'session:read', 'session:write', 'workspace:read', 'workspace:write', 'workspace:pty'];
    return {
      target: options.environmentId, epoch, instanceId, role: options.role, connectionProfileId: registrations.connectionProfileId,
      workspace, store, index, snapshots: index.snapshots, events: index.events, registry: drivers.registry, acceptance, capabilities,
      authority: id => drivers.authority(id),
      grant: Object.freeze({ target: options.environmentId, role: options.role, capabilities, permissions, workspaceKeys: workspace.workspaces.map(entry => entry.key) }),
      async start() {
        if (options.role === 'manager') return;
        for (const manifest of drivers.registry.list()) await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'harnesses', key: manifest.harnessInstanceId, value: { environmentId: manifest.environmentId, harnessInstanceId: manifest.harnessInstanceId, kind: manifest.kind, manifest } }] });
        for (const root of workspace.workspaces) await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'workspaces', key: root.key, value: { kind: 'workspace', workspace: decodeWorkspaceKey(root.key), sources: [], orphan: false } }] });
        await drivers.start(index);
        for (const manifest of drivers.registry.list()) {
          for (let attempt = 0; attempt < 4; attempt++) {
            const prior = await store.get({ collection: 'harnesses', key: manifest.harnessInstanceId });
            try { await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'harnesses', key: manifest.harnessInstanceId, expectedRevision: prior?.revision ?? 0, value: { ...prior?.value, environmentId: manifest.environmentId, harnessInstanceId: manifest.harnessInstanceId, kind: manifest.kind, manifest } }] }); break; }
            catch (error) { if (error.code !== 'conflict' || attempt === 3) throw error; }
          }
        }
      },
      async inspect(base, targets) {
        const harnesses = await Promise.all(drivers.registry.list().map(async manifest => ({ manifest, inspection: await drivers.registry.invoke({ environmentId: manifest.environmentId, harnessInstanceId: manifest.harnessInstanceId, channel: 'core', operation: 'inspect', params: manifest.kind === 'acp' ? drivers.authority(manifest.harnessInstanceId) : {} }) })));
        return parseRuntimeResult('runtime.inspect', { ...base, role: options.role, connectionProfileId: registrations.connectionProfileId, targets, harnesses, transports: { direct: true, ssh: false, slurm: false } });
      },
      close() {
        closed ??= (async () => {
          active = false;
          const errors = [];
          for (const release of [...cleanup].reverse()) try { await release(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, 'Runtime service shutdown failed');
        })();
        return closed;
      },
    };
  } catch (error) {
    active = false;
    const failures = [error];
    for (const release of [...cleanup].reverse()) try { await release(); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, 'Runtime initialization cleanup failed');
    throw error;
  }
}

