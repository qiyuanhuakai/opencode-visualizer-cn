import { requireValue } from '../../../shared/runtime/capabilities.js';
import type { HostMutationCall } from '../../../shared/runtime/hostWire.js';
import type { EnvironmentId } from '../../../shared/runtime/identity.js';
import type { Ack } from '../../../bridge/runtime/storage/runtimeStore.js';
import type { ImportService } from '../../../bridge/runtime/migration/importService.js';
import type { RuntimeClient } from '../client';
import { createHostClient } from '../hostClient';
import { legacyDigest } from './legacyExport';

function decodeAck(value: unknown): Ack {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'migration.receipt');
  const row = Object.fromEntries(Object.entries(value));
  requireValue(row.phase === 'durable-accepted' && typeof row.intentId === 'string' && row.intentId.length > 0, 'migration.receipt');
  requireValue(typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision > 0 && typeof row.watermark === 'number' && Number.isSafeInteger(row.watermark) && row.watermark >= 0, 'migration.receipt');
  return { phase: 'durable-accepted', intentId: row.intentId, revision: row.revision, watermark: row.watermark };
}
export function createBridgeImportService(client: RuntimeClient, environmentId: EnvironmentId): ImportService {
  const host = createHostClient(client, environmentId);
  async function invoke(call: Extract<HostMutationCall, { domain: 'migration' }>): Promise<Ack> {
    const idempotencyKey = `migration:${call.operation}:${await legacyDigest(JSON.stringify(call.args))}`;
    const mutation = host.mutate(call, decodeAck, idempotencyKey);
    void mutation.accepted.catch(() => undefined);
    return mutation.executed;
  }
  return { accept: args => invoke({ domain: 'migration', operation: 'accept', args }), verify: args => invoke({ domain: 'migration', operation: 'verify', args }) };
}
