import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import CodexMcpElicitation from './CodexMcpElicitation.vue';
import type { McpElicitationRequest } from '../../backends/codex/serverRequests';

async function flushRender() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe('CodexMcpElicitation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('submits a schema-driven form without persisting secret values', async () => {
    const replies: unknown[] = [];
    const request: McpElicitationRequest = {
      mode: 'form',
      requestId: 1,
      dialogId: 'codex-elicitation:number:1',
      sessionID: 'thread-1',
      turnId: 'turn-1',
      serverName: 'deployments',
      message: 'Choose a deployment target',
      required: ['region', 'token'],
      fields: [
        {
          key: 'region',
          label: 'Region',
          type: 'select',
          required: true,
          options: [{ value: 'eu', label: 'Europe' }],
        },
        {
          key: 'token',
          label: 'Token',
          type: 'string',
          format: 'password',
          required: true,
        },
      ],
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp(defineComponent({
      setup() {
        return () => h(CodexMcpElicitation, {
          request,
          onReply: (action: string, content?: Record<string, unknown>) => {
            replies.push({ action, content });
          },
        });
      },
    }));
    app.use(createI18n({
      legacy: false,
      locale: 'en',
      messages: {
        en: {
          codexPanel: {
            elicitation: {
              server: 'Server',
              required: 'Required',
              accept: 'Continue',
              decline: 'Decline',
              cancel: 'Cancel',
              openLink: 'Open link',
            },
          },
        },
      },
    }));
    app.mount(root);
    await flushRender();

    const submit = root.querySelector<HTMLButtonElement>('[data-action="accept"]')!;
    expect(submit.disabled).toBe(true);
    const select = root.querySelector<HTMLSelectElement>('select[name="region"]')!;
    select.value = 'eu';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const token = root.querySelector<HTMLInputElement>('input[name="token"]')!;
    expect(token.type).toBe('password');
    token.value = 'secret-value';
    token.dispatchEvent(new Event('input', { bubbles: true }));
    await flushRender();

    expect(submit.disabled).toBe(false);
    submit.click();
    expect(replies).toEqual([{ action: 'accept', content: { region: 'eu', token: 'secret-value' } }]);
    expect(localStorage.length).toBe(0);

    app.unmount();
  });

  it('renders URL requests as explicit external links', async () => {
    const onReply = vi.fn();
    const request: McpElicitationRequest = {
      mode: 'url',
      requestId: 'url-1',
      dialogId: 'codex-elicitation:string:url-1',
      sessionID: 'thread-1',
      turnId: null,
      serverName: 'identity',
      message: 'Authorize the MCP server',
      url: 'https://example.test/authorize',
      elicitationId: 'external-1',
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp(CodexMcpElicitation, { request, onReply });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { codexPanel: { elicitation: {
      server: 'Server', required: 'Required', accept: 'Continue', decline: 'Decline', cancel: 'Cancel', openLink: 'Open link',
    } } } } }));
    app.mount(root);
    await flushRender();

    const link = root.querySelector<HTMLAnchorElement>('a[data-action="open-link"]')!;
    expect(link.href).toBe('https://example.test/authorize');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(onReply).not.toHaveBeenCalled();

    app.unmount();
  });
});
