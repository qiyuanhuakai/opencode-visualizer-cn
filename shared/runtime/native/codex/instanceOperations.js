import { parseEnvironmentId, parseHarnessInstanceId, parseInstanceId } from '../../identity.js';
import { jsonValue, requireValue } from '../../capabilities.js';

/** Instance mutations have no SessionRef until native thread/start returns its real ID. */
export function createInstanceOperations({
  store,
  scope: input,
  isCurrent,
  fingerprint,
  newId,
  authorize = async () => {},
}) {
  const scope = Object.freeze({
    environmentId: parseEnvironmentId(input.environmentId),
    harnessInstanceId: parseHarnessInstanceId(input.harnessInstanceId),
    epoch: parseInstanceId(input.epoch),
    processGeneration: input.processGeneration,
  });
  requireValue(
    Number.isSafeInteger(scope.processGeneration) && scope.processGeneration > 0,
    'codex.instance.generation',
  );
  const prefix = `codex-instance:${fingerprint([scope.environmentId, scope.harnessInstanceId])}`;
  const leaseKey = `${prefix}:lease`;
  async function authority() {
    requireValue(isCurrent(scope), 'codex.instance.generation', 'reconcile_required');
    await authorize();
    const trusted = await store.ready;
    requireValue(
      trusted.environment === scope.environmentId,
      'codex.instance.store_target',
      'unauthorized',
    );
    requireValue(isCurrent(scope), 'codex.instance.generation', 'reconcile_required');
  }
  async function read(key) {
    await authority();
    const row = await store.getControl({ collection: 'operations', key });
    await authority();
    requireValue(!row?.chunked, 'codex.instance.record');
    return row;
  }
  function fence(row) {
    requireValue(
      row?.value?.kind === 'codex-instance-operation' &&
        fingerprint(row.value.scope) === fingerprint(scope),
      'codex.instance.scope',
      'reconcile_required',
    );
  }
  async function change({ key, prior, value, extra = [] }) {
    await authority();
    const ack = await store.mutateControl({
      intentId: newId(),
      changes: [
        { collection: 'operations', key, expectedRevision: prior?.revision ?? 0, value },
        ...extra,
      ],
    });
    await authority();
    return { key, revision: ack.revision - extra.length, value };
  }
  async function accept({ method, payload, idempotencyKey }) {
    requireValue(
      typeof idempotencyKey === 'string' &&
        idempotencyKey.length > 0 &&
        idempotencyKey.length <= 512,
      'codex.instance.idempotency',
    );
    requireValue(typeof method === 'string' && method.length < 256, 'codex.instance.method');
    const clean = jsonValue(payload),
      body = JSON.stringify(clean);
    requireValue(new TextEncoder().encode(body).length <= 1048576, 'codex.instance.payload');
    const operationId = `${prefix}:${fingerprint(idempotencyKey)}`;
    const digest = fingerprint({ method, payload: clean });
    let row = await read(operationId);
    if (!row) {
      try {
        row = await change({
          key: operationId,
          prior: null,
          value: {
            kind: 'codex-instance-operation',
            operationId,
            scope,
            method,
            digest,
            chunks: Math.ceil(body.length / 8192),
            phase: 'intent',
          },
        });
      } catch (error) {
        if (error?.code !== 'conflict') throw error;
        row = await read(operationId);
        if (!row) throw error;
      }
    }
    fence(row);
    requireValue(row.value.digest === digest, 'codex.instance.idempotency_mismatch', 'conflict');
    if (row.value.phase === 'intent') {
      for (let i = 0; i < row.value.chunks; i++) {
        await authority();
        await store.mutate({
          intentId: `${operationId}:body:${i}:${digest}`,
          changes: [
            {
              collection: 'operations',
              key: `${operationId}:body:${i}`,
              expectedRevision: 0,
              value: body.slice(i * 8192, (i + 1) * 8192),
            },
          ],
        });
        await authority();
      }
      try {
        row = await change({
          key: operationId,
          prior: row,
          value: { ...row.value, phase: 'accepted' },
        });
      } catch (error) {
        if (error?.code !== 'conflict') throw error;
        row = await read(operationId);
        fence(row);
      }
    }
    return { phase: 'durable-accepted', operationId };
  }
  async function execute(operationId, submit) {
    requireValue(
      typeof operationId === 'string' && operationId.startsWith(`${prefix}:`),
      'codex.instance.operation',
      'unauthorized',
    );
    let row = await read(operationId);
    fence(row);
    requireValue(
      row.value.phase === 'accepted',
      'codex.instance.phase',
      ['sent', 'reconciling'].includes(row.value.phase) ? 'reconcile_required' : 'conflict',
    );
    const lease = await read(leaseKey);
    requireValue(!lease?.value, 'codex.instance.busy', 'conflict');
    const chunks = [];
    for (let i = 0; i < row.value.chunks; i++) {
      const chunk = await store.get({ collection: 'operations', key: `${operationId}:body:${i}` });
      await authority();
      requireValue(
        typeof chunk?.value === 'string' && !chunk.chunked,
        'codex.instance.payload_missing',
        'reconcile_required',
      );
      chunks.push(chunk.value);
    }
    const payload = JSON.parse(chunks.join(''));
    requireValue(
      fingerprint({ method: row.value.method, payload }) === row.value.digest,
      'codex.instance.payload_corrupt',
      'reconcile_required',
    );
    row = await change({
      key: operationId,
      prior: row,
      value: { ...row.value, phase: 'sent' },
      extra: [
        {
          collection: 'operations',
          key: leaseKey,
          expectedRevision: lease?.revision ?? 0,
          value: { operationId },
        },
      ],
    });
    try {
      await authority();
      const result = await submit({ method: row.value.method, payload });
      await authority();
      row = await change({
        key: operationId,
        prior: row,
        value: { ...row.value, phase: 'observed' },
      });
      const held = await read(leaseKey);
      requireValue(
        held?.value?.operationId === operationId,
        'codex.instance.lease',
        'reconcile_required',
      );
      await change({
        key: operationId,
        prior: row,
        value: { ...row.value, phase: 'terminal', outcome: 'completed' },
        extra: [
          { collection: 'operations', key: leaseKey, expectedRevision: held.revision, value: null },
        ],
      });
      return { phase: 'native-executed', operationId, result };
    } catch (error) {
      // Losing authority leaves the durable sent/observed fence intact; no native retry is safe.
      if (isCurrent(scope)) {
        const latest = await read(operationId);
        if (latest?.value?.phase !== 'terminal')
          await change({
            key: operationId,
            prior: latest,
            value: { ...latest.value, phase: 'reconciling' },
          });
      }
      throw error;
    }
  }
  return {
    accept,
    execute,
    async get(id) {
      const row = await read(id);
      fence(row);
      return row.value;
    },
  };
}
