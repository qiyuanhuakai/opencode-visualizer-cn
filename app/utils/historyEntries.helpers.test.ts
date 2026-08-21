import { describe, expect, it } from 'vitest';

import {
  extractQuestionAnswers,
  extractQuestionInfos,
  getMessageHistoryAgent,
  getSubtaskPartTime,
  getToolPartTime,
  resolveMessageIsSubagent,
  resolveQuestionStatus,
} from './historyEntries';
import {
  makeAssistantMessage,
  makeQuestionTool,
  makeSubtaskPart,
  makeToolPart,
  makeUserMessage,
} from './historyEntries.fixtures';

describe('getToolPartTime', () => {
  it('Given a running, completed, or error tool, When reading its time, Then it returns state.time.start', () => {
    expect(getToolPartTime(makeToolPart('a1', 's1', 'bash', 'running', 7))).toBe(7);
    expect(getToolPartTime(makeToolPart('a1', 's1', 'bash', 'completed', 8))).toBe(8);
    expect(getToolPartTime(makeToolPart('a1', 's1', 'bash', 'error', 9))).toBe(9);
  });

  it('Given a pending tool, When reading its time, Then it returns 0', () => {
    expect(getToolPartTime(makeToolPart('a1', 's1', 'bash', 'pending'))).toBe(0);
  });
});

describe('getSubtaskPartTime', () => {
  it('Given a subtask part and a fallback time, When reading its time, Then it returns the fallback', () => {
    expect(getSubtaskPartTime(makeSubtaskPart('a1', 's1'), 42)).toBe(42);
  });
});

describe('extractQuestionInfos', () => {
  it('Given a question tool with valid questions, When extracting, Then it returns the valid questions', () => {
    const part = makeQuestionTool('a1', 's1', 'completed');

    const infos = extractQuestionInfos(part);

    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ question: 'Proceed?', header: 'Confirm' });
  });

  it('Given a question tool without a questions array, When extracting, Then it returns an empty array', () => {
    const part = makeToolPart('a1', 's1', 'question', 'completed', 5);

    expect(extractQuestionInfos(part)).toEqual([]);
  });
});

describe('resolveQuestionStatus', () => {
  it('Given a completed question tool, When resolving status, Then it returns replied', () => {
    expect(resolveQuestionStatus(makeQuestionTool('a1', 's1', 'completed'))).toBe('replied');
  });

  it('Given an errored question tool, When resolving status, Then it returns rejected', () => {
    expect(resolveQuestionStatus(makeQuestionTool('a1', 's1', 'error'))).toBe('rejected');
  });

  it('Given a running or pending question tool, When resolving status, Then it returns pending', () => {
    expect(resolveQuestionStatus(makeQuestionTool('a1', 's1', 'running'))).toBe('pending');
    expect(resolveQuestionStatus(makeQuestionTool('a1', 's1', 'pending'))).toBe('pending');
  });
});

describe('extractQuestionAnswers', () => {
  it('Given a completed question tool with answers, When extracting, Then it returns the answers', () => {
    const part = makeQuestionTool('a1', 's1', 'completed', [['yes']]);

    expect(extractQuestionAnswers(part)).toEqual([['yes']]);
  });

  it('Given a completed question tool without answers, When extracting, Then it returns undefined', () => {
    expect(extractQuestionAnswers(makeQuestionTool('a1', 's1', 'completed'))).toBeUndefined();
  });

  it('Given a non-completed question tool, When extracting, Then it returns undefined', () => {
    expect(extractQuestionAnswers(makeQuestionTool('a1', 's1', 'running'))).toBeUndefined();
  });
});

describe('resolveMessageIsSubagent', () => {
  it('Given a message from a different session than the current one, When resolving, Then it returns true', () => {
    const message = makeAssistantMessage('sub-session', 'a1', 'u1', 2);

    expect(resolveMessageIsSubagent(message, 'main-session')).toBe(true);
  });

  it('Given a message from the current session, When resolving, Then it returns false', () => {
    const message = makeAssistantMessage('main-session', 'a1', 'u1', 2);

    expect(resolveMessageIsSubagent(message, 'main-session')).toBe(false);
  });

  it('Given no current session id, When resolving, Then it returns false', () => {
    const message = makeAssistantMessage('sub-session', 'a1', 'u1', 2);

    expect(resolveMessageIsSubagent(message, undefined)).toBe(false);
  });
});

describe('getMessageHistoryAgent', () => {
  it('Given an assistant message with an agent, When reading the agent, Then it returns the agent name', () => {
    const message = makeAssistantMessage('s1', 'a1', 'u1', 2, 'codex');

    expect(getMessageHistoryAgent(message)).toBe('codex');
  });

  it('Given an assistant message without an agent, When reading the agent, Then it returns undefined', () => {
    const message = makeAssistantMessage('s1', 'a1', 'u1', 2, '');

    expect(getMessageHistoryAgent(message)).toBeUndefined();
  });

  it('Given a user message, When reading the agent, Then it returns undefined', () => {
    const message = makeUserMessage('s1', 'u1', 1);

    expect(getMessageHistoryAgent(message)).toBeUndefined();
  });
});
