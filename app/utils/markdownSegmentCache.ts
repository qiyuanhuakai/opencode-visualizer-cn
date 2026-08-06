export const MARKDOWN_SEGMENT_CACHE_LIMIT = 256;

const cache = new Map<string, string>();

function cacheKey(theme: string, blockText: string): string {
  return `${theme}\n${blockText}`;
}

export function getMarkdownSegmentHtml(theme: string, blockText: string): string | undefined {
  const key = cacheKey(theme, blockText);
  const html = cache.get(key);
  if (html === undefined) return undefined;
  cache.delete(key);
  cache.set(key, html);
  return html;
}

export function setMarkdownSegmentHtml(theme: string, blockText: string, html: string): void {
  const key = cacheKey(theme, blockText);
  cache.delete(key);
  cache.set(key, html);
  if (cache.size <= MARKDOWN_SEGMENT_CACHE_LIMIT) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

export function clearMarkdownSegmentCache(): void {
  cache.clear();
}
