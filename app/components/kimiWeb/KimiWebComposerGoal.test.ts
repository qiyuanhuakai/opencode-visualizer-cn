import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import KimiWebComposerGoal from './KimiWebComposerGoal.vue';
import type { KimiWebGoal } from '../../backends/kimiWeb/goal';
import en from '../../locales/en';
vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function settle() { for (let i = 0; i < 4; i++) { await nextTick(); await Promise.resolve(); } }
const goal: KimiWebGoal = { goalId: 'goal', objective: 'Current objective', status: 'active', turnsUsed: 0, tokensUsed: 0, wallClockMs: 0 };
function setup() {
  const connected = ref(false);
  const sessionId = ref('');
  const revision = ref(0);
  const client = { getGoal: vi.fn(async (): Promise<KimiWebGoal | null> => goal), updateProfile: vi.fn() };
  const open = vi.fn();
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp(defineComponent({ setup: () => () => h(KimiWebComposerGoal, { client, sessionId: sessionId.value, connected: connected.value, revision: revision.value, onOpen: open }) }));
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } })); app.mount(root);
  cleanups.push(() => { app.unmount(); root.remove(); });
  return { root, connected, sessionId, revision, client, open };
}
describe('Kimi composer goal', () => {
  it('does not fetch disconnected or empty targets, then shows and opens the current goal', async () => {
    const state = setup(); await settle();
    expect(state.client.getGoal).not.toHaveBeenCalled();
    state.connected.value = true; await settle();
    expect(state.client.getGoal).not.toHaveBeenCalled();
    state.sessionId.value = 'current'; await settle();
    expect(state.client.getGoal).toHaveBeenCalledWith('current');
    expect(state.root.textContent).toContain('Current objective');
    state.root.querySelector('button')?.click();
    expect(state.open).toHaveBeenCalledOnce();
    state.client.getGoal.mockResolvedValue(null); state.revision.value++; await settle();
    expect(state.root.textContent).toContain('No goal is set');
  });
  it('clears old objectives on switching, ignores late responses, and renders current errors', async () => {
    const state = setup(); state.connected.value = true; state.sessionId.value = 'first'; await settle();
    const late = Promise.withResolvers<KimiWebGoal | null>();
    state.client.getGoal.mockReturnValueOnce(late.promise).mockRejectedValueOnce(new Error('Goal unavailable'));
    state.sessionId.value = 'second'; await settle();
    expect(state.root.textContent).not.toContain('Current objective');
    state.sessionId.value = 'third'; await settle();
    late.resolve(goal); await settle();
    expect(state.root.querySelector('[role="alert"]')?.textContent).toBe('Goal unavailable');
    expect(state.root.textContent).not.toContain('Current objective');
    state.connected.value = false; await settle();
    expect(state.root.querySelector('button')?.disabled).toBe(true);
  });
});
