/**
 * PR #182 review round 081ff620a item 1 — the default desktop settings can no
 * longer browse/select a local application (REGRESSION).
 *
 * Task 23 added a `workspace.readFileContent` gate to the Editor page's local
 * application Browse button, but App.vue never passes the new
 * `workspaceEnvironmentId` / `workspacePath` props, so in the DEFAULT app the
 * gate resolves against no workspace at all: Browse renders disabled, the
 * chooser is never invoked, and a "workspace missing" line is shown.
 *
 * The local application chooser is an Electron LOCAL capability
 * (`electronAPI.localFile.selectApplication` on this machine); it never reads
 * a remote workspace. These tests mount the REAL SettingsModal with exactly
 * the scope props App.vue supplies by default (none) plus an Electron chooser
 * double, and assert the pre-migration behaviour is preserved. The gate must
 * still apply once workspace props ARE supplied.
 */
import { createApp, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enLocale from '../locales/en';
import type { DesktopApi, DesktopState } from '../types/desktop';

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { class: 'iconify', 'data-icon': props.icon }),
}));

const en = enLocale.settings.editor.localApplication;
const WORKSPACE_SOURCE_TESTID = 'workspace-control-source';

const mountedApps: Array<() => void> = [];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  delete window.electronAPI;
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete window.electronAPI;
});

function makeState(): DesktopState {
  return {
    preferences: {
      locale: 'en',
      minimizeToTray: true,
      closeToTray: false,
      autoCheckUpdates: true,
      autoDownloadUpdates: false,
      idleNotifications: true,
      notificationSound: false,
    },
    trayAvailable: true,
    nativeNotificationsAvailable: true,
    updates: {
      app: {
        component: 'app',
        currentVersion: '1.4.0',
        availableVersion: null,
        phase: 'idle',
        progress: null,
        error: null,
        installKind: 'automatic',
        assetName: null,
      },
      bridge: {
        component: 'bridge',
        currentVersion: null,
        availableVersion: null,
        phase: 'idle',
        progress: null,
        error: null,
        installKind: 'manual',
        assetName: null,
      },
    },
  };
}

function createDesktopApi(): DesktopApi {
  return {
    getState: vi.fn(() => Promise.resolve(makeState())),
    configure: vi.fn(() => Promise.resolve(makeState())),
    check: vi.fn(() => Promise.resolve(makeState())),
    download: vi.fn(() => Promise.resolve(makeState())),
    install: vi.fn(() => Promise.resolve(makeState())),
    notify: vi.fn(() => Promise.resolve()),
    onState: vi.fn(() => () => {}),
    onNotificationClick: vi.fn(() => () => {}),
  };
}

/** The Electron chooser double: a spy that resolves a chosen application path. */
function createElectronLocalFile(selectedPath: string | null = '/usr/bin/code') {
  return {
    selectApplication: vi.fn(() => Promise.resolve(selectedPath)),
    clearApplication: vi.fn(() => Promise.resolve()),
  };
}

async function flushAsync() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

/**
 * Mount the real SettingsModal with EXACTLY the scope props App.vue passes by
 * default: `open` only. No `workspaceEnvironmentId`, no `workspacePath`.
 */
async function mountDefaultModal() {
  const [{ default: SettingsModal }, { i18n }] = await Promise.all([
    import('./SettingsModal.vue'),
    import('../i18n'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(SettingsModal, { open: true });
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  return host;
}

/** Mount with explicit workspace scope props (the wired-in-later shape). */
async function mountModalWithWorkspaceScope(workspaceEnvironmentId: string, workspacePath: string) {
  const [{ default: SettingsModal }, { i18n }] = await Promise.all([
    import('./SettingsModal.vue'),
    import('../i18n'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(SettingsModal, {
    open: true,
    workspaceEnvironmentId,
    workspacePath,
  });
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  return host;
}

function modalBody(host: HTMLElement) {
  const body = host.querySelector('.modal-body');
  expect(body).not.toBeNull();
  return body as HTMLElement;
}

function pageRows(host: HTMLElement) {
  return Array.from(modalBody(host).querySelectorAll(':scope > .setting-row'));
}

async function openEditorPage(host: HTMLElement) {
  const editorLink = pageRows(host).find(
    (row) => row.querySelector('.setting-label')?.textContent === enLocale.settings.editor.label,
  );
  expect(editorLink, 'editor link row must exist').toBeDefined();
  editorLink!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flushAsync();
}

function localApplicationRow(host: HTMLElement) {
  const row = pageRows(host).find(
    (candidate) =>
      candidate.querySelector('.setting-label')?.textContent === en.label,
  );
  expect(row, 'local application row must exist on the editor page').toBeDefined();
  return row as HTMLElement;
}

function browseButton(host: HTMLElement) {
  const button = Array.from(
    localApplicationRow(host).querySelectorAll<HTMLButtonElement>('.local-application-controls button'),
  ).find((candidate) => candidate.textContent?.trim() === en.browse);
  expect(button, 'browse button must exist').toBeDefined();
  return button as HTMLButtonElement;
}

function workspaceSourceLine(host: HTMLElement) {
  return localApplicationRow(host).querySelector(`[data-testid="${WORKSPACE_SOURCE_TESTID}"]`);
}

describe('SettingsModal local application browse — default app scope (PR #182 finding A)', () => {
  it('keeps Browse enabled and invokes the Electron chooser with App’s default scope props', async () => {
    // Given: an Electron runtime and App's DEFAULT scope props (no workspace props).
    const localFile = createElectronLocalFile('/usr/bin/code');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: createDesktopApi(), localFile },
    });
    const host = await mountDefaultModal();

    // When: the editor page is opened.
    await openEditorPage(host);

    // Then: Browse is NOT disabled by the workspace gate (pre-migration behaviour).
    const button = browseButton(host);
    expect(button.disabled).toBe(false);
    expect(workspaceSourceLine(host)).toBeNull();

    // And: clicking it invokes the local Electron chooser exactly once.
    button.click();
    await flushAsync();
    expect(localFile.selectApplication).toHaveBeenCalledTimes(1);
  });

  it('records the application path the chooser returns', async () => {
    // Given: a chooser that resolves a path.
    const localFile = createElectronLocalFile('/usr/local/bin/zed');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: createDesktopApi(), localFile },
    });
    localStorage.setItem('opencode.settings.localApplicationPath.v1', '');
    const host = await mountDefaultModal();

    await openEditorPage(host);
    browseButton(host).click();
    await flushAsync();

    // Then: the chosen path lands in the path input (the original behaviour).
    const pathInput = localApplicationRow(host).querySelector<HTMLInputElement>(
      'input.local-application-path',
    );
    expect(pathInput).not.toBeNull();
    expect(pathInput!.value).toBe('/usr/local/bin/zed');
    expect(localApplicationErrorText(host)).toBe('');
  });
});

describe('SettingsModal local application browse — workspace scope supplied (PR #182 finding A)', () => {
  it('still gates on the workspace control when workspace props ARE present and malformed', async () => {
    // Given: workspace props whose environment id is not a valid EnvironmentId.
    const localFile = createElectronLocalFile(null);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: createDesktopApi(), localFile },
    });
    const host = await mountModalWithWorkspaceScope('not-a-valid-environment-id', '/repo');

    await openEditorPage(host);

    // Then: the workspace gate engages — Browse is disabled and names its source.
    const button = browseButton(host);
    expect(button.disabled).toBe(true);
    const source = workspaceSourceLine(host);
    expect(source).not.toBeNull();
    expect(source!.textContent).toContain('invalid environment id');
    expect(localFile.selectApplication).not.toHaveBeenCalled();
  });

  it('keeps Browse enabled when a valid workspace scope is supplied', async () => {
    // Given: a valid workspace scope (readFileContent is a workspace operation).
    const localFile = createElectronLocalFile(null);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: createDesktopApi(), localFile },
    });
    const host = await mountModalWithWorkspaceScope(
      '11111111-1111-4111-8111-111111111111',
      '/repo',
    );

    await openEditorPage(host);

    // Then: the workspace control resolves supported, so Browse stays enabled.
    expect(browseButton(host).disabled).toBe(false);
    expect(workspaceSourceLine(host)).toBeNull();
  });
});

function localApplicationErrorText(host: HTMLElement) {
  return localApplicationRow(host).querySelector('.theme-import-error')?.textContent ?? '';
}
