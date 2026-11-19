import { expect, it, vi } from 'vitest';
import { mountRuntimeApp } from './test/runtimeAppHarness';

it('connects through Bridge login and renders selected native history over the actual runtime wire', async () => {
  const fixture = await mountRuntimeApp([{ info: { id: 'message-from-backend', sessionID: 'session-a', role: 'user', time: { created: 101 } }, parts: [{ id: 'part-from-backend', messageID: 'message-from-backend', sessionID: 'session-a', type: 'text', text: 'History through the qualified Bridge boundary' }] }]);
  expect(fixture.element.querySelector('.app-login-backend')).toBeNull();
  await fixture.connect();
  await fixture.select('Session A');
  await vi.waitFor(() => expect(fixture.element.textContent).toContain('History through the qualified Bridge boundary'), { timeout: 10000 });
  expect(fixture.historyOpens).toEqual([expect.objectContaining({ environmentId: fixture.environmentId, nativeSessionId: 'session-a' })]);
  expect(fixture.element.querySelectorAll('.thread-block')).toHaveLength(1);
  await fixture.select('Session B');
  await vi.waitFor(() => {
    expect(fixture.historyOpens.at(-1)).toEqual(expect.objectContaining({ environmentId: fixture.environmentId, nativeSessionId: 'session-b' }));
    expect(fixture.element.textContent).not.toContain('History through the qualified Bridge boundary');
  }, { timeout: 10000 });
  expect(fixture.historyOpens.every(session => session.environmentId === fixture.environmentId)).toBe(true);
}, 30000);

it('opens the selected session as a Host Thread through the Bridge', async () => {
  const fixture = await mountRuntimeApp([]);
  await fixture.connect();
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
}, 30000);
