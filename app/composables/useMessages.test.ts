import { beforeEach, describe, expect, it } from 'vitest';

import type { MessageInfo } from '../types/sse';
import { useMessages } from './useMessages';

describe('useMessages getDiffs', () => {
  beforeEach(() => {
    useMessages().reset();
  });

  it('preserves per-file patches from user message summary diffs', () => {
    const messages = useMessages();

    messages.updateMessage({
      id: 'msg-1',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'test', modelID: 'test-model' },
      summary: {
        diffs: [
          {
            file: 'app/components/renderers/DiffRenderer.vue',
            patch: '@@ -1,2 +1,2 @@\n-foo\n+bar',
            additions: 1,
            deletions: 1,
          },
          {
            file: 'app/composables/useMessages.ts',
            patch: '@@ -10,0 +11,1 @@\n+const value = true;',
            additions: 1,
            deletions: 0,
          },
        ],
      },
    } as MessageInfo);

    expect(messages.getDiffs('msg-1')).toEqual([
      {
        file: 'app/components/renderers/DiffRenderer.vue',
        diff: '@@ -1,2 +1,2 @@\n-foo\n+bar',
        before: undefined,
        after: undefined,
      },
      {
        file: 'app/composables/useMessages.ts',
        diff: '@@ -10,0 +11,1 @@\n+const value = true;',
        before: undefined,
        after: undefined,
      },
    ]);
  });

  it('overwrites existing parts when loadHistory receives the same part id again', () => {
    const messages = useMessages();

    messages.loadHistory([
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 1, completed: 2 },
          parentID: 'user-1',
          modelID: 'codex',
          providerID: 'codex',
          mode: 'codex',
          agent: 'codex',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
          id: 'tool-1',
          sessionID: 'session-1',
          messageID: 'assistant-1',
          type: 'tool',
          callID: 'tool-1',
          tool: 'bash',
          state: {
            status: 'running',
            input: { command: 'ls' },
            title: 'ls',
            metadata: { source: 'codex' },
            time: { start: 1 },
          },
          metadata: { source: 'codex' },
        }],
      },
    ]);

    messages.loadHistory([
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 1, completed: 3 },
          parentID: 'user-1',
          modelID: 'codex',
          providerID: 'codex',
          mode: 'codex',
          agent: 'codex',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
          id: 'tool-1',
          sessionID: 'session-1',
          messageID: 'assistant-1',
          type: 'tool',
          callID: 'tool-1',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'done',
            title: 'ls',
            metadata: { source: 'codex' },
            time: { start: 1, end: 3 },
          },
          metadata: { source: 'codex' },
        }],
      },
    ]);

    expect(messages.getPartsByType('assistant-1', 'tool')[0]?.state.status).toBe('completed');
  });

  it('removes provisional messages and their parts', () => {
    const messages = useMessages();

    messages.loadHistory([
      {
        info: {
          id: 'codex:turn:pending-turn:123:user:0',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'codex',
          model: { providerID: 'codex', modelID: 'codex' },
        },
        parts: [{
          id: 'codex:turn:pending-turn:123:user:0:text',
          sessionID: 'session-1',
          messageID: 'codex:turn:pending-turn:123:user:0',
          type: 'text',
          text: 'hello',
          time: { start: 1, end: 1 },
        }],
      },
    ]);

    messages.removeMessage('codex:turn:pending-turn:123:user:0');

    expect(messages.get('codex:turn:pending-turn:123:user:0')).toBeUndefined();
    expect(messages.getParts('codex:turn:pending-turn:123:user:0')).toEqual([]);
  });

  it('does not duplicate assistant reply when streaming state is followed by completed history reload', () => {
    const messages = useMessages();

    messages.updateMessage({
      id: 'turn_1:user:0',
      sessionID: 'thread-1',
      role: 'user',
      time: { created: 1 },
      agent: 'codex',
      model: { providerID: 'codex', modelID: 'codex' },
    } as MessageInfo);

    messages.updateMessage({
      id: 'turn_1:assistant',
      sessionID: 'thread-1',
      role: 'assistant',
      time: { created: 2 },
      parentID: 'turn_1:user:0',
      modelID: 'codex',
      providerID: 'codex',
      mode: 'codex',
      agent: 'codex',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageInfo);
    messages.updatePart({
      id: 'turn_1:assistant:text',
      sessionID: 'thread-1',
      messageID: 'turn_1:assistant',
      type: 'text',
      text: 'partial',
      time: { start: 2 },
    });

    messages.loadHistory([
      {
        info: {
          id: 'turn_1:assistant',
          sessionID: 'thread-1',
          role: 'assistant',
          time: { created: 2, completed: 3 },
          parentID: 'turn_1:user:0',
          modelID: 'codex',
          providerID: 'codex',
          mode: 'codex',
          agent: 'codex',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
          id: 'turn_1:assistant:text',
          sessionID: 'thread-1',
          messageID: 'turn_1:assistant',
          type: 'text',
          text: 'final answer',
          time: { start: 2, end: 3 },
        }],
      },
    ]);

    const assistant = messages.get('turn_1:assistant');
    expect(assistant?.role).toBe('assistant');
    if (!assistant || assistant.role !== 'assistant') throw new Error('Expected assistant message');
    expect(assistant.parentID).toBe('turn_1:user:0');
    const textParts = messages.getPartsByType('turn_1:assistant', 'text');
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe('final answer');
  });

  it('replaces temporary realtime state after reset and hydrate reload', () => {
    const messages = useMessages();

    messages.updateMessage({
      id: 'turn_1:user:0',
      sessionID: 'thread-1',
      role: 'user',
      time: { created: 1 },
      agent: 'codex',
      model: { providerID: 'codex', modelID: 'codex' },
    } as MessageInfo);
    messages.updateMessage({
      id: 'turn_1:assistant',
      sessionID: 'thread-1',
      role: 'assistant',
      time: { created: 2 },
      parentID: 'turn_1:user:0',
      modelID: 'codex',
      providerID: 'codex',
      mode: 'codex',
      agent: 'codex',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageInfo);
    messages.updatePart({
      id: 'turn_1:assistant:text',
      sessionID: 'thread-1',
      messageID: 'turn_1:assistant',
      type: 'text',
      text: 'temporary stream',
      time: { start: 2 },
    });

    messages.reset();
    messages.loadHistory([
      {
        info: {
          id: 'turn_1:user:0',
          sessionID: 'thread-1',
          role: 'user',
          time: { created: 1 },
          agent: 'codex',
          model: { providerID: 'codex', modelID: 'codex' },
        },
        parts: [{
          id: 'turn_1:user:0:text',
          sessionID: 'thread-1',
          messageID: 'turn_1:user:0',
          type: 'text',
          text: 'prompt',
          time: { start: 1, end: 1 },
        }],
      },
      {
        info: {
          id: 'turn_1:assistant',
          sessionID: 'thread-1',
          role: 'assistant',
          time: { created: 2, completed: 3 },
          parentID: 'turn_1:user:0',
          modelID: 'codex',
          providerID: 'codex',
          mode: 'codex',
          agent: 'codex',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
          id: 'turn_1:assistant:text',
          sessionID: 'thread-1',
          messageID: 'turn_1:assistant',
          type: 'text',
          text: 'final answer',
          time: { start: 2, end: 3 },
        }],
      },
    ]);

    expect(messages.roots.value).toHaveLength(1);
    expect(messages.getTextContent('turn_1:assistant')).toBe('final answer');
    expect(messages.getThread('turn_1:user:0').map((entry) => entry.id)).toEqual(['turn_1:user:0', 'turn_1:assistant']);
  });
});
