import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import KimiWebThreadGoalWindow from './KimiWebThreadGoalWindow.vue';
import type { KimiWebGoal } from '../../backends/kimiWeb/goal';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Kimi thread goal window', () => {
  it('shows server status and routes objective and control buttons to its pinned session', async () => {
    let goal: KimiWebGoal | null = null;
    const client = {
      getGoal: vi.fn(async () => goal),
      updateProfile: vi.fn(async () => ({
        id: 'pinned',
        workspace_id: 'workspace',
        title: 'Session',
        busy: false,
        main_turn_active: false,
        pending_interaction: 'none' as const,
        archived: false,
      })),
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onUpdated = vi.fn();
    const app = createApp(KimiWebThreadGoalWindow, { sessionId: 'pinned', client, onUpdated });
    app.use(
      createI18n({
        legacy: false,
        locale: 'en',
        messages: { en: { common: { save: 'Save', refresh: 'Refresh' } } },
      }),
    );
    app.mount(root);
    await nextTick();
    await nextTick();
    expect(root.textContent).toContain('No goal is set');
    expect(onUpdated).not.toHaveBeenCalled();
    const textarea = root.querySelector('textarea');
    if (!textarea) throw new Error('Missing objective input');
    textarea.value = 'Build the project';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    goal = {
      goalId: 'goal',
      objective: textarea.value,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
    };
    root
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    await nextTick();
    expect(client.updateProfile).toHaveBeenCalledWith('pinned', {
      agent_config: { goal_objective: 'Build the project' },
    });
    expect(onUpdated).toHaveBeenCalledOnce();
    const pause = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent === 'Pause goal',
    );
    expect(pause).toBeDefined();
    goal = { ...goal, status: 'paused' };
    pause?.click();
    await nextTick();
    await nextTick();
    await nextTick();
    expect(client.updateProfile).toHaveBeenLastCalledWith('pinned', {
      agent_config: { goal_control: 'pause' },
    });
    expect(root.textContent).toContain('Resume work');
    expect(onUpdated).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain('may use tokens');
    client.updateProfile.mockRejectedValueOnce(new Error('Goal change rejected'));
    Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Resume work')?.click();
    await nextTick();
    await nextTick();
    await nextTick();
    expect(onUpdated).toHaveBeenCalledTimes(2);
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('Goal change rejected');
    app.unmount();
  });
});
