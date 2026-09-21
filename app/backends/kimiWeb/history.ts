/**
 * Kimi Web session-history paging.
 *
 * `GET …/messages` returns items in REVERSE chronological order (newest first)
 * and pages with `has_more` + `before_id`. This module stitches the pages into
 * one chronological list, drops injected user messages
 * (`metadata.origin.kind === 'injection'` — full path per docs/kimi.md L139),
 * and hands the result to `historyEntries` for conversion. No live bridge or
 * popup callback is involved: history is pure replay.
 */
import type { KimiWebMessage } from '../../utils/kimiWeb';
import { KimiWebTransportError } from '../../utils/kimiWeb';
import {
  isInjectionMessage,
  kimiWebMessagesToHistoryEntries,
  type KimiWebHistoryEntry,
} from './historyEntries';

export type KimiWebHistoryPage = {
  items: KimiWebMessage[];
  has_more?: boolean;
};

export type KimiWebMessagesQuery = {
  before_id?: string;
  after_id?: string;
  page_size?: number;
  signal?: AbortSignal;
};

export type KimiWebMessagesFetcher = (
  sessionId: string,
  query?: KimiWebMessagesQuery,
) => Promise<KimiWebHistoryPage>;

export type KimiWebHistoryCollection = {
  /** Chronological (oldest first), injection messages removed. */
  messages: KimiWebMessage[];
  pages: number;
  /** True when the page cap (or an undriveable cursor) bounded the result. */
  truncated: boolean;
};

export const KIMI_WEB_HISTORY_PAGE_SIZE = 100;
/** Hard upper bound so a hostile `has_more:true` can never loop forever. */
export const KIMI_WEB_HISTORY_MAX_PAGES = 100;

export async function collectKimiWebHistoryMessages(params: {
  sessionId: string;
  fetchPage: KimiWebMessagesFetcher;
  maxPages?: number;
  pageSize?: number;
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
}): Promise<KimiWebHistoryCollection> {
  const maxPages = params.maxPages ?? KIMI_WEB_HISTORY_MAX_PAGES;
  const pageSize = params.pageSize ?? KIMI_WEB_HISTORY_PAGE_SIZE;
  const collected: KimiWebMessage[] = [];
  let beforeId: string | undefined;
  let pages = 0;
  let hasMore = true;

  while (hasMore && pages < maxPages) {
    if (params.shouldContinue && !params.shouldContinue()) {
      return { messages: [], pages, truncated: false };
    }
    const page = await params.fetchPage(params.sessionId, {
      before_id: beforeId,
      page_size: pageSize,
      signal: params.signal,
    });
    pages += 1;
    if (!page || !Array.isArray(page.items)) {
      throw new KimiWebTransportError('Kimi Web history page is missing its items.', {
        kind: 'malformed-response',
        path: `/api/v1/sessions/${params.sessionId}/messages`,
      });
    }
    collected.push(...page.items.filter((message) => !isInjectionMessage(message)));
    hasMore = page.has_more === true;
    if (!hasMore) break;
    const oldest = page.items.at(-1);
    if (!oldest?.id) break;
    beforeId = oldest.id;
  }

  collected.reverse();
  return { messages: collected, pages, truncated: hasMore };
}

/** Paging + conversion in one step, returning loadHistory-ready entries. */
export async function loadKimiWebHistoryEntries(params: {
  sessionId: string;
  getMessages: KimiWebMessagesFetcher;
  maxPages?: number;
  pageSize?: number;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<{ entries: KimiWebHistoryEntry[]; pages: number; truncated: boolean }> {
  const collection = await collectKimiWebHistoryMessages({
    sessionId: params.sessionId,
    fetchPage: params.getMessages,
    maxPages: params.maxPages,
    pageSize: params.pageSize,
    signal: params.signal,
    shouldContinue: params.isCurrent,
  });
  return {
    entries: kimiWebMessagesToHistoryEntries(collection.messages),
    pages: collection.pages,
    truncated: collection.truncated,
  };
}
