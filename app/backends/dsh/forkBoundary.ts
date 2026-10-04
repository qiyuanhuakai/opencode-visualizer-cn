import { readDshHistoryPage, type DshHistoryPageFetcher } from './history';
import { asArray, isRecord } from './parts';

export async function resolveDshForkBoundary(options: {
  sessionId: string;
  messageId: string;
  cursor: number;
  fetchPage: DshHistoryPageFetcher;
}): Promise<number> {
  let beforeSeq = options.cursor + 1;
  let promptSeq: number | undefined;
  for (let pageIndex = 0; pageIndex < 100 && beforeSeq > 0; pageIndex += 1) {
    const raw = await options.fetchPage({ address: { kind: 'session', sessionId: options.sessionId },
      throughSeq: options.cursor, beforeSeq });
    const page = readDshHistoryPage(raw);
    const matches = page.records.filter(({ event }) => {
      if (!isRecord(event.data)) return false;
      if (event.type === 'user/message') return event.data.id === options.messageId;
      return event.type === 'agent/inbox/spliced'
        && asArray(event.data.inserted).some((item) => isRecord(item) && item.id === options.messageId);
    });
    if (matches.length > 0) {
      const seq = Math.min(...matches.map(({ event }) => event.seq));
      promptSeq = promptSeq === undefined ? seq : Math.min(promptSeq, seq);
      if (matches.some(({ event }) => event.type === 'agent/inbox/spliced')) break;
    }
    const lowest = Math.min(...page.records.map(({ event }) => event.seq));
    if (!Number.isFinite(lowest) || lowest >= beforeSeq) break;
    beforeSeq = lowest;
  }
  if (promptSeq !== undefined && promptSeq > 0) return promptSeq - 1;
  throw new Error('DSH prompt was not found in the session history.');
}
