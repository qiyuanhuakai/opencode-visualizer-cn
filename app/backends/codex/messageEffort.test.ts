import { beforeEach, describe, expect, it } from 'vitest';
import { restoreCodexMessageEfforts, saveCodexTurnEffort } from './messageEffort';
import { normalizeCodexTurnsToHistory } from './normalize';
import { StorageKeys, storageSetJSON } from '../../utils/storageKeys';

function history(threadId: string) {
  return normalizeCodexTurnsToHistory({
    sessionId: threadId,
    turns: [{ id: 'turn', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
      { type: 'agentMessage', id: 'answer', text: 'Answer' },
    ] }],
  });
}

describe('Codex per-turn effort metadata', () => {
  beforeEach(() => localStorage.clear());

  it('keeps identical turn IDs isolated by thread', () => {
    saveCodexTurnEffort('thread-a', 'turn', 'high');
    saveCodexTurnEffort('thread-b', 'turn', 'low');
    expect(restoreCodexMessageEfforts('thread-a', history('thread-a')).map(entry => entry.info.variant)).toEqual(['high', 'high']);
    expect(restoreCodexMessageEfforts('thread-b', history('thread-b')).map(entry => entry.info.variant)).toEqual(['low', 'low']);
  });

  it('ignores malformed saved effort values', () => {
    storageSetJSON(`${StorageKeys.state.codexTurnEfforts}.thread`, { 'turn:user:0': { effort: 'high' } });
    expect(restoreCodexMessageEfforts('thread', history('thread')).map(entry => entry.info.variant)).toEqual([undefined, undefined]);
  });

  it('does not infer a variant when the request omitted its effort', () => {
    saveCodexTurnEffort('thread', 'turn', undefined);
    expect(restoreCodexMessageEfforts('thread', history('thread')).map(entry => entry.info.variant)).toEqual([undefined, undefined]);
  });

  it('preserves effort supplied by message metadata over a saved selection', () => {
    saveCodexTurnEffort('thread', 'turn', 'high');
    const entries = history('thread').map(entry => ({ ...entry, info: { ...entry.info, variant: 'low' } }));
    expect(restoreCodexMessageEfforts('thread', entries).map(entry => entry.info.variant)).toEqual(['low', 'low']);
  });
});
