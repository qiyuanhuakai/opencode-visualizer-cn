import { createApp, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopMessages } from '../locales/desktop';
import enLocale from '../locales/en';
import type { DesktopApi, DesktopState } from '../types/desktop';

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { class: 'iconify', 'data-icon': props.icon }),
}));

const en = desktopMessages.en.desktopSettings;

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

function createDesktopApi() {
  const api: DesktopApi = {
    getState: vi.fn(() => Promise.resolve(makeState())),
    configure: vi.fn(() => Promise.resolve(makeState())),
    check: vi.fn(() => Promise.resolve(makeState())),
    download: vi.fn(() => Promise.resolve(makeState())),
    install: vi.fn(() => Promise.resolve(makeState())),
    notify: vi.fn(() => Promise.resolve()),
    onState: vi.fn(() => () => {}),
    onNotificationClick: vi.fn(() => () => {}),
  };
  return api;
}

async function flushAsync() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountModal() {
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

function modalBody(host: HTMLElement) {
  const body = host.querySelector('.modal-body');
  expect(body).not.toBeNull();
  return body as HTMLElement;
}

function pageRows(host: HTMLElement) {
  return Array.from(modalBody(host).querySelectorAll(':scope > .setting-row'));
}

describe('SettingsModal desktop mounting', () => {
  it('hides the desktop link row when the desktop API is unavailable', async () => {
    // Given: a web runtime without window.electronAPI.
    const host = await mountModal();

    // Then: the root page keeps its original twelve rows and no desktop entry.
    expect(pageRows(host)).toHaveLength(12);
    const labels = pageRows(host).map((row) => row.querySelector('.setting-label')?.textContent);
    expect(labels).not.toContain(en.linkLabel);
  });

  it('shows the desktop link row and navigates to the desktop page when the API exists', async () => {
    // Given: a desktop runtime with the desktop bridge API.
    const api = createDesktopApi();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: api } });
    const host = await mountModal();

    // Then: a thirteenth link row leads to the desktop page.
    const rows = pageRows(host);
    expect(rows).toHaveLength(13);
    const linkRow = rows[12];
    expect(linkRow.querySelector('.setting-label')?.textContent).toBe(en.linkLabel);
    expect(linkRow.querySelector('.setting-description')?.textContent).toBe(en.linkDescription);

    // When: the link row is clicked.
    linkRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: the desktop page renders with its title and live state.
    expect(host.querySelector('.modal-title')!.textContent).toBe(en.pageTitle);
    expect(api.getState).toHaveBeenCalled();
    const cards = modalBody(host).querySelectorAll('.desktop-update-card');
    expect(cards).toHaveLength(2);
  });
});

describe('SettingsModal local application row layout', () => {
  function mountWithLocalFile(path: string) {
    localStorage.setItem('opencode.settings.localApplicationPath.v1', path);
    const localFile = {
      selectApplication: vi.fn(() => Promise.resolve(null)),
      clearApplication: vi.fn(() => Promise.resolve()),
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: createDesktopApi(), localFile },
    });
    return { localFile };
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
        candidate.querySelector('.setting-label')?.textContent ===
        enLocale.settings.editor.localApplication.label,
    );
    expect(row, 'local application row must exist on the editor page').toBeDefined();
    return row as HTMLElement;
  }

  it('places the path input and app buttons on a separate row below the label and description', async () => {
    // Given: an Electron runtime with the local file API and a configured path.
    mountWithLocalFile('/usr/bin/code');
    const host = await mountModal();

    // When: the editor page is opened.
    await openEditorPage(host);

    // Then: the row stacks vertically so the controls sit on their own row.
    const row = localApplicationRow(host);
    expect(row.getAttribute('class')).toBe('setting-row setting-row-column');
    const info = row.querySelector(':scope > .setting-info');
    const controls = row.querySelector(':scope > .local-application-controls');
    expect(info, 'row must lead with the label/description block').not.toBeNull();
    expect(controls, 'row must render the controls block').not.toBeNull();
    expect(
      info!.compareDocumentPosition(controls!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'controls must come after the label/description in DOM order',
    ).not.toBe(0);

    // And: the controls row carries the readonly path input with both buttons.
    const input = controls!.querySelector('input.font-stack-input[readonly]');
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe('/usr/bin/code');
    const buttonLabels = Array.from(controls!.querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );
    expect(buttonLabels).toEqual([
      enLocale.settings.editor.localApplication.browse,
      enLocale.settings.editor.localApplication.clear,
    ]);
  });

  it('omits the remove button when no local application is configured', async () => {
    // Given: an Electron runtime without a configured local application path.
    mountWithLocalFile('');
    const host = await mountModal();

    // When: the editor page is opened.
    await openEditorPage(host);

    // Then: only the browse action renders inside the controls row.
    const controls = localApplicationRow(host).querySelector(
      ':scope > .local-application-controls',
    );
    expect(controls).not.toBeNull();
    const buttonLabels = Array.from(controls!.querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );
    expect(buttonLabels).toEqual([enLocale.settings.editor.localApplication.browse]);
  });
});
