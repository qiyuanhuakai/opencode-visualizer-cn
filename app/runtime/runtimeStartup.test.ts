// @vitest-environment node
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import { unavailableRegistration } from '../../bridge/runtime/runtimeDriverFactories.js';
import { parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';

it.each(['factory', 'subscription', 'discovery'])('recovers an initial %s failure through a coalesced source retry', async failure => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vis-startup-retry-'));
  let attempts = 0;
  let closed = 0;
  let discoveryAvailable = false;
  const services = await createRuntimeServices({
    environmentId: randomUUID(), stateRoot: root, role: 'local',
    roots: [{ root, permissions: ['read'] }],
    config: { version: 1, nativeServices: { codex: true, opencode: false, 'kimi-web': false, dsh: false }, acpAgents: [] },
    nativeSupervisor: { start: async () => [], stop: async () => {}, getStatus: () => [] },
    acpManager: { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach() { throw new Error('ACP is disabled'); } },
    runtime: { mutate: action => action() },
    factories: { codex: async context => {
      attempts++;
      if (attempts === 1 && failure === 'factory') throw new Error('Controlled initial native connection failure');
      const registration = unavailableRegistration({ environmentId: parseEnvironmentId(context.environmentId), harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId), kind: 'codex' }, 'starting');
      return {
        registration: {
          manifest: { ...registration.manifest, core: { ...registration.manifest.core, listSessionPage: { state: 'supported' }, ...(failure === 'subscription' ? { subscribe: { state: 'supported' } } : {}) } },
          driver: { core: {
            inspect: () => ({ state: 'ready' }),
            listSessionPage: () => {
              if (!discoveryAvailable && failure === 'discovery') throw new Error('Controlled initial discovery failure');
              return { items: [], cursor: null, completeness: 'complete' };
            },
            ...(failure === 'subscription' ? { subscribe: () => {
              if (attempts === 1) throw new Error('Controlled initial subscription failure');
              return { read: async () => ({ status: 'complete', events: [] }), detach: () => {} };
            } } : {}),
          }, native: {} },
        },
        close: async () => { closed++; },
      };
    } },
  });
  try {
    await services.start();
    const manifest = services.registry.list().find(item => item.kind === 'codex');
    if (!manifest) throw new Error('Codex registration is missing');
    expect(manifest.core.listSessionPage).toMatchObject(failure === 'discovery' ? { state: 'supported' } : { state: 'unsupported', reason: 'failed' });
    expect(services.index.state.sources).toBe(failure === 'discovery' ? 1 : 0);
    discoveryAvailable = true;
    const results = await Promise.all([services.index.retry(manifest.harnessInstanceId), services.index.retry(manifest.harnessInstanceId)]);
    expect(results).toEqual([expect.objectContaining({ status: 'complete' }), expect.objectContaining({ status: 'complete' })]);
    expect(attempts).toBe(failure === 'discovery' ? 1 : 2);
    expect(services.index.state.sources).toBe(1);
    const published = await services.store.get({ collection: 'harnesses', key: manifest.harnessInstanceId });
    expect(published?.value).toMatchObject({ manifest: { core: { listSessionPage: { state: 'supported' } } } });
  } finally {
    await services.close();
    await rm(root, { recursive: true, force: true });
  }
  expect(closed).toBe(failure === 'subscription' ? 2 : 1);
});

it('publishes a ready source and its extension grant while discovery is still pending', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vis-startup-'));
  const listing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const creating = Promise.withResolvers<void>();
  const allowCreation = Promise.withResolvers<void>();
  let creations = 0;
  const services = await createRuntimeServices({
    environmentId: randomUUID(), stateRoot: root, role: 'local',
    roots: [{ root, permissions: ['read'] }],
    config: { version: 1, nativeServices: { codex: true, opencode: false, 'kimi-web': false, dsh: false }, acpAgents: [] },
    nativeSupervisor: { start: async () => [], stop: async () => {}, getStatus: () => [] },
    acpManager: { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach() { throw new Error('ACP is disabled'); } },
    runtime: { mutate: action => action() },
    factories: { codex: async context => {
      creations++;
      creating.resolve();
      await allowCreation.promise;
      const registration = unavailableRegistration({ environmentId: parseEnvironmentId(context.environmentId), harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId), kind: 'codex' }, 'starting');
      return {
        registration: {
          manifest: { ...registration.manifest,
            core: { ...registration.manifest.core, inspect: { state: 'supported' }, listSessionPage: { state: 'supported' } },
            extensions: [{ owner: registration.manifest.harnessInstanceId, name: 'startupProbe', scope: 'instance', permission: 'startup:read', schemaVersion: 1, support: { state: 'supported' } }],
          },
          driver: { core: {
            inspect: () => ({ state: 'ready' }),
            listSessionPage: async () => {
              listing.resolve(); await release.promise;
              return { items: [], cursor: null, completeness: 'complete' };
            },
          }, native: { startupProbe: () => ({ ready: true }) } },
        },
        close: async () => {},
      };
    } },
  });
  const starting = services.start();
  let retrying: Promise<unknown> | undefined;
  try {
    await creating.promise;
    const pendingManifest = services.registry.list().find(item => item.kind === 'codex');
    if (!pendingManifest) throw new Error('Starting Codex registration is missing');
    retrying = services.index.retry(pendingManifest.harnessInstanceId);
    allowCreation.resolve();
    await listing.promise;
    expect(creations).toBe(1);
    const manifest = services.registry.list().find(item => item.kind === 'codex');
    if (!manifest) throw new Error('Codex registration is missing');
    const published = await services.store.get({ collection: 'harnesses', key: manifest.harnessInstanceId });
    expect(published?.value).toMatchObject({ manifest: { core: { listSessionPage: { state: 'supported' } } } });
    expect(services.grant.capabilities.extensions).toContainEqual(expect.objectContaining({ name: 'startupProbe', owner: manifest.harnessInstanceId }));
    expect(services.grant.permissions).toContain('startup:read');
    const workspace = await services.store.page({ collection: 'workspaces', limit: 1 });
    expect(workspace.items[0]?.value).toMatchObject({ gitKind: 'unknown', repoKey: null });
  } finally {
    allowCreation.resolve();
    release.resolve();
    await starting;
    await retrying;
    await services.close();
    await rm(root, { recursive: true, force: true });
  }
});
