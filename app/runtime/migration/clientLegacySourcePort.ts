import type { SessionDatabaseApi } from '../../types/sessionDatabase';
import type { LegacySourcePort } from './sourceArchive';
import { legacyDigest } from './legacyExport';
import type { LegacyExportChunk, LegacyExportToken } from './legacyExport';
import { LegacyExportError } from '../../../shared/runtime/migration/streamingJson.js';

export type DesktopLegacyApi = Pick<SessionDatabaseApi, 'exportOpen' | 'exportPage' | 'exportBinding'>;

function validToken(token: LegacyExportToken): boolean {
  return token?.version === 1 && /^[a-f0-9]{64}$/u.test(token.revision)
    && [token.offset, token.count, token.records, token.exportableRecords, token.localOnlyRecords].every(value => Number.isSafeInteger(value) && value >= 0)
    && token.offset <= token.count && token.records === token.exportableRecords + token.localOnlyRecords;
}

export function createClientLegacySourcePort(browser: LegacySourcePort, desktop?: DesktopLegacyApi | null): LegacySourcePort {
  if (desktop === undefined) return browser;
  if (!desktop?.exportOpen || !desktop.exportPage || !desktop.exportBinding) throw new LegacyExportError('source_unavailable');
  const sources: readonly LegacySourcePort[] = [browser, {
    open: desktop.exportOpen.bind(desktop),
    page: desktop.exportPage.bind(desktop),
    binding: sourceKey => desktop.exportBinding!({ sourceKey }),
  }];
  // Binding is normally requested for the page just read. Retain at most one
  // maximum-sized page; serialized cursors do not depend on this cache.
  const owners = new Map<string, number>();
  async function snapshot() {
    const results = await Promise.allSettled(sources.map(source => source.open()));
    const children: LegacyExportToken[] = [];
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      children.push(result.value);
    }
    if (children.some(token => !validToken(token) || token.offset !== 0)) throw new LegacyExportError('corrupt_source');
    const token: LegacyExportToken = {
      version: 1, revision: await legacyDigest(JSON.stringify(children)), offset: 0,
      count: children.reduce((sum, child) => sum + child.count, 0),
      records: children.reduce((sum, child) => sum + child.records, 0),
      exportableRecords: children.reduce((sum, child) => sum + child.exportableRecords, 0),
      localOnlyRecords: children.reduce((sum, child) => sum + child.localOnlyRecords, 0),
    };
    if (!validToken(token)) throw new LegacyExportError('corrupt_source');
    return { token, children };
  }
  return {
    open: async () => (await snapshot()).token,
    async page({ token, limit = 100 }) {
      if (!validToken(token) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new LegacyExportError('invalid_cursor');
      const current = await snapshot();
      if (current.token.revision !== token.revision || ['count', 'records', 'exportableRecords', 'localOnlyRecords'].some(key => current.token[key as keyof LegacyExportToken] !== token[key as keyof LegacyExportToken])) throw new LegacyExportError('source_changed');
      const chunks: LegacyExportChunk[] = [];
      const pageOwners = new Map<string, number>();
      let base = 0, offset = token.offset, remaining = limit;
      for (const [index, child] of current.children.entries()) {
        if (offset < base + child.count && remaining > 0) {
          const localOffset = offset - base;
          const size = Math.min(remaining, child.count - localOffset);
          const page = await sources[index]!.page({ token: { ...child, offset: localOffset }, limit: size });
          const expectedNext = localOffset + size < child.count ? localOffset + size : null;
          if (page.revision !== child.revision || (page.next?.offset ?? null) !== expectedNext || page.next && page.next.revision !== child.revision || page.chunks.length > size) throw new LegacyExportError('source_changed');
          for (const chunk of page.chunks) {
            if (pageOwners.has(chunk.sourceKey) && pageOwners.get(chunk.sourceKey) !== index) throw new LegacyExportError('corrupt_source');
            pageOwners.set(chunk.sourceKey, index);
            chunks.push(chunk);
          }
          offset += size; remaining -= size;
        }
        base += child.count;
      }
      // A source outside this page may also change while its sibling is read.
      if ((await snapshot()).token.revision !== token.revision) throw new LegacyExportError('source_changed');
      for (const [sourceKey, owner] of pageOwners) {
        owners.delete(sourceKey); owners.set(sourceKey, owner);
        while (owners.size > 200) owners.delete(owners.keys().next().value!);
      }
      return { revision: token.revision, chunks, next: offset < token.count ? { ...token, offset } : null };
    },
    async binding(sourceKey) {
      const owner = owners.get(sourceKey);
      if (owner !== undefined) return sources[owner]!.binding(sourceKey);
      for (const source of sources) {
        try { return await source.binding(sourceKey); }
        catch (error) {
          if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'source_changed') throw error;
        }
      }
      throw new LegacyExportError('source_changed');
    },
  };
}
