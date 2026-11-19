import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, shallowRef } from 'vue';
import { createI18n } from 'vue-i18n';
import { parseSessionRef } from '../../../shared/runtime/identity.js';
import type { CollaborationTeamView } from '../../composables/useRuntimeCollaboration';
import TeamEditor from './TeamEditor.vue';
import type { CollaborationFanoutView } from '../../composables/useRuntimeCollaboration';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

it('sends only explicitly selected visible members and clears selection when the member page changes', async () => {
  const members = ['one', 'two'].map((id) => ({ memberId: id, participantId: id, role: 'worker' as const, harnessKind: 'codex', sessionKey: id,
    session: parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: id }) }));
  const team = shallowRef<CollaborationTeamView>({ teamId: 'team', name: 'Actual recipients', members });
  const send = vi.fn();
  const root = document.createElement('div'); document.body.appendChild(root);
  const app = createApp({ render: () => h(TeamEditor, { team: team.value, budgets: null, fanout: null, onFanOut: send }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(root); cleanups.push(() => { app.unmount(); root.remove(); }); await nextTick();
  const prompt = root.querySelector('[data-testid="fanout-prompt"]');
  const button = root.querySelector('[data-testid="fanout-trigger"]');
  if (!(prompt instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) throw new Error('Missing fanout controls');
  prompt.value = 'Send this once'; prompt.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
  expect(button.disabled).toBe(true);
  const checkbox = root.querySelector('[data-testid="fanout-select-recipient"]');
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing recipient selection');
  checkbox.click(); await nextTick(); button.click(); await nextTick();
  expect(send).toHaveBeenCalledExactlyOnceWith({ prompt: 'Send this once', targets: [{ participantId: 'one', session: members[0]!.session }] });
  team.value = { ...team.value, members: [members[1]!] }; await nextTick(); await nextTick();
  prompt.value = 'New page'; prompt.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
  expect(button.disabled).toBe(true);
  expect(send).toHaveBeenCalledOnce();
});

it('offers retries only for server-declared safe recipients and keeps ambiguous recipients visible', async () => {
  const session = parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'native' });
  const fanout: CollaborationFanoutView = { fanoutId: 'fanout', state: 'ambiguous', stats: {}, retryable: ['safe'], targets: ['safe', 'uncertain'].map((id) => ({ recipientId: id, participantId: id, session, attachmentPath: null, outcome: id === 'safe' ? 'pending' : 'ambiguous', resolution: null, resolutionCode: null })) };
  const action = vi.fn(async () => {});
  const root = document.createElement('div'); document.body.appendChild(root);
  const app = createApp({ render: () => h(TeamEditor, { team: null, budgets: null, fanout, fanoutAction: action }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(root); cleanups.push(() => { app.unmount(); root.remove(); }); await nextTick();
  const rows = root.querySelectorAll('[data-testid="fanout-recipient"]');
  expect(rows).toHaveLength(2);
  expect(rows[1]?.textContent).toContain('ambiguous');
  expect(rows[1]?.querySelector('button')).toBeNull();
  const retry = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry safe recipient'));
  if (!retry) throw new Error('Missing safe retry action');
  retry.click();
  expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'retry', recipientId: 'safe' });
});
