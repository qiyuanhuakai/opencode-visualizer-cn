import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locales/en';
import KimiWebComposerModes from './KimiWebComposerModes.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

type Props = InstanceType<typeof KimiWebComposerModes>['$props'];
const apps: App[] = [];
afterEach(() => { apps.splice(0).forEach((app) => app.unmount()); document.body.innerHTML = ''; });

async function mountModes(overrides: Partial<Props> = {}) {
  const events = { onTogglePlan: vi.fn(), onToggleSwarm: vi.fn(), onToggleTower: vi.fn(), onRetry: vi.fn() };
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(KimiWebComposerModes, { towerEnabled: true, confidence: 'confirmed', ...overrides, ...events });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(host); apps.push(app);
  await nextTick();
  const trigger = host.querySelector<HTMLButtonElement>('.ui-dropdown-button');
  trigger?.click();
  await nextTick();
  const items = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
  return { host, events, items, trigger };
}

describe('Kimi composer mode dropdown', () => {
  it('opens upward with lowercase untranslated independent modes', async () => {
    const { host, items, trigger } = await mountModes();
    expect(trigger).not.toBeNull();
    expect(items.map((item) => item.querySelector('.kimi-web-mode-label')?.textContent)).toEqual(['plan', 'swarm', 'tower']);
    expect(host.querySelector('.ui-dropdown-menu')?.getAttribute('style')).toContain('top: auto');
  });
  it('allows plan and swarm simultaneously and only changes the chosen field', async () => {
    const { items, events, trigger } = await mountModes({ planMode: true, swarmMode: true, towerMode: false });
    expect(items[0]?.classList.contains('is-active')).toBe(true);
    expect(items[1]?.classList.contains('is-active')).toBe(true);
    expect(trigger?.textContent).toContain('Mode');
    items[0]?.click();
    expect(events.onTogglePlan).toHaveBeenCalledExactlyOnceWith(false);
    expect(events.onToggleSwarm).not.toHaveBeenCalled();
    expect(events.onToggleTower).not.toHaveBeenCalled();
  });
  it('gates tower without disabling other independent modes', async () => {
    const { items, events } = await mountModes({ towerEnabled: false });
    expect(items[2]?.getAttribute('aria-disabled')).toBe('true');
    items[2]?.click(); expect(events.onToggleTower).not.toHaveBeenCalled();
    items[0]?.click(); expect(events.onTogglePlan).toHaveBeenCalledWith(true);
  });
  it('shows unknown state and saving state without inventing enabled modes', async () => {
    const { items } = await mountModes({ planMode: undefined, swarmMode: false, towerMode: false, pendingField: 'swarmMode' });
    expect(items[0]?.textContent).toContain(en.kimiWeb.composer.unconfirmed);
    expect(items[1]?.textContent).toContain(en.kimiWeb.composer.saving);
    expect(items[1]?.getAttribute('aria-disabled')).toBe('true');
    expect(items[0]?.classList.contains('is-active')).toBe(false);
  });
  it('blocks the trigger while the composer is disabled', async () => {
    const { trigger, events } = await mountModes({ disabled: true });
    expect(trigger?.disabled).toBe(true); expect(events.onTogglePlan).not.toHaveBeenCalled();
  });
  it('preserves rejection and uncertain retry feedback', async () => {
    const { host, events } = await mountModes({ error: { kind: 'rejected', message: 'Rejected' }, confidence: 'stale' });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Rejected');
    expect(host.textContent).toContain(en.kimiWeb.composer.stale);
    host.querySelector<HTMLButtonElement>('.kimi-web-mode-retry')?.click();
    expect(events.onRetry).toHaveBeenCalledOnce();
  });
});
