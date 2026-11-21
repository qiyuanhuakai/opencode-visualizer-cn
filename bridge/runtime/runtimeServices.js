import { createHostServices } from './hostServices.js';
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
  let active = true, closed, repositoryDiscovery;
  const store = createRuntimeStore({ stateDirectory: options.stateRoot, environmentId: options.environmentId, ownerId: instanceId, epoch, takeover: options.runtimeStoreTakeover, recoverDeadOwner: options.recoverDeadOwner });
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
    let hostServices;
    const acceptance = createRuntimeAcceptance({ store, onNativeObservation: event => hostServices?.observeNative(event) });
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
        }) ?? hostServices?.writerWorkspace(canonical);
      requireValue(root, 'runtime.workspace', 'unauthorized');
      return { environmentId: options.environmentId, canonicalPath: root.root, pathPolicy: root.pathPolicy };
    };
    const publishHarness = async manifest => {
      const supported = manifest.extensions.filter(extension => extension.support.state === 'supported');
      const remaining = capabilities.extensions.filter(extension => extension.owner !== manifest.harnessInstanceId);
      capabilities.extensions.splice(0, capabilities.extensions.length, ...remaining, ...supported.map(extension => ({ owner: extension.owner, name: extension.name, permission: extension.permission, schemaVersion: extension.schemaVersion, metadata: { scope: extension.scope } })));
      if (!options.permissions) for (const extension of supported) {
        if (!permissions.includes(extension.permission)) permissions.push(extension.permission);
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const prior = await store.get({ collection: 'harnesses', key: manifest.harnessInstanceId });
        try {
          await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'harnesses', key: manifest.harnessInstanceId, expectedRevision: prior?.revision ?? 0,
            value: { ...prior?.value, environmentId: manifest.environmentId, harnessInstanceId: manifest.harnessInstanceId, kind: manifest.kind, manifest } }] });
          return;
        } catch (error) { if (error?.code !== 'conflict' || attempt === 7) throw error; }
      }
    };
    const drivers = createRuntimeDriverFactories({ ...options, epoch, workspace, store: acceptance.store, registrations: registrations.harnesses, isCurrent: () => active, authorizeDirectory, onHarnessReady: publishHarness, onWriterHarness: manifest => {
      for (const extension of manifest.extensions.filter(item => item.support.state === 'supported')) {
        capabilities.extensions.push({ owner: extension.owner, name: extension.name, permission: extension.permission, schemaVersion: extension.schemaVersion, metadata: { scope: extension.scope } });
        if (!options.permissions && !permissions.includes(extension.permission)) permissions.push(extension.permission);
      }
    } });
    cleanup.push(() => drivers.close());
    hostServices = await createHostServices({ store, role: options.role, environmentId: options.environmentId, stateRoot: options.stateRoot, workspace, ensureWriterHarness: drivers.ensureWriterHarness, refreshWriterHarness: drivers.refreshWriterHarness, commandWorkspaceKeys: workspace.workspaces.filter((_, index) => roots[index].permissions.includes('command')).map(root => root.key), registry: drivers.registry, authority: id => drivers.authority(id), acceptance, remoteServices: options.remoteServices, probeWorkspace: key => catalog.probe(key, { selected: true }) });
    cleanup.push(() => hostServices.close());
    const index = createSessionIndex({ store, registry: drivers.registry, catalog, resolveWorkspace: input => authorizeDirectory(input.directory), recoverSource: id => drivers.retry(id) });
    cleanup.push(() => index.close());
    const methods = options.role === 'manager' ? ['runtime.inspect', 'runtime.target.attach', 'runtime.target.detach', 'runtime.host.read', 'runtime.host.mutate'] : Object.keys(RUNTIME_WIRE_METHODS);
    const capabilities = Object.freeze({ methods, extensions: [] });
    const permissions = options.permissions ? [...options.permissions] : ['runtime:read', 'session:read', 'session:write', 'workspace:read', 'workspace:write', 'workspace:pty'];
    return {
      target: options.environmentId, epoch, instanceId, role: options.role, connectionProfileId: registrations.connectionProfileId,
      workspace, store, index, hostServices, remoteServices: options.remoteServices, snapshots: index.snapshots, events: index.events, registry: drivers.registry, acceptance, capabilities,
      authority: id => drivers.authority(id),
      requestSourceStart: id => drivers.requestStart(id),
      grant: Object.freeze({ target: options.environmentId, role: options.role, capabilities, permissions, workspaceKeys: workspace.workspaces.map(entry => entry.key) }),
      async start({ signal } = {}) {
        if (options.role === 'manager' || signal?.aborted) return;
        for (const manifest of drivers.registry.list()) await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'harnesses', key: manifest.harnessInstanceId, value: { environmentId: manifest.environmentId, harnessInstanceId: manifest.harnessInstanceId, kind: manifest.kind, manifest } }] });
        for (let offset = 0; offset < workspace.workspaces.length; offset += 200) {
          for (let attempt = 0; attempt < 8; attempt++) {
            const changes = [];
            const batch = workspace.workspaces.slice(offset, offset + 200);
            for (let start = 0; start < batch.length; start += 8) {
              const chunk = batch.slice(start, start + 8);
              const priors = await Promise.all(chunk.map(root => store.get({ collection: 'workspaces', key: root.key })));
              chunk.forEach((root, index) => {
                const prior = priors[index];
                changes.push({ collection: 'workspaces', key: root.key, expectedRevision: prior?.revision ?? 0,
                  value: { ...prior?.value, kind: 'workspace', workspace: decodeWorkspaceKey(root.key), sources: prior?.value?.sources ?? [], orphan: false, gitKind: prior?.value?.gitKind ?? 'unknown', repoKey: prior?.value?.repoKey ?? null } });
              });
            }
            try { await store.mutate({ intentId: randomUUID(), changes }); break; }
            catch (error) { if (error?.code !== 'conflict' || attempt === 7) throw error; }
          }
        }
        if (signal?.aborted) return;
        const cancelDiscovery = () => index.stopDiscovery();
        signal?.addEventListener('abort', cancelDiscovery, { once: true });
        try { await drivers.start(index); }
        finally { signal?.removeEventListener('abort', cancelDiscovery); }
        if (signal?.aborted) return;
        await hostServices.restoreWriterHarnesses();
        capabilities.extensions.splice(0, capabilities.extensions.length, ...drivers.registry.list().flatMap(manifest => manifest.extensions.filter(extension => extension.support.state === 'supported').map(extension => ({ owner: extension.owner, name: extension.name, permission: extension.permission, schemaVersion: extension.schemaVersion, metadata: { scope: extension.scope } }))));
        if (!options.permissions) {
          for (const manifest of drivers.registry.list()) for (const extension of manifest.extensions) {
            if (extension.support.state === 'supported' && !permissions.includes(extension.permission)) permissions.push(extension.permission);
          }
        }
        for (const manifest of drivers.registry.list()) {
          for (let attempt = 0; attempt < 4; attempt++) {
            const prior = await store.get({ collection: 'harnesses', key: manifest.harnessInstanceId });
            try { await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'harnesses', key: manifest.harnessInstanceId, expectedRevision: prior?.revision ?? 0, value: { ...prior?.value, environmentId: manifest.environmentId, harnessInstanceId: manifest.harnessInstanceId, kind: manifest.kind, manifest, ...(manifest.core.listSessionPage.state === 'unsupported' ? { indexDiscovery: [{ scopeKey: '{}', status: 'partial', count: 0, reason: manifest.core.listSessionPage.reason }] } : {}) } }] }); break; }
            catch (error) { if (error.code !== 'conflict' || attempt === 3) throw error; }
          }
        }
      },
      async inspect(base, targets) {
        const harnesses = await Promise.all(drivers.registry.list().map(async manifest => ({ manifest, inspection: await drivers.registry.invoke({ environmentId: manifest.environmentId, harnessInstanceId: manifest.harnessInstanceId, channel: 'core', operation: 'inspect', params: manifest.kind === 'acp' ? drivers.authority(manifest.harnessInstanceId) : {} }) })));
        if (options.role !== 'manager') repositoryDiscovery ??= (async () => {
          for (const root of workspace.workspaces) {
            if (!active) break;
            try { await catalog.probe(root.key, { visible: true, identityOnly: true }); }
            catch { /* Optional repository identity stays unknown for this root. */ }
          }
        })();
        return parseRuntimeResult('runtime.inspect', { ...base, role: options.role, connectionProfileId: registrations.connectionProfileId, targets, harnesses, transports: options.remoteServices?.capabilities ?? { direct: true, ssh: false, slurm: false } });
      },
      close() {
        closed ??= (async () => {
          active = false;
          await repositoryDiscovery;
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

