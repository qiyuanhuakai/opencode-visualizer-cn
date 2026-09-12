import { normalizeCodexTurnsToHistory } from './normalize';
import type { CodexTurn } from './codexAdapter';

export function codexRollbackCount(sessionId: string, turns: readonly CodexTurn[], messageId: string): number {
  const index = turns.findIndex(turn => normalizeCodexTurnsToHistory({ sessionId, turns: [turn] })
    .some(entry => entry.info.role === 'user' && entry.info.id === messageId));
  if (index < 0) throw new Error('Codex rollback target is no longer present in this thread.');
  return turns.length - index;
}
