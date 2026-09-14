import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHistoryApp } from './test/appHarness';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
});

describe('App root history request binding', () => {
  it('Given a ready App, When the user selects a session in the real picker, Then App loads and renders its history through the production loader', async () => {
    const fixture = await mountHistoryApp([
      {
        info: {
          id: 'message-from-backend',
          sessionID: 'session-a',
          role: 'user',
          agent: 'build',
          model: { providerID: 'provider-a', modelID: 'model-a' },
          time: { created: 101 },
        },
        parts: [
          {
            id: 'part-from-backend',
            messageID: 'message-from-backend',
            sessionID: 'session-a',
            type: 'text',
            text: 'Loaded through the App history boundary',
          },
        ],
      },
    ]);
    mountedApps.push(fixture);
    await vi.waitFor(() => expect(fixture.listSessionMessages).toHaveBeenCalled());
    fixture.listSessionMessages.mockClear();

    const picker = fixture.host.querySelector('.top-panel .ui-dropdown-button');
    expect(picker).toBeInstanceOf(HTMLButtonElement);
    picker?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      const session = Array.from(fixture.host.querySelectorAll('.ui-dropdown-item')).find((item) =>
        item.textContent?.includes('Session A'),
      );
      if (!session) throw new Error('Session A did not appear in the picker');
      session.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() =>
      expect(fixture.listSessionMessages).toHaveBeenCalledWith('session-a', {
        directory: '/repo',
      }),
    );
    await vi.waitFor(() => expect(fixture.host.querySelectorAll('.thread-block')).toHaveLength(1));
  });
});
