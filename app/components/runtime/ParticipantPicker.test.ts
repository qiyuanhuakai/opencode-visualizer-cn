import { createApp, h, nextTick, shallowRef } from 'vue';
import { createI18n } from 'vue-i18n';
import { expect, it, vi } from 'vitest';
import { encodeSessionKey, parseSessionRef } from '../../../shared/runtime/identity.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import { parseParticipantId } from '../../../shared/runtime/thread.js';
import type { ParticipantView } from '../../../bridge/runtime/threads/participantService.js';
import ParticipantPicker from './ParticipantPicker.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

it('keeps same-native-ID participants independent across harnesses and environments', async () => {
  const first = parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'native-1002' });
  const second = parseSessionRef({ ...first, harnessInstanceId: '33333333-3333-4333-8333-333333333333' });
  const foreign = parseSessionRef({ ...first, environmentId: '44444444-4444-4444-8444-444444444444' });
  const owner: ParticipantView = { participantId: parseParticipantId('55555555-5555-4555-8555-555555555555'), role: 'owner', state: 'active', session: first, nativeParent: null, harnessInstanceId: first.harnessInstanceId };
  const participants = shallowRef<readonly ParticipantView[]>([owner]);
  const candidates = shallowRef([
    { session: first, label: 'Original conversation', harness: 'opencode' },
    { session: second, label: 'Other Agent conversation', harness: 'codex' },
    { session: foreign, label: 'Other environment conversation', harness: 'opencode' },
  ]);
  const joined: unknown[] = [], located: unknown[] = [];
  const warnings = vi.spyOn(console, 'warn');
  const element = document.createElement('div');
  document.body.append(element);
  const app = createApp({ render: () => h(ParticipantPicker, {
    participants: participants.value, targets: [], availableSessions: candidates.value,
    onJoin: (session: SessionRef) => joined.push(session), onLocateSession: (session: SessionRef) => located.push(session),
  }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  try {
    app.mount(element);
    await nextTick();
    const buttons = () => [...element.querySelectorAll<HTMLButtonElement>('[data-testid=add-source]')];
    expect(buttons()).toHaveLength(3);
    expect(buttons().map(button => button.disabled)).toEqual([true, false, false]);
    buttons()[1]!.click(); buttons()[2]!.click();
    expect(joined).toEqual([second, foreign]);
    element.querySelector<HTMLButtonElement>('[data-testid=locate-session]')!.click();
    expect(located).toEqual([first]);
    participants.value = [...participants.value, { ...owner, participantId: parseParticipantId('66666666-6666-4666-8666-666666666666'), role: 'participant', session: second, harnessInstanceId: second.harnessInstanceId }];
    candidates.value = [...candidates.value].reverse();
    await nextTick();
    expect(buttons().map(button => button.dataset.sessionKey)).toEqual([foreign, second, first].map(encodeSessionKey));
    expect(buttons().map(button => button.disabled)).toEqual([false, true, true]);
    expect(warnings.mock.calls.some(arguments_ => String(arguments_[0]).includes('Duplicate keys'))).toBe(false);
  } finally {
    app.unmount(); element.remove(); warnings.mockRestore();
  }
});
