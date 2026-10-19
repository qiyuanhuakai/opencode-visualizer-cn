import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHistoryApp } from './test/appHarness';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
});

function historyEntry(id: string, text: string) {
  return {
    info: {
      id,
      sessionID: 'session-a',
      role: 'user',
      agent: 'build',
      model: { providerID: 'provider-a', modelID: 'model-a' },
      time: { created: 101 },
    },
    parts: [
      {
        id: `part-${id}`,
        messageID: id,
        sessionID: 'session-a',
        type: 'text',
        text,
      },
    ],
  };
}

async function selectSessionA(fixture: { host: HTMLElement }) {
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
}

describe('App is the real container of the Host Thread surface', () => {
  it('provides the thread state, so the thread surface can render in the running app', async () => {
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);

    // The seam the review found open: `useRuntimeThreadState()` answered null in
    // the real app, so OutputPanel's ThreadPanel was never mounted there.
    const threadState = fixture.readSetupBinding('threadState');
    expect(threadState).toBeTruthy();
    expect(typeof (threadState as { openThread?: unknown }).openThread).toBe('function');
  });

  it('binds @refresh-native-history on OutputPanel, so the event is not dropped', async () => {
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);

    const outputPanel = fixture.host.querySelector('.output-panel');
    expect(outputPanel).not.toBeNull();
    const listeners = (outputPanel as unknown as { __vnode?: { props?: Record<string, unknown> } }).__vnode?.props;
    expect(listeners).toBeTruthy();
    expect(typeof listeners?.onRefreshNativeHistory).toBe('function');
  });

  it('Refresh re-reads the located participant\'s OWN native history and backfills the panel', async () => {
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);

    // When: the user opens the Host Thread for the selected session.
    const toggle = fixture.host.querySelector<HTMLElement>('[data-testid="host-thread-toggle"]');
    expect(toggle).not.toBeNull();
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="thread-view"]')).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history"]')).not.toBeNull();
    });

    // Then: the container produced a first read through the REAL backend.
    expect(fixture.listSessionMessages).toHaveBeenCalledWith('session-a', { directory: '/repo' });
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'first-read-entry',
      );
    });

    // And: the group names the participant's OWN native session, never a merged one.
    expect(
      fixture.host.querySelector('[data-testid="native-history-session"]')?.textContent?.trim(),
    ).toBe('session-a');

    // When: the backend's history changes and the user clicks Refresh.
    fixture.listSessionMessages.mockResolvedValue([historyEntry('message-2', 'reloaded-entry')]);
    fixture.host.querySelector<HTMLElement>('[data-testid="browse-native-history"]')?.click();

    // Then: the panel shows the RE-READ bytes, not the first read.
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'reloaded-entry',
      );
    });
  });
});
