import { legacyDigest } from './legacyExport';
import type { ImportBinding } from '../../../bridge/runtime/migration/importService.js';
export type LocalBindingHint = Readonly<{ sourceKey: string; kind?: 'composer' | 'question' | 'history' | 'metadata' | 'local'; nativeSessionId?: string; scopeFingerprint?: string }>;
export type ProvenMapping = ImportBinding & Readonly<{ scopeFingerprint?: string; evidence: 'endpoint' | 'user-confirmed' }>;
export type LegacyBinding = Readonly<{ kind: 'bound'; binding: ImportBinding }> | Readonly<{ kind: 'unattached'; sourceKey: string }>;
export function bindLegacySource(hint: LocalBindingHint, mappings: readonly ProvenMapping[]): LegacyBinding {
  const matches = hint.scopeFingerprint ? mappings.filter(mapping => mapping.scopeFingerprint === hint.scopeFingerprint
    && mapping.nativeSessionId === hint.nativeSessionId) : [];
  const unique = new Map(matches.map(mapping => [JSON.stringify([mapping.profileId, mapping.environmentId, mapping.harnessInstanceId, mapping.nativeSessionId]), mapping]));
  if (unique.size !== 1) return { kind: 'unattached', sourceKey: hint.sourceKey };
  const mapping = unique.values().next().value;
  if (!mapping) return { kind: 'unattached', sourceKey: hint.sourceKey };
  return { kind: 'bound', binding: { environmentId: mapping.environmentId, harnessInstanceId: mapping.harnessInstanceId, nativeSessionId: mapping.nativeSessionId, profileId: mapping.profileId } };
}

export async function describeLocalBinding(local: Readonly<{ key: string; namespace: string }>, sourceKey: string): Promise<LocalBindingHint> {
  if (local.key === 'opencode.drafts.composer.v1') return { sourceKey, kind: 'composer' };
  if (local.key === 'opencode.drafts.question.v1') return { sourceKey, kind: 'question' };
  let nativeSessionId: string | undefined;
  let scopeFingerprint: string | undefined;
  const scoped = /^opencode\.state\.backendHistory\.v1\.([a-f0-9]{32})\.(.+)$/u.exec(local.key);
  if (scoped) {
    try { nativeSessionId = decodeURIComponent(scoped[2]); } catch { return { sourceKey, kind: 'local' }; }
    scopeFingerprint = await legacyDigest('backend-history-v1:' + scoped[1]);
  } else if (local.namespace.startsWith('backend-history-v1:')) {
    try {
      const tuple: unknown = JSON.parse(local.key);
      if (Array.isArray(tuple) && tuple.length === 2 && typeof tuple[0] === 'string') {
        const scope = /^opencode\.state\.backendHistory\.v1\.([a-f0-9]{32})\.(.+)$/u.exec(tuple[0]);
        if (scope && local.namespace === 'backend-history-v1:' + scope[1]) nativeSessionId = decodeURIComponent(scope[2]);
      } else if (Array.isArray(tuple) && typeof tuple[2] === 'string') nativeSessionId = tuple[2];
    } catch { return { sourceKey, kind: 'local' }; }
    scopeFingerprint = await legacyDigest(local.namespace);
  }
  if (!nativeSessionId || nativeSessionId.length > 1024 || /[:@/?#]/u.test(nativeSessionId) || [...nativeSessionId].some(char => char.charCodeAt(0) < 32)) return { sourceKey, kind: 'local' };
  return { sourceKey, kind: 'history', nativeSessionId, scopeFingerprint };
}
