import { describe, expect, it, vi } from 'vitest';
import { mountRuntimeApp } from './test/runtimeAppHarness';

describe('App root history request binding', () => {
  it('Given a ready Bridge-connected App, When the user selects a session, Then its qualified runtime history is loaded and rendered', async () => {
    const fixture = await mountRuntimeApp([
      {
        info: {
          id: 'message-from-backend', sessionID: 'session-a', role: 'user',
          agent: 'build', model: { providerID: 'provider-a', modelID: 'model-a' },
          time: { created: 101 },
        },
        parts: [{
          id: 'part-from-backend', messageID: 'message-from-backend', sessionID: 'session-a',
          type: 'text', text: 'Loaded through the App history boundary',
        }],
      },
    ]);
    await fixture.connect();
    expect(fixture.historyOpens).toHaveLength(0);
    await fixture.select('Session A');
    await vi.waitFor(() => {
      expect(fixture.historyOpens).toContainEqual({
        environmentId: fixture.environmentId,
        harnessInstanceId: expect.any(String), nativeSessionId: 'session-a',
      });
      expect(fixture.element.querySelectorAll('.thread-block')).toHaveLength(1);
      expect(fixture.element.textContent).toContain('Loaded through the App history boundary');
    });
    await fixture.unmount();
  }, 30000);
});
