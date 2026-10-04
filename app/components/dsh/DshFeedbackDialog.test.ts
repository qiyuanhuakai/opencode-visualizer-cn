// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import DshFeedbackDialog from './DshFeedbackDialog.vue';
import { recordDshSessionFeedback } from './sessionFeedback';
import type { DshRpcClient } from '../../utils/dshRpc';
import type { DshJsonValue } from '../../backends/dsh/types';
import { deferred } from '../../composables/useBackendMessageSend.test-helpers';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function flush() { for (let index = 0; index < 8; index++) { await Promise.resolve(); await nextTick(); } }
async function mount(rpc: Pick<DshRpcClient, 'call'>) {
  const sessionId = ref('session-1'); const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(DshFeedbackDialog, { rpc, sessionId: sessionId.value }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } })); app.mount(root);
  cleanups.push(() => { app.unmount(); root.remove(); }); await flush();
  function submit() { root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
  function text(value: string) { const area = root.querySelector('textarea'); if (!area) throw new Error('Missing feedback field'); area.value = value; area.dispatchEvent(new Event('input', { bubbles: true })); }
  return { root, sessionId, submit, text };
}
it('records text/category locally with the native request shape and confirms only recorded:true', async () => {
  const call = vi.fn(async (): Promise<DshJsonValue> => ({ ok: true, value: { recorded: true } }));
  const ui = await mount({ call }); ui.text('  Useful feedback  ');
  ui.root.querySelector<HTMLButtonElement>('[data-feedback-category="task-result"]')?.click(); await flush(); ui.submit(); await flush();
  expect(call).toHaveBeenCalledWith('sessionFeedback', 'record', { request: { sessionId: 'session-1', text: 'Useful feedback', category: 'task-result' } });
  expect(ui.root.querySelector('[role="status"]')?.textContent).toContain('recorded in the local session log');
  expect(ui.root.querySelector('fieldset')?.disabled).toBe(true);
  ui.submit(); await flush(); expect(call).toHaveBeenCalledOnce();
});
it('preserves the draft on a semantic failure and succeeds after retry', async () => {
  const call = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'session-not-found' } }).mockResolvedValueOnce({ ok: true, value: { recorded: true } });
  const ui = await mount({ call }); ui.text('keep this feedback'); ui.submit(); await flush();
  expect(ui.root.querySelector('[role="alert"]')?.textContent).toContain('no longer available');
  expect(ui.root.querySelector('textarea')?.value).toBe('keep this feedback');
  expect(ui.root.querySelector('[role="status"]')).toBeNull();
  ui.submit(); await flush(); expect(ui.root.querySelector('[role="status"]')).not.toBeNull();
});
it('does not acknowledge a previous session response in a new feedback dialog state', async () => {
  const pending = deferred<DshJsonValue>(); const call = vi.fn(() => pending.promise);
  const ui = await mount({ call }); ui.text('old session feedback'); ui.submit(); await flush();
  ui.sessionId.value = 'session-2'; await flush(); pending.resolve({ ok: true, value: { recorded: true } }); await flush();
  expect(ui.root.querySelector('[role="status"]')).toBeNull();
  expect(ui.root.querySelector('textarea')?.value).toBe('');
  expect(ui.root.textContent).toContain('session-2');
});
it('allows the native empty feedback entry and rejects an unconfirmed response', async () => {
  const call = vi.fn(async (): Promise<DshJsonValue> => ({ ok: true, value: { recorded: true } }));
  await recordDshSessionFeedback({ call }, { sessionId: 's1', text: ' ', category: '' });
  expect(call).toHaveBeenCalledWith('sessionFeedback', 'record', { request: { sessionId: 's1' } });
  await expect(recordDshSessionFeedback({ call: async () => ({ ok: true }) }, { sessionId: 's1', text: '', category: '' })).rejects.toThrow('not recorded');
});
