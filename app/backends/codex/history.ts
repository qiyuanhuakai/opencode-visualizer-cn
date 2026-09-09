import type { CodexAdapter, CodexThreadReadResult, CodexTurn } from './codexAdapter';
import { isUnmaterializedThreadError, isUnsupportedCodexMethodError } from './errors';

const HISTORY_PAGE_SIZE = 100;

type CodexHistorySource = Pick<CodexAdapter, 'listThreadTurns' | 'readThread'>;

async function readPaginatedHistory(
  source: CodexHistorySource,
  threadId: string,
): Promise<CodexThreadReadResult> {
  const metadata = await source.readThread({ threadId, includeTurns: false });
  const turns: CodexTurn[] = [];
  let cursor: string | null | undefined;

  try {
    do {
      const page = await source.listThreadTurns({
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: HISTORY_PAGE_SIZE,
        sortDirection: 'asc',
        itemsView: 'full',
      });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    if (!isUnmaterializedThreadError(error) || turns.length > 0) throw error;
  }

  return {
    ...metadata,
    thread: {
      ...metadata.thread,
      turns,
    },
  };
}

export function createCodexHistoryReader(source: CodexHistorySource) {
  let hydratedReadUnsupported = false;

  return async (threadId: string): Promise<CodexThreadReadResult> => {
    if (hydratedReadUnsupported) return readPaginatedHistory(source, threadId);

    try {
      return await source.readThread({ threadId, includeTurns: true });
    } catch (error) {
      if (isUnmaterializedThreadError(error)) {
        const metadata = await source.readThread({ threadId, includeTurns: false });
        return { ...metadata, thread: { ...metadata.thread, turns: [] } };
      }
      if (!isUnsupportedCodexMethodError(error)) throw error;
      hydratedReadUnsupported = true;
      return readPaginatedHistory(source, threadId);
    }
  };
}
