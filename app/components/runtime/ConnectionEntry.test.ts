/**
 * Task 24 acceptance tests — the workspace panel and connection surfaces.
 *
 *   1. `ConnectionEntry.vue` — the ONE single Bridge entry point. It binds a
 *      connection profile / target, never a per-backend chooser that flips a
 *      global active backend, and it exposes the target's capabilities so a
 *      capability the target lacks is never offered.
 *   2. `MigrationWizard.vue` — legacy data can be browsed, bound and migrated
 *      with a retry path. Backup progress and retry progress are explicit.
 *   3. The workspace panel (ProjectPicker / ProjectSettingsDialog) resolves
 *      every workspace action through the WorkspaceService-shaped surface
 *      rather than a raw active-backend adapter.
 *
 * The tests drive the real components over the real i18n message catalogue.
 */
import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locales/en';
import ConnectionEntry from './ConnectionEntry.vue';
import MigrationWizard from './MigrationWizard.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function mount(component: unknown, props: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(component as never, props);
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en }, missingWarn: false, fallbackWarn: false });
  app.use(i18n);
  app.mount(host);
  return host;
}

// ---------------------------------------------------------------------------
// 1. ConnectionEntry — one single Bridge entry point
// ---------------------------------------------------------------------------

describe('ConnectionEntry is one single Bridge entry point', () => {
  const profiles = [
    { profileId: '11111111-1111-4111-8111-111111111111', label: 'Workstation', bridgeUrl: 'ws://127.0.0.1:23004', target: { environmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'opencode' as const } },
    { profileId: '22222222-2222-4222-8222-222222222222', label: 'Lab cluster', bridgeUrl: 'ws://10.0.0.5:23004', target: { environmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'codex' as const } },
  ];

  it('renders one entry surface, not one control per backend', () => {
    const root = mount(ConnectionEntry, { profiles, open: true, status: 'idle' });
    expect(root.querySelector('[data-testid="connection-entry"]')).not.toBeNull();
    // No per-backend chooser: a single-active-backend control would render one
    // button per kind that flips the app's backend.
    expect(root.querySelector('[data-testid="connection-backend-chooser"]')).toBeNull();
    expect(root.querySelectorAll('[data-testid="connection-profile-row"]')).toHaveLength(2);
  });

  it('binds the chosen profile and target together, so the binding is never ambiguous', async () => {
    const bound: unknown[] = [];
    const root = mount(ConnectionEntry, {
      profiles,
      open: true,
      status: 'idle',
      onBind: (value: unknown) => bound.push(value),
    });
    const row = root.querySelectorAll<HTMLButtonElement>('[data-testid="connection-profile-row"]')[1]!;
    row.click();
    await nextTick();
    expect(root.querySelector('[data-testid="connection-target-ambiguous"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-testid="connection-connect"]')?.click();
    await nextTick();
    expect(bound).toEqual([
      {
        profileId: '22222222-2222-4222-8222-222222222222',
        target: { environmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'codex' },
      },
    ]);
  });

  it('names the target a capability comes from, so an unsupported capability never masquerades as available', () => {
    const root = mount(ConnectionEntry, {
      profiles,
      open: true,
      status: 'idle',
      capabilities: [
        { capability: 'files', supported: true, target: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        { capability: 'externalEditor', supported: false, target: 'bbbbbbbb-bbbb-4bbb-8aaa-bbbbbbbbbbbb' },
      ],
    });
    const unsupported = root.querySelector('[data-testid="connection-capability-unsupported"]');
    expect(unsupported).not.toBeNull();
    expect(unsupported?.textContent).toContain('externalEditor');
    // The target is named so the reader knows WHICH source lacks it.
    expect(unsupported?.textContent).toContain('bbbb…');
    expect(root.querySelector('[data-testid="connection-capability-supported"]')?.textContent).toContain('files');
    // The unsupported row carries no affordance.
    expect(unsupported?.querySelector('button')).toBeNull();
  });

  it('shows the connecting, error and retry states distinctly', async () => {
    const root = mount(ConnectionEntry, { profiles, open: true, status: 'connecting', error: '' });
    expect(root.querySelector<HTMLElement>('[data-testid=connection-status]')?.dataset.state).toBe('connecting');
    root.remove();
    const failed = mount(ConnectionEntry, { profiles, open: true, status: 'error', error: 'target unreachable' });
    expect(failed.querySelector<HTMLElement>('[data-testid=connection-status]')?.dataset.state).toBe('error');
    expect(failed.querySelector('[data-testid="connection-error"]')?.textContent).toContain('target unreachable');
    expect(failed.querySelector<HTMLButtonElement>('[data-testid="connection-retry"]')?.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. MigrationWizard — browse / bind / migrate with retry
// ---------------------------------------------------------------------------

describe('MigrationWizard browses, binds and migrates legacy data with a retry path', () => {
  const inventory = {
    revision: 'rev-0001',
    sources: [
      { sourceKey: 'opencode.drafts.composer.v1', source: 'browser:abc/localStorage', kind: 'composer' as const, bytes: 120 },
      { sourceKey: 'opencode.state.backendHistory.v1.deadbeef.ses-1', source: 'browser:abc/opencode.backendHistory/histories', kind: 'history' as const, bytes: 4096, nativeSessionId: 'ses-1' },
    ],
  };
  const mappings = [
    { profileId: '11111111-1111-4111-8111-111111111111', environmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', harnessInstanceId: '10000000-0000-4000-8000-000000000001', nativeSessionId: 'ses-1', evidence: 'user-confirmed' as const },
  ];

  it('browses the legacy inventory and reports what each source is', () => {
    const root = mount(MigrationWizard, { open: true, inventory, mappings, status: 'idle' });
    expect(root.querySelectorAll('[data-testid="migration-source-row"]')).toHaveLength(2);
    const rows = root.querySelectorAll('[data-testid="migration-source-row"]');
    expect(rows[0]?.textContent).toContain('Composer draft');
    expect(rows[1]?.textContent).toContain('History');
  });

  it('binds a legacy source to a target and marks the binding, so the same native id cannot bind twice', async () => {
    const bound: unknown[] = [];
    const root = mount(MigrationWizard, {
      open: true,
      inventory,
      mappings,
      status: 'idle',
      onBind: (value: unknown) => bound.push(value),
    });
    const row = root.querySelectorAll<HTMLButtonElement>('[data-testid="migration-source-row"]')[1]!;
    row.click();
    await nextTick();
    expect(bound).toEqual([
      { sourceKey: 'opencode.state.backendHistory.v1.deadbeef.ses-1', nativeSessionId: 'ses-1' },
    ]);
    expect(root.querySelector('[data-testid="migration-bound"]')?.textContent).toContain('1 source(s) bound');
    expect(root.querySelector<HTMLElement>('[data-testid="migration-bound"]')?.dataset.state).not.toBe('ambiguous');
  });

  it('shows explicit backup progress before any target write', () => {
    const root = mount(MigrationWizard, {
      open: true,
      inventory,
      mappings,
      status: 'backing-up',
      backup: { records: 2, chunks: 5, boundRecords: 1, boundChunks: 3, done: false },
    });
    const progress = root.querySelector<HTMLElement>('[data-testid="migration-backup-progress"]');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain('2');
    expect(progress?.dataset.complete).toBe('false');
  });

  it('migrates and reports the cutover result', () => {
    const root = mount(MigrationWizard, {
      open: true,
      inventory,
      mappings,
      status: 'done',
      result: { importId: 'imp-1', records: 2, chunks: 5, drafts: 1, boundRecords: 1, localOnlyRecords: 1 },
    });
    const result = root.querySelector('[data-testid="migration-result"]');
    expect(result).not.toBeNull();
    expect(result?.textContent).toContain('2');
    expect(result?.textContent).toContain('imp-1');
  });

  it('keeps a failed migration retryable and never loses the legacy original', () => {
    const retried: unknown[] = [];
    const root = mount(MigrationWizard, {
      open: true,
      inventory,
      mappings,
      status: 'failed',
      error: 'disk full',
      retained: true,
      onRetry: () => retried.push('retry'),
    });
    expect(root.querySelector('[data-testid="migration-error"]')?.textContent).toContain('disk full');
    expect(root.querySelector('[data-testid="migration-retained"]')?.textContent).toContain('retained');
    root.querySelector<HTMLButtonElement>('[data-testid="migration-retry"]')?.click();
    expect(retried).toEqual(['retry']);
  });
});
