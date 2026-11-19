import { expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mountRuntimeApp } from './test/runtimeAppHarness';
import { makeAssistantMessage, makeTextPart, makeToolPart, makeUserMessage } from './components/historyTestBuilders';
import { useMessages } from './composables/useMessages';

vi.mock('./components/MessageViewer.vue', () => ({
  default: defineComponent({ props: ['code'], setup: (props) => () => h('div', props.code) }),
}));

async function openChild(read: () => Promise<unknown>, childSessionId = 'child', historyPageSize?: number) {
  const task = makeToolPart('answer', 'session-a', 'task');
  const history = [
    { info: makeUserMessage('session-a', 'question', 1), parts: [] },
    {
      info: makeAssistantMessage('session-a', 'answer', 'question', 2),
      parts: [{ ...task, state: { ...task.state, status: 'completed', title: 'child', output: '', time: { start: 2, end: 3 }, metadata: { sessionId: childSessionId } } }],
    },
  ];
  const wireHistory: Parameters<typeof mountRuntimeApp>[0] = JSON.parse(JSON.stringify(history));
  const fixture = await mountRuntimeApp(wireHistory, {
    childSessions: [childSessionId], historyPageSize,
    readHistory: async selected => selected.nativeSessionId === 'session-a' ? wireHistory : JSON.parse(JSON.stringify(await read())),
  });
  await fixture.connect();
  await fixture.select('Session A');
  await vi.waitFor(() => expect(fixture.element.querySelector('.ib-action-subagent')).not.toBeNull());
  expect(fixture.historyOpens.some(session => session.nativeSessionId === childSessionId)).toBe(false);
  fixture.element.querySelector<HTMLButtonElement>('.ib-action-subagent')?.click();
  return fixture;
}

it('loads OpenCode child history on demand when background hydration has no child messages', async () => {
  const fixture = await openChild(async () => [{
    info: makeAssistantMessage('child', 'child-answer', 'child-question', 4),
    parts: [makeTextPart('child-answer', 'child', 'Recovered child answer')],
  }], 'child');
  await vi.waitFor(() => expect(fixture.historyOpens).toContainEqual(expect.objectContaining({ environmentId: fixture.environmentId, nativeSessionId: 'child' })));
  await vi.waitFor(() => expect(document.querySelector('.subagent-history .history-item')).not.toBeNull());
  expect(document.querySelector('.subagent-history')?.textContent).toContain('Recovered child answer');
  expect(fixture.element.querySelectorAll('.thread-block')).toHaveLength(1);
}, 30000);

it('keeps already observed child history when OpenCode has discarded its transcript', async () => {
  await openChild(async () => {
    useMessages().loadHistory([{
      info: makeAssistantMessage('retained-child-session', 'retained-child', 'retained-question', 5),
      parts: [makeTextPart('retained-child', 'retained-child-session', 'Previously observed child history')],
    }]);
    return [];
  }, 'retained-child-session');
  await vi.waitFor(() => expect(document.querySelector('.subagent-history')?.textContent).toContain('Previously observed child history'));
}, 30000);

it('shows failed OpenCode child reads instead of a misleading empty history', async () => {
  await openChild(async () => { throw new Error('Child read failed'); }, 'failed-child-session');
  await vi.waitFor(() => expect(document.querySelector('.subagent-history [role="alert"]')?.textContent).toContain('Unable to load subagent history. Try again.'));
}, 30000);

it('distinguishes an empty child transcript from a malformed response', async () => {
  await openChild(async () => [], 'empty-child-session');
  await vi.waitFor(() => expect(document.querySelector('.subagent-history .subagent-empty')?.textContent).toContain('No subagent history available yet.'));
  expect(document.querySelector('.subagent-history [role="alert"]')).toBeNull();
  expect(document.querySelector('.subagent-history .history-item')).toBeNull();
}, 30000);

it('reports malformed OpenCode history responses as an error', async () => {
  await openChild(async () => [{ info: { id: 'malformed-native-message', sessionID: 'invalid-child-session', role: 'invalid-role' }, parts: [] }], 'invalid-child-session');
  await vi.waitFor(() => expect(document.querySelector('.subagent-history [role="alert"]')?.textContent).toContain('Invalid OpenCode session history entry.'));
}, 30000);

it('pages a child window without retiring the parent history and releases its own reader on close', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    info: makeAssistantMessage('paged-child', `child-${index}`, 'child-question', index + 4),
    parts: [makeTextPart(`child-${index}`, 'paged-child', `Child page entry ${index}`)],
  }));
  const fixture = await openChild(async () => rows, 'paged-child', 100);
  await vi.waitFor(() => expect(document.querySelector('.subagent-history')?.textContent).toContain('Child page entry 99'));
  expect(fixture.historyCloses.some(session => session.nativeSessionId === 'session-a')).toBe(false);
  const next = () => [...document.querySelectorAll<HTMLButtonElement>('.subagent-history button')].find(button => button.textContent?.includes('Next history page'));
  expect(next()).toBeDefined();
  next()!.click();
  await vi.waitFor(() => expect(document.querySelector('.subagent-history')?.textContent).toContain('Child page entry 199'));
  next()!.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.subagent-history')?.textContent).toContain('Child page entry 204');
    const rendered = document.querySelectorAll('.subagent-history .history-item').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(200);
    expect(fixture.historyPages.filter(page => page.session.nativeSessionId === 'paged-child').map(page => page.cursor)).toEqual([null, '100', '200']);
    expect(next()).toBeUndefined();
  });
  document.querySelector<HTMLButtonElement>('.subagent-history .subagent-close-button')!.click();
  await vi.waitFor(() => expect(document.querySelector('.subagent-history')).toBeNull());
  await vi.waitFor(() => expect(fixture.historyCloses).toContainEqual(expect.objectContaining({ nativeSessionId: 'paged-child' })));
  expect(fixture.historyCloses.some(session => session.nativeSessionId === 'session-a')).toBe(false);
}, 30000);

it('retries a failed child read through its own Bridge connection without retiring the parent', async () => {
  let attempts = 0;
  const fixture = await openChild(async () => {
    if (++attempts === 1) throw new Error('Transient child failure');
    return [{ info: makeAssistantMessage('retry-child', 'recovered-child', 'child-question', 4),
      parts: [makeTextPart('recovered-child', 'retry-child', 'Recovered after child retry')] }];
  }, 'retry-child');
  await vi.waitFor(() => expect(document.querySelector('.subagent-history [role="alert"]')?.textContent).toContain('Unable to load subagent history.'));
  const retry = [...document.querySelectorAll<HTMLButtonElement>('.subagent-history button')].find(button => button.textContent === 'Retry');
  expect(retry).toBeDefined();
  retry!.click();
  await vi.waitFor(() => expect(document.querySelector('.subagent-history')?.textContent).toContain('Recovered after child retry'));
  expect(document.querySelector('.subagent-history [role="alert"]')).toBeNull();
  expect(fixture.historyOpens.filter(session => session.nativeSessionId === 'retry-child')).toHaveLength(2);
  expect(fixture.historyCloses.some(session => session.nativeSessionId === 'session-a')).toBe(false);
}, 30000);

it('discards the captured child window on logout so reconnect cannot reopen its old reader', async () => {
  const fixture = await openChild(async () => [{ info: makeAssistantMessage('logout-child', 'old-child', 'child-question', 4),
    parts: [makeTextPart('old-child', 'logout-child', 'History from the old connection')] }], 'logout-child');
  await vi.waitFor(() => expect(document.querySelector('.subagent-history')?.textContent).toContain('History from the old connection'));
  fixture.element.querySelector<HTMLButtonElement>('.logout-button')!.click();
  await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid=bridge-login]')).not.toBeNull());
  await fixture.connect();
  await vi.waitFor(() => expect(fixture.element.querySelector('.top-panel')).not.toBeNull());
  expect(document.querySelector('.subagent-history')).toBeNull();
  expect(fixture.historyOpens.filter(session => session.nativeSessionId === 'logout-child')).toHaveLength(1);
}, 30000);
