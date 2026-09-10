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

  it('restores distinct selections for supplemental users in the same turn', () => {
    saveCodexTurnEffort('thread', 'turn', 'high', 'turn:user:a');
    saveCodexTurnEffort('thread', 'turn', 'low', 'turn:user:b');
    const entries = normalizeCodexTurnsToHistory({ sessionId: 'thread', turns: [{ id: 'turn', items: [
      { id: 'a', type: 'userMessage', content: [{ type: 'text', text: 'A' }] },
      { id: 'answer-a', type: 'agentMessage', text: 'A' },
      { id: 'b', type: 'userMessage', content: [{ type: 'text', text: 'B' }] },
      { id: 'answer-b', type: 'agentMessage', text: 'B' },
    ] }] });
    expect(restoreCodexMessageEfforts('thread', entries).map(entry => entry.info.variant)).toEqual(['high', 'high', 'low', 'low']);
  });

  it('restores old ordinal effort metadata to wire identities by user order', () => {
    saveCodexTurnEffort('thread', 'turn', 'high');
    const entries = normalizeCodexTurnsToHistory({ sessionId: 'thread', turns: [{ id: 'turn', items: [
      { id: 'wire', type: 'userMessage', content: [{ type: 'text', text: 'A' }] },
      { id: 'answer', type: 'agentMessage', text: 'A' },
    ] }] });
    expect(restoreCodexMessageEfforts('thread', entries).map(entry => entry.info.variant)).toEqual(['high', 'high']);
  });

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
