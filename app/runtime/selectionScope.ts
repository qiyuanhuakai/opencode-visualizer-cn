import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, SessionRef } from '../../shared/runtime/identity.js';
import type { RuntimeClient, RuntimeScope } from './client';

export type QualifiedSession = Readonly<{ profileId: ConnectionProfileId; session: SessionRef }>;
export type SelectionCapture = Readonly<{
  selection: QualifiedSession;
  selectionGeneration: number;
  clientScope: RuntimeScope;
  signal: AbortSignal;
  isCurrent(): boolean;
}>;

export function createSelectionScope({ client, profileId }: Readonly<{
  client: Pick<RuntimeClient, 'scope' | 'onDetach'>;
  profileId: ConnectionProfileId;
}>) {
  parseConnectionProfileId(profileId);
  let generation = 0;
  let selected: SelectionCapture | null = null;
  let controller: AbortController | undefined;
  let disposed = false;
  function invalidate() {
    generation++;
    selected = null;
    controller?.abort(); controller = undefined;
  }
  function isCurrent(capture: SelectionCapture): boolean {
    if (disposed || capture !== selected || capture.selectionGeneration !== generation || capture.signal.aborted || !capture.clientScope.isCurrent()) return false;
    try {
      const current = client.scope(capture.selection.session.environmentId);
      const previous = capture.clientScope;
      return current.isCurrent() && current.generation === previous.generation
        && current.binding.target === previous.binding.target
        && current.binding.epoch === previous.binding.epoch
        && current.binding.generation === previous.binding.generation;
    } catch (error) {
      if (error instanceof ProtocolError) return false;
      throw error;
    }
  }
  const unsubscribe = client.onDetach(target => { if (selected?.selection.session.environmentId === target) invalidate(); });
  return {
    select(session: SessionRef | null): SelectionCapture | null {
      requireValue(!disposed, 'selection.disposed', 'cancelled');
      invalidate();
      if (session === null) return null;
      const identity = Object.freeze({ ...parseSessionRef(session) });
      const scope = client.scope(identity.environmentId);
      const clientScope = Object.freeze({ ...scope, binding: Object.freeze({ ...scope.binding }) });
      controller = new AbortController();
      const capture: SelectionCapture = Object.freeze({
        selection: Object.freeze({ profileId, session: identity }), selectionGeneration: generation,
        clientScope, signal: controller.signal, isCurrent: () => isCurrent(capture),
      });
      selected = capture;
      return capture;
    },
    capture: () => selected && isCurrent(selected) ? selected : null,
    isCurrent,
    dispose() { if (disposed) return; disposed = true; invalidate(); unsubscribe(); },
  };
}
