import { describe, expect, it } from 'vitest';

import { buildHistoryEntries, selectSubagentMessages } from './historyEntries';
import {
  makeAssistantMessage,
  makeQuestionTool,
  makeReasoningPart,
  makeSource,
  makeSubtaskPart,
  makeTextPart,
  makeToolPart,
  makeUserMessage,
} from './historyEntries.fixtures';

describe('buildHistoryEntries', () => {
  it('Given an assistant message with text and a completed tool, When building entries, Then it emits a message entry and a tool entry', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeTextPart('a1', 's1', 'hello'), makeToolPart('a1', 's1', 'bash', 'completed', 3)],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'message', time: 2 });
    expect(entries[1]).toMatchObject({ kind: 'tool', time: 3 });
  });

  it('Given messages out of order, When building entries, Then they are sorted ascending by time', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 10);
    const source = makeSource([user, assistant], {
      a1: [
        makeTextPart('a1', 's1', 'reply'),
        makeToolPart('a1', 's1', 'bash', 'completed', 5),
        makeReasoningPart('a1', 's1', 'thinking', 2),
      ],
    });

    const entries = buildHistoryEntries(source);

    expect(entries.map((entry) => entry.time)).toEqual([2, 5, 10]);
  });

  it('Given a user message with text, When building entries, Then no message entry is emitted for it', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const source = makeSource([user], { u1: [makeTextPart('u1', 's1', 'prompt')] });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(0);
  });

  it('Given an assistant message without text content, When building entries, Then no message entry is emitted', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], { a1: [] });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(0);
  });

  it('Given a pending tool part, When building entries, Then it is skipped', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeToolPart('a1', 's1', 'bash', 'pending')],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(0);
  });

  it('Given a question tool part, When building entries, Then a question entry is emitted', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeQuestionTool('a1', 's1', 'completed')],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'question', time: 5 });
  });

  it('Given a non-history tool part, When building entries, Then it is skipped', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeToolPart('a1', 's1', 'task', 'completed', 3)],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(0);
  });

  it('Given a reasoning part without text, When building entries, Then it is skipped', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeReasoningPart('a1', 's1', '', 3)],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(0);
  });

  it('Given a subtask part, When building entries, Then a subtask entry uses the message created time', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeSubtaskPart('a1', 's1')],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'subtask', time: 2 });
  });
  it('Given a reasoning part with text, When building entries, Then a reasoning entry uses the part start time', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeReasoningPart('a1', 's1', 'thinking', 3)],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'reasoning', time: 3 });
  });

  it('Given a text part, When building entries, Then only the assistant message entry is emitted', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeTextPart('a1', 's1', 'hello')],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'message', time: 2 });
  });

  it('Given a running and an errored tool part, When building entries, Then both emit tool entries using their start time', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [
        makeToolPart('a1', 's1', 'bash', 'running', 4),
        makeToolPart('a1', 's1', 'bash', 'error', 6),
      ],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.time)).toEqual([4, 6]);
    expect(entries.every((entry) => entry.kind === 'tool')).toBe(true);
  });

  it('Given a question, a pending tool, and a history tool in one message, When building entries, Then only the question and history tool are emitted', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [
        makeQuestionTool('a1', 's1', 'completed'),
        makeToolPart('a1', 's1', 'bash', 'pending'),
        makeToolPart('a1', 's1', 'bash', 'completed', 7),
      ],
    });

    const entries = buildHistoryEntries(source);

    expect(entries.map((entry) => entry.kind)).toEqual(['question', 'tool']);
    expect(entries.map((entry) => entry.time)).toEqual([5, 7]);
  });

  it('Given an assistant message without text but with a completed tool, When building entries, Then only the tool entry is emitted', () => {
    const user = makeUserMessage('s1', 'u1', 1);
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const source = makeSource([user, assistant], {
      a1: [makeToolPart('a1', 's1', 'bash', 'completed', 3)],
    });

    const entries = buildHistoryEntries(source);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', time: 3 });
  });
});

describe('selectSubagentMessages', () => {
  it('Given roots from multiple sessions, When selecting for a target session, Then it returns only that session user roots flattened', () => {
    const targetUser = makeUserMessage('target', 'u-target', 1);
    const targetAssistant = makeAssistantMessage('target', 'a-target', 'u-target', 2);
    const otherUser = makeUserMessage('other', 'u-other', 1);
    const roots = [targetUser, otherUser];
    const getThread = (rootId: string) =>
      rootId === 'u-target' ? [targetUser, targetAssistant] : [otherUser];

    const messages = selectSubagentMessages(roots, getThread, 'target');

    expect(messages.map((message) => message.id)).toEqual(['u-target', 'a-target']);
  });

  it('Given an empty or whitespace target session id, When selecting, Then it returns an empty array', () => {
    const user = makeUserMessage('target', 'u1', 1);

    expect(selectSubagentMessages([user], () => [user], '')).toEqual([]);
    expect(selectSubagentMessages([user], () => [user], '   ')).toEqual([]);
  });

  it('Given a target session with no user roots, When selecting, Then it returns an empty array', () => {
    const otherUser = makeUserMessage('other', 'u-other', 1);

    expect(selectSubagentMessages([otherUser], () => [otherUser], 'target')).toEqual([]);
  });
});
