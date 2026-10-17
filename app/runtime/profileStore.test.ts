import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConnectionProfileId, parseEnvironmentId } from '../../shared/runtime/identity.js';
import { resolveProfileEnvironment } from '../../shared/runtime/connectionProfile.js';
import { createProfileStore } from '../../bridge/runtime/transports/profileStore.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function profilePath() {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-profiles-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'profiles.json');
}

const environment = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const otherEnvironment = parseEnvironmentId('22222222-2222-4222-8222-222222222222');

function localProfile(name = 'Local host') {
  return {
    name,
    transport: { kind: 'local' as const },
    target: { kind: 'local' as const, environmentId: environment },
    role: 'local' as const,
    credentialRef: 'cred-local-1',
  };
}

function sshProfile() {
  return {
    name: 'Build host',
    transport: { kind: 'ssh' as const, endpoint: 'builder.example:22' },
    target: { kind: 'ssh' as const, environmentId: otherEnvironment },
    role: 'execution' as const,
    credentialRef: 'cred-ssh-7',
  };
}

describe('profileStore', () => {
  it('assigns a stable UUID and persists it across reloads without changing identity', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const created = await store.create(localProfile());
    expect(() => parseConnectionProfileId(created.profileId)).not.toThrow();
    expect(created.enabled).toBe(false);

    const reloaded = await createProfileStore({ profilePath: storePath }).load();
    const found = reloaded.find((profile) => profile.profileId === created.profileId);
    expect(found?.profileId).toBe(created.profileId);
    expect(found === undefined ? undefined : resolveProfileEnvironment(found)).toBe(environment);

    const mode = (await stat(storePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('starts empty without creating the file until the first write', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    expect(await store.list()).toEqual([]);
    await expect(stat(storePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists multiple profiles without sharing identity', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const local = await store.create(localProfile());
    const ssh = await store.create(sshProfile());

    const reloaded = await createProfileStore({ profilePath: storePath }).load();
    expect(reloaded).toHaveLength(2);
    const localReloaded = reloaded.find((profile) => profile.profileId === local.profileId);
    const sshReloaded = reloaded.find((profile) => profile.profileId === ssh.profileId);
    expect(localReloaded?.target).toEqual({ kind: 'local', environmentId: environment });
    expect(sshReloaded?.target).toEqual({ kind: 'ssh', environmentId: otherEnvironment });
    expect(localReloaded?.profileId).not.toBe(sshReloaded?.profileId);
  });

  it('edits mutable fields while preserving the stable UUID and environment identity', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const created = await store.create(localProfile());
    const edited = await store.update(created.profileId, {
      name: 'Renamed host',
      credentialRef: 'cred-local-2',
      transport: { kind: 'local' },
    });
    expect(edited?.profileId).toBe(created.profileId);
    expect(edited?.name).toBe('Renamed host');
    expect(edited?.credentialRef).toBe('cred-local-2');
    expect(edited?.target).toEqual(created.target);

    const reloaded = await createProfileStore({ profilePath: storePath }).load();
    expect(reloaded[0]?.profileId).toBe(created.profileId);
    expect(reloaded[0] === undefined ? undefined : resolveProfileEnvironment(reloaded[0])).toBe(environment);
  });

  it('refuses edits that would change the profile identity or silently enable a source', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const created = await store.create(localProfile());
    const foreign = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');

    await expect(store.update(created.profileId, { profileId: foreign })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      store.update(created.profileId, {
        target: { kind: 'local', environmentId: otherEnvironment },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(store.update(created.profileId, { enabled: true })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    // A forbidden direct transport-kind change would remap the target kind.
    await expect(
      store.update(created.profileId, { transport: { kind: 'ssh' } }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const reloaded = await store.get(created.profileId);
    expect(reloaded?.enabled).toBe(false);
    expect(reloaded === undefined ? undefined : resolveProfileEnvironment(reloaded)).toBe(environment);
  });

  it('enables only through the explicit enable action and preserves the choice on later edits', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const created = await store.create(localProfile());
    const enabled = await store.setEnabled(created.profileId, true);
    expect(enabled?.enabled).toBe(true);
    const renamed = await store.update(created.profileId, { name: 'Still enabled' });
    expect(renamed?.enabled).toBe(true);
    const disabled = await store.setEnabled(created.profileId, false);
    expect(disabled?.enabled).toBe(false);
  });

  it('removes only the profile record and keeps the other profiles intact', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const local = await store.create(localProfile());
    const ssh = await store.create(sshProfile());

    const removed = await store.remove(local.profileId);
    expect(removed?.profileId).toBe(local.profileId);
    expect(await store.get(local.profileId)).toBeUndefined();
    expect(await store.get(ssh.profileId)).toBeDefined();

    const reloaded = await createProfileStore({ profilePath: storePath }).load();
    expect(reloaded.map((profile) => profile.profileId)).toEqual([ssh.profileId]);
    await expect(readFile(storePath, 'utf8')).resolves.not.toContain(local.profileId);
  });

  it('rejects an input carrying a secret instead of persisting it', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    await expect(
      store.create({ ...localProfile(), password: 'super-secret' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      store.create({
        ...sshProfile(),
        transport: { kind: 'ssh', endpoint: 'builder.example:22?token=super-secret' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects malformed persisted JSON at the system boundary', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-profiles-bad-'));
    temporaryDirectories.push(directory);
    const storePath = path.join(directory, 'profiles.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(storePath, JSON.stringify({ version: 1, profiles: [{ name: 'x' }] }), 'utf8');
    await expect(createProfileStore({ profilePath: storePath }).load()).rejects.toBeDefined();
  });

  it('does not lose an acknowledged create under concurrent writes', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.create(localProfile(`Host ${index}`))),
    );
    expect(created).toHaveLength(10);
    expect(new Set(created.map((profile) => profile.profileId)).size).toBe(10);

    const reloaded = await createProfileStore({ profilePath: storePath }).load();
    expect(reloaded).toHaveLength(10);
    expect(reloaded.map((profile) => profile.name).sort()).toEqual(
      created.map((profile) => profile.name).sort(),
    );
    for (const profile of created) {
      expect(reloaded.some((entry) => entry.profileId === profile.profileId)).toBe(true);
    }
  });

  it('keeps both acknowledged edits when two profiles are updated at once', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const first = await store.create(localProfile('First'));
    const second = await store.create(sshProfile());
    const [firstEdited, secondEdited] = await Promise.all([
      store.update(first.profileId, { name: 'First edited' }),
      store.update(second.profileId, { name: 'Second edited' }),
    ]);
    expect(firstEdited?.name).toBe('First edited');
    expect(secondEdited?.name).toBe('Second edited');

    const reloaded = await createProfileStore({ profilePath: storePath }).load();
    expect(reloaded.find((profile) => profile.profileId === first.profileId)?.name).toBe('First edited');
    expect(reloaded.find((profile) => profile.profileId === second.profileId)?.name).toBe('Second edited');
  });

  it('keeps an interleaved delete and update coherent', async () => {
    const storePath = await profilePath();
    const store = createProfileStore({ profilePath: storePath });
    const first = await store.create(localProfile('First'));
    const second = await store.create(sshProfile());
    const third = await store.create(localProfile('Third'));
    const [edited, removed] = await Promise.all([
      store.update(first.profileId, { name: 'First edited' }),
      store.remove(second.profileId),
    ]);
    expect(edited?.name).toBe('First edited');
    expect(removed?.profileId).toBe(second.profileId);

    const reloaded = await createProfileStore({ profilePath: storePath }).load();
    expect(reloaded.map((profile) => profile.profileId).sort()).toEqual(
      [first.profileId, third.profileId].sort(),
    );
    expect(reloaded.find((profile) => profile.profileId === first.profileId)?.name).toBe('First edited');
  });

  it('serializes overlapping writes across store instances on one path', async () => {
    const storePath = await profilePath();
    const first = createProfileStore({ profilePath: storePath });
    const second = createProfileStore({ profilePath: storePath });
    const created = await Promise.all([
      first.create(localProfile('From first instance')),
      second.create(sshProfile()),
    ]);
    expect(created).toHaveLength(2);

    const reloaded = await createProfileStore({ profilePath: storePath }).load();
    expect(reloaded).toHaveLength(2);
    expect(reloaded.map((profile) => profile.profileId).sort()).toEqual(
      created.map((profile) => profile.profileId).sort(),
    );
  });
});
