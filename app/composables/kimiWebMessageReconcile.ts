import { kimiWebMessagesToHistoryEntries } from '../backends/kimiWeb/historyEntries';
import type { KimiWebSnapshot } from '../utils/kimiWeb';
import type { KimiWebWsFrame } from '../utils/kimiWebWs';
import type { MessageInfo, MessagePart } from '../types/sse';

export type KimiWebReconcilePartKind = 'tool' | 'reasoning' | 'subagent';

export function authoritativeEntries(snapshot: KimiWebSnapshot) {
  return kimiWebMessagesToHistoryEntries(snapshot.messages.items);
}

export function tailEntries(items: KimiWebSnapshot['messages']['items']) {
  return kimiWebMessagesToHistoryEntries([...items].reverse());
}

export function reconcilePartKind(
  info: MessageInfo | undefined,
  part: MessagePart,
  parentSessionId: string | undefined,
): KimiWebReconcilePartKind | undefined {
  if (!info || !isTerminalPart(part)) return undefined;
  if (part.type === 'tool') return 'tool';
  if (part.sessionID !== parentSessionId) return 'subagent';
  if (part.type === 'reasoning') return 'reasoning';
  return undefined;
}

function isTerminalPart(part: MessagePart): boolean {
  if ('time' in part && part.time && 'end' in part.time && part.time.end !== undefined) return true;
  return part.type === 'tool' && (part.state.status === 'completed' || part.state.status === 'error');
}

function frameDelta(frame: KimiWebWsFrame): string {
  const payload = frame.payload;
  return payload && typeof payload === 'object' && 'delta' in payload && typeof payload.delta === 'string'
    ? payload.delta
    : '';
}

function longestBoundaryOverlap(authoritative: string, buffered: string): number {
  for (let length = Math.min(authoritative.length, buffered.length); length > 0; length -= 1) {
    if (authoritative.endsWith(buffered.slice(0, length))) return length;
  }
  return 0;
}

function reconcileBufferedFrame(
  snapshot: KimiWebSnapshot,
  remaining: Map<string, number>,
  entry: KimiWebWsFrame,
): KimiWebWsFrame[] {
  if (entry.epoch && entry.epoch !== snapshot.epoch) return [];
  if (entry.volatile !== true && typeof entry.seq === 'number' && entry.seq <= snapshot.as_of_seq) return [];
  if (entry.volatile !== true) return [entry];
  if (entry.seq !== snapshot.as_of_seq) {
    // Replay contract §6.2 lines 203-205: volatile frames share an opener seq,
    // so seq<=U is never a replay/dedup filter for content that arrived live.
    const { offset: _offset, seq: _seq, ...appendOnly } = entry;
    return [appendOnly];
  }

  const delta = frameDelta(entry);
  const skip = Math.min(remaining.get(entry.type) ?? 0, delta.length);
  remaining.set(entry.type, Math.max(0, (remaining.get(entry.type) ?? 0) - skip));
  if (skip === delta.length) return [];
  const payload = entry.payload && typeof entry.payload === 'object'
    ? { ...entry.payload, delta: delta.slice(skip) }
    : entry.payload;
  const { offset: _offset, ...appendOnly } = entry;
  return [{ ...appendOnly, payload }];
}

export function snapshotBoundaryFrames(
  snapshot: KimiWebSnapshot,
  buffered: readonly KimiWebWsFrame[],
): KimiWebWsFrame[] {
  // Replay contract §5.5 lines 244-252 and §6.4 lines 279-285: the snapshot has no
  // offset watermark, so its strings replace local content and only the uncovered
  // suffix of same-seq buffered volatile content may be appended.
  const boundary = buffered.filter((entry) => entry.volatile === true && entry.seq === snapshot.as_of_seq);
  const assistant = boundary.filter((entry) => entry.type === 'assistant.delta').map(frameDelta).join('');
  const thinking = boundary.filter((entry) => entry.type === 'thinking.delta').map(frameDelta).join('');
  const remaining = new Map<string, number>([
    ['assistant.delta', longestBoundaryOverlap(snapshot.in_flight_turn?.assistant_text ?? '', assistant)],
    ['thinking.delta', longestBoundaryOverlap(snapshot.in_flight_turn?.thinking_text ?? '', thinking)],
  ]);

  return buffered.flatMap((entry) => reconcileBufferedFrame(snapshot, remaining, entry));
}
