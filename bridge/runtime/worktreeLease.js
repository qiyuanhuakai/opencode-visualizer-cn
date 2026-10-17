import { randomUUID } from 'node:crypto';
import { requireValue } from '../../shared/runtime/capabilities.js';
import { decodeRepoKey, decodeWorkspaceKey } from '../../shared/runtime/identity.js';

export function leaseKey(resource) {
  try {
    decodeRepoKey(resource);
  } catch {
    decodeWorkspaceKey(resource);
  }
  return `git-lease:${resource}`;
}
export function createWorktreeLease({ store }) {
  async function read(resource) {
    const key = leaseKey(resource);
    let ref;
    try {
      ref = decodeRepoKey(resource);
    } catch {
      ref = decodeWorkspaceKey(resource);
    }
    requireValue(
      ref.environmentId === (await store.ready).environment,
      'git.lease_target',
      'unauthorized',
    );
    return store.getControl({ collection: 'operations', key });
  }
  async function claimChanges(resources, owner, baseCommit = null) {
    const changes = [];
    for (const resource of new Set(resources)) {
      const prior = await read(resource);
      requireValue(!prior?.value, 'git.leased', 'conflict');
      changes.push({
        collection: 'operations',
        key: leaseKey(resource),
        expectedRevision: prior?.revision ?? 0,
        value: { kind: 'git-lease', owner, resource, baseCommit, purpose: 'operation' },
      });
    }
    return changes;
  }
  return {
    read,
    claimChanges,
    async acquire(resource, owner, baseCommit) {
      requireValue(typeof owner === 'string' && owner.length > 0, 'git.lease_owner');
      await store.mutateControl({
        intentId: randomUUID(),
        changes: (await claimChanges([resource], owner, baseCommit)).map((change) => ({
          ...change,
          value: { ...change.value, purpose: 'writer' },
        })),
      });
    },
    async release(resource, owner) {
      const prior = await read(resource);
      requireValue(prior?.value?.owner === owner, 'git.lease_owner', 'conflict');
      requireValue(prior.value.purpose === 'writer', 'git.operation_lease', 'conflict');
      await store.mutateControl({
        intentId: randomUUID(),
        changes: [
          {
            collection: 'operations',
            key: leaseKey(resource),
            expectedRevision: prior.revision,
            value: null,
          },
        ],
      });
    },
  };
}
