import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMessages } from './useMessages';
import { assistantMessage, textPart, toolPart, userMessage } from './useMessages.test-helpers';

describe('useMessages history and realtime state', () => {
  beforeEach(() => {
    useMessages().reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves per-file patches from user message summary diffs', () => {
    const messages = useMessages();

    messages.updateMessage(
      userMessage('msg-1', {
        sessionID: 'session-1',
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
      }),
    );

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
        info: assistantMessage('assistant-1', {
          sessionID: 'session-1',
          time: { created: 1, completed: 2 },
          parentID: 'user-1',
        }),
        parts: [
          toolPart('assistant-1', {
            status: 'running',
            input: { command: 'ls' },
            title: 'ls',
            metadata: { source: 'codex' },
            time: { start: 1 },
          }),
        ],
      },
    ]);

    messages.loadHistory([
      {
        info: assistantMessage('assistant-1', {
          sessionID: 'session-1',
          time: { created: 1, completed: 3 },
          parentID: 'user-1',
        }),
        parts: [
          toolPart('assistant-1', {
            status: 'completed',
            input: { command: 'ls' },
            output: 'done',
            title: 'ls',
            metadata: { source: 'codex' },
            time: { start: 1, end: 3 },
          }),
        ],
      },
    ]);

    expect(messages.getPartsByType('assistant-1', 'tool')[0]?.state.status).toBe('completed');
  });

  it('removes provisional messages and their parts', () => {
    const messages = useMessages();

    messages.loadHistory([
      {
        info: userMessage('codex:turn:pending-turn:123:user:0', {
          sessionID: 'session-1',
        }),
        parts: [
          textPart('codex:turn:pending-turn:123:user:0', {
            id: 'codex:turn:pending-turn:123:user:0:text',
            sessionID: 'session-1',
            text: 'hello',
            time: { start: 1, end: 1 },
          }),
        ],
      },
    ]);

    messages.removeMessage('codex:turn:pending-turn:123:user:0');

    expect(messages.get('codex:turn:pending-turn:123:user:0')).toBeUndefined();
    expect(messages.getParts('codex:turn:pending-turn:123:user:0')).toEqual([]);
  });

  it('does not duplicate assistant reply when streaming state is followed by completed history reload', () => {
    const messages = useMessages();

    messages.updateMessage(userMessage('turn_1:user:0'));

    messages.updateMessage(assistantMessage('turn_1:assistant'));
    messages.updatePart(
      textPart('turn_1:assistant', {
        text: 'partial',
        time: { start: 2 },
      }),
    );

    messages.loadHistory([
      {
        info: assistantMessage('turn_1:assistant', {
          time: { created: 2, completed: 3 },
        }),
        parts: [
          textPart('turn_1:assistant', {
            text: 'final answer',
            time: { start: 2, end: 3 },
          }),
        ],
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

    messages.updateMessage(userMessage('turn_1:user:0'));
    messages.updateMessage(assistantMessage('turn_1:assistant'));
    messages.updatePart(
      textPart('turn_1:assistant', {
        text: 'temporary stream',
        time: { start: 2 },
      }),
    );

    messages.reset();
    messages.loadHistory([
      {
        info: userMessage('turn_1:user:0'),
        parts: [
          textPart('turn_1:user:0', {
            text: 'prompt',
            time: { start: 1, end: 1 },
          }),
        ],
      },
      {
        info: assistantMessage('turn_1:assistant', {
          time: { created: 2, completed: 3 },
        }),
        parts: [
          textPart('turn_1:assistant', {
            text: 'final answer',
            time: { start: 2, end: 3 },
          }),
        ],
      },
    ]);

    expect(messages.roots.value).toHaveLength(1);
    expect(messages.getTextContent('turn_1:assistant')).toBe('final answer');
    expect(messages.getThread('turn_1:user:0').map((entry) => entry.id)).toEqual([
      'turn_1:user:0',
      'turn_1:assistant',
    ]);
  });

  it('preserves older canonical history when later realtime-only updates touch the newest message', () => {
    const messages = useMessages();

    messages.loadHistory([
      {
        info: userMessage('turn_1:user:0'),
        parts: [
          textPart('turn_1:user:0', {
            text: 'first question',
            time: { start: 1, end: 1 },
          }),
        ],
      },
      {
        info: assistantMessage('turn_2:assistant', {
          time: { created: 2, completed: 3 },
        }),
        parts: [
          textPart('turn_2:assistant', {
            text: 'latest answer',
            time: { start: 2, end: 3 },
          }),
        ],
      },
    ]);

    messages.updatePart(
      textPart('turn_2:assistant', {
        text: 'latest answer updated',
        time: { start: 2, end: 4 },
      }),
    );

    expect(messages.get('turn_1:user:0')?.role).toBe('user');
    const firstUserPart = messages.getParts('turn_1:user:0')[0];
    const latestAssistantPart = messages.getParts('turn_2:assistant')[0];
    expect(firstUserPart?.type).toBe('text');
    expect(latestAssistantPart?.type).toBe('text');
    if (!firstUserPart || firstUserPart.type !== 'text')
      throw new Error('Expected first user text part');
    if (!latestAssistantPart || latestAssistantPart.type !== 'text')
      throw new Error('Expected latest assistant text part');
    expect(firstUserPart.text).toBe('first question');
    expect(latestAssistantPart.text).toBe('latest answer updated');
  });

  it('yields to a browser task between history chunks', async () => {
    const messages = useMessages();
    const yieldControl = vi.fn().mockResolvedValue(undefined);

    await messages.loadHistoryIncrementally([null, null], { chunkSize: 1, yieldControl });

    expect(yieldControl).toHaveBeenCalledOnce();
  });

  it('uses background browser-task priority for default history yields when available', async () => {
    const postTask = vi.fn(async (callback: () => void, _options: { priority: 'background' }) =>
      callback(),
    );
    vi.stubGlobal('scheduler', { postTask });

    await useMessages().loadHistoryIncrementally([null, null], { chunkSize: 1 });

    expect(postTask).toHaveBeenCalledOnce();
    expect(postTask.mock.calls[0]?.[1]).toEqual({ priority: 'background' });
  });

  it('does not retain a session larger than the warm-cache byte budget', () => {
    const messages = useMessages();
    messages.loadHistory([
      {
        info: userMessage('oversized-cache-message', {
          sessionID: 'oversized-cache-session',
          agent: 'build',
          model: { providerID: 'test', modelID: 'test-model' },
        }),
        parts: [
          textPart('oversized-cache-message', {
            id: 'oversized-cache-part',
            sessionID: 'oversized-cache-session',
            text: 'x'.repeat(17 * 1024 * 1024),
            time: { start: 1, end: 1 },
          }),
        ],
      },
    ]);

    messages.saveSessionState({ namespace: 'opencode:a', sessionId: 'oversized-cache-session' });
    messages.reset();

    expect(
      messages.tryLoadFromCache({ namespace: 'opencode:a', sessionId: 'oversized-cache-session' }),
    ).toBe(false);
  });

  it('isolates warm entries by backend and directory identity', () => {
    const messages = useMessages();
    messages.loadHistory([
      {
        info: userMessage('scoped-cache-message', {
          sessionID: 'scoped-cache-session',
          agent: 'build',
          model: { providerID: 'test', modelID: 'test-model' },
        }),
        parts: [],
      },
    ]);

    messages.saveSessionState({
      namespace: 'opencode:endpoint-a:/repo-a',
      sessionId: 'scoped-cache-session',
    });
    messages.reset();

    expect(
      messages.tryLoadFromCache({
        namespace: 'opencode:endpoint-b:/repo-a',
        sessionId: 'scoped-cache-session',
      }),
    ).toBe(false);
    expect(
      messages.tryLoadFromCache({
        namespace: 'opencode:endpoint-a:/repo-a',
        sessionId: 'scoped-cache-session',
      }),
    ).toBe(true);
  });

  it('publishes each history chunk before yielding to the next browser task', async () => {
    const messages = useMessages();
    expect(messages.roots.value).toHaveLength(0);
    const entries = [1, 2].map((created) => ({
      info: userMessage(`user-${created}`, {
        sessionID: 'session-1',
        time: { created },
        agent: 'build',
        model: { providerID: 'test', modelID: 'test-model' },
      }),
      parts: [],
    }));
    const yieldControl = vi.fn(async () => {
      await Promise.resolve();
      expect(messages.roots.value).toHaveLength(1);
      expect(messages.roots.value[0]?.id).toBe('user-2');
    });

    await messages.loadHistoryIncrementally(entries, { chunkSize: 1, yieldControl });

    expect(yieldControl).toHaveBeenCalledOnce();
    expect(messages.roots.value).toHaveLength(2);
  });
});

describe('useMessages authentication cache lifecycle', () => {
  it('clears all warm snapshots when the authentication context changes', () => {
    const messages = useMessages();
    messages.reset();
    messages.updateMessage(
      userMessage('message-auth', {
        sessionID: 'session-auth',
        agent: 'build',
        model: { providerID: 'test', modelID: 'test-model' },
      }),
    );
    messages.saveSessionState({
      namespace: 'opencode:primary:/repo',
      sessionId: 'session-auth',
    });

    messages.clearSessionCache();

    expect(
      messages.tryLoadFromCache({
        namespace: 'opencode:primary:/repo',
        sessionId: 'session-auth',
      }),
    ).toBe(false);
    messages.reset();
  });
});
