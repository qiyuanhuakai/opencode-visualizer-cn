import { createApp, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import en from '../locales/en';
import ConnectionEntry from '../components/runtime/ConnectionEntry.vue';
import MigrationWizard from '../components/runtime/MigrationWizard.vue';
import type { ConnectionProfileEntry } from '../components/runtime/ConnectionEntry.vue';
import type { MigrationInventory } from '../components/runtime/MigrationWizard.vue';

declare global {
  interface Window {
    __task24__?: {
      ready: boolean;
      setTheme(value: string): void;
      setSurface(value: 'connection' | 'migration-idle' | 'migration-backup' | 'migration-retry'): void;
      state(): Readonly<{ theme: string; surface: string; width: number; rows: number; bound: number; errors: number }>;
    };
    __task24Errors?: unknown[];
  }
}

const THEMES = ['default', 'aurora-tide', 'sakura'] as const;
const THEME_VARS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  default: {
    '--theme-surface-base': '#0f172a',
    '--theme-surface-panel': '#1e293b',
    '--theme-surface-panel-elevated': 'rgba(15, 23, 42, 0.98)',
    '--theme-surface-overlay': 'rgba(2, 6, 23, 0.65)',
    '--theme-text-primary': '#e2e8f0',
    '--theme-text-muted': '#94a3b8',
    '--theme-border-default': '#334155',
    '--theme-border-muted': '#334155',
    '--theme-modal-bg': 'rgba(15, 23, 42, 0.98)',
    '--theme-modal-border': '#334155',
    '--theme-modal-text': '#e2e8f0',
    '--theme-modal-text-muted': '#94a3b8',
    '--theme-modal-control-bg': '#0b1320',
    '--theme-modal-active-bg': '#1e293b',
    '--theme-modal-accent': '#60a5fa',
    '--theme-modal-active-text': '#e2e8f0',
    '--theme-shadow-panel': '0 12px 32px rgba(2, 6, 23, 0.45)',
    '--theme-status-error': '#f87171',
    '--color-region-accent': '#3b82f6',
    '--color-success-400': '#22c55e',
  },
  'aurora-tide': {
    '--theme-surface-base': '#0b1f27',
    '--theme-surface-panel': '#123039',
    '--theme-surface-panel-elevated': 'rgba(11, 31, 39, 0.98)',
    '--theme-surface-overlay': 'rgba(2, 17, 23, 0.65)',
    '--theme-text-primary': '#dff3f6',
    '--theme-text-muted': '#8fb6bf',
    '--theme-border-default': '#1f5563',
    '--theme-border-muted': '#1f5563',
    '--theme-modal-bg': 'rgba(11, 31, 39, 0.98)',
    '--theme-modal-border': '#1f5563',
    '--theme-modal-text': '#dff3f6',
    '--theme-modal-text-muted': '#8fb6bf',
    '--theme-modal-control-bg': '#071820',
    '--theme-modal-active-bg': '#123039',
    '--theme-modal-accent': '#38bdf8',
    '--theme-modal-active-text': '#04141a',
    '--theme-shadow-panel': '0 12px 32px rgba(2, 17, 23, 0.5)',
    '--theme-status-error': '#fb7185',
    '--color-region-accent': '#38bdf8',
    '--color-success-400': '#34d399',
  },
  sakura: {
    '--theme-surface-base': '#241a20',
    '--theme-surface-panel': '#33222b',
    '--theme-surface-panel-elevated': 'rgba(36, 26, 32, 0.98)',
    '--theme-surface-overlay': 'rgba(20, 12, 17, 0.65)',
    '--theme-text-primary': '#f7e6ec',
    '--theme-text-muted': '#c3a3b1',
    '--theme-border-default': '#5b3a48',
    '--theme-border-muted': '#5b3a48',
    '--theme-modal-bg': 'rgba(36, 26, 32, 0.98)',
    '--theme-modal-border': '#5b3a48',
    '--theme-modal-text': '#f7e6ec',
    '--theme-modal-text-muted': '#c3a3b1',
    '--theme-modal-control-bg': '#1c1218',
    '--theme-modal-active-bg': '#33222b',
    '--theme-modal-accent': '#f472b6',
    '--theme-modal-active-text': '#2a0f1c',
    '--theme-shadow-panel': '0 12px 32px rgba(20, 12, 17, 0.5)',
    '--theme-status-error': '#fda4af',
    '--color-region-accent': '#f472b6',
    '--color-success-400': '#4ade80',
  },
};

const PROFILES: readonly ConnectionProfileEntry[] = [
  {
    profileId: '11111111-1111-4111-8111-111111111111',
    label: 'Workstation',
    bridgeUrl: 'ws://127.0.0.1:23004/runtime',
    target: { environmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'opencode' },
  },
  {
    profileId: '22222222-2222-4222-8222-222222222222',
    label: 'Lab bridge',
    bridgeUrl: 'ws://lab.example.com:23004/runtime',
    target: { environmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'codex' },
  },
];

const CAPABILITIES = [
  { capability: 'files', supported: true, target: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { capability: 'git', supported: true, target: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { capability: 'terminal', supported: true, target: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { capability: 'externalEditor', supported: false, target: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
];

const INVENTORY: MigrationInventory = {
  revision: 'browser:9f2c41ab7d0e5c18',
  sources: [
    { sourceKey: 'opencode.drafts.composer.v1', source: 'browser/localStorage', kind: 'composer', bytes: 2048 },
    { sourceKey: 'opencode.state.backendHistory.v1.deadbeef.ses-1', source: 'browser/opencode.backendHistory/histories', kind: 'history', bytes: 65536, nativeSessionId: 'ses-1' },
    { sourceKey: 'opencode.state.backendHistory.v1.deadbeef.ses-2', source: 'browser/opencode.backendHistory/histories', kind: 'history', bytes: 131072, nativeSessionId: 'ses-2' },
    { sourceKey: 'opencode.codexAuxiliaryHistory', source: 'browser/opencode.codexAuxiliaryHistory/snapshots', kind: 'metadata', bytes: 512 },
  ],
};

const surface = ref<'connection' | 'migration-idle' | 'migration-backup' | 'migration-retry'>('connection');
const theme = ref<string>('default');
const mount = ref<HTMLDivElement | null>(null);
const bound: string[] = [];

function migrationProps(value: 'migration-idle' | 'migration-backup' | 'migration-retry') {
  if (value === 'migration-backup') {
    return {
      status: 'backing-up' as const,
      backup: { records: 2, chunks: 5, boundRecords: 1, boundChunks: 3, done: false },
      retained: false,
    };
  }
  if (value === 'migration-retry') {
    return {
      status: 'failed' as const,
      backup: { records: 2, chunks: 5, boundRecords: 1, boundChunks: 3, done: false },
      retained: false,
      error: 'the migration chunk 3 was refused by the target',
    };
  }
  return { status: 'idle' as const, retained: false };
}

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en }, missingWarn: false, fallbackWarn: false });

function render() {
  const host = mount.value;
  if (!host) return;
  host.replaceChildren();
  const app = createApp({
    render: () =>
      surface.value === 'connection'
        ? h(ConnectionEntry, {
            open: true,
            profiles: PROFILES,
            capabilities: CAPABILITIES,
            status: 'ready',
            onBind: (value: unknown) => bound.push(JSON.stringify(value)),
            onClose: () => undefined,
            onRetry: () => undefined,
          })
        : h(MigrationWizard, {
            open: true,
            inventory: INVENTORY,
            onBind: (value: unknown) => bound.push(JSON.stringify(value)),
            onClose: () => undefined,
            onStart: () => undefined,
            onRetry: () => undefined,
            ...migrationProps(surface.value),
          }),
  });
  app.use(i18n);
  app.mount(host);
}

function applyTheme(value: string) {
  theme.value = value;
  const vars = THEME_VARS[value];
  for (const [key, cssValue] of Object.entries(vars)) {
    document.documentElement.style.setProperty(key, cssValue);
  }
  document.documentElement.dataset.theme = value;
}

const controls = document.createElement('div');
controls.className = 'task24-controls';
for (const name of THEMES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = name;
  button.dataset.theme = name;
  button.setAttribute('aria-pressed', String(theme.value === name));
  button.addEventListener('click', () => {
    applyTheme(name);
    for (const candidate of controls.querySelectorAll('button')) {
      candidate.setAttribute('aria-pressed', String(candidate.dataset.theme === name));
    }
  });
  controls.appendChild(button);
}
for (const [label, value] of [
  ['Connection entry', 'connection'],
  ['Wizard · bind', 'migration-idle'],
  ['Wizard · backup', 'migration-backup'],
  ['Wizard · retry', 'migration-retry'],
] as const) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.surface = value;
  button.setAttribute('aria-pressed', String(surface.value === value));
  button.addEventListener('click', () => {
    surface.value = value;
    for (const candidate of controls.querySelectorAll<HTMLButtonElement>('button[data-surface]')) {
      candidate.setAttribute('aria-pressed', String(candidate.dataset.surface === value));
    }
    void nextTick(render);
  });
  controls.appendChild(button);
}

const shell = document.createElement('div');
shell.className = 'task24-shell';
shell.appendChild(controls);
mount.value = document.createElement('div');
mount.value.className = 'task24-mount';
shell.appendChild(mount.value);
document.getElementById('app')?.replaceChildren(shell);

applyTheme('default');
render();

window.__task24__ = {
  ready: true,
  setTheme(value: string) {
      applyTheme(value);
      for (const candidate of controls.querySelectorAll<HTMLButtonElement>('button[data-theme]')) {
        candidate.setAttribute('aria-pressed', String(candidate.dataset.theme === value));
      }
    },
  setSurface(value: 'connection' | 'migration-idle' | 'migration-backup' | 'migration-retry') {
    surface.value = value;
    void nextTick(render);
  },
  state() {
    return {
      theme: theme.value,
      surface: surface.value,
      width: window.innerWidth,
      rows: surface.value === 'connection' ? PROFILES.length : INVENTORY.sources.length,      bound: bound.length,
      errors: (window.__task24Errors ?? []).length,
    };
  },
};
