import type { LegacyExportPage, LegacyExportToken, LegacyPageRequest } from './legacyExport';
import { openLegacyExport, readLegacyExportPage, resolveLegacyLocalBinding } from './legacyExport';
import type { LegacySource } from './legacyExport';
import { legacyDigest } from './legacyExport';
import type { LegacySourcePort } from './sourceArchive';
import type { LocalBindingHint } from './legacyBinding';

/**
 * Task 24 — adapt a browser `LegacySource` (an async iterable of pieces) onto
 * the `LegacySourcePort` the import coordinator and archive consume.
 *
 * The browser source streams every legacy piece exactly once; the port needs
 * random access over that stream. The adapter materialises the stream into
 * paged chunks keyed by the export revision, so the coordinator can open,
 * page and re-open the same source without a second pass over IndexedDB or
 * localStorage. Nothing is written: the source stays read-only and the legacy
 * original is never mutated.
 */
export function createBrowserLegacySourcePort(source: LegacySource): LegacySourcePort {
  let token: LegacyExportToken | null = null;
  const chunks = new Map<string, string>();
  const endings = new Set<string>();

  async function materialise(): Promise<LegacyExportToken> {
    if (token) return token;
    const opened = await openLegacyExport(source);
    token = opened;
    let request: LegacyPageRequest | null = { token: opened };
    while (request) {
      const page: LegacyExportPage = await readLegacyExportPage(source, request);
      for (const chunk of page.chunks) {
        chunks.set(chunk.sourceKey, (chunks.get(chunk.sourceKey) ?? '') + chunk.content);
        if (chunk.end) endings.add(chunk.sourceKey);
      }
      request = page.next ? { token: page.next } : null;
    }
    return opened;
  }

  return {
    async open(): Promise<LegacyExportToken> {
      return materialise();
    },
    async page(request: LegacyPageRequest): Promise<LegacyExportPage> {
      const current = await materialise();
      if (request.token.revision !== current.revision) {
        throw new TypeError('source_changed');
      }
      const remaining = [...chunks.keys()].slice(request.token.offset, request.token.offset + 8);
      const nextOffset = request.token.offset + remaining.length;
      return {
        revision: current.revision,
        chunks: remaining.map((sourceKey) => ({
          source: sourceKey,
          sourceKey,
          namespace: 'unattached-legacy-local',
          ownership: 'unattached-legacy-local' as const,
          authority: 'indexeddb',
          offset: request.token.offset,
          content: chunks.get(sourceKey) ?? '',
          end: endings.has(sourceKey),
          checksum: '',
        })),
        next: nextOffset < chunks.size ? { ...current, offset: nextOffset } : null,
      };
    },
    async binding(sourceKey: string): Promise<LocalBindingHint> {
      const resolved = await resolveLegacyLocalBinding(source, sourceKey);
      return describeBinding(resolved);
    },
  };
}

async function describeBinding(local: Readonly<{ key: string; source: string; namespace: string }>): Promise<LocalBindingHint> {
  return {
    sourceKey: local.key,
    ...(local.namespace.startsWith('backend-history-v1:')
      ? { kind: 'history' as const, scopeFingerprint: await legacyDigest(local.namespace) }
      : { kind: 'local' as const }),
  };
}
