import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { resolveProfileEnvironment } from '../../shared/runtime/connectionProfile.js';
import { createSshTransport } from './transports/sshTransport.js';
import { openRemoteRuntime } from './transports/remoteRuntimeClient.js';
import { createConnectionManager } from './transports/connectionManager.js';
import { objectFields } from '../../shared/runtime/capabilities.js';
import { createSlurmServices } from './transports/slurmServices.js';
import { buildResourcePreview, normalizeSlurmResources } from './transports/slurmJobs.js';
import { spawnSync } from 'node:child_process';
import { createRemoteCredentialResolver } from './transports/remoteCredentials.js';

/** Owns profile transports and the authenticated targets they actually reached. */
export function createRemoteServices(options = {}) {
  const targets = new Map(), handles = new Set(), opening = new Set();
  const targetProfiles = new Map();
  const nestedTargets = new Map();
  let refreshingTargets = false;
  const challenges = new Map();
  const slurm = options.slurm ?? createSlurmServices(options);
  const resolveCredential = options.resolveCredential ?? createRemoteCredentialResolver(options.stateRoot);
  const capabilities = Object.freeze({ direct: true,
    ssh: spawnSync('ssh', ['-V'], { stdio: 'ignore', timeout: 2000 }).status === 0,
    slurm: slurm.available === true,
  });
  let manager, closed = false;
  function respondChallenge(challenge) {
    if (options.respondChallenge) return options.respondChallenge(challenge);
    requireValue(challenges.size < 32, 'remote.challenges', 'source_unavailable');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        challenges.delete(challenge.challengeId);
        reject(new ProtocolError('timeout', 'remote.challenge'));
      }, 60000);
      challenges.set(challenge.challengeId, { challenge, resolve, reject, timer });
    });
  }
  async function openProfileTransport(profile) {
    const environmentId = resolveProfileEnvironment(profile);
    requireValue(!closed, 'remote.closed', 'cancelled');
    requireValue(!targets.has(environmentId) && !opening.has(environmentId), 'remote.target', 'conflict');
    opening.add(environmentId);
    let transport, client;
    try {
      const credentials = await resolveCredential(profile.credentialRef) ?? {};
      requireValue(!closed, 'remote.closed', 'cancelled');
      switch (profile.transport.kind) {
        case 'local': return { environmentId, connectionId: `local-${profile.profileId}` };
        case 'direct':
          client = await openRemoteRuntime({ endpoint: profile.transport.endpoint, environmentId, token: credentials.bridgeToken });
          break;
        case 'ssh': {
          const ssh = createSshTransport({ ...options.ssh, ...credentials.ssh,
            responder: challenge => respondChallenge({ profileId: profile.profileId, environmentId, ...challenge }),
            targetHello: async ({ host, port }) => {
              try {
                client = await openRemoteRuntime({ endpoint: `ws://${host}:${port}/runtime`, environmentId, token: credentials.bridgeToken });
                return { ok: true };
              } catch (error) {
                if (error.code === 'source_unavailable') return { ok: false, code: 'ECONNREFUSED' };
                throw error;
              }
            },
          });
          transport = await ssh.open(profile);
          break;
        }
        case 'slurm':
          requireValue(slurm.available, 'remote.slurm.login_service', 'source_unavailable');
          ({ transport, client } = await slurm.open(profile));
          break;
        default: throw new ProtocolError('unsupported', 'remote.transport');
      }
      requireValue(client?.hello.target === environmentId && client.grant.target === environmentId, 'remote.target', 'unauthorized');
      requireValue(!closed, 'remote.closed', 'cancelled');
      targets.set(environmentId, client);
      targetProfiles.set(environmentId, profile.profileId);
      let handleClosed = false;
      const closeListeners = new Set();
      const handle = { environmentId, connectionId: `${profile.transport.kind}-${profile.profileId}`,
        onClose(listener) { closeListeners.add(listener); if (handleClosed) listener(); },
        async close() {
        if (handleClosed) return;
        handleClosed = true; handles.delete(handle);
        if (targets.get(environmentId) === client) {
          targets.delete(environmentId);
          targetProfiles.delete(environmentId);
        }
        try { client.close(); await transport?.close(); }
        finally { for (const listener of closeListeners) listener(); }
      } };
      handles.add(handle);
      client.subscribe(event => { if (event.kind === 'closed') void handle.close().catch(error => options.onError?.(error)); });
      return Object.freeze(handle);
    } catch (error) { client?.close(); await transport?.close(); throw error; }
    finally { opening.delete(environmentId); }
  }
  function configureProfiles(store) {
    manager ??= createConnectionManager({ store, openTransport: openProfileTransport });
    return manager;
  }
  if (options.profileStore) configureProfiles(options.profileStore);
  async function profileFor(profileId, requireEnabled = true) {
    requireValue(manager, 'remote.profiles', 'source_unavailable');
    const profile = await manager.get(profileId);
    requireValue(profile && (!requireEnabled || profile.enabled), 'remote.profile', 'source_unavailable');
    return profile;
  }
  function cancelChallenges(profileId) {
    for (const [id, entry] of challenges) {
      if (entry.challenge.profileId !== profileId) continue;
      challenges.delete(id); clearTimeout(entry.timer); entry.reject(new ProtocolError('cancelled', 'remote.challenge'));
    }
  }
  async function refreshTargets() {
    if (refreshingTargets) return;
    refreshingTargets = true;
    try {
      for (const [target, nested] of nestedTargets) {
        if (targets.get(nested.parent.hello.target) !== nested.parent) nestedTargets.delete(target);
      }
      for (const parent of targets.values()) {
        if (parent.inspection.role !== 'manager' || !parent.attachTarget) continue;
        const inspection = await parent.request({ method: 'runtime.inspect', params: {} });
        const advertised = new Set(inspection.targets.map(grant => grant.target));
        for (const [target, nested] of nestedTargets) {
          if (nested.parent === parent && !advertised.has(target)) {
            nestedTargets.delete(target);
            await nested.client.close();
          }
        }
        for (const grant of inspection.targets) {
          if (targets.has(grant.target) || nestedTargets.has(grant.target)) continue;
          nestedTargets.set(grant.target, { parent, client: await parent.attachTarget(grant.target) });
        }
      }
    } finally { refreshingTargets = false; }
  }
  return Object.freeze({
    capabilities,
    openProfileTransport,
    getTarget: target => targets.get(target) ?? nestedTargets.get(target)?.client,
    listTargets: () => [...targets.values(), ...[...nestedTargets.values()].map(nested => nested.client)].map(client => client.grant),
    refreshTargets,
    configureProfiles,
    async read(operation, args) {
      switch (operation) {
        case 'capabilities': objectFields(args, []); return capabilities;
        case 'preview': objectFields(args, ['resources']); return buildResourcePreview(normalizeSlurmResources(args.resources));
        case 'identity': {
          objectFields(args, ['profileId']);
          const profile = await profileFor(args.profileId, false);
          if (!profile.enabled) return null;
          const environmentId = resolveProfileEnvironment(profile);
          const client = targetProfiles.get(environmentId) === profile.profileId ? targets.get(environmentId) : undefined;
          return client ? {
            environmentId: client.hello.target,
            instanceId: client.hello.instanceId,
            epoch: client.hello.epoch,
            generation: client.hello.generation,
          } : null;
        }
        case 'challenges': objectFields(args, ['profileId']); return [...challenges.values()].filter(entry => entry.challenge.profileId === args.profileId).map(entry => entry.challenge);
        case 'profiles': objectFields(args, []); requireValue(manager, 'remote.profiles', 'source_unavailable'); return manager.list();
        case 'status': objectFields(args, ['profileId']); requireValue(manager, 'remote.profiles', 'source_unavailable'); return manager.status(args.profileId);
        case 'jobs': objectFields(args, ['profileId']); return slurm.list(await profileFor(args.profileId, false));
        case 'job': objectFields(args, ['profileId', 'intentId']); return slurm.operate(await profileFor(args.profileId, false), 'state', args.intentId);
        default: throw new ProtocolError('unsupported', 'remote.operation');
      }
    },
    async mutate(operation, args) {
      requireValue(manager, 'remote.profiles', 'source_unavailable');
      switch (operation) {
        case 'respond': {
          objectFields(args, ['profileId', 'challengeId', 'answer']);
          const entry = challenges.get(args.challengeId);
          requireValue(entry && entry.challenge.profileId === args.profileId, 'remote.challenge', 'conflict');
          objectFields(args.answer, [], ['accept', 'persist', 'secret']);
          challenges.delete(args.challengeId); clearTimeout(entry.timer); entry.resolve(args.answer);
          return { answered: true };
        }
        case 'create': return manager.create(args);
        case 'update': objectFields(args, ['profileId', 'patch']); cancelChallenges(args.profileId); return manager.update(args.profileId, args.patch);
        case 'enable': objectFields(args, ['profileId', 'enabled']); if (!args.enabled) cancelChallenges(args.profileId); return manager.setEnabled(args.profileId, args.enabled);
        case 'submit': objectFields(args, ['profileId', 'deployment']); return slurm.submit(await profileFor(args.profileId), args.deployment);
        case 'borrow': objectFields(args, ['profileId', 'jobId', 'deployment']); return slurm.borrow(await profileFor(args.profileId), args.jobId, args.deployment);
        case 'reconcile': case 'detach': case 'stop': {
          objectFields(args, ['profileId', 'intentId']);
          const result = await slurm.operate(await profileFor(args.profileId), operation, args.intentId);
          if (operation === 'detach' || result.cancelled === true || result.terminal) await manager.disconnect(args.profileId);
          return result;
        }
        case 'connect': case 'reconnect': case 'disconnect': case 'delete':
          objectFields(args, ['profileId']);
          if (operation !== 'connect') cancelChallenges(args.profileId);
          return manager[operation](args.profileId);
        default: throw new ProtocolError('unsupported', 'remote.operation');
      }
    },
    async close() {
      closed = true;
      for (const entry of challenges.values()) { clearTimeout(entry.timer); entry.reject(new ProtocolError('cancelled', 'remote.closed')); }
      challenges.clear();
      const results = await Promise.allSettled([...handles].map(handle => handle.close()));
      try { await slurm.close(); } catch (error) { results.push({ status: 'rejected', reason: error }); }
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Remote service shutdown failed');
    },
  });
}
