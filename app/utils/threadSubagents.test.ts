import { describe, expect, it } from 'vitest';

import type { MessagePart, ToolPart } from '../types/sse';
import {
  resolveChildOwners,
  resolveThreadSubagentSessions,
} from './threadSubagents';

const CURRENT_SESSION = 'ses-parent';

function makeTaskPart(
  callId: string,
  metadata: Record<string, unknown> | undefined,
  status: 'pending' | 'running' | 'completed' | 'error' = 'completed',
  input: Record<string, unknown> = {},
): ToolPart {
  const base = {
    id: `part-${callId}`,
    messageID: 'msg-assistant-1',
    sessionID: CURRENT_SESSION,
    type: 'tool' as const,
    callID: callId,
    tool: 'task',
  };
  if (status === 'pending') {
    return { ...base, state: { status, input, raw: '' } };
  }
  if (status === 'running') {
    return { ...base, state: { status, input, metadata, time: { start: 1 } } };
  }
  if (status === 'error') {
    return {
      ...base,
      state: { status, input, error: 'boom', metadata, time: { start: 1, end: 2 } },
    };
  }
  return {
    ...base,
    state: {
      status,
      input,
      output: 'done',
      title: 'task',
      metadata: metadata ?? {},
      time: { start: 1, end: 2 },
    },
  };
}

function makeNonTaskToolPart(callId: string, metadata: Record<string, unknown>): ToolPart {
  return {
    id: `part-${callId}`,
    messageID: 'msg-assistant-1',
    sessionID: CURRENT_SESSION,
    type: 'tool',
    callID: callId,
    tool: 'bash',
    state: {
      status: 'completed',
      input: {},
      output: 'ok',
      title: 'bash',
      metadata,
      time: { start: 1, end: 2 },
    },
  };
}

describe('resolveThreadSubagentSessions', () => {
  it('returns the subagent session spawned by a task part in this thread', () => {
    const parts: MessagePart[] = [makeTaskPart('c1', { sessionId: 'ses-child-1' })];
    const meta = { 'ses-child-1': { parentID: CURRENT_SESSION, label: 'Record the (@Sisyphus-Junior subagent)' } };
    expect(resolveThreadSubagentSessions(parts, CURRENT_SESSION, meta)).toEqual([
      { sessionId: 'ses-child-1', label: 'Record the (@Sisyphus-Junior subagent)' },
    ]);
  });

  it('does not attribute a subagent session to a thread that did not spawn it', () => {
    // Regression: the old implementation listed every session whose parentID
    // matched the current session on EVERY thread card. A thread without a
    // task part must show no subagent entry even when the session has one.
    const parts: MessagePart[] = [];
    const meta = { 'ses-child-1': { parentID: CURRENT_SESSION, label: 'child' } };
    expect(resolveThreadSubagentSessions(parts, CURRENT_SESSION, meta)).toEqual([]);
  });

  it('attributes a live child by a unique task description before metadata arrives', () => {
    const pendingTask = makeTaskPart('task-description', undefined, 'pending', {
      description: 'Trace status bugs',
    });

    expect(
      resolveChildOwners(
        [
          { rootId: 'root-1', parts: [pendingTask] },
          { rootId: 'root-2', parts: [] },
        ],
        CURRENT_SESSION,
        { child: { parentID: CURRENT_SESSION, label: 'Trace status bugs' } },
      ),
    ).toEqual({ 'root-1': ['child'] });
  });

  it('places an ambiguous child on the latest thread until exact metadata arrives', () => {
    const first = makeTaskPart('task-1', undefined, 'pending', {
      description: 'Duplicate task',
    });
    const second = makeTaskPart('task-2', undefined, 'pending', {
      description: 'Duplicate task',
    });

    expect(
      resolveChildOwners(
        [
          { rootId: 'root-1', parts: [first] },
          { rootId: 'root-2', parts: [second] },
        ],
        CURRENT_SESSION,
        { child: { parentID: CURRENT_SESSION, label: 'Duplicate task' } },
      ),
    ).toEqual({ 'root-2': ['child'] });
  });

  it('removes the latest-thread fallback when exact metadata arrives', () => {
    const exact = makeTaskPart('task-1', { sessionId: 'child' }, 'running', {
      description: 'Duplicate task',
    });
    const ambiguous = makeTaskPart('task-2', undefined, 'pending', {
      description: 'Duplicate task',
    });
    const meta = { child: { parentID: CURRENT_SESSION, label: 'Duplicate task' } };

    expect(
      resolveChildOwners(
        [
          { rootId: 'root-1', parts: [exact] },
          { rootId: 'root-2', parts: [ambiguous] },
        ],
        CURRENT_SESSION,
        meta,
      ),
    ).toEqual({});
    expect(resolveThreadSubagentSessions([exact], CURRENT_SESSION, meta)).toEqual([
      { sessionId: 'child', label: 'Duplicate task' },
    ]);
  });

  it('only attributes the subagent to the spawning thread when several threads exist', () => {
    const threadA: MessagePart[] = [makeTaskPart('c1', { sessionId: 'ses-child-1' })];
    const threadB: MessagePart[] = [makeNonTaskToolPart('c2', { sessionId: 'ses-child-1' })];
    const meta = { 'ses-child-1': { parentID: CURRENT_SESSION, label: 'child' } };
    expect(resolveThreadSubagentSessions(threadA, CURRENT_SESSION, meta)).toHaveLength(1);
    expect(resolveThreadSubagentSessions(threadB, CURRENT_SESSION, meta)).toEqual([]);
  });

  it('excludes task parts whose child session belongs to a different parent session', () => {
    const parts: MessagePart[] = [makeTaskPart('c1', { sessionId: 'ses-foreign' })];
    const meta = { 'ses-foreign': { parentID: 'ses-other', label: 'foreign' } };
    expect(resolveThreadSubagentSessions(parts, CURRENT_SESSION, meta)).toEqual([]);
  });

  it('ignores pending task parts and task parts without a sessionId metadata', () => {
    const parts: MessagePart[] = [
      makeTaskPart('c1', { sessionId: 'ses-child-1' }, 'pending'),
      makeTaskPart('c2', undefined),
      makeTaskPart('c3', { sessionId: 42 }),
      makeTaskPart('c4', { sessionId: '   ' }),
    ];
    const meta = { 'ses-child-1': { parentID: CURRENT_SESSION, label: 'child' } };
    expect(resolveThreadSubagentSessions(parts, CURRENT_SESSION, meta)).toEqual([]);
  });

  it('detects running and errored task parts, not only completed ones', () => {
    const parts: MessagePart[] = [
      makeTaskPart('c1', { sessionId: 'ses-child-1' }, 'running'),
      makeTaskPart('c2', { sessionId: 'ses-child-2' }, 'error'),
    ];
    const meta = {
      'ses-child-1': { parentID: CURRENT_SESSION, label: 'one' },
      'ses-child-2': { parentID: CURRENT_SESSION, label: 'two' },
    };
    expect(resolveThreadSubagentSessions(parts, CURRENT_SESSION, meta)).toEqual([
      { sessionId: 'ses-child-1', label: 'one' },
      { sessionId: 'ses-child-2', label: 'two' },
    ]);
  });

  it('deduplicates repeated task parts that reference the same child session', () => {
    const parts: MessagePart[] = [
      makeTaskPart('c1', { sessionId: 'ses-child-1' }),
      makeTaskPart('c2', { sessionId: 'ses-child-1' }),
    ];
    const meta = { 'ses-child-1': { parentID: CURRENT_SESSION, label: 'child' } };
    expect(resolveThreadSubagentSessions(parts, CURRENT_SESSION, meta)).toEqual([
      { sessionId: 'ses-child-1', label: 'child' },
    ]);
  });

  it('falls back to the raw session id as label when session metadata is unavailable', () => {
    const parts: MessagePart[] = [makeTaskPart('c1', { sessionId: 'ses-child-1' })];
    expect(resolveThreadSubagentSessions(parts, CURRENT_SESSION, undefined)).toEqual([
      { sessionId: 'ses-child-1', label: 'ses-child-1' },
    ]);
  });

  it('returns nothing when the current session id is empty', () => {
    const parts: MessagePart[] = [makeTaskPart('c1', { sessionId: 'ses-child-1' })];
    const meta = { 'ses-child-1': { parentID: CURRENT_SESSION, label: 'child' } };
    expect(resolveThreadSubagentSessions(parts, '  ', meta)).toEqual([]);
  });
});
