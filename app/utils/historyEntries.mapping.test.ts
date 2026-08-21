import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from '../types/message';
import { getHistoryEntryKey, toHistoryWindowEntry } from './historyEntries';
import {
  makeAssistantMessage,
  makeQuestionTool,
  makeReasoningPart,
  makeSubtaskPart,
  makeToolPart,
} from './historyEntries.fixtures';

describe('getHistoryEntryKey', () => {
  it('Given each entry kind, When deriving a key, Then it uses the kind-specific prefix', () => {
    const assistant = makeAssistantMessage('s1', 'a1', 'u1', 2);
    const messageEntry: HistoryEntry = { kind: 'message', message: assistant, time: 2 };
    const toolEntry: HistoryEntry = {
      kind: 'tool',
      part: makeToolPart('a1', 's1', 'bash'),
      time: 3,
    };
    const reasoningEntry: HistoryEntry = {
      kind: 'reasoning',
      part: makeReasoningPart('a1', 's1', 'x', 4),
      time: 4,
    };
    const questionEntry: HistoryEntry = {
      kind: 'question',
      part: makeQuestionTool('a1', 's1', 'completed'),
      time: 5,
    };
    const subtaskEntry: HistoryEntry = {
      kind: 'subtask',
      part: makeSubtaskPart('a1', 's1'),
      time: 6,
    };

    expect(getHistoryEntryKey(messageEntry)).toBe('msg:a1');
    expect(getHistoryEntryKey(toolEntry)).toBe('tool:call-a1-bash');
    expect(getHistoryEntryKey(reasoningEntry)).toBe('reasoning:reasoning-a1');
    expect(getHistoryEntryKey(questionEntry)).toBe('question:call-question-a1');
    expect(getHistoryEntryKey(subtaskEntry)).toBe('subtask:subtask-a1');
  });
});

describe('toHistoryWindowEntry', () => {
  it('Given a message entry with a view, When mapping, Then it carries content, sessionId, isSubagent, and agent', () => {
    const assistant = makeAssistantMessage('sub-session', 'a1', 'u1', 2, 'codex');
    const entry: HistoryEntry = { kind: 'message', message: assistant, time: 2 };

    const windowEntry = toHistoryWindowEntry(entry, {
      content: 'hello',
      isSubagent: true,
      agent: 'codex',
    });

    expect(windowEntry).toMatchObject({
      key: 'msg:a1',
      kind: 'message',
      content: 'hello',
      time: 2,
      sessionId: 'sub-session',
      isSubagent: true,
      agent: 'codex',
    });
  });

  it('Given a reasoning entry, When mapping, Then it passes the part through', () => {
    const reasoning = makeReasoningPart('a1', 's1', 'x', 4);
    const entry: HistoryEntry = { kind: 'reasoning', part: reasoning, time: 4 };

    const windowEntry = toHistoryWindowEntry(entry);

    expect(windowEntry).toMatchObject({
      key: 'reasoning:reasoning-a1',
      kind: 'reasoning',
      time: 4,
    });
    expect(windowEntry.kind === 'reasoning' && windowEntry.part).toBe(reasoning);
  });

  it('Given a question entry, When mapping, Then it resolves questions, status, and answers', () => {
    const question = makeQuestionTool('a1', 's1', 'completed', [['yes']]);
    const entry: HistoryEntry = { kind: 'question', part: question, time: 5 };

    const windowEntry = toHistoryWindowEntry(entry);

    expect(windowEntry).toMatchObject({
      key: 'question:call-question-a1',
      kind: 'question',
      status: 'replied',
      answers: [['yes']],
      time: 5,
    });
  });

  it('Given a subtask entry, When mapping, Then it passes the part through', () => {
    const subtask = makeSubtaskPart('a1', 's1');
    const entry: HistoryEntry = { kind: 'subtask', part: subtask, time: 6 };

    const windowEntry = toHistoryWindowEntry(entry);

    expect(windowEntry).toMatchObject({ key: 'subtask:subtask-a1', kind: 'subtask', time: 6 });
    expect(windowEntry.kind === 'subtask' && windowEntry.part).toBe(subtask);
  });

  it('Given a tool entry, When mapping, Then it passes the part through', () => {
    const tool = makeToolPart('a1', 's1', 'bash', 'completed', 3);
    const entry: HistoryEntry = { kind: 'tool', part: tool, time: 3 };

    const windowEntry = toHistoryWindowEntry(entry);

    expect(windowEntry).toMatchObject({ key: 'tool:call-a1-bash', kind: 'tool', time: 3 });
    expect(windowEntry.kind === 'tool' && windowEntry.part).toBe(tool);
  });
});
