import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import CodexAccountTokenUsage from './CodexAccountTokenUsage.vue';
import { useCodexApi } from '../../composables/useCodexApi';

let app: App | undefined;
afterEach(() => { app?.unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers(); });
function mountUsage(initialView?: 'daily' | 'weekly' | 'cumulative') {
  const api = useCodexApi();
  api.status.value = 'connected';
  api.account.value = null;
  api.accountUsage.value = null;
  api.runtimeCapabilities.value = {};
  const refresh = vi.spyOn(api, 'refreshAccountUsage').mockResolvedValue({ summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null });
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = createApp(CodexAccountTokenUsage, { api, initialView });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  app.mount(target);
  return { api, refresh, target };
}
describe('account token activity', () => {
  it('uses UTC daily buckets for today and the last seven days independently of lifetime', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T08:00:00Z'));
    const { api, target, refresh } = mountUsage();
    api.accountUsage.value = {
      summary: { lifetimeTokens: 9999, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
      dailyUsageBuckets: [{ startDate: '2026-09-14', tokens: 100 }, { startDate: '2026-09-08', tokens: 200 }, { startDate: '2026-09-07', tokens: 900 }],
    };
    await nextTick();
    expect(refresh).toHaveBeenCalledOnce();
    expect([...target.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['100', '300', '9,999']);
    expect(target.querySelectorAll('tbody tr')).toHaveLength(3);
  });
  it.each(['daily', 'weekly', 'cumulative'] as const)('focuses the requested %s usage view after data arrives', async (view) => {
    const { api, target } = mountUsage(view);
    api.accountUsage.value = { summary: { lifetimeTokens: 20, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: [{ startDate: '2026-09-14', tokens: 20 }] };
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(target.querySelector(`[data-view="${view}"]`));
    expect(target.querySelector('details')?.open).toBe(view === 'daily');
  });

  it('distinguishes missing buckets from zero usage', async () => {
    const { api, target } = mountUsage();
    api.accountUsage.value = { summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null };
    await nextTick();
    expect([...target.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['—', '—', '—']);
  });
  it('reports refresh errors and unsupported capability without treating them as empty data', async () => {
    const { api, target, refresh } = mountUsage();
    refresh.mockRejectedValueOnce(new Error('Server unavailable'));
    await nextTick();
    target.querySelector('button')?.click();
    await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain('Server unavailable'));
    api.runtimeCapabilities.value = { 'account/usage/read': 'unsupported' };
    await nextTick();
    expect(target.textContent).toContain('unavailable for this server');
    expect(target.querySelector('button')?.disabled).toBe(true);
  });
});
