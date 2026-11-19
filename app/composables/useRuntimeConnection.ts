import { getCurrentScope, onScopeDispose, readonly, shallowRef } from 'vue';
import type { PublicConnectionReference } from '../../shared/runtime/runtimeWire.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { createRuntimeClient } from '../runtime/client';
import { createRuntimeConnection, type RuntimeConnectionOptions, type RuntimeConnectionStatus } from '../runtime/connection';
import { adoptConnectionReference, connectionError, parseConnectionReference, RuntimeConnectionError } from '../runtime/connectionProfile';
import { createPendingSelection, type RuntimeSelection } from '../runtime/pendingSelection';

export function useRuntimeConnection(options: RuntimeConnectionOptions & Readonly<{ selection?: RuntimeSelection }>) {
  const selectedReference = parseConnectionReference(options.reference);
  const connection = createRuntimeConnection({ ...options, reference: selectedReference });
  const client = createRuntimeClient({ connection });
  const status = shallowRef<RuntimeConnectionStatus>(connection.status);
  const reference = shallowRef<PublicConnectionReference | null>(null);
  const pendingSelection = options.selection ? createPendingSelection(options.selection) : undefined;
  const selection = shallowRef(pendingSelection?.state ?? null);
  let disposed = false;
  let provenReference: PublicConnectionReference | undefined;
  let revision = 0;
  let verified: Promise<PublicConnectionReference> | undefined;
  const unsubscribe = connection.subscribe(event => {
    status.value = connection.status;
    switch (event.kind) {
      case 'hello': {
        const current = ++revision;
        reference.value = null;
        pendingSelection?.suspend(); selection.value = pendingSelection?.state ?? null;
        verified = client.inspect().then(inspection => {
          if (disposed || revision !== current || connection.status.generation !== event.generation || connection.status.state !== 'ready') throw new RuntimeConnectionError('cancelled');
          const adopted = adoptConnectionReference(provenReference ?? selectedReference, event.hello, inspection);
          provenReference = adopted;
          reference.value = adopted; return adopted;
        }).catch(error => {
          const safe = connectionError(error);
          if (!disposed && revision === current) {
            connection.disconnect();
            status.value = { state: 'error', generation: connection.status.generation, error: { code: safe.code, message: safe.message } };
          }
          throw safe;
        });
        void verified.catch(() => undefined);
        break;
      }
      case 'disconnected':
        revision += 1; reference.value = null; pendingSelection?.suspend(); selection.value = pendingSelection?.state ?? null;
        break;
      case 'error':
      case 'frame':
      case 'binary': break;
      default: { const unreachable: never = event; throw unreachable; }
    }
  });
  function dispose() {
    if (disposed) return;
    disposed = true; revision += 1;
    client.dispose(); connection.dispose(); unsubscribe();
    reference.value = null; status.value = connection.status;
  }
  if (getCurrentScope()) onScopeDispose(dispose);
  return {
    connection, client, status: readonly(status), reference: readonly(reference), selection: readonly(selection),
    async connect(): Promise<PublicConnectionReference> {
      const opening = connection.connect(); status.value = connection.status;
      await opening;
      if (!verified || disposed) throw new RuntimeConnectionError('cancelled');
      return verified;
    },
    disconnect() { connection.disconnect(); status.value = connection.status; },
    resolveSelection(sessions: readonly SessionRef[], complete = false) {
      if (pendingSelection) selection.value = pendingSelection.reconcile({ reference: reference.value, sessions, complete });
      return selection.value;
    },
    dispose,
  };
}
