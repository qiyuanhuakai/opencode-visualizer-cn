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
 * Serialises every read-modify-persist transaction against one profile path within this process,
 * so overlapping writes cannot lose an already-acknowledged update and two writers can never share
 * a temp file. Store instances that name the same path share the chain; a failed transaction is
 * swallowed on the chain so it cannot poison later callers (the caller still sees its own failure).
 */
const writeChains = new Map();

function serializeWrite(key, task) {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const result = previous.then(() => task());
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(key, tail);
  tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  });
  return result;
}

/**
 * Durable connection-profile store. One JSON document at `profilePath`, written atomically
 * (unique temp file + rename) with owner-only mode 0600 under a 0700 directory. Persistence only
 * ever removes or rewrites the profile record; it holds no native history or job handles, so a
 * delete here can never destroy them.
 */
export function createProfileStore(options = {}) {
  const profilePath = options.profilePath;
  requireValue(typeof profilePath === 'string' && profilePath.length > 0, 'profilePath');
  const lockKey = path.resolve(profilePath);
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
    const temporary = `${profilePath}.tmp-${process.pid}-${randomUUID()}`;
    const document = createProfileDocument(profiles);
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, profilePath);
    cache = [...profiles];
  }

  async function currentProfiles() {
    return cache ?? load();
  }

  async function transaction(apply) {
    return serializeWrite(lockKey, async () => {
      const profiles = await load();
      const { write, profiles: next, result } = apply(profiles);
      if (write) await persist(next);
      return result;
    });
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
      return transaction((profiles) => {
        const profile = parseConnectionProfile({ profileId: randomUUID(), ...draft });
        requireValue(!profiles.some((entry) => entry.profileId === profile.profileId), 'profile.profileId', 'conflict');
        return { write: true, profiles: [...profiles, profile], result: profile };
      });
    },

    async update(profileId, patch) {
      const id = parseConnectionProfileId(profileId);
      return transaction((profiles) => {
        const index = profiles.findIndex((profile) => profile.profileId === id);
        if (index === -1) return { write: false, result: undefined };
        const next = updateConnectionProfile(profiles[index], patch);
        const updated = [...profiles];
        updated[index] = next;
        return { write: true, profiles: updated, result: next };
      });
    },

    async setEnabled(profileId, enabled) {
      const id = parseConnectionProfileId(profileId);
      requireValue(typeof enabled === 'boolean', 'enabled');
      return transaction((profiles) => {
        const index = profiles.findIndex((profile) => profile.profileId === id);
        if (index === -1) return { write: false, result: undefined };
        const next = parseConnectionProfile({ ...profiles[index], enabled });
        const updated = [...profiles];
        updated[index] = next;
        return { write: true, profiles: updated, result: next };
      });
    },

    async remove(profileId) {
      const id = parseConnectionProfileId(profileId);
      return transaction((profiles) => {
        const removed = profiles.find((profile) => profile.profileId === id);
        if (removed === undefined) return { write: false, result: undefined };
        return { write: true, profiles: profiles.filter((profile) => profile.profileId !== id), result: removed };
      });
    },
  });
}
