import type { LegacySourcePort } from './sourceArchive';
import type { LegacyExportToken } from './legacyExport';
import type { LocalBindingHint } from './legacyBinding';
export type BrowserInventoryEntry = LocalBindingHint & { source: string; bytes: number };
export async function readBrowserInventory(source: LegacySourcePort, start?: LegacyExportToken): Promise<{
  revision: string; sources: BrowserInventoryEntry[]; next: LegacyExportToken | null;
}> {
  const token = start ?? await source.open();
  let cursor: LegacyExportToken | null = token;
  const sources: BrowserInventoryEntry[] = [];
  let current: BrowserInventoryEntry | undefined;
  while (cursor) {
    const page = await source.page({ token: cursor, limit: 1 });
    
    for (const chunk of page.chunks) {
      if (!current) current = { ...await source.binding(chunk.sourceKey), source: chunk.authority, bytes: 0 };
      current.bytes += new TextEncoder().encode(chunk.content).length;
      if (chunk.end) { sources.push(current); current = undefined; }
      if (sources.length === 100) {
        const offset = cursor.offset + 1;
        return { revision: token.revision, sources, next: offset < token.count ? { ...token, offset } : null };
      }
    }
    cursor = page.next;
  }
  return { revision: token.revision, sources, next: null };
}
