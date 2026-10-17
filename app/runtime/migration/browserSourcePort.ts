import type { LegacyExportChunk, LegacyExportPage, LegacyExportToken, LegacyPageRequest } from './legacyExport';
import { openLegacyExport, readLegacyExportPage, resolveLegacyLocalBinding } from './legacyExport';
import type { LegacySource } from './legacyExport';
import type { LegacySourcePort } from './sourceArchive';
import { describeLocalBinding, type LocalBindingHint } from './legacyBinding';

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
  const chunks: LegacyExportChunk[] = [];

  async function materialise(): Promise<LegacyExportToken> {
    if (token) return token;
    const opened = await openLegacyExport(source);
    token = opened;
    let request: LegacyPageRequest | null = { token: opened };
    while (request) {
      const page: LegacyExportPage = await readLegacyExportPage(source, request);
      for (const chunk of page.chunks) chunks.push(chunk);
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
      // Serve the source's own chunks unchanged: the archive verifies each
      // chunk's `checksum` against `legacyDigest(chunk.content)` and relies on
      // the original `namespace`/`authority`/`offset`/`end` fields. Re-deriving
      // them here (or emitting an empty checksum) fails any non-empty source.
      const limit = request.limit ?? 8;
      const remaining = chunks.slice(request.token.offset, request.token.offset + limit);
      const nextOffset = request.token.offset + remaining.length;
      return {
        revision: current.revision,
        chunks: remaining,
        next: nextOffset < chunks.length ? { ...current, offset: nextOffset } : null,
      };
    },
    async binding(sourceKey: string): Promise<LocalBindingHint> {
      // `resolveLegacyLocalBinding` yields exactly the `{ key, namespace }` shape
      // `describeLocalBinding` consumes, so the port classifies a legacy key with
      // the SAME describer the rest of the pipeline uses. `bindLegacySource`
      // matches a proven mapping on `scopeFingerprint` AND `nativeSessionId`, so
      // dropping either silently detaches every history record from its target.
      const resolved = await resolveLegacyLocalBinding(source, sourceKey);
      return describeLocalBinding(resolved, sourceKey);
    },
  };
}
