import { describe, expect, it, vi } from 'vitest';

import {
  CONNECTION_ROLES,
  TRANSPORT_KINDS,
  assertNoSecretPayload,
  parseConnectionProfile,
  parseNewConnectionProfile,
  publicConnectionProfile,
  resolveProfileEnvironment,
  updateConnectionProfile,
} from '../../shared/runtime/connectionProfile.js';
import { parseConnectionProfileId, parseEnvironmentId } from '../../shared/runtime/identity.js';

const environment = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const clusterEnvironment = parseEnvironmentId('22222222-2222-4222-8222-222222222222');

function localProfileInput() {
  return {
    name: 'Workstation',
    transport: { kind: 'local' as const },
    target: { kind: 'local' as const, environmentId: environment },
    role: 'local' as const,
    credentialRef: 'cred-1',
  };
}

describe('connectionProfile shared contract', () => {
  it('declares the four host transports and the management/execution roles', () => {
    expect([...TRANSPORT_KINDS]).toEqual(['local', 'direct', 'ssh', 'slurm']);
    expect([...CONNECTION_ROLES]).toEqual(['local', 'manager', 'execution']);
  });

  it('maps a profile to its stable environment identity independent of mutable fields', () => {
    const profile = parseConnectionProfile({
      profileId: '33333333-3333-4333-8333-333333333333',
      ...localProfileInput(),
      enabled: false,
    });
    expect(resolveProfileEnvironment(profile)).toBe(environment);

    // A Slurm profile resolves to the persistent cluster environment, never a compute hostname.
    const slurm = parseConnectionProfile({
      profileId: '44444444-4444-4444-8444-444444444444',
      name: 'Cluster login',
      transport: { kind: 'slurm' },
      target: { kind: 'slurm', clusterEnvironmentId: clusterEnvironment },
      role: 'manager',
      credentialRef: 'cred-cluster',
      enabled: true,
    });
    expect(resolveProfileEnvironment(slurm)).toBe(clusterEnvironment);
  });

  it('preserves UUID, target and enabled across an identity-preserving edit', () => {
    const profile = parseConnectionProfile({
      profileId: '33333333-3333-4333-8333-333333333333',
      ...localProfileInput(),
      enabled: true,
    });
    const edited = updateConnectionProfile(profile, { name: 'Renamed', credentialRef: 'cred-2' });
    expect(edited.profileId).toBe(profile.profileId);
    expect(edited.target).toEqual(profile.target);
    expect(edited.enabled).toBe(true);
    expect(edited.name).toBe('Renamed');
    expect(edited.credentialRef).toBe('cred-2');
  });

  it('rejects a target that does not match the declared transport kind', () => {
    expect(() =>
      parseConnectionProfile({
        profileId: '33333333-3333-4333-8333-333333333333',
        ...localProfileInput(),
        transport: { kind: 'ssh' },
        enabled: false,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('rejects a normal payload that carries a secret and accepts a credential reference', () => {
    expect(() => assertNoSecretPayload({ profileId: 'x', password: 'super-secret' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => assertNoSecretPayload({ transport: { token: 'super-secret' } })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() =>
      parseNewConnectionProfile({ ...localProfileInput(), apiKey: 'super-secret' }),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() =>
      parseNewConnectionProfile({
        ...localProfileInput(),
        transport: { kind: 'direct', endpoint: 'wss://bridge.test/runtime?token=super-secret' },
        target: { kind: 'direct', environmentId: environment },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => parseNewConnectionProfile(localProfileInput())).not.toThrow();
  });

  it('serializes a public profile with a credential reference and no secret', () => {
    const profile = parseConnectionProfile({
      profileId: '33333333-3333-4333-8333-333333333333',
      ...localProfileInput(),
      enabled: true,
    });
    const publicProfile = publicConnectionProfile(profile);
    const serialized = JSON.stringify(publicProfile);
    expect(serialized).toContain('cred-1');
    expect(serialized).not.toContain('super-secret');
    expect(publicProfile.credentialRef).toBe('cred-1');
    expect(() => parseConnectionProfileId(publicProfile.profileId)).not.toThrow();
    // The public view must still be a strict profile (no hidden secret-carrying field).
    expect(() => assertNoSecretPayload(publicProfile)).not.toThrow();
  });
});

describe('connection manager acceptance criteria', () => {
  it('keeps the environment identity across create, edit, reconnect and delete', async () => {
    const { createConnectionManager } = await import(
      '../../bridge/runtime/transports/connectionManager.js'
    );
    const { createProfileStore } = await import('../../bridge/runtime/transports/profileStore.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-conn-id-'));
    try {
      const store = createProfileStore({ profilePath: path.join(directory, 'profiles.json') });
      const observed: string[] = [];
      const manager = createConnectionManager({
        store,
        openTransport: async (profile) => {
          const identity = resolveProfileEnvironment(profile);
          observed.push(identity);
          return { environmentId: identity, connectionId: 'c-1', close: vi.fn() };
        },
      });

      const created = await manager.create(localProfileInput());
      await manager.setEnabled(created.profileId, true);
      await manager.connect(created.profileId);
      await manager.update(created.profileId, { name: 'Edited' });
      await manager.reconnect(created.profileId);
      const receipt = await manager.delete(created.profileId);

      expect(observed).toEqual([environment, environment]);
      expect(receipt.removed).toBe(created.profileId);
      expect(receipt.environmentId).toBe(environment);
      expect(await manager.list()).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never auto-enables a disabled source through connect, reconnect or edit', async () => {
    const { createConnectionManager } = await import(
      '../../bridge/runtime/transports/connectionManager.js'
    );
    const { createProfileStore } = await import('../../bridge/runtime/transports/profileStore.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-conn-disabled-'));
    try {
      const store = createProfileStore({ profilePath: path.join(directory, 'profiles.json') });
      const manager = createConnectionManager({
        store,
        openTransport: async (profile) => ({
          environmentId: resolveProfileEnvironment(profile),
          connectionId: 'c-1',
          close: vi.fn(),
        }),
      });
      const created = await manager.create(localProfileInput());
      expect(created.enabled).toBe(false);

      await expect(manager.connect(created.profileId)).rejects.toMatchObject({
        code: 'source_unavailable',
      });
      await expect(manager.reconnect(created.profileId)).rejects.toMatchObject({
        code: 'source_unavailable',
      });
      await manager.update(created.profileId, { name: 'Renamed while disabled' });

      const stillDisabled = (await manager.list())[0];
      expect(stillDisabled?.enabled).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deleting a connection preserves native history and owned jobs', async () => {
    const { createConnectionManager } = await import(
      '../../bridge/runtime/transports/connectionManager.js'
    );
    const { createProfileStore } = await import('../../bridge/runtime/transports/profileStore.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-conn-delete-'));
    try {
      const store = createProfileStore({ profilePath: path.join(directory, 'profiles.json') });
      const dropNativeHistory = vi.fn();
      const cancelOwnedJobs = vi.fn();
      const manager = createConnectionManager({
        store,
        openTransport: async (profile) => ({
          environmentId: resolveProfileEnvironment(profile),
          connectionId: 'c-1',
          close: vi.fn(),
        }),
        resources: { dropNativeHistory, cancelOwnedJobs },
      });
      const created = await manager.create(localProfileInput());
      await manager.setEnabled(created.profileId, true);
      await manager.connect(created.profileId);
      const receipt = await manager.delete(created.profileId);

      expect(receipt.nativeHistoryPreserved).toBe(true);
      expect(receipt.ownedJobsPreserved).toBe(true);
      expect(receipt.cancelledJobs).toBe(0);
      expect(dropNativeHistory).not.toHaveBeenCalled();
      expect(cancelOwnedJobs).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to adopt a different environment on reconnect and stays failed', async () => {
    const { createConnectionManager } = await import(
      '../../bridge/runtime/transports/connectionManager.js'
    );
    const { createProfileStore } = await import('../../bridge/runtime/transports/profileStore.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-conn-conflict-'));
    try {
      const store = createProfileStore({ profilePath: path.join(directory, 'profiles.json') });
      const foreign = parseEnvironmentId('55555555-5555-4555-8555-555555555555');
      let call = 0;
      const manager = createConnectionManager({
        store,
        openTransport: async (profile) => {
          call += 1;
          return {
            environmentId: call === 1 ? resolveProfileEnvironment(profile) : foreign,
            connectionId: 'c-1',
            close: vi.fn(),
          };
        },
      });
      const created = await manager.create(localProfileInput());
      await manager.setEnabled(created.profileId, true);
      await manager.connect(created.profileId);
      await expect(manager.reconnect(created.profileId)).rejects.toMatchObject({ code: 'conflict' });
      const status = await manager.status(created.profileId);
      expect(status?.environmentId).toBe(environment);
      expect(status?.state).toBe('failed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
