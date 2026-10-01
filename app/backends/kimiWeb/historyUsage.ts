import type { KimiWebAgentTranscript, KimiWebClient } from '../../utils/kimiWeb';
import { KimiWebError, KimiWebTransportError } from '../../utils/kimiWeb';
import type { MessagePart } from '../../types/sse';
import { kimiWebTranscriptToHistoryEntries, type KimiWebHistoryEntry } from './historyEntries';

export type KimiWebTranscriptFetcher = KimiWebClient['getAgentTranscript'];

export async function collectKimiWebUsageTranscript(
  sessionId: string,
  fetchTranscript?: KimiWebTranscriptFetcher,
): Promise<KimiWebAgentTranscript> {
  const transcript: KimiWebAgentTranscript = { agent_id: 'main', items: [], has_more: false };
  if (!fetchTranscript) return transcript;
  let beforeTurn: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    let result: KimiWebAgentTranscript;
    try {
      result = await fetchTranscript(sessionId, 'main', beforeTurn);
    } catch (error) {
      if (!(error instanceof KimiWebError) && !(error instanceof KimiWebTransportError)) throw error;
      console.warn('Kimi Web transcript usage could not be restored; retaining message history.', { sessionId, error });
      break;
    }
    transcript.items.push(...result.items);
    if (!result.has_more) break;
    const oldest = result.items.filter((item) => item.kind === 'turn').at(-1);
    if (!oldest || oldest.turnId === beforeTurn) break;
    beforeTurn = oldest.turnId;
  }
  return transcript;
}

function signature(parts: readonly MessagePart[]): string | undefined {
  const calls = parts.flatMap((part) => part.type === 'tool' ? [part.callID] : []);
  if (calls.length) return JSON.stringify(['tool', ...calls]);
  const text = parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
  return text ? JSON.stringify(['text', text]) : undefined;
}

export function restoreKimiWebHistoryUsage(
  entries: KimiWebHistoryEntry[],
  sessionId: string,
  transcript: KimiWebAgentTranscript,
): KimiWebHistoryEntry[] {
  const candidates = new Map<string, KimiWebHistoryEntry[]>();
  const chronological = { ...transcript,
    items: transcript.items.filter((item) => item.kind === 'turn').sort((a, b) => a.ordinal - b.ordinal),
  };
  for (const entry of kimiWebTranscriptToHistoryEntries(sessionId, chronological)) {
    const key = signature(entry.parts);
    if (!key) continue;
    const matches = candidates.get(key) ?? [];
    matches.push(entry);
    candidates.set(key, matches);
  }
  // REST rows have no step/message link. Match tool IDs first, then exact text.
  // Consume newest first so snapshot/tail suffixes select the latest occurrence.
  return [...entries].reverse().map((entry) => {
    if (entry.info.role !== 'assistant' || entry.info.sessionID !== sessionId) return entry;
    const key = signature(entry.parts);
    const source = key ? candidates.get(key)?.pop() : undefined;
    if (!source || source.info.role !== 'assistant') return entry;
    return { ...entry, info: { ...entry.info, tokens: source.info.tokens } };
  }).reverse();
}
