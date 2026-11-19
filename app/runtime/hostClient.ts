import { ProtocolError } from '../../shared/runtime/capabilities.js';
import type { HostReadCall, HostMutationCall } from '../../shared/runtime/hostWire.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';
import type { RuntimeClient } from './client';

export function createHostClient(client: RuntimeClient, target: EnvironmentId) {
  const scope = client.scope(target);

  function assertCurrent(): void {
    if (!scope.isCurrent()) throw new ProtocolError('reconcile_required', 'host.connection');
  }

  async function read<T>(call: HostReadCall, decode: (value: unknown) => T): Promise<T> {
    assertCurrent();
    const result = await client.request(target, 'runtime.host.read', call, { selectionCurrent: scope.isCurrent });
    assertCurrent();
    return decode(result);
  }

  function mutate<T>(call: HostMutationCall, decode: (value: unknown) => T, idempotencyKey: string) {
    assertCurrent();
    const operation = client.mutate(target, 'runtime.host.mutate', call, {
      idempotencyKey,
      selectionCurrent: scope.isCurrent,
    });
    const executed = operation.executed.then((result) => {
      assertCurrent();
      return decode(result.value);
    });
    void executed.catch(() => undefined);
    return { accepted: operation.accepted, executed };
  }

  function onChanged(listener: () => void): () => void {
    return client.onObserverDelivery((environment, delivery) => {
      if (environment !== target || !scope.isCurrent() || delivery === null) return;
      if (delivery.kind === 'replay_required') { listener(); return; }
      if (delivery.kind !== 'event' && delivery.kind !== 'control') return;
      const payload = delivery.frame.payload;
      if (payload !== null && typeof payload === 'object' && 'key' in payload &&
        typeof payload.key === 'string' && payload.key.startsWith('host:v1:')) listener();
    });
  }

  return { target, read, mutate, onChanged, isCurrent: scope.isCurrent };
}

export type HostClient = ReturnType<typeof createHostClient>;
