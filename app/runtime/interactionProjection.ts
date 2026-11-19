import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { encodeSessionKey, parseSessionRef } from '../../shared/runtime/identity.js';
import type { HarnessKind } from '../../shared/runtime/harnessContract.js';
import type { CanonicalEntity } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeClient } from './client';
import type { SelectionCapture } from './selectionScope';
import { projectNativeInteraction } from './nativeInteractions';
import type { NativeInteractionView } from './nativeInteractions';

export function createInteractionProjection(options: {
  client: RuntimeClient;
  capture(): SelectionCapture | null;
  kind(): HarnessKind;
  show(view: NativeInteractionView, capture: SelectionCapture, interactionId: string): void;
  remove(id: string): void;
  error(message: string): void;
}) {
  const pending = new Map<string, CanonicalEntity>();
  const displayed = new Map<string, string>();
  const revisions = new Map<string, number>();
  let revision = 0, closed = false;
  function clear() { revision++; for (const id of displayed.values()) options.remove(id); displayed.clear(); }
  function matches(row: CanonicalEntity, capture: SelectionCapture) {
    const value = row.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('scope' in value)) return false;
    const scope = value.scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !('session' in scope)) return false;
    return encodeSessionKey(parseSessionRef(scope.session)) === encodeSessionKey(capture.selection.session);
  }
  async function show(row: CanonicalEntity, capture: SelectionCapture, current: number) {
    if (!matches(row, capture)) return;
    const detail = await options.client.request(capture.selection.session.environmentId, 'runtime.interaction.read', {
      session: capture.selection.session, interactionId: row.key,
    }, { signal: capture.signal, selectionCurrent: capture.isCurrent });
    if (closed || current !== revision || !capture.isCurrent() || pending.get(row.key) !== row) return;
    if (detail.phase !== 'pending') { pending.delete(row.key); const id = displayed.get(row.key); if (id) options.remove(id); displayed.delete(row.key); return; }
    const view = projectNativeInteraction(options.kind(), detail.session, row.key, detail.payload);
    displayed.set(row.key, view.id); options.show(view, capture, row.key);
  }
  function report(error: unknown) {
    if (closed || (error instanceof ProtocolError && ['cancelled', 'reconcile_required'].includes(error.code))) return;
    options.error(error instanceof Error ? error.message : String(error));
  }
  async function apply(row: CanonicalEntity) {
    if (closed || row.collection !== 'interactions' || row.revision < (revisions.get(row.key) ?? 0)) return;
    const value = row.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value) || !['interaction', 'acp-interaction'].includes(String(value.kind))) return;
    revisions.set(row.key, row.revision);
    if (value.phase !== 'pending') {
      pending.delete(row.key); const id = displayed.get(row.key); if (id) options.remove(id); displayed.delete(row.key);
    } else {
      requireValue(pending.has(row.key) || pending.size < 256, 'interaction.pending_budget', 'source_unavailable');
      pending.set(row.key, row);
      const capture = options.capture(); if (capture) await show(row, capture, revision);
    }
    while (revisions.size > 512) { const key = revisions.keys().next().value; if (key === undefined) break; revisions.delete(key); }
  }
  const unsubscribe = options.client.onObserverDelivery((target, delivery) => {
    if (!delivery || !('frame' in delivery) || delivery.frame.type !== 'entity.patch') return;
    const payload = delivery.frame.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('collection' in payload) || payload.collection !== 'interactions') return;
    void options.client.request(target, 'runtime.entity.resolve', { event: delivery.frame }).then(apply).catch(report);
  });
  return {
    observeOperation(row: CanonicalEntity) {
      const value = row.value;
      if (row.collection !== 'operations' || !value || typeof value !== 'object' || Array.isArray(value) || !('phase' in value) || value.phase !== 'terminal') return;
      for (const [key, interaction] of pending) {
        const metadata = interaction.value;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('parentOperationId' in metadata) || metadata.parentOperationId !== row.key) continue;
        pending.delete(key);
        const id = displayed.get(key); if (id) options.remove(id); displayed.delete(key);
      }
    },
    async start(target: Parameters<RuntimeClient['readIndex']>[0]) {
      await options.client.readIndex(target, 'interactions', { onPage: async (_, page) => {
        for (const row of page.items) {
          requireValue(row !== null && typeof row === 'object' && !Array.isArray(row) && 'key' in row && typeof row.key === 'string' && 'revision' in row && typeof row.revision === 'number', 'interaction.index_row');
          await apply({ key: row.key, revision: row.revision, collection: 'interactions', ...('value' in row ? { value: row.value } : {}) });
        }
      } });
    },
    async select() {
      clear(); const capture = options.capture(), current = revision;
      if (!capture) return;
      for (const row of pending.values()) { if (!capture.isCurrent() || current !== revision) return; await show(row, capture, current).catch(report); }
    },
    dispose() { closed = true; unsubscribe(); clear(); pending.clear(); revisions.clear(); },
  };
}
