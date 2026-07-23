import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';

function createMessages() {
  return {
    en: {
      dropdown: { selectPlaceholder: 'Select' },
      topPanel: {
        title: 'Vis',
        pendingNotifications: '{count} notifications',
        noNotifications: 'No notifications',
        selectSession: 'Select session',
        searchPlaceholder: 'Search',
        empty: { noMatchingSessions: 'No matches', noWorktrees: 'No worktrees' },
        newSessionShortcut: 'New session',
        openShell: 'Open shell',
        openForge: 'Open Forge panel',
        openProject: 'Open project',
        github: 'GitHub',
        settings: 'Settings',
        providerManager: 'Providers',
        statusMonitor: 'Status',
        autoWindowsSuppressed: 'Auto windows suppressed',
        suppressAutoWindows: 'Suppress auto windows',
        logout: 'Logout',
        managementMode: { enter: 'Enter management mode', exit: 'Exit management mode' },
        management: {
          title: 'Manage',
          selectedCount: '{count}',
          done: 'Done',
          selectVisible: 'Select visible',
          unselectVisible: 'Unselect visible',
          clear: 'Clear',
          pin: 'Pin',
          unpin: 'Unpin',
          archive: 'Archive',
          unarchive: 'Unarchive',
          delete: 'Delete',
          archiveCodex: 'Archive Codex',
        },
        sessionActions: {
          unpin: 'Unpin',
          pin: 'Pin',
          rename: 'Rename',
          archive: 'Archive',
          unarchive: 'Unarchive',
          deletePermanently: 'Delete permanently',
          archiveCodex: 'Archive Codex',
        },
        confirm: { deleteSession: 'Delete?', archiveCodexSession: 'Archive?' },
        projectSettings: 'Project settings',
        newSession: 'New session',
        createSandbox: 'Create sandbox',
      },
      sidePanel: {
        session: {
          sessionTree: {
            pinProject: 'Pin project',
            unpinProject: 'Unpin project',
            pinSandbox: 'Pin sandbox',
            unpinSandbox: 'Unpin sandbox',
          },
        },
      },
      codexPanel: {
        title: 'Codex',
        connectToLoad: 'Connect to load',
        modelsTitle: 'Models',
        fileManagerTitle: 'Files',
        mcpTitle: 'MCP',
        skillsTitle: 'Skills',
        pluginsTitle: 'Plugins',
        connectorsTitle: 'Connectors',
        configTitle: 'Config',
        experimentalFeaturesTitle: 'Experiments',
        collaborationModesTitle: 'Collaboration',
        feedbackTitle: 'Feedback',
      },
    },
  };
}

function isButtonElement(element: Element | null): element is HTMLButtonElement {
  return element instanceof HTMLButtonElement;
}

function requireButton(root: ParentNode, selector: string) {
  const button = root.querySelector(selector);
  if (!isButtonElement(button)) {
    throw new Error(`Missing button: ${selector}`);
  }
  return button;
}

describe('TopPanel', () => {
  let originalLocalStorage: Storage;

  beforeEach(() => {
    vi.resetModules();
    originalLocalStorage = window.localStorage;
    const storage = new Map<string, string>([
      ['opencode.settings.showCodexButton.v1', 'true'],
      ['opencode.settings.showForgePanelButton.v1', 'true'],
    ]);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        get length() {
          return storage.size;
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ path: '/home/user' }), { status: 200 })),
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
    vi.unstubAllGlobals();
  });

  it('places Forge and Codex panel buttons to the right of management mode', async () => {
    // Given: both Forge and Codex panel launchers are enabled.
    const { default: TopPanel } = await import('./TopPanel.vue');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(TopPanel, {
              treeData: [],
              notificationSessions: [],
              projectDirectory: '/repo',
              activeDirectory: '/repo',
              selectedSessionId: 'session-1',
              homePath: '/home/user',
              codexConnected: true,
              ptySupported: true,
            });
        },
      }),
    );
    app.provide('showConfirm', vi.fn());
    app.use(createI18n({ legacy: false, locale: 'en', messages: createMessages() }));
    app.mount(root);
    await nextTick();

    // When: the top toolbar renders its management and backend panel controls.
    const management = requireButton(root, '.management-toggle-button');
    const forge = requireButton(root, '.forge-button');
    const codex = requireButton(root, '.codex-button');

    // Then: the order is management mode, Forge panel, then Codex panel.
    expect(management.compareDocumentPosition(forge) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(forge.compareDocumentPosition(codex) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    app.unmount();
  });

  it('shows only session actions supported by the active backend', async () => {
    const { default: TopPanel } = await import('./TopPanel.vue');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(TopPanel, {
              treeData: [
                {
                  directory: '/repo',
                  label: 'repo',
                  projectId: 'acp',
                  sandboxes: [
                    {
                      directory: '/repo',
                      sessions: [{ id: 'session-1', title: 'Session', status: 'idle' }],
                    },
                  ],
                },
              ],
              notificationSessions: [],
              projectDirectory: '/repo',
              activeDirectory: '/repo',
              selectedSessionId: 'session-1',
              ptySupported: true,
              sessionActionCapabilities: {
                rename: false,
                pin: true,
                unpin: true,
                archive: false,
                unarchive: false,
                delete: false,
              },
            });
        },
      }),
    );
    app.provide('showConfirm', vi.fn());
    app.use(createI18n({ legacy: false, locale: 'en', messages: createMessages() }));
    app.mount(root);
    requireButton(root, '.tree-dropdown-root .ui-dropdown-button').click();
    await nextTick();

    expect(root.querySelector('.session-rename')).toBeNull();
    expect(root.querySelector('.session-del')).toBeNull();
    expect(root.querySelector('.session-pin')).not.toBeNull();
    app.unmount();
  });

  it('emits explicit repository and branch pin scopes with accessible labels', async () => {
    const { default: TopPanel } = await import('./TopPanel.vue');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onPinSandbox = vi.fn();
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(TopPanel, {
              treeData: [
                {
                  directory: '/repo',
                  label: 'repo',
                  name: 'repo',
                  projectId: 'acp',
                  kind: 'sandbox',
                  pinScope: { level: 'repo', root: '/repo' },
                  sandboxes: [
                    {
                      directory: '/repo-worktree',
                      branch: 'feature',
                      kind: 'branch',
                      pinScope: {
                        level: 'branch',
                        directory: '/repo-worktree',
                        repoRoot: '/repo',
                      },
                      sessions: [{ id: 'session-1', title: 'Session', status: 'idle' }],
                    },
                  ],
                },
              ],
              notificationSessions: [],
              projectDirectory: '/repo',
              activeDirectory: '/repo-worktree',
              selectedSessionId: 'session-1',
              sandboxFirstMode: true,
              onPinSandbox,
            });
        },
      }),
    );
    app.provide('showConfirm', vi.fn());
    app.use(createI18n({ legacy: false, locale: 'en', messages: createMessages() }));
    app.mount(root);
    requireButton(root, '.tree-dropdown-root .ui-dropdown-button').click();
    await nextTick();

    requireButton(root, 'button[aria-label="Pin project repo"]').click();
    requireButton(root, 'button[aria-label="Pin sandbox feature"]').click();

    expect(onPinSandbox).toHaveBeenNthCalledWith(1, {
      projectId: 'acp',
      scope: { level: 'repo', root: '/repo' },
    });
    expect(onPinSandbox).toHaveBeenNthCalledWith(2, {
      projectId: 'acp',
      scope: { level: 'branch', directory: '/repo-worktree', repoRoot: '/repo' },
    });
    app.unmount();
  });
});
