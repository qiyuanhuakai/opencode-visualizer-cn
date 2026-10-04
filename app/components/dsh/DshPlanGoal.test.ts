import { afterEach, expect, it, vi } from 'vitest';
import { computed, createApp, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import DshComposerPlanGoal from './DshComposerPlanGoal.vue';
import DshThreadGoalWindow from './DshThreadGoalWindow.vue';
import en from '../../locales/en';
import type { DshPlanGoalControl } from '../../composables/useDshPlanGoal';
vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ''; });

it('opens the goal editor and submits a changed objective through native controls', async () => {
  const sessionId = ref('active-session');
  const control = {
    sessionId: computed(() => sessionId.value), goal: ref(null), plan: ref({ active: false, pending: false }), pending: ref(false), loaded: ref(true), error: ref(''),
    refresh: vi.fn(async () => true), togglePlan: vi.fn(async () => true), changeGoal: vi.fn(async () => true),
  } satisfies DshPlanGoalControl;
  const open = ref(false);
  const host = document.createElement('div'); document.body.append(host);
  const app = createApp({ render: () => h('div', [h(DshComposerPlanGoal, { control, onOpen: () => { open.value = true; } }), open.value ? h(DshThreadGoalWindow, { control }) : null]) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } })); app.mount(host); apps.push(app);
  host.querySelector<HTMLButtonElement>('.dsh-plan')?.click();
  expect(control.togglePlan).toHaveBeenCalledOnce();
  host.querySelector<HTMLButtonElement>('.dsh-goal')?.click(); await nextTick();
  const input = host.querySelector<HTMLTextAreaElement>('textarea');
  if (!input) throw new Error('Missing goal editor');
  input.value = 'Finish verification'; input.dispatchEvent(new Event('input')); await nextTick();
  host.querySelector('form')?.dispatchEvent(new Event('submit')); await nextTick();
  expect(control.changeGoal).toHaveBeenCalledWith('save', 'Finish verification');
  sessionId.value = 'next-session'; await nextTick();
  expect(input.value).toBe('');
  expect(host.querySelector('.goal-session')?.textContent).toBe('next-session');
});
