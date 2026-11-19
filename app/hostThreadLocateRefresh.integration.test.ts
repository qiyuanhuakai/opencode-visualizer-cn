import { expect, it, vi } from 'vitest';
import { mountRuntimeApp } from './test/runtimeAppHarness';

async function openThread(fixture: Awaited<ReturnType<typeof mountRuntimeApp>>) {
  await fixture.connect();
  await fixture.select('Session A');
  const opener = await vi.waitFor(() => {
    const button = fixture.element.querySelector<HTMLButtonElement>('[data-testid="open-runtime-thread"]');
    expect(button?.disabled).toBe(false);
    return button!;
  }, { timeout: 10000 });
  opener.click();
  return vi.waitFor(() => {
    const panel = fixture.element.querySelector('[data-testid="thread-view"][open]');
    expect(panel?.querySelector('[data-testid="thread-meta"]')).toBeTruthy();
    return panel!;
  }, { timeout: 10000 });
}

it('offers Locate only for Thread participants, including when the session tree also contains a non-member', async () => {
  const fixture = await mountRuntimeApp([]);
  const panel = await openThread(fixture);
  const available = panel.querySelector<HTMLButtonElement>('[data-testid="add-source"][data-native-session-id="session-b"]');
  expect(available).toBeTruthy();
  expect(panel.querySelectorAll('[data-testid="locate-session"]')).toHaveLength(1);
  expect(panel.querySelector('[data-testid="participant-session"][title="session-b"]')).toBeNull();

  fixture.element.querySelector<HTMLButtonElement>('[data-testid="thread-view-close"]')!.click();
  await fixture.select('Session B');
  await vi.waitFor(() => {
    const selected = fixture.element.querySelector('[data-testid="thread-for-session"]');
    expect(selected?.getAttribute('data-unresolved')).toBe('true');
    expect(fixture.historyOpens.at(-1)?.nativeSessionId).toBe('session-b');
  }, { timeout: 5000 });
}, 30000);

it('serializes participant Refresh and shows native read failures without substituting another session', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await mountRuntimeApp([], {
    secondWorktree: true,
    readHistory: async (session) => {
      if (session.nativeSessionId !== 'session-b') return [];
      started.resolve();
      await release.promise;
      throw new Error('Controlled native history read failed');
    },
  });
  const panel = await openThread(fixture);
  const add = await vi.waitFor(() => {
    const button = panel.querySelector<HTMLButtonElement>('[data-testid="add-source"][data-native-session-id="session-b"]');
    expect(button?.disabled).toBe(false);
    return button!;
  }, { timeout: 5000 });
  add.click();
  const group = await vi.waitFor(() => {
    const label = panel.querySelector('[data-testid="native-history-session"][title="session-b"]');
    const group = label?.closest('[data-testid="native-history-group"]');
    expect(group?.querySelector<HTMLButtonElement>('[data-testid="browse-native-history"]')?.disabled).toBe(false);
    return group!;
  }, { timeout: 5000 });
  const refresh = group.querySelector<HTMLButtonElement>('[data-testid="browse-native-history"]')!;
  refresh.click();
  try {
    await started.promise;
    expect(refresh.disabled).toBe(true);
    expect([...panel.querySelectorAll<HTMLButtonElement>('[data-testid="browse-native-history"]')].every(button => button.disabled)).toBe(true);
    refresh.click();
  } finally {
    release.resolve();
  }

  await vi.waitFor(() => {
    expect(group.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(refresh.disabled).toBe(false);
  }, { timeout: 5000 });
  expect(group.querySelectorAll('.group-entry')).toHaveLength(0);
  expect(fixture.historyPages.filter(page => page.session.nativeSessionId === 'session-b')).toHaveLength(1);
}, 30000);
