import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requireValue } from '../../../shared/runtime/capabilities.js';
import { parseConnectionProfileId } from '../../../shared/runtime/identity.js';
import {
  createProfileDocument,
  parseConnectionProfile,
  parseNewConnectionProfile,
  parseProfileDocument,
  updateConnectionProfile,
} from '../../../shared/runtime/connectionProfile.js';

/**
 * Durable connection-profile store. One JSON document at `profilePath`, written atomically
 * (temp file + rename) with owner-only mode 0600 under a 0700 directory. Persistence only ever
 * removes or rewrites the profile record; it holds no native history or job handles, so a delete
 * here can never destroy them.
 */
export function createProfileStore(options = {}) {
  const profilePath = options.profilePath;
  requireValue(typeof profilePath === 'string' && profilePath.length > 0, 'profilePath');
  let cache;

  async function load() {
    try {
      cache = parseProfileDocument(JSON.parse(await readFile(profilePath, 'utf8')));
      return cache;
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        cache = [];
        return cache;
      }
      throw error;
    }
  }

  async function persist(profiles) {
    const directory = path.dirname(profilePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${profilePath}.tmp-${process.pid}-${Date.now()}`;
    const document = createProfileDocument(profiles);
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, profilePath);
    cache = [...profiles];
  }

  async function currentProfiles() {
    return cache ?? load();
  }

  return Object.freeze({
    profilePath,

    async load() {
      return Object.freeze([...(await load())]);
    },

    async list() {
      return Object.freeze([...(await currentProfiles())]);
    },

    async get(profileId) {
      const id = parseConnectionProfileId(profileId);
      return (await currentProfiles()).find((profile) => profile.profileId === id);
    },

    async create(input) {
      const draft = parseNewConnectionProfile(input);
      const profiles = await currentProfiles();
      const profile = parseConnectionProfile({ profileId: randomUUID(), ...draft });
      requireValue(!profiles.some((entry) => entry.profileId === profile.profileId), 'profile.profileId', 'conflict');
      await persist([...profiles, profile]);
      return profile;
    },

    async update(profileId, patch) {
      const id = parseConnectionProfileId(profileId);
      const profiles = await currentProfiles();
      const index = profiles.findIndex((profile) => profile.profileId === id);
      if (index === -1) return undefined;
      const next = updateConnectionProfile(profiles[index], patch);
      const updated = [...profiles];
      updated[index] = next;
      await persist(updated);
      return next;
    },

    async setEnabled(profileId, enabled) {
      const id = parseConnectionProfileId(profileId);
      requireValue(typeof enabled === 'boolean', 'enabled');
      const profiles = await currentProfiles();
      const index = profiles.findIndex((profile) => profile.profileId === id);
      if (index === -1) return undefined;
      const next = parseConnectionProfile({ ...profiles[index], enabled });
      const updated = [...profiles];
      updated[index] = next;
      await persist(updated);
      return next;
    },

    async remove(profileId) {
      const id = parseConnectionProfileId(profileId);
      const profiles = await currentProfiles();
      const removed = profiles.find((profile) => profile.profileId === id);
      if (removed === undefined) return undefined;
      await persist(profiles.filter((profile) => profile.profileId !== id));
      return removed;
    },
  });
}
