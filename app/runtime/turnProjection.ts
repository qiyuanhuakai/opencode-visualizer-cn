import { shallowReactive } from 'vue';
import { requireValue } from '../../shared/runtime/capabilities.js';
import { encodeSessionKey, parseSessionRef, type SessionRef } from '../../shared/runtime/identity.js';
import type { CanonicalEntity } from '../../shared/runtime/runtimeWire.js';

export function createRuntimeTurnProjection() {
  const active = shallowReactive(new Map<string, Readonly<{ operationId: string; revision: number; phase: string }>>());
  const revisions = new Map<string, number>();
  let bytes = 0;
  const cost = (key: string, id: string) => (key.length + id.length) * 2 + 192;
  function apply(row: CanonicalEntity) {
    if (row.collection !== 'operations' || row.revision <= (revisions.get(row.key) ?? 0)) return;
    const value = row.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value) || !['operation', 'acp-operation'].includes(String(value.kind)) || !('method' in value) || !['send', 'turn/start', 'session/prompt'].includes(String(value.method)) || !('scope' in value)) return;
    const scope = value.scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !('session' in scope)) return;
    const session = parseSessionRef(scope.session), key = encodeSessionKey(session);
    const phase = 'phase' in value ? String(value.phase) : '';
    revisions.delete(row.key); revisions.set(row.key, row.revision);
    while (revisions.size > 4096) { const oldest = revisions.keys().next().value; if (oldest === undefined) break; revisions.delete(oldest); }
    const prior = active.get(key);
    if (phase === 'terminal') {
      if (prior?.operationId === row.key) { active.delete(key); bytes -= cost(key, row.key); }
      return;
    }
    if (!['accepted', 'sent', 'observed', 'reconciling'].includes(phase) || prior && prior.revision > row.revision) return;
    if (prior && prior.operationId !== row.key && phase === 'accepted') return;
    const nextBytes = bytes - (prior ? cost(key, prior.operationId) : 0) + cost(key, row.key);
    requireValue(nextBytes <= 1048576 && (prior !== undefined || active.size < 2048), 'runtime.turn_budget', 'source_unavailable');
    active.set(key, Object.freeze({ operationId: row.key, revision: row.revision, phase })); bytes = nextBytes;
  }
  return {
    apply,
    get: (session: SessionRef | null) => session ? active.get(encodeSessionKey(session)) ?? null : null,
    activity(session: SessionRef, summary?: Readonly<{ key: string; status: string | null }> | null) {
      const key = encodeSessionKey(session), owned = active.has(key);
      return { busy: owned || summary?.key === key && ['busy', 'running', 'retry'].includes(summary.status ?? ''), cancellable: owned };
    },
    clear() { active.clear(); revisions.clear(); bytes = 0; },
    usage: () => ({ bytes, active: active.size, revisions: revisions.size }),
  };
}
