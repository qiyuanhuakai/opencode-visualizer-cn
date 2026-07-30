import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import en from '../locales/en';
import TopPanel from './TopPanel.vue';

vi.mock('@iconify/vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    Icon: defineComponent({
      props: { icon: { type: String, required: true } },
      setup(props) {
        return () => h('span', { 'data-icon': props.icon });
      },
    }),
  };
});

describe('TopPanel OpenCode branch icon', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ path: '/home/user' }), { status: 200 })),
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders a native OpenCode sandbox row with the branch icon', async () => {
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
                  label: '/repo',
                  name: 'repo',
                  projectId: 'project-1',
                  kind: 'sandbox',
                  sandboxes: [
                    {
                      directory: '/repo',
                      branch: 'main',
                      kind: 'sandbox',
                      sessions: [{ id: 'session-1', title: 'Session', status: 'idle' }],
                    },
                  ],
                },
              ],
              notificationSessions: [],
              projectDirectory: '/repo',
              activeDirectory: '/repo',
              selectedSessionId: 'session-1',
              homePath: '/home/user',
              ptySupported: true,
            });
        },
      }),
    );
    app.provide('showConfirm', vi.fn());
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.mount(root);

    const dropdownButton = root.querySelector<HTMLButtonElement>(
      '.tree-dropdown-root .ui-dropdown-button',
    );
    expect(dropdownButton).not.toBeNull();
    dropdownButton?.click();
    await nextTick();

    const icon = root.querySelector('.tree-sandbox .tree-header-icon');
    expect(icon?.getAttribute('data-icon')).toBe('lucide:git-branch');
    app.unmount();
  });
});
