// Task 23 registered QA browser entry — capability-gated native harness settings.
//
// Loaded by scripts/qa/runtime-v090-cases/task-23.mjs from a runner-served page.
// The REAL production surfaces execute in a real headless Chromium:
//   * app/components/runtime/HarnessSettings.vue over the real useRuntimeCapabilities
//     resolution, for every one of the five harness kinds;
//   * the real app/composables/useRuntimeCapabilities.ts (support / capture / apply)
//     driven directly for the capability matrix and the scoped-save contract;
//   * the capability-gated paths in ProviderManagerModal.vue, StatusMonitorModal.vue
//     and SettingsModal.vue, each mounted with an explicit harness/workspace scope
//     so the manifest gate (not the legacy adapter-shape fallback) decides.
//
// The only controlled boundary is the manifest set and the write sink (a local
// ledger whose writes are guarded by the REAL capabilities.apply). The legacy
// harnessScope / harnessManifests props are additive and INACTIVE until task 24
// binds a scope in App.vue, so this entry passes a scope explicitly and makes NO
// end-to-end legacy-UI migration claim.
import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';
import type { EnvironmentId, HarnessInstanceId, SessionRef } from '../../../shared/runtime/identity.js';
import { NATIVE_EXTENSIONS } from '../../../shared/runtime/nativeExtensions.js';
import type { NativeOperation } from '../../../shared/runtime/nativeExtensions.js';
import type { HarnessManifest, HarnessKind, Support } from '../../../shared/runtime/harnessContract.js';
import {
  captureControlSave,
  describeControlSupport,
  resolveControlSupport,
  useRuntimeCapabilities,
} from '../../composables/useRuntimeCapabilities';
import type { ControlScope, ControlSupport } from '../../composables/useRuntimeCapabilities';
import { DEFAULT_REGION_THEME, AURORA_TIDE_PRESET, SAKURA_PRESET } from '../../utils/regionTheme.js';
import HarnessSettings from '../../components/runtime/HarnessSettings.vue';
import ProviderManagerModal from '../../components/ProviderManagerModal.vue';
import StatusMonitorModal from '../../components/StatusMonitorModal.vue';
import SettingsModal from '../../components/SettingsModal.vue';
import { useCodexApi } from '../../composables/useCodexApi';
import i18n from '../../i18n';
import en from '../../locales/en';

type AnyRecord = Record<string, any>;

const ENV: EnvironmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const HARNESS_IDS: Record<string, HarnessInstanceId> = {
  opencode: parseHarnessInstanceId('10000000-0000-4000-8000-000000000001'),
  codex: parseHarnessInstanceId('10000000-0000-4000-8000-000000000002'),
  'kimi-web': parseHarnessInstanceId('10000000-0000-4000-8000-000000000003'),
  dsh: parseHarnessInstanceId('10000000-0000-4000-8000-000000000004'),
  acp: parseHarnessInstanceId('10000000-0000-4000-8000-000000000005'),
};
const KINDS: readonly HarnessKind[] = ['opencode', 'codex', 'kimi-web', 'dsh', 'acp'];
const SESSIONS: Record<string, SessionRef> = Object.fromEntries(
  KINDS.map((kind) => [kind, parseSessionRef({ environmentId: ENV, harnessInstanceId: HARNESS_IDS[kind]!, nativeSessionId: `ses-${kind}` })]),
) as Record<string, SessionRef>;

const SUPPORTED: Support = Object.freeze({ state: 'supported' });
const unsupportedCap = (reason: string): Support => Object.freeze({ state: 'unsupported', code: 'unsupported', reason });

const LABELS: Readonly<Record<string, string>> = Object.freeze({
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
});
const ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  updateMcp: 'Save',
  updateGlobalConfig: 'Save',
  updateSkill: 'Save',
  setProviderAuth: 'Connect',
  'codex.models': 'Select',
});
const CONTROLS: readonly string[] = Object.freeze(Object.keys(LABELS));

// The declared native surface per kind — the same shape the bridge publishes.
const DECLARED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  opencode: ['listProviders', 'listProviderAuthMethods', 'setProviderAuth', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'getMcpStatus', 'updateMcp', 'getSkillStatus', 'updateSkill', 'getLspStatus', 'getPluginStatus', 'listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent', 'listCommands', 'getSessionStatusMap'],
  codex: ['listProviders', 'codex.models', 'codex.providerCapabilities', 'codex.usage', 'codex.rateLimits', 'codex.account', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'getMcpStatus', 'getSkillStatus', 'updateSkill', 'getPluginStatus'],
  'kimi-web': ['getSkillStatus', 'updateSkill', 'getGlobalConfig', 'updateGlobalConfig'],
  dsh: ['getGlobalConfig', 'updateGlobalConfig', 'getMcpStatus', 'updateMcp'],
  acp: ['listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent', 'getMcpStatus', 'updateMcp', 'getGlobalConfig', 'updateGlobalConfig', 'sendCommand', 'setPluginEnabled'],
});

function manifest(kind: string, declared: readonly string[], capabilities: Readonly<Record<string, Support>> = {}): HarnessManifest {
  const id = HARNESS_IDS[kind]!;
  return Object.freeze({
    environmentId: ENV,
    harnessInstanceId: id,
    kind: kind as HarnessKind,
    protocolVersion: 1,
    core: Object.freeze({
      inspect: SUPPORTED, listSessionPage: SUPPORTED, getSession: SUPPORTED, readHistoryPage: SUPPORTED,
      createSession: SUPPORTED, send: SUPPORTED, cancel: SUPPORTED, respondInteraction: SUPPORTED,
      subscribe: SUPPORTED, close: SUPPORTED,
    }),
    extensions: Object.freeze(declared.map((name) => Object.freeze({
      name, owner: id,
      scope: NATIVE_EXTENSIONS[name as NativeOperation]?.scope ?? 'instance',
      permission: `${kind}:${name}`, schemaVersion: 1, support: SUPPORTED,
    }))),
    capabilities: Object.freeze(capabilities),
  });
}

const VARIANTS: Readonly<Record<string, Readonly<Record<string, Support>>>> = Object.freeze({
  default: {},
  'provider-unsupported': { providerConfig: unsupportedCap('Codex owns provider configuration') },
  forbidden: { providerConfig: unsupportedCap('403 forbidden: provider configuration is not permitted for this account') },
  'restart-required': { status: unsupportedCap('restart required: the usage monitor starts after the next harness restart') },
});

function manifestsFor(kind: string, variant: string): readonly HarnessManifest[] {
  if (variant === 'unregistered') return [];
  if (variant === 'nothing') return [manifest(kind, [])];
  return [manifest(kind, DECLARED[kind] ?? [], VARIANTS[variant] ?? {})];
}

const sessionScope = (kind: string): ControlScope => Object.freeze({ kind: 'session' as const, session: SESSIONS[kind]! });
const instanceScope = (kind: string): ControlScope => Object.freeze({ kind: 'instance' as const, environmentId: ENV, harnessInstanceId: HARNESS_IDS[kind]! });
const workspaceScope = (canonicalPath: string): ControlScope => Object.freeze({ kind: 'workspace' as const, environmentId: ENV, canonicalPath });

// ── log spy: capture every console channel so a credential leak can be proven absent ──
const consoleEntries: Array<{ level: string; text: string }> = [];
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { consoleEntries.push({ level, text: args.map(safeString).join(' ') }); } catch { /* capture never throws */ }
    original(...args);
  };
}
const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

// ── theme application: the region presets as the CSS custom properties the app reads ──
const THEME_PRESETS: Record<string, typeof DEFAULT_REGION_THEME> = {
  default: DEFAULT_REGION_THEME, 'aurora-tide': AURORA_TIDE_PRESET, sakura: SAKURA_PRESET,
};
function applyTheme(name: string): void {
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

// ── pure capability API over the real resolver ──
const capabilities = useRuntimeCapabilities({ activeBackendKind: 'opencode', manifests: KINDS.map((kind) => manifest(kind, DECLARED[kind]!)) });

function normalizeSupport(support: ControlSupport): AnyRecord {
  if (support.state === 'supported') {
    return {
      state: 'supported', channel: support.channel, control: support.control, operation: support.operation,
      capability: support.capability, sourceKind: support.channel === 'harness' ? support.source.kind : 'workspace',
      reason: null, hasSource: true,
    };
  }
  return {
    state: 'unsupported', channel: support.channel, control: support.control, operation: support.operation,
    capability: support.capability, sourceKind: support.source ? support.source.kind : null,
    reason: support.reason, hasSource: support.source !== null, description: describeControlSupport(support),
  };
}

function matrix(): AnyRecord {
  const result: AnyRecord = {};
  for (const kind of KINDS) {
    const supported: string[] = []; const unsupported: string[] = [];
    for (const control of CONTROLS) {
      const support = resolveControlSupport({ control, scope: sessionScope(kind), manifests: [manifest(kind, DECLARED[kind]!)] });
      if (support.state === 'supported') supported.push(control); else unsupported.push(control);
    }
    result[kind] = { supported: supported.sort(), unsupported: unsupported.sort(), supportedCount: supported.length, unsupportedCount: unsupported.length, total: CONTROLS.length };
  }
  return result;
}

function resolveOne(input: AnyRecord): AnyRecord {
  const kind = String(input.kind);
  const scope = input.scopeKind === 'workspace' ? workspaceScope(String(input.path ?? '/repo')) : input.scopeKind === 'instance' ? instanceScope(kind) : sessionScope(kind);
  const manifests = input.variant ? manifestsFor(kind, String(input.variant)) : [manifest(kind, DECLARED[kind]!)] ;
  return normalizeSupport(resolveControlSupport({ control: String(input.control), scope, manifests, activeBackendKind: input.activeBackendKind }));
}

// ── write sink: a local ledger whose writes are guarded by the REAL capabilities.apply ──
const writeLedger: Array<{ target: string; control: string; payload: AnyRecord }> = [];
function captureFor(input: AnyRecord): { save: ReturnType<typeof captureControlSave> | null; error: string | null } {
  const kind = String(input.kind);
  const scope = input.scopeKind === 'instance' ? instanceScope(kind) : sessionScope(kind);
  try {
    return { save: capabilities.capture({ control: String(input.control), scope, payload: input.payload ?? {} }), error: null };
  } catch (error) { return { save: null, error: error instanceof Error ? error.message : String(error) }; }
}
function writeTo(target: string, save: ReturnType<typeof captureControlSave>): { applied: boolean; error: string | null } {
  const kind = target.split(':')[0]!;
  const scope = target.includes('instance') ? instanceScope(kind) : sessionScope(kind);
  try {
    if (!capabilities.apply(save, scope)) return { applied: false, error: 'scope_mismatch' };
    writeLedger.push({ target, control: save.control, payload: save.payload as AnyRecord });
    return { applied: true, error: null };
  } catch (error) { return { applied: false, error: error instanceof Error ? error.message : String(error) }; }
}

// ── HarnessSettings surface ──
const harnessSaves: string[] = [];
const harnessHost = document.createElement('div');
harnessHost.id = 'qa23-harness';
const harnessState = reactive({ kind: 'opencode' as HarnessKind, manifests: [manifest('opencode', DECLARED.opencode!)] as readonly HarnessManifest[], scope: sessionScope('opencode') as ControlScope, controls: [...CONTROLS] as readonly string[] });
const harnessApp = createApp(defineComponent({
  setup() {
    return () => h(HarnessSettings, {
      harnessKind: harnessState.kind, manifests: harnessState.manifests, scope: harnessState.scope,
      controls: harnessState.controls, labels: LABELS, actionLabels: ACTIONS, title: 'Native harness settings',
      onSave: (control: string) => harnessSaves.push(control),
    });
  },
}));
harnessApp.use(i18n);
harnessApp.mount(harnessHost);

async function setHarness(input: AnyRecord): Promise<void> {
  const kind = String(input.kind);
  harnessState.kind = kind as HarnessKind;
  harnessState.manifests = manifestsFor(kind, String(input.variant ?? 'default'));
  harnessState.scope = sessionScope(kind);
  harnessState.controls = input.variant === 'unknown' ? [...CONTROLS, 'not-a-real-control'] : [...CONTROLS];
  await nextTick();
}
function harnessRows(): AnyRecord {
  const rows = Array.from(harnessHost.querySelectorAll<HTMLElement>('.harness-settings-row'));
  return {
    rows: rows.map((row) => ({
      control: row.dataset.control ?? null,
      state: row.dataset.state ?? null,
      sourceKind: row.dataset.sourceKind ?? null,
      sourceText: row.querySelector('[data-testid="harness-control-source"]')?.textContent?.trim() ?? null,
      hasAction: Boolean(row.querySelector('[data-testid="harness-control-action"]')),
      actionDisabled: row.querySelector<HTMLButtonElement>('[data-testid="harness-control-action"]')?.disabled ?? null,
    })),
    rowCount: rows.length,
    summary: harnessHost.querySelector('[data-testid="harness-settings-unsupported-count"]')?.textContent?.trim() ?? null,
    scopeText: harnessHost.querySelector('[data-testid="harness-settings-scope"]')?.textContent?.trim() ?? null,
    text: harnessHost.innerText.slice(0, 4000),
  };
}
function clickHarnessAction(control: string): void {
  harnessHost.querySelector<HTMLButtonElement>(`[data-control="${control}"] [data-testid="harness-control-action"]`)?.click();
}

// ── ProviderManagerModal surface ──
const providerHost = document.createElement('div');
providerHost.id = 'qa23-provider';
const providerState = reactive({
  open: true,
  providers: [{ id: 'alpha', name: 'Alpha', source: 'api', models: {} }],
  connectedProviderIds: [] as string[],
  selectedModel: '', hiddenModels: [] as string[], providerConfig: null as AnyRecord | null,
  backendKind: 'opencode' as const,
  harnessScope: instanceScope('kimi-web') as ControlScope,
  harnessManifests: [manifest('kimi-web', DECLARED['kimi-web']!)] as readonly HarnessManifest[],
});
const providerApp = createApp(defineComponent({
  setup() {
    return () => h(ProviderManagerModal, { ...providerState });
  },
}));
providerApp.use(i18n);
providerApp.provide('showPrompt', async () => null);
providerApp.provide('showConfirm', async () => true);
providerApp.mount(providerHost);

async function setProviderScope(input: AnyRecord): Promise<void> {
  const kind = String(input.kind ?? 'kimi-web');
  providerState.harnessScope = input.scopeKind === 'instance' ? instanceScope(kind) : sessionScope(kind);
  providerState.harnessManifests = manifestsFor(kind, String(input.variant ?? 'default'));
  await nextTick();
  providerHost.querySelector<HTMLButtonElement>('.provider-view-all-toggle')?.click();
  await nextTick();
}
function providerStateSnapshot(): AnyRecord {
  const sources = Array.from(providerHost.querySelectorAll('[data-testid="provider-control-source"]'));
  const rows = Array.from(providerHost.querySelectorAll('.provider-mini-row'));
  const alpha = rows.find((row) => (row.textContent ?? '').includes('alpha'));
  const buttons = alpha ? Array.from(alpha.querySelectorAll<HTMLButtonElement>('button')).map((button) => ({ text: button.textContent?.trim() ?? '', disabled: button.disabled, title: button.getAttribute('title') })) : [];
  return {
    sourceTexts: sources.map((element) => element.textContent?.trim() ?? ''),
    sourceCount: sources.length,
    providerRows: rows.length,
    alphaButtons: buttons,
    text: providerHost.innerText.slice(0, 3000),
  };
}

// ── StatusMonitorModal surface ──
const monitorHost = document.createElement('div');
monitorHost.id = 'qa23-monitor';
const monitorState = reactive({
  open: false, preload: false, activeBackendKind: 'opencode' as const,
  harnessScope: instanceScope('opencode') as ControlScope,
  harnessManifests: [manifest('opencode', [])] as readonly HarnessManifest[],
});
const monitorApp = createApp(defineComponent({
  setup() {
    const codexApi = useCodexApi();
    return () => h(StatusMonitorModal, { ...monitorState, codexApi });
  },
}));
monitorApp.use(i18n);
monitorApp.mount(monitorHost);

async function setMonitorScope(input: AnyRecord): Promise<void> {
  const kind = String(input.kind ?? 'opencode');
  monitorState.harnessScope = input.scopeKind === 'instance' ? instanceScope(kind) : sessionScope(kind);
  monitorState.harnessManifests = manifestsFor(kind, String(input.variant ?? 'default'));
  await nextTick();
  // Opening the modal runs the real refresh() over the manifest-gated path; the
  // unsupported flags are set before the first await, then the MCP tab renders.
  monitorState.open = true;
  await new Promise((resolve) => setTimeout(resolve, 400));
  await nextTick();
  const tabs = Array.from(monitorHost.querySelectorAll<HTMLButtonElement>('[role="tablist"] button'));
  const mcp = tabs.find((tab) => (tab.textContent ?? '').trim().toUpperCase() === 'MCP') ?? tabs.find((tab) => (tab.textContent ?? '').toUpperCase().includes('MCP'));
  mcp?.click();
  await nextTick();
}
function monitorSnapshot(): AnyRecord {
  const sources = Array.from(monitorHost.querySelectorAll('[data-testid="monitor-control-source"]'));
  const tabs = Array.from(monitorHost.querySelectorAll('[role="tablist"] button')).map((tab) => (tab.textContent ?? '').trim());
  return {
    sourceTexts: sources.map((element) => element.textContent?.trim() ?? ''),
    sourceCount: sources.length,
    tabs,
    text: monitorHost.innerText.slice(0, 3000),
  };
}

// ── SettingsModal surface (workspace channel) ──
(window as unknown as AnyRecord).electronAPI = { localFile: { open: async () => null, save: async () => true }, desktop: {} };
const settingsHost = document.createElement('div');
settingsHost.id = 'qa23-settings';
const settingsState = reactive({ open: true, workspaceEnvironmentId: ENV as string | undefined, workspacePath: '/repo' as string | undefined });
const settingsApp = createApp(defineComponent({
  setup() {
    return () => h(SettingsModal, { ...settingsState });
  },
}));
settingsApp.use(i18n);
settingsApp.mount(settingsHost);

async function setWorkspaceScope(input: AnyRecord): Promise<void> {
  settingsState.workspaceEnvironmentId = input.present === false ? undefined : ENV;
  settingsState.workspacePath = input.present === false ? undefined : String(input.path ?? '/repo');
  await nextTick();
  const target = Array.from(settingsHost.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.getAttribute('aria-label') === en.settings.editor.label);
  target?.click();
  await nextTick();
}
function settingsSnapshot(): AnyRecord {
  const controls = Array.from(settingsHost.querySelectorAll<HTMLButtonElement>('.local-application-controls button'));
  const browse = controls[0] ?? null;
  const source = settingsHost.querySelector('[data-testid="workspace-control-source"]');
  return {
    hasLocalApplicationRow: controls.length > 0,
    browseDisabled: browse ? browse.disabled : null,
    browseTitle: browse ? browse.getAttribute('title') : null,
    sourceText: source ? source.textContent?.trim() ?? '' : null,
    sourceCount: source ? 1 : 0,
    text: settingsHost.innerText.slice(0, 3000),
  };
}

// ── page assembly + window API ──
const statusElement = document.createElement('pre');
statusElement.id = 'qa23-status';
statusElement.style.cssText = 'white-space:pre-wrap;font:12px/1.5 monospace;padding:8px;';
const rootHost = document.getElementById('app') ?? document.body;
rootHost.append(harnessHost, providerHost, monitorHost, settingsHost, statusElement);
applyTheme('default');

const api = {
  ready: true,
  errors: () => errors,
  consoleEntries: () => consoleEntries,
  domText: () => document.body.innerText,
  marker: (message: string) => { console.log(String(message)); return { logged: true }; },
  matrix,
  resolveOne,
  captureFor,
  writeTo,
  writeLedger: () => writeLedger,
  crossWrite: (input: AnyRecord) => {
    const captured = captureFor({ kind: input.sourceKind, scopeKind: input.scopeKind ?? 'instance', control: input.control, payload: input.payload ?? {} });
    const result: AnyRecord = { captured: captured.save !== null, captureError: captured.error };
    if (captured.save) {
      result.saveScope = JSON.parse(JSON.stringify(captured.save.scope));
      result.writeToOther = writeTo(String(input.targetKind), captured.save);
      // A save resolved on one source must refuse to be captured for another.
      const otherSupport = resolveControlSupport({ control: String(input.control), scope: instanceScope(String(input.targetKind)), manifests: [manifest(String(input.targetKind), DECLARED[String(input.targetKind)] ?? [])] });
      try {
        captureControlSave({ control: String(input.control), support: otherSupport, scope: instanceScope(String(input.sourceKind)), payload: input.payload ?? {} });
        result.crossCaptureError = null;
      } catch (error) { result.crossCaptureError = error instanceof Error ? error.message : String(error); }
    }
    result.ledger = writeLedger;
    return result;
  },
  captureUnsupported: (input: AnyRecord) => {
    const kind = String(input.kind);
    const support = resolveControlSupport({ control: String(input.control), scope: instanceScope(kind), manifests: [manifest(kind, DECLARED[kind] ?? [])] });
    try { captureControlSave({ control: String(input.control), support, scope: instanceScope(kind), payload: input.payload ?? {} }); return { thrown: false, error: null }; }
    catch (error) { return { thrown: true, error: error instanceof Error ? error.message : String(error) }; }
  },
  setHarness: (input: AnyRecord) => setHarness(input),
  harnessRows,
  clickHarnessAction,
  harnessSaves: () => harnessSaves,
  setProviderScope: (input: AnyRecord) => setProviderScope(input),
  provider: providerStateSnapshot,
  setMonitorScope: (input: AnyRecord) => setMonitorScope(input),
  monitor: monitorSnapshot,
  setWorkspaceScope: (input: AnyRecord) => setWorkspaceScope(input),
  settings: settingsSnapshot,
  setTheme: (name: string) => { applyTheme(name); return { theme: name }; },
  status: () => ({ harnessRows: harnessHost.querySelectorAll('.harness-settings-row').length, providerRows: providerHost.querySelectorAll('.provider-mini-row').length, monitorTabs: monitorHost.querySelectorAll('[role="tablist"] button').length, settingsLocalRow: settingsHost.querySelectorAll('.local-application-controls button').length }),
};

(window as unknown as AnyRecord).task23 = api;
void nextTick();
