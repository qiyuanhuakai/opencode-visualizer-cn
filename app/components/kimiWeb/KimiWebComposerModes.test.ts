import { createApp, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locales/en';
import KimiWebComposerModes from './KimiWebComposerModes.vue';

type ComposerModesProps = InstanceType<typeof KimiWebComposerModes>['$props'];

const mountedApps: App[] = [];

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

function mountModes(overrides: Partial<ComposerModesProps> = {}) {
  const events = {
    onTogglePlan: vi.fn(),
    onToggleSwarm: vi.fn(),
    onToggleTower: vi.fn(),
    onRetry: vi.fn(),
  };
  const props = {
    towerEnabled: true,
    confidence: 'confirmed',
    ...overrides,
    ...events,
  } satisfies Partial<ComposerModesProps> & typeof events;
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(KimiWebComposerModes, props);
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      missingWarn: false,
      fallbackWarn: false,
      messages: { en },
    }),
  );
  app.mount(host);
  mountedApps.push(app);
  return { props, host, events };
}

function switchesIn(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="switch"]'));
}

describe('KimiWebComposerModes', () => {
  it('renders Plan Swarm Tower in that order', () => {
    const { host } = mountModes();

    const switches = switchesIn(host);
    expect(switches).toHaveLength(3);
    expect(switches[0].textContent).toContain(en.kimiWeb.composer.plan);
    expect(switches[1].textContent).toContain(en.kimiWeb.composer.swarm);
    expect(switches[2].textContent).toContain(en.kimiWeb.composer.tower);
    expect(switches[0].getAttribute('title')).toContain(en.kimiWeb.composer.planDescription);
    expect(switches[1].getAttribute('title')).toContain(en.kimiWeb.composer.swarmDescription);
    expect(switches[2].getAttribute('title')).toContain(en.kimiWeb.composer.towerDescription);
  });

  it('reflects checked unchecked and unconfirmed states distinctly', () => {
    const { host } = mountModes({ planMode: true, swarmMode: false, towerMode: undefined });

    const [plan, swarm, tower] = switchesIn(host);
    expect(plan.getAttribute('aria-checked')).toBe('true');
    expect(plan.dataset.state).toBe('on');
    expect(swarm.getAttribute('aria-checked')).toBe('false');
    expect(swarm.dataset.state).toBe('off');
    expect(tower.getAttribute('aria-checked')).toBe('mixed');
    expect(tower.dataset.state).toBe('unconfirmed');
    expect(tower.textContent).toContain(en.kimiWeb.composer.unconfirmed);
    expect(plan.textContent).not.toContain(en.kimiWeb.composer.unconfirmed);
    expect(swarm.textContent).not.toContain(en.kimiWeb.composer.unconfirmed);
  });

  it('disables Tower without the experimental flag', () => {
    const { host, events } = mountModes({ towerEnabled: false, towerMode: false });

    const [plan, swarm, tower] = switchesIn(host);
    expect(tower.disabled).toBe(true);
    expect(tower.getAttribute('title')).toContain(en.kimiWeb.composer.towerDisabled);
    expect(plan.disabled).toBe(false);
    expect(swarm.disabled).toBe(false);
    tower.click();
    expect(events.onToggleTower).not.toHaveBeenCalled();
  });

  it('shows a saving indicator only on the pending switch', () => {
    const { host } = mountModes({
      pendingField: 'swarmMode',
      planMode: true,
      swarmMode: false,
      towerMode: false,
    });

    const [plan, swarm, tower] = switchesIn(host);
    expect(swarm.textContent).toContain(en.kimiWeb.composer.saving);
    expect(plan.textContent).not.toContain(en.kimiWeb.composer.saving);
    expect(tower.textContent).not.toContain(en.kimiWeb.composer.saving);
    expect(swarm.disabled).toBe(true);
    expect(plan.disabled).toBe(false);
    expect(tower.disabled).toBe(false);
  });

  it('keeps a pending permission-mode save off the switches', () => {
    const { host } = mountModes({
      pendingField: 'permissionMode',
      planMode: true,
      swarmMode: false,
      towerMode: false,
    });

    for (const modeSwitch of switchesIn(host)) {
      expect(modeSwitch.textContent).not.toContain(en.kimiWeb.composer.saving);
      expect(modeSwitch.disabled).toBe(false);
    }
  });

  it('emits only the toggled field', () => {
    const { host, events } = mountModes({ planMode: true, swarmMode: false, towerMode: false });

    const [plan, swarm, tower] = switchesIn(host);
    plan.click();
    expect(events.onTogglePlan).toHaveBeenCalledExactlyOnceWith(false);
    expect(events.onToggleSwarm).not.toHaveBeenCalled();
    expect(events.onToggleTower).not.toHaveBeenCalled();

    swarm.click();
    expect(events.onToggleSwarm).toHaveBeenCalledExactlyOnceWith(true);
    expect(events.onToggleTower).not.toHaveBeenCalled();

    tower.click();
    expect(events.onToggleTower).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('emits an enable when toggling an unconfirmed switch', () => {
    const { host, events } = mountModes({ planMode: undefined });

    switchesIn(host)[0].click();
    expect(events.onTogglePlan).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('offers retry after a rejection and after an uncertain write', () => {
    const rejected = mountModes({ error: { kind: 'rejected', message: 'Server refused tower_mode' } });
    expect(rejected.host.textContent).toContain('Server refused tower_mode');
    expect(rejected.host.querySelector('[role="alert"]')?.textContent).toContain(
      'Server refused tower_mode',
    );
    const rejectedRetry = rejected.host.querySelector<HTMLButtonElement>('.kimi-web-mode-retry');
    if (!rejectedRetry) throw new Error('retry button missing after rejection');
    expect(rejectedRetry.textContent).toContain(en.kimiWeb.composer.retry);
    rejectedRetry.click();
    expect(rejected.events.onRetry).toHaveBeenCalledOnce();

    const uncertain = mountModes({ error: { kind: 'uncertain' } });
    expect(uncertain.host.textContent).toContain(en.kimiWeb.composer.saveUncertain);
    const uncertainRetry = uncertain.host.querySelector<HTMLButtonElement>('.kimi-web-mode-retry');
    if (!uncertainRetry) throw new Error('retry button missing after uncertain write');
    uncertainRetry.click();
    expect(uncertain.events.onRetry).toHaveBeenCalledOnce();
  });

  it('shows the stale notice when confidence is stale', () => {
    const { host } = mountModes({ confidence: 'stale' });
    expect(host.textContent).toContain(en.kimiWeb.composer.stale);
  });

  it('disables every switch while the composer is disabled', () => {
    const { host, events } = mountModes({ disabled: true, planMode: true });

    const [plan, swarm, tower] = switchesIn(host);
    expect(plan.disabled).toBe(true);
    expect(swarm.disabled).toBe(true);
    expect(tower.disabled).toBe(true);
    plan.click();
    expect(events.onTogglePlan).not.toHaveBeenCalled();
  });

  it('is keyboard operable and exposes accessible names', () => {
    const { host, events } = mountModes({ planMode: false });

    const plan = switchesIn(host)[0];
    // Native buttons activate on Enter and Space; happy-dom does not synthesize those
    // clicks, so assert the keyboard-operable primitive plus its activation path.
    expect(plan.tagName).toBe('BUTTON');
    expect(plan.getAttribute('type')).toBe('button');
    plan.focus();
    expect(document.activeElement).toBe(plan);
    plan.click();
    expect(events.onTogglePlan).toHaveBeenCalledExactlyOnceWith(true);

    expect(plan.getAttribute('role')).toBe('switch');
    expect(plan.getAttribute('aria-checked')).toBe('false');
    expect(plan.textContent).toContain(en.kimiWeb.composer.plan);
    expect(plan.getAttribute('title')).toContain(en.kimiWeb.composer.planDescription);
  });
});
