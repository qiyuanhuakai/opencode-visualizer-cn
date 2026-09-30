import { afterEach, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mountHistoryApp } from './test/appHarness';
import { makeAssistantMessage, makeTextPart, makeToolPart, makeUserMessage } from './components/historyTestBuilders';

vi.mock('./components/MessageViewer.vue', () => ({
  default: defineComponent({ props: ['code'], setup: (props) => () => h('div', props.code) }),
}));

const fixtures: Awaited<ReturnType<typeof mountHistoryApp>>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.unmount()));

async function openChild(read: () => Promise<unknown>) {
  const task = makeToolPart('answer', 'session-a', 'task');
  const fixture = await mountHistoryApp([
    { info: makeUserMessage('session-a', 'question', 1), parts: [] },
    {
      info: makeAssistantMessage('session-a', 'answer', 'question', 2),
      parts: [{ ...task, state: { ...task.state, status: 'completed', title: 'child', output: '', time: { start: 2, end: 3 }, metadata: { sessionId: 'child' } } }],
    },
  ]);
  fixtures.push(fixture);
  fixture.host.querySelector<HTMLButtonElement>('.top-panel .ui-dropdown-button')?.click();
  await vi.waitFor(() => {
    const session = Array.from(fixture.host.querySelectorAll<HTMLElement>('.ui-dropdown-item')).find((item) => item.textContent?.includes('Session A'));
    if (!session) throw new Error('Session A is unavailable');
    session.click();
  });
  await vi.waitFor(() => expect(fixture.host.querySelector('.ib-action-subagent')).not.toBeNull());
  fixture.listSessionMessages.mockImplementation(read);
  fixture.host.querySelector<HTMLButtonElement>('.ib-action-subagent')?.click();
  return fixture;
}

it('loads OpenCode child history on demand when background hydration has no child messages', async () => {
  const fixture = await openChild(async () => [{
    info: makeAssistantMessage('child', 'child-answer', 'child-question', 4),
    parts: [makeTextPart('child-answer', 'child', 'Recovered child answer')],
  }]);
  await vi.waitFor(() => expect(fixture.listSessionMessages).toHaveBeenCalledWith('child', { directory: '/repo' }));
  await vi.waitFor(() => expect(document.querySelector('.subagent-history .history-item')).not.toBeNull());
  expect(document.querySelector('.subagent-history')?.textContent).toContain('Recovered child answer');
  expect(fixture.host.querySelectorAll('.thread-block')).toHaveLength(1);
}, 15000);

it('shows failed OpenCode child reads instead of a misleading empty history', async () => {
  await openChild(async () => { throw new Error('Child read failed'); });
  await vi.waitFor(() => expect(document.querySelector('.subagent-history [role="alert"]')?.textContent).toContain('Child read failed'));
}, 15000);

it('distinguishes an empty child transcript from a malformed response', async () => {
  await openChild(async () => []);
  await vi.waitFor(() => expect(document.querySelector('.subagent-history .subagent-empty')?.textContent).toContain('No subagent history available yet.'));
  expect(document.querySelector('.subagent-history [role="alert"]')).toBeNull();
  expect(document.querySelector('.subagent-history .history-item')).toBeNull();
}, 15000);

it('reports malformed OpenCode history responses as an error', async () => {
  await openChild(async () => ({ error: 'invalid response' }));
  await vi.waitFor(() => expect(document.querySelector('.subagent-history [role="alert"]')?.textContent).toContain('Invalid OpenCode session history response.'));
}, 15000);
