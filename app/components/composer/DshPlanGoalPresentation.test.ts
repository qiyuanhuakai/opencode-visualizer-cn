import { computed, createApp, h, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, expect, it, vi } from 'vitest';
import DshComposerPlanGoal from '../dsh/DshComposerPlanGoal.vue';
import type { DshPlanGoalControl } from '../../composables/useDshPlanGoal';
import en from '../../locales/en';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const apps: App[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.replaceChildren(); });

it('retains queued plan inversion and blocks a pending write while exposing the goal error', async () => {
  const control: DshPlanGoalControl = {
    sessionId: computed(() => 'session-one'), goal: ref(null),
    plan: ref({ active: false, pending: true }), pending: ref(false), loaded: ref(true), error: ref(''),
    refresh: vi.fn(async () => true), togglePlan: vi.fn(async () => true), changeGoal: vi.fn(async () => true),
  };
  const onOpen = vi.fn(); const host = document.createElement('div'); document.body.append(host);
  const app = createApp({ render: () => h(DshComposerPlanGoal, { control, onOpen }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } })); apps.push(app); app.mount(host);
  const plan = host.querySelector<HTMLButtonElement>('.dsh-plan');
  expect(plan?.getAttribute('aria-pressed')).toBe('true'); expect(plan?.textContent).toContain('On…');
  plan?.click(); expect(control.togglePlan).toHaveBeenCalledOnce();
  control.pending.value = true; await nextTick();
  expect(plan?.disabled).toBe(true); expect(plan?.getAttribute('aria-busy')).toBe('true');
  plan?.click(); expect(control.togglePlan).toHaveBeenCalledOnce();
  control.pending.value = false; control.error.value = 'Goal read rejected';
  control.plan.value = { active: true, pending: true }; await nextTick();
  expect(plan?.getAttribute('aria-pressed')).toBe('false'); expect(plan?.textContent).toContain('Off…');
  const goal = host.querySelector<HTMLButtonElement>('.dsh-goal');
  expect(goal?.getAttribute('aria-label')).toContain('Goal read rejected');
  expect(goal?.querySelector('[role="alert"]')?.textContent).toBe('Goal read rejected');
  goal?.click(); expect(onOpen).toHaveBeenCalledOnce();
});
