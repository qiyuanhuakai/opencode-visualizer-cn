import { expect, it, vi } from 'vitest';
import { mountRuntimeApp } from './test/runtimeAppHarness';

it('connects through Bridge login and renders selected native history over the actual runtime wire', async () => {
  const fixture = await mountRuntimeApp([{ info: { id: 'message-from-backend', sessionID: 'session-a', role: 'user', time: { created: 101 } }, parts: [{ id: 'part-from-backend', messageID: 'message-from-backend', sessionID: 'session-a', type: 'text', text: 'History through the qualified Bridge boundary' }] }]);
  expect(fixture.element.querySelector('.app-login-backend')).toBeNull();
  await fixture.connect();
  const inspections = fixture.frames.filter(frame => frame.direction === 'send'
    && (frame.value as { method?: string }).method === 'runtime.inspect');
  expect(inspections).toHaveLength(1);
  await fixture.select('Session A');
  await vi.waitFor(() => expect(fixture.element.textContent).toContain('History through the qualified Bridge boundary'), { timeout: 10000 });
  expect(fixture.historyOpens).toEqual([expect.objectContaining({ environmentId: fixture.environmentId, nativeSessionId: 'session-a' })]);
  expect(fixture.element.querySelectorAll('.thread-block')).toHaveLength(1);
  const manager = fixture.element.querySelector('[data-testid="management-agent-selector"]')!;
  expect(manager.querySelector('button')?.textContent).toContain('OpenCode');
  fixture.element.querySelector<HTMLButtonElement>('button[title="Status monitor"]')!.click();
  const monitor = await vi.waitFor(() => {
    const button = fixture.element.querySelector<HTMLButtonElement>('.status-monitor-popover [data-testid="management-agent-selector"] button');
    expect(button?.getAttribute('aria-label')).toContain('OpenCode');
    return button!;
  });
  monitor.click();
  const codex = await vi.waitFor(() => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Codex'));
    expect(item).toBeTruthy();
    return item!;
  });
  codex.click();
  await vi.waitFor(() => {
    expect(manager.querySelector('button')?.textContent).toContain('Codex');
    expect(monitor.getAttribute('aria-label')).toContain('Codex');
  });
  fixture.element.querySelector<HTMLButtonElement>('button[aria-label="Close status monitor"]')!.click();
  fixture.element.querySelector<HTMLButtonElement>('button[title="Providers & models"]')!.click();
  await vi.waitFor(() => {
    const providerSelector = fixture.element.querySelector<HTMLButtonElement>('dialog[open].provider-manager-backdrop [data-testid="management-agent-selector"] button');
    expect(providerSelector?.getAttribute('aria-label')).toContain('Codex');
  });
  fixture.element.querySelector<HTMLDialogElement>('dialog[open].provider-manager-backdrop')!.close();
  expect(fixture.element.textContent).toContain('History through the qualified Bridge boundary');
  expect(fixture.historyOpens).toHaveLength(1);

  await fixture.select('Session B');
  await vi.waitFor(() => {
    expect(fixture.historyOpens.at(-1)).toEqual(expect.objectContaining({ environmentId: fixture.environmentId, nativeSessionId: 'session-b' }));
    expect(fixture.element.textContent).not.toContain('History through the qualified Bridge boundary');
  }, { timeout: 10000 });
  expect(fixture.historyOpens.every(session => session.environmentId === fixture.environmentId)).toBe(true);
}, 30000);

it('opens a Host Thread, refreshes a participant’s own history, and locates their session', async () => {
  let participantText = 'Initial participant history';
  let pauseRead = false;
  const pausedRead = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const fixture = await mountRuntimeApp([], {
    secondWorktree: true,
    readHistory: async session => {
      if (session.nativeSessionId !== 'session-b') return [];
      if (pauseRead) {
        pausedRead.resolve();
        await releaseRead.promise;
      }
      return [{
        info: { id: 'b-history', sessionID: 'session-b', role: 'user', time: { created: 101 } },
        parts: [{ id: 'b-part', messageID: 'b-history', sessionID: 'session-b', type: 'text', text: participantText }],
      }];
    },
  });
  await fixture.connect();
  // Both granted worktrees resolve to the same real Git repository.
  await vi.waitFor(async () => {
    const { items } = await fixture.workspaceTopology();
    const entries = items.map(item => item.value as { gitKind: string; repoKey: string | null; workspace: { canonicalPath: string } });
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.workspace.canonicalPath)).toContain(fixture.secondDirectory);
    expect(entries.every(entry => entry.gitKind === 'git' && entry.repoKey !== null)).toBe(true);
    expect(new Set(entries.map(entry => entry.repoKey)).size).toBe(1);
  });
  await fixture.select('Session A');
  const opener = await vi.waitFor(() => {
    const button = fixture.element.querySelector<HTMLButtonElement>('[data-testid="open-runtime-thread"]');
    if (!button || button.disabled) throw new Error('Selected session cannot open a Host Thread');
    return button;
  });
  opener.click();
  await vi.waitFor(() => {
    const view = fixture.element.querySelector('[data-testid="thread-view"]');
    expect(view?.querySelector('[data-testid="thread-meta"]')).toBeTruthy();
    expect(view?.querySelector('[data-testid="thread-error"]')).toBeNull();
  }, { timeout: 10000 });
  const add = await vi.waitFor(() => {
    const button = fixture.element.querySelector<HTMLButtonElement>('[data-testid="add-source"][data-native-session-id="session-b"]');
    expect(button?.disabled).toBe(false);
    return button!;
  });
  add.click();
  const historyGroup = await vi.waitFor(() => {
    const label = fixture.element.querySelector('[data-testid="native-history-session"][title="session-b"]');
    const group = label?.closest('[data-testid="native-history-group"]');
    expect(group?.querySelector<HTMLButtonElement>('[data-testid="browse-native-history"]')?.disabled).toBe(false);
    return group!;
  });
  const refresh = historyGroup.querySelector<HTMLButtonElement>('[data-testid="browse-native-history"]')!;
  refresh.click();
  await vi.waitFor(() => {
    expect(refresh.disabled).toBe(false);
    expect(historyGroup.textContent).toContain('Initial participant history');
  }, { timeout: 5000 });
  participantText = 'Refreshed participant history';
  refresh.click();
  await vi.waitFor(() => {
    expect(refresh.disabled).toBe(false);
    expect(historyGroup.textContent).toContain('Refreshed participant history');
    expect(historyGroup.textContent).not.toContain('Initial participant history');
    expect(fixture.historyPages.filter(page => page.session.nativeSessionId === 'session-b')).toHaveLength(2);
  }, { timeout: 5000 });
  pauseRead = true;
  participantText = 'Late result from the closed panel';
  refresh.click();
  try {
    await pausedRead.promise;
    fixture.element.querySelector<HTMLButtonElement>('[data-testid="thread-view-close"]')!.click();
    await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid="thread-view"][open]')).toBeNull());
  } finally {
    pauseRead = false;
    releaseRead.resolve();
  }
  await vi.waitFor(() => expect(fixture.historyCloses.filter(session => session.nativeSessionId === 'session-b')).toHaveLength(3));
  const reopen = fixture.element.querySelector<HTMLButtonElement>('[data-testid="open-runtime-thread"]');
  expect(reopen?.disabled).toBe(false);
  reopen!.click();
  await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid="thread-view"][open]')).toBeTruthy(), { timeout: 3000 });
  const reopenedHistory = fixture.element.querySelector('[data-testid="thread-view"][open] [data-testid="native-history"]');
  expect(reopenedHistory).toBeTruthy();
  expect(reopenedHistory?.textContent).not.toContain('Late result from the closed panel');
  const reopenedRow = fixture.element.querySelector('[data-testid="participant-session"][title="session-b"]')?.closest('[data-testid="participant-row"]');
  const reopenedLocate = reopenedRow?.querySelector<HTMLButtonElement>('[data-testid="locate-session"]');
  expect(reopenedLocate?.disabled).toBe(false);
  reopenedLocate!.click();
  await vi.waitFor(() => expect(fixture.historyPages.filter(page => page.session.nativeSessionId === 'session-b')).toHaveLength(4));
  const participantId = reopenedRow?.getAttribute('data-participant-id');
  expect(participantId).toBeTruthy();
  await vi.waitFor(() => {
    const resolution = fixture.element.querySelector('[data-testid="thread-for-session"]');
    expect(resolution?.getAttribute('data-participant-id')).toBe(participantId);
    expect(resolution?.getAttribute('data-unresolved')).toBe('false');
  });
  fixture.element.querySelector<HTMLButtonElement>('[data-testid="thread-view-close"]')!.click();
  await fixture.select('Session A');
  await vi.waitFor(() => {
    const owner = fixture.element.querySelector('[data-testid="participant-row"][data-role="owner"]');
    const resolution = fixture.element.querySelector('[data-testid="thread-for-session"]');
    expect(owner?.getAttribute('data-participant-id')).toBeTruthy();
    expect(resolution?.getAttribute('data-participant-id')).toBe(owner?.getAttribute('data-participant-id'));
  });
}, 30000);

it('loads DSH account status from the management instance while OpenCode owns the conversation', async () => {
  const dshAccount = { status: 'signed-in' };
  const fixture = await mountRuntimeApp([], { dshAccount });
  await fixture.connect();
  await fixture.select('Session A');
  await vi.waitFor(() => expect(fixture.historyOpens.map(session => session.nativeSessionId)).toEqual(['session-a']), { timeout: 10000 });
  fixture.element.querySelector<HTMLButtonElement>('button[title="Status monitor"]')!.click();
  const monitor = await vi.waitFor(() => {
    const panel = fixture.element.querySelector('.status-monitor-popover');
    expect(panel).toBeTruthy();
    return panel!;
  });
  monitor.querySelector<HTMLButtonElement>('[data-testid="management-agent-selector"] button')!.click();
  const option = [...monitor.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes('DSH'));
  expect(option).toBeTruthy();
  option!.click();
  await vi.waitFor(() => expect(monitor.textContent).toContain('Signed in'));
  expect(fixture.nativeQueries.filter(query => query.operation === 'dsh.ui.account.getState')).toEqual([
    { operation: 'dsh.ui.account.getState' },
  ]);
  dshAccount.status = 'signed-out';
  await vi.waitFor(() => {
    const refresh = monitor.querySelector<HTMLButtonElement>('button.refresh-button');
    expect(refresh?.disabled).toBe(false);
    refresh!.click();
  });
  await vi.waitFor(() => expect(monitor.textContent).toContain('Signed out'));
  expect(fixture.nativeQueries.filter(query => query.operation === 'dsh.ui.account.getState')).toEqual([
    { operation: 'dsh.ui.account.getState' },
    { operation: 'dsh.ui.account.getState' },
  ]);
  expect(fixture.historyOpens.map(session => session.nativeSessionId)).toEqual(['session-a']);
}, 30000);

it('hides a slash-containing model from Bridge providers without changing the active conversation', async () => {
  const fixture = await mountRuntimeApp([], { additionalModelId: 'org/model/v1' });
  await fixture.connect();
  await fixture.select('Session A');
  await vi.waitFor(() => expect(fixture.historyOpens.at(-1)?.nativeSessionId).toBe('session-a'));
  const historyCount = fixture.historyOpens.length;
  const providerQueries = fixture.nativeQueries.filter(query => query.operation === 'listProviders').length;

  fixture.element.querySelector<HTMLButtonElement>('.provider-manager-button')!.click();
  const models = await vi.waitFor(() => {
    const tab = [...fixture.element.querySelectorAll<HTMLButtonElement>('.provider-manager-tab')].find(item => item.textContent?.trim() === 'Model management');
    expect(tab).toBeTruthy();
    return tab!;
  });
  models.click();
  const toggle = await vi.waitFor(() => {
    const row = [...fixture.element.querySelectorAll('.model-row')].find(item => item.textContent?.includes('Slash Model'));
    const input = row?.querySelector<HTMLInputElement>('.toggle-input');
    expect(input?.checked).toBe(true);
    return input!;
  });
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => {
    const value = JSON.parse(localStorage.getItem('opencode.global.dat:model') ?? '{}');
    expect(value.user).toContainEqual({ providerID: 'provider-a', modelID: 'org/model/v1', visibility: 'hide' });
  });
  expect(fixture.nativeQueries.filter(query => query.operation === 'listProviders').length).toBeGreaterThan(providerQueries);
  expect(fixture.historyOpens).toHaveLength(historyCount);
}, 15000);

it('publishes returned config in the Bridge provider panel without changing the active conversation', async () => {
  const fixture = await mountRuntimeApp([], { editableProvider: true });
  await fixture.connect();
  await fixture.select('Session A');
  await vi.waitFor(() => expect(fixture.historyOpens.at(-1)?.nativeSessionId).toBe('session-a'));
  fixture.element.querySelector<HTMLButtonElement>('.provider-manager-button')!.click();
  const toggle = await vi.waitFor(() => {
    const input = fixture.element.querySelector<HTMLInputElement>('.provider-list-row .toggle-input');
    expect(input?.checked).toBe(true);
    return input!;
  });
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  toggle.checked = true;
  await vi.waitFor(() => {
    expect(fixture.nativeQueries.some(query => query.operation === 'updateGlobalConfig')).toBe(true);
    const current = fixture.element.querySelector<HTMLInputElement>('.provider-list-row .toggle-input');
    expect(current?.checked, fixture.element.querySelector('.provider-manager-feedback')?.textContent ?? '').toBe(false);
  });
  expect(fixture.element.querySelector('.selected-title')?.textContent).toBe('Session A');
  expect(fixture.historyOpens.at(-1)?.nativeSessionId).toBe('session-a');
}, 15000);

it('places archived ACP protocol sessions in the unified archived section', async () => {
  const fixture = await mountRuntimeApp([], { archivedAcpSession: true });
  await fixture.connect();
  const archive = await vi.waitFor(() => {
    const row = [...fixture.element.querySelectorAll('[role="treeitem"]')].find(item => item.textContent?.includes('Archived'));
    expect(row, fixture.element.querySelector('[data-testid=unified-session-tree]')?.textContent).toBeTruthy();
    return row!;
  }, { timeout: 10000 });
  expect(fixture.element.textContent).not.toContain('Archived ACP session');
  archive.querySelector<HTMLElement>('[data-testid="row-toggle"]')!.click();
  await vi.waitFor(() => {
    const session = [...fixture.element.querySelectorAll('[role="treeitem"]')].find(item => item.textContent?.includes('Archived ACP session'));
    expect(session).toBeTruthy();
    expect(Number(session?.getAttribute('aria-level'))).toBeGreaterThan(Number(archive.getAttribute('aria-level')));
  });
}, 20000);
