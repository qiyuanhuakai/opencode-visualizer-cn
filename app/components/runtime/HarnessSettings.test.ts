import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import type { HarnessManifest, Support } from '../../../shared/runtime/harnessContract.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import { NATIVE_EXTENSIONS } from '../../../shared/runtime/nativeExtensions.js';
import type { NativeOperation } from '../../../shared/runtime/nativeExtensions.js';
import HarnessSettings from './HarnessSettings.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

/**
 * Task 23 acceptance tests — capability-gated native harness settings.
 *
 * The real HarnessSettings.vue renders over the real useRuntimeCapabilities
 * resolution: an available control shows its action, an unsupported or unknown
 * control shows SOURCE INFORMATION and no action, so nothing masquerades as
 * available. The only controlled boundary is the manifest set, which is the
 * same shape the bridge publishes.
 */

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const HARNESS_A = parseHarnessInstanceId('10000000-0000-4000-8000-000000000001');
const SESSION_A: SessionRef = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_A, nativeSessionId: 'ses-a' });

const SUPPORTED: Support = Object.freeze({ state: 'supported' });

function manifest(declared: readonly string[], capabilities: Readonly<Record<string, Support>> = {}): HarnessManifest {
  return Object.freeze({
    environmentId: ENV_A,
    harnessInstanceId: HARNESS_A,
    kind: 'opencode',
    protocolVersion: 1,
    core: Object.freeze({
      inspect: SUPPORTED, listSessionPage: SUPPORTED, getSession: SUPPORTED, readHistoryPage: SUPPORTED,
      createSession: SUPPORTED, send: SUPPORTED, cancel: SUPPORTED, respondInteraction: SUPPORTED,
      subscribe: SUPPORTED, close: SUPPORTED,
    }),
    extensions: Object.freeze(declared.map((name) => Object.freeze({
      name, owner: HARNESS_A,
      scope: NATIVE_EXTENSIONS[name as NativeOperation]?.scope ?? 'instance',
      permission: `opencode:${name}`, schemaVersion: 1, support: SUPPORTED,
    }))),
    capabilities: Object.freeze(capabilities),
  });
}

const LABELS: Readonly<Record<string, string>> = {
  getMcpStatus: 'MCP servers',
  updateMcp: 'Toggle MCP server',
  getSkillStatus: 'Skills',
  updateSkill: 'Toggle skill',
  getGlobalConfig: 'Global configuration',
  updateGlobalConfig: 'Write configuration',
  getLspStatus: 'LSP servers',
  listProviders: 'Providers',
  listProviderAuthMethods: 'Provider auth methods',
  setProviderAuth: 'Set provider credential',
  'codex.models': 'Models',
  getGlobalHealth: 'Server health',
  notARealControl: 'Not a real control',
};
const ACTIONS: Readonly<Record<string, string>> = {
  updateMcp: 'Save',
  updateGlobalConfig: 'Save',
  updateSkill: 'Save',
  setProviderAuth: 'Connect',
};

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

async function mount(manifests: readonly HarnessManifest[], controls: readonly string[], options: Readonly<{ scope?: 'session' | 'instance' }> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const saves: string[] = [];
  const app = createApp(HarnessSettings, {
    harnessKind: 'opencode',
    manifests,
    scope: options.scope === 'instance'
      ? { kind: 'instance', environmentId: ENV_A, harnessInstanceId: HARNESS_A }
      : { kind: 'session', session: SESSION_A },
    controls,
    labels: LABELS,
    actionLabels: ACTIONS,
    title: 'Native harness settings',
    onSave: (control: string) => saves.push(control),
  });
  app.component('HarnessBadge', (await import('./HarnessBadge.vue')).default);
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });
  app.use(i18n);
  app.mount(host);
  await nextTick();
  return { host, saves };
}

function row(host: HTMLDivElement, control: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[data-control="${control}"]`);
  if (!found) throw new Error(`no row for ${control}`);
  return found;
}

describe('HarnessSettings renders an available control with its action', () => {
  it('a declared control is available and carries its action', async () => {
    const { host: root } = await mount([manifest(['getMcpStatus', 'updateMcp'])], ['getMcpStatus', 'updateMcp']);
    expect(row(root, 'getMcpStatus').dataset.state).toBe('supported');
    expect(row(root, 'getMcpStatus').querySelector('[data-testid="harness-control-available"]')).not.toBeNull();
    expect(row(root, 'getMcpStatus').querySelector('[data-testid="harness-control-unavailable"]')).toBeNull();
    const action = row(root, 'updateMcp').querySelector<HTMLButtonElement>('[data-testid="harness-control-action"]');
    expect(action?.textContent?.trim()).toBe('Save');
    expect(action?.disabled).toBe(false);
  });

  it('the scope is rendered so a save cannot be attributed to the wrong source', async () => {
    const { host: root } = await mount([manifest(['getMcpStatus'])], ['getMcpStatus']);
    expect(root.querySelector('[data-testid="harness-settings-scope"]')?.textContent).toContain('session ses-a');
  });

  it('the scope names the explicit harness instance for instance-scoped controls', async () => {
    const { host: root } = await mount([manifest(['getMcpStatus'])], ['getMcpStatus'], { scope: 'instance' });
    expect(root.querySelector('[data-testid="harness-settings-scope"]')?.textContent).toContain('harness instance');
  });
});

describe('HarnessSettings never lets an unsupported capability masquerade as available', () => {
  it('a control the harness does not declare is unavailable and shows its source', async () => {
    const { host: root } = await mount([manifest(['getMcpStatus'])], ['getSkillStatus']);
    const target = row(root, 'getSkillStatus');
    expect(target.dataset.state).toBe('unsupported');
    expect(target.querySelector('[data-testid="harness-control-unavailable"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="harness-control-available"]')).toBeNull();
    expect(target.querySelector('[data-testid="harness-control-action"]')).toBeNull();
    const source = target.querySelector('[data-testid="harness-control-source"]');
    expect(source?.textContent).toContain('opencode');
    expect(source?.textContent).toContain('does not declare');
    expect(target.dataset.sourceKind).toBe('opencode');
  });

  it('an explicitly unsupported capability shows the declared reason and its source', async () => {
    const declared = manifest(['getGlobalConfig'], { providerConfig: { state: 'unsupported', code: 'unsupported', reason: 'Codex owns provider configuration' } });
    const { host: root } = await mount([declared], ['updateGlobalConfig']);
    const target = row(root, 'updateGlobalConfig');
    expect(target.dataset.state).toBe('unsupported');
    const source = target.querySelector('[data-testid="harness-control-source"]');
    expect(source?.textContent).toContain('Codex owns provider configuration');
    expect(target.querySelector('[data-testid="harness-control-action"]')).toBeNull();
  });

  it('an unknown control is unavailable, shows source information, and has no action', async () => {
    const { host: root } = await mount([manifest(['getMcpStatus'])], ['notARealControl']);
    const target = row(root, 'notARealControl');
    expect(target.dataset.state).toBe('unsupported');
    expect(target.querySelector('[data-testid="harness-control-unavailable"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="harness-control-action"]')).toBeNull();
    const source = target.querySelector('[data-testid="harness-control-source"]');
    expect(source?.textContent).toContain('Unknown harness control');
  });

  it('an unregistered harness instance reports the missing source and no action', async () => {
    const { host: root } = await mount([], ['getMcpStatus']);
    const target = row(root, 'getMcpStatus');
    expect(target.dataset.state).toBe('unsupported');
    const source = target.querySelector('[data-testid="harness-control-source"]');
    expect(source?.textContent).toContain('not registered');
    expect(target.querySelector('[data-testid="harness-control-action"]')).toBeNull();
  });

  it('the header counts the unavailable controls without hiding them', async () => {
    const { host: root } = await mount([manifest(['getMcpStatus'])], ['getMcpStatus', 'getSkillStatus', 'getLspStatus']);
    expect(root.querySelector('[data-testid="harness-settings-unsupported-count"]')?.textContent?.trim()).toBe('2 / 3 unavailable');
    expect(root.querySelectorAll('.harness-settings-row')).toHaveLength(3);
  });
});

describe('HarnessSettings keeps the five harness kinds gated per source', () => {
  it('a control declared only by codex is unavailable on the opencode manifest', async () => {
    const { host: root } = await mount([manifest(['getMcpStatus'])], ['codex.models']);
    const target = row(root, 'codex.models');
    expect(target.dataset.state).toBe('unsupported');
    expect(target.querySelector('[data-testid="harness-control-source"]')?.textContent).toContain('does not declare');
  });

  it('a control declared by the manifest is available on the same source', async () => {
    const { host: root } = await mount([manifest(['codex.models'])], ['codex.models']);
    expect(row(root, 'codex.models').dataset.state).toBe('supported');
  });

  it('provider auth controls stay gated on their own manifest', async () => {
    const { host: root } = await mount([manifest(['listProviders'])], ['listProviders', 'listProviderAuthMethods', 'setProviderAuth']);
    expect(row(root, 'listProviders').dataset.state).toBe('supported');
    expect(row(root, 'listProviderAuthMethods').dataset.state).toBe('unsupported');
    expect(row(root, 'setProviderAuth').dataset.state).toBe('unsupported');
    expect(row(root, 'setProviderAuth').querySelector('[data-testid="harness-control-action"]')).toBeNull();
  });
});

describe('HarnessSettings captures the scope when a save is requested', () => {
  it('saving an available control emits the control id from the rendered scope', async () => {
    const { host: root, saves } = await mount([manifest(['getMcpStatus', 'updateMcp'])], ['updateMcp']);
    row(root, 'updateMcp').querySelector<HTMLButtonElement>('[data-testid="harness-control-action"]')?.click();
    await nextTick();
    expect(saves).toEqual(['updateMcp']);
  });

  it('an unavailable control emits nothing', async () => {
    const { host: root, saves } = await mount([manifest(['getMcpStatus'])], ['updateSkill']);
    const target = row(root, 'updateSkill');
    expect(target.querySelector('[data-testid="harness-control-action"]')).toBeNull();
    target.click();
    await nextTick();
    expect(saves).toEqual([]);
  });
});
