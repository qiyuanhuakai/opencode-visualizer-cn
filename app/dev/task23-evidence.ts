// Task 23 evidence page — real HarnessSettings.vue rendering over the real
// useRuntimeCapabilities resolution, in a real Chromium at desktop (1440) and
// mobile (390) widths across three themes.
//
// This page is NOT the registered QA lane entry (app/dev/runtime-v090/task23.ts,
// owned by a separate registered lane); it exists only to produce the visual
// evidence this task owes. It mounts the real component with the same manifest
// shapes the bridge publishes for the five harness kinds, and applies the real
// theme presets from app/utils/regionTheme.ts as CSS custom properties so each
// theme renders with its own palette.
import { createApp, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import { NATIVE_EXTENSIONS } from '../../shared/runtime/nativeExtensions.js';
import type { NativeOperation } from '../../shared/runtime/nativeExtensions.js';
import type { HarnessManifest, Support } from '../../shared/runtime/harnessContract.js';
import {
  DEFAULT_REGION_THEME,
  AURORA_TIDE_PRESET,
  SAKURA_PRESET,
} from '../utils/regionTheme.js';
import HarnessSettings from '../components/runtime/HarnessSettings.vue';

const ENV = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const HARNESS_IDS: Record<string, HarnessInstanceId> = {
  opencode: parseHarnessInstanceId('10000000-0000-4000-8000-000000000001'),
  codex: parseHarnessInstanceId('10000000-0000-4000-8000-000000000002'),
  'kimi-web': parseHarnessInstanceId('10000000-0000-4000-8000-000000000003'),
  dsh: parseHarnessInstanceId('10000000-0000-4000-8000-000000000004'),
  acp: parseHarnessInstanceId('10000000-0000-4000-8000-000000000005'),
};
const SESSIONS: Record<string, SessionRef> = Object.fromEntries(
  Object.entries(HARNESS_IDS).map(([kind, id]) => [kind, parseSessionRef({ environmentId: ENV, harnessInstanceId: id, nativeSessionId: `ses-${kind}` })]),
) as Record<string, SessionRef>;

const SUPPORTED: Support = Object.freeze({ state: 'supported' });

function manifest(kind: string, declared: readonly string[]): HarnessManifest {
  const id = HARNESS_IDS[kind]!;
  const core = Object.freeze({
    inspect: SUPPORTED, listSessionPage: SUPPORTED, getSession: SUPPORTED, readHistoryPage: SUPPORTED,
    createSession: SUPPORTED, send: SUPPORTED, cancel: SUPPORTED, respondInteraction: SUPPORTED,
    subscribe: SUPPORTED, close: SUPPORTED,
  });
  return Object.freeze({
    environmentId: ENV,
    harnessInstanceId: id,
    kind: kind as HarnessManifest['kind'],
    protocolVersion: 1,
    core,
    extensions: Object.freeze(declared.map((name) => Object.freeze({
      name,
      owner: id,
      scope: NATIVE_EXTENSIONS[name as NativeOperation]?.scope ?? 'instance',
      permission: `${kind}:${name}`,
      schemaVersion: 1,
      support: SUPPORTED,
    }))),
    capabilities: Object.freeze({}),
  });
}

const LABELS: Record<string, string> = {
  'codex.models': 'Models',
  listProviders: 'Providers',
  listProviderAuthMethods: 'Provider auth methods',
  setProviderAuth: 'Set provider credential',
  'codex.providerCapabilities': 'Provider capabilities',
  listAgents: 'Agents',
  listAgentAuthMethods: 'Agent auth methods',
  createAgentAuthPty: 'Agent auth terminal',
  authenticateAgent: 'Authenticate agent',
  getSkillStatus: 'Skills',
  updateSkill: 'Toggle skill',
  getMcpStatus: 'MCP servers',
  updateMcp: 'Toggle MCP server',
  getGlobalHealth: 'Server health',
  'codex.usage': 'Account usage',
  'codex.rateLimits': 'Rate limits',
  'codex.account': 'Account',
  getGlobalConfig: 'Global configuration',
  updateGlobalConfig: 'Write configuration',
  writeConfigValue: 'Write config value',
  listCommands: 'Commands',
  sendCommand: 'Send command',
  getPluginStatus: 'Plugins',
  getPluginManagementEntries: 'Plugin management',
  setPluginEnabled: 'Toggle plugin',
  getLspStatus: 'LSP servers',
  getSessionStatusMap: 'Session status',
  listPendingPermissions: 'Pending permissions',
  listPendingQuestions: 'Pending questions',
};
const ACTIONS: Record<string, string> = {
  updateMcp: 'Save',
  updateGlobalConfig: 'Save',
  updateSkill: 'Save',
  setProviderAuth: 'Connect',
  'codex.models': 'Select',
};

const DECLARED: Record<string, readonly string[]> = {
  opencode: ['listProviders', 'listProviderAuthMethods', 'setProviderAuth', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'getMcpStatus', 'updateMcp', 'getSkillStatus', 'updateSkill', 'getLspStatus', 'getPluginStatus', 'listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent', 'listCommands', 'getSessionStatusMap'],
  codex: ['listProviders', 'codex.models', 'codex.providerCapabilities', 'codex.usage', 'codex.rateLimits', 'codex.account', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'getMcpStatus', 'getSkillStatus', 'updateSkill', 'getPluginStatus'],
  'kimi-web': ['getSkillStatus', 'updateSkill', 'getGlobalConfig', 'updateGlobalConfig'],
  dsh: ['getGlobalConfig', 'updateGlobalConfig', 'getMcpStatus', 'updateMcp'],
  acp: ['listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent', 'getMcpStatus', 'updateMcp', 'getGlobalConfig', 'updateGlobalConfig', 'sendCommand', 'setPluginEnabled'],
};
const CONTROLS = Object.keys(LABELS);

const THEME_PRESETS: Record<string, typeof DEFAULT_REGION_THEME> = {
  default: DEFAULT_REGION_THEME,
  'aurora-tide': AURORA_TIDE_PRESET,
  sakura: SAKURA_PRESET,
};

const state = ref({ theme: 'default', kind: 'opencode', width: 1440 });

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`rejection: ${String((event as PromiseRejectionEvent).reason)}`); });

/** Apply one theme preset's regions as the CSS custom properties the components read. */
function applyTheme(name: string) {
  const preset = THEME_PRESETS[name];
  const root = document.documentElement;
  if (!preset) { root.removeAttribute('data-theme'); return; }
  root.dataset.theme = preset.name;
  const style = root.style;
  const set = (key: string, value: string | undefined) => { if (value) style.setProperty(key, value); };
  const regions = preset.regions ?? {};
  for (const [region, colors] of Object.entries(regions)) {
    if (!colors) continue;
    const prefix = `--theme-${region.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
    set(`${prefix}-bg`, colors.bg);
    set(`${prefix}-text`, colors.text);
    set(`${prefix}-border`, colors.border);
    set(`${prefix}-accent`, colors.accent);
    set(`${prefix}-control-bg`, colors.controlBg);
    set(`${prefix}-active-bg`, colors.activeBg);
    set(`${prefix}-active-text`, colors.activeText);
    set(`${prefix}-text-muted`, colors.textMuted);
  }
  const page = regions.pageBackground ?? regions.modalPanel;
  set('--theme-app-bg', page?.bg);
  set('--theme-text-primary', page?.text ?? regions.modalPanel?.text);
  set('--theme-text-muted', page?.textMuted);
  set('--theme-card-bg', regions.chatCard?.bg ?? regions.modalPanel?.controlBg);
  set('--theme-card-hover-bg', regions.chatCard?.activeBg);
  set('--theme-border-subtle', page?.border);
  set('--theme-surface-panel', page?.controlBg);
  set('--theme-surface-panel-hover', page?.activeBg);
  set('--theme-accent-primary', page?.accent);
  set('--theme-accent-soft', regions.chatCard?.activeBg);
  set('--theme-status-success', '#86efac');
  set('--theme-status-warning', '#fcd34d');
  set('--theme-status-danger', '#f87171');
  set('--theme-status-info', '#7dd3fc');
  set('--theme-status-neutral', '#94a3b8');
  set('--theme-side-accent', page?.accent);
  set('--theme-side-text-muted', page?.textMuted);
  set('--theme-modal-text', page?.text);
  set('--theme-modal-text-muted', page?.textMuted);
  set('--theme-modal-border', page?.border);
  set('--theme-modal-control-bg', page?.controlBg);
  set('--theme-empty-state-text', page?.textMuted);
  set('--app-monospace-font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace');
}

const saves: string[] = [];
const app = createApp({
  render: () => h('div', { class: 'task23-page' }, [
    h('div', { class: 'task23-note' }, 'Task 23 real-UI evidence: capability-gated native harness settings with source information'),
    h(HarnessSettings, {
      key: state.value.kind,
      harnessKind: state.value.kind as HarnessManifest['kind'],
      manifests: [manifest(state.value.kind, DECLARED[state.value.kind] ?? [])],
      scope: { kind: 'session', session: SESSIONS[state.value.kind]! },
      controls: CONTROLS,
      labels: LABELS,
      actionLabels: ACTIONS,
      title: 'Native harness settings',
      onSave: (control: string) => saves.push(control),
    }),
  ]),
});
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });
app.use(i18n);
app.mount('#app');

declare global {
  interface Window {
    __TASK23__?: {
      setTheme(name: string): void;
      setKind(kind: string): void;
      setWidth(width: number): void;
      state(): { theme: string; kind: string; width: number; rows: number; unsupported: number };
      errors(): readonly string[];
    };
  }
}

window.__TASK23__ = {
  setTheme(name) { state.value = { ...state.value, theme: name }; applyTheme(name); },
  setKind(kind) { state.value = { ...state.value, kind }; },
  setWidth(width) { state.value = { ...state.value, width }; },
  state() {
    const rows = Array.from(document.querySelectorAll('.harness-settings-row'));
    return {
      theme: state.value.theme,
      kind: state.value.kind,
      width: state.value.width,
      rows: rows.length,
      unsupported: rows.filter((row) => (row as HTMLElement).dataset.state === 'unsupported').length,
    };
  },
  errors() { return errors; },
};

applyTheme(state.value.theme);
void nextTick();
