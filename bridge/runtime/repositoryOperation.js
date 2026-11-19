import { randomUUID } from 'node:crypto';
import {
  decodeRepoKey,
  encodeWorkspaceKey,
  parseWorkspaceRef,
} from '../../shared/runtime/identity.js';
import { requireValue, textValue, jsonValue } from '../../shared/runtime/capabilities.js';
import { fingerprint } from './operationJournal.js';
import { createWorktreeLease, leaseKey } from './worktreeLease.js';

export function createRepositoryOperation({ store, assertCurrent }) {
  const leases = createWorktreeLease({ store });
  async function read(id) {
    const item = await store.getControl({ collection: 'operations', key: id });
    requireValue(item?.value?.kind === 'repository-operation', 'git.operation');
    return item;
  }
  async function change(id, prior, value, changes = []) {
    await store.mutateControl({
      intentId: randomUUID(),
      changes: [
        { collection: 'operations', key: id, expectedRevision: prior.revision, value },
        ...changes,
      ],
    });
    return value;
  }
  async function fence(value) {
    assertCurrent();
    const state = await store.ready;
    requireValue(
      state.environment === value.workspace.environmentId && state.epoch === value.epoch,
      'git.operation_target',
      'reconcile_required',
    );
  }
  // The request identity is what the caller chose: the repository, the workspace it
  // names, the method and its payload. A server-derived base commit is deliberately
  // excluded - re-resolving the source HEAD on a retry must not change the identity
  // of a request the caller repeated verbatim.
  async function identity({ repoKey, workspace: input, idempotencyKey, method, payload }) {
    const workspace = parseWorkspaceRef(input);
    const repo = decodeRepoKey(repoKey);
    requireValue(
      repo.environmentId === workspace.environmentId,
      'git.repo_target',
      'unauthorized',
    );
    textValue(idempotencyKey, 'git.idempotency');
    textValue(method, 'git.method');
    const body = jsonValue(payload);
    requireValue(Buffer.byteLength(JSON.stringify(body)) <= 65536, 'git.payload_size');
    return {
      workspace,
      body,
      digest: fingerprint({ repoKey, workspace, method, payload: body }),
      operationId: `git-op:${fingerprint([repoKey, idempotencyKey])}`,
    };
  }
  return {
    leases,
    async lookup({ repoKey, workspace, idempotencyKey, method, payload }) {
      const { digest, operationId } = await identity({
        repoKey,
        workspace,
        idempotencyKey,
        method,
        payload,
      });
      const prior = await store.getControl({ collection: 'operations', key: operationId });
      if (!prior?.value) return null;
      requireValue(prior.value.digest === digest, 'git.idempotency_mismatch', 'conflict');
      return prior.value;
    },
    async accept({ repoKey, workspace: input, idempotencyKey, method, payload, baseCommit }) {
      const { workspace, body, digest, operationId } = await identity({
        repoKey,
        workspace: input,
        idempotencyKey,
        method,
        payload,
      });
      const state = await store.ready;
      const workspaceKey = encodeWorkspaceKey(workspace);
      const value = {
        kind: 'repository-operation',
        operationId,
        repoKey,
        workspace,
        workspaceKey,
        epoch: state.epoch,
        method,
        payload: body,
        baseCommit,
        digest,
        phase: 'accepted',
      };
      await fence(value);
      const prior = await store.getControl({ collection: 'operations', key: operationId });
      if (prior?.value) {
        requireValue(prior.value.digest === digest, 'git.idempotency_mismatch', 'conflict');
        return { phase: 'durable-accepted', operationId };
      }
      const claims = await leases.claimChanges([repoKey, workspaceKey], operationId, baseCommit);
      await store.mutateControl({
        intentId: randomUUID(),
        changes: [
          { collection: 'operations', key: operationId, expectedRevision: 0, value },
          ...claims,
        ],
      });
      return { phase: 'durable-accepted', operationId };
    },
    async launch(id, send) {
      const prior = await read(id);
      await fence(prior.value);
      requireValue(prior.value.phase === 'accepted', 'git.operation_phase', 'reconcile_required');
      const sent = await change(id, prior, { ...prior.value, phase: 'sent' });
      try {
        await fence(sent);
        return await send(sent);
      } catch (error) {
        await this.reconcile(id);
        throw error;
      }
    },
    async observed(id) {
      const prior = await read(id);
      await fence(prior.value);
      requireValue(prior.value.phase === 'sent', 'git.operation_phase', 'reconcile_required');
      return change(id, prior, { ...prior.value, phase: 'observed' });
    },
    async terminal(id, outcome, retainWorkspace = false) {
      requireValue(['completed', 'failed', 'cancelled'].includes(outcome), 'git.outcome');
      const prior = await read(id);
      await fence(prior.value);
      requireValue(
        ['accepted', 'sent', 'observed', 'reconciling'].includes(prior.value.phase),
        'git.operation_phase',
        'conflict',
      );
      const changes = [];
      for (const resource of [prior.value.repoKey, prior.value.workspaceKey]) {
        const lease = await leases.read(resource);
        requireValue(lease?.value?.owner === id, 'git.lease_owner', 'conflict');
        changes.push({
          collection: 'operations',
          key: leaseKey(resource),
          expectedRevision: lease.revision,
          value:
            retainWorkspace && resource === prior.value.workspaceKey
              ? { ...lease.value, purpose: 'writer' }
              : null,
        });
      }
      return change(id, prior, { ...prior.value, phase: 'terminal', outcome }, changes);
    },
    async reconcile(id) {
      const prior = await read(id);
      return prior.value.phase === 'terminal'
        ? prior.value
        : change(id, prior, { ...prior.value, phase: 'reconciling' });
    },
    async get(id) {
      return (await read(id)).value;
    },
  };
}
