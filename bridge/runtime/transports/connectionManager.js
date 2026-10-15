import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { publicConnectionProfile, resolveProfileEnvironment } from '../../../shared/runtime/connectionProfile.js';

/**
 * Host lifecycle manager. Owns no native data: it dials a profile's transport, tracks the live
 * connection generation, and reconnects against the *same* stable environment identity.
 *
 * Management vs execution is explicit on the profile (`role`); this layer only enforces the
 * invariants the acceptance criteria name:
 *  - a profile edit / reconnect / delete never changes the target environment identity;
 *  - a disabled source is never auto-enabled (dialing requires `enabled === true`);
 *  - deleting a connection closes the live transport and drops the profile record only — it
 *    never touches native harness history or already-owned jobs (no destructive handle exists);
 *  - a dial in flight is retired — and the handle it produced closed — when the profile is
 *    deleted, disconnected, or superseded before the dial settles, and concurrent connects of one
 *    profile share a single dial instead of overwriting (and leaking) one another's handle.
 */
async function defaultOpenTransport(profile) {
  if (profile.transport.kind !== 'local') throw new ProtocolError('unsupported', 'transport.live');
  return { environmentId: resolveProfileEnvironment(profile), connectionId: `local-${profile.profileId}` };
}

async function safeClose(handle) {
  try {
    await handle?.close?.();
  } catch {
    // A transport close failure must not mask the lifecycle result.
  }
}

export function createConnectionManager(options = {}) {
  const store = options.store;
  const openTransport = options.openTransport ?? defaultOpenTransport;
  // Native history / owned-job handles are accepted only so the manager can prove it never
  // calls them; delete() records them as preserved and issues no cancellation.
  const resources = options.resources ?? {};
  requireValue(store !== null && typeof store === 'object', 'store');
  const connections = new Map();
  // In-flight dials keyed by profileId. Each carries a monotonic token; a disconnect, delete or a
  // superseding dial removes or replaces the entry, so a late result can tell it no longer owns the
  // profile lifecycle and must close its handle instead of registering it.
  const pendingDials = new Map();
  let dialSequence = 0;

  function statusOf(profile) {
    const record = connections.get(profile.profileId);
    return Object.freeze({
      profileId: profile.profileId,
      state: record?.state ?? 'disconnected',
      environmentId: record?.environmentId ?? resolveProfileEnvironment(profile),
      generation: record?.generation ?? 0,
    });
  }

  function fail(profile, environmentId, generation) {
    connections.set(profile.profileId, { state: 'failed', environmentId, generation });
  }

  async function requireProfile(profileId) {
    const profile = await store.get(profileId);
    requireValue(profile !== undefined, 'profile', 'source_unavailable');
    return profile;
  }

  async function connect(profileId) {
    const profile = await requireProfile(profileId);
    requireValue(profile.enabled === true, 'profile.disabled', 'source_unavailable');
    const key = profile.profileId;
    const existing = connections.get(key);
    if (existing?.state === 'connected') return statusOf(profile);
    // Deduplicate concurrent dials: a second caller awaits the first dial rather than opening a
    // second handle that would overwrite — and leak — the first.
    const inflight = pendingDials.get(key);
    if (inflight !== undefined) return inflight.promise;

    const expected = resolveProfileEnvironment(profile);
    const generation = (existing?.generation ?? 0) + 1;
    const token = (dialSequence += 1);
    const entry = { token, promise: undefined };
    // Register the pending token BEFORE openTransport runs, so a delete/disconnect landing during
    // the await finds and invalidates this dial instead of letting its late result resurrect.
    pendingDials.set(key, entry);
    const dial = (async () => {
      try {
        const dialed = await openTransport(profile);
        const current = pendingDials.get(key);
        if (current === undefined || current.token !== token) {
          await safeClose(dialed);
          const stillPresent = await store.get(key);
          requireValue(stillPresent !== undefined, 'profile', 'source_unavailable');
          throw new ProtocolError('conflict', 'profile.dial');
        }
        pendingDials.delete(key);
        if (dialed === undefined || dialed === null || dialed.environmentId !== expected) {
          await safeClose(dialed);
          fail(profile, expected, generation);
          throw new ProtocolError('conflict', 'profile.environment');
        }
        connections.set(key, {
          state: 'connected',
          environmentId: expected,
          generation,
          connectionId: dialed.connectionId ?? `conn-${generation}`,
          close: dialed.close,
        });
        return statusOf(profile);
      } catch (error) {
        // Retire THIS dial's pending entry on every failure path. The entry is registered before
        // openTransport runs, so without this cleanup a rejected dial would be reused forever: the
        // next connect would await the same settled rejection and never open a new transport.
        if (pendingDials.get(key) === entry) pendingDials.delete(key);
        throw error;
      }
    })();
    entry.promise = dial;
    return dial;
  }

  async function disconnect(profileId) {
    const profile = await requireProfile(profileId);
    const key = profile.profileId;
    pendingDials.delete(key);
    const existing = connections.get(key);
    if (existing !== undefined) {
      await safeClose(existing);
      connections.delete(key);
    }
    return statusOf(profile);
  }

  async function reconnect(profileId) {
    await requireProfile(profileId);
    await disconnect(profileId);
    return connect(profileId);
  }

  async function deleteConnection(profileId) {
    const profile = await store.get(profileId);
    if (profile === undefined) {
      return Object.freeze({ removed: undefined, environmentId: undefined, nativeHistoryPreserved: true, ownedJobsPreserved: true, cancelledJobs: 0, preservedHandles: Object.freeze([]) });
    }
    const environmentId = resolveProfileEnvironment(profile);
    const key = profile.profileId;
    pendingDials.delete(key);
    const existing = connections.get(key);
    if (existing !== undefined) {
      await safeClose(existing);
      connections.delete(key);
    }
    await store.remove(key);
    return Object.freeze({
      removed: profile.profileId,
      environmentId,
      nativeHistoryPreserved: true,
      ownedJobsPreserved: true,
      cancelledJobs: 0,
      preservedHandles: Object.freeze(Object.keys(resources)),
    });
  }

  return Object.freeze({
    async list() {
      return Object.freeze((await store.list()).map(publicConnectionProfile));
    },
    async get(profileId) {
      const profile = await store.get(profileId);
      return profile === undefined ? undefined : publicConnectionProfile(profile);
    },
    async create(input) {
      return publicConnectionProfile(await store.create(input));
    },
    async update(profileId, patch) {
      const profile = await store.update(profileId, patch);
      return profile === undefined ? undefined : publicConnectionProfile(profile);
    },
    async setEnabled(profileId, enabled) {
      const profile = await store.setEnabled(profileId, enabled);
      return profile === undefined ? undefined : publicConnectionProfile(profile);
    },
    async status(profileId) {
      const profile = await store.get(profileId);
      return profile === undefined ? undefined : statusOf(profile);
    },
    async inspect() {
      const profiles = await store.list();
      return Object.freeze({ profiles: Object.freeze(profiles.map((profile) => statusOf(profile))) });
    },
    connect,
    disconnect,
    reconnect,
    delete: deleteConnection,
  });
}
