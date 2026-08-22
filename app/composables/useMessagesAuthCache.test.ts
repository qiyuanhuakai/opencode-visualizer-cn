import { describe, expect, it } from 'vitest';
import { useMessages } from './useMessages';

describe('useMessages authentication cache lifecycle', () => {
  it('clears all warm snapshots when the authentication context changes', () => {
    const messages = useMessages();
    messages.reset();
    messages.updateMessage({
      id: 'message-auth',
      sessionID: 'session-auth',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'test', modelID: 'test-model' },
    });
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
