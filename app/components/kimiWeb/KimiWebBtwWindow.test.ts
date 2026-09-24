import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { describe, expect, it, vi } from 'vitest';
import { createKimiWebClient } from '../../utils/kimiWeb';
import KimiWebBtwWindow from './KimiWebBtwWindow.vue';

async function flushPromises() { for (let i = 0; i < 16; i++) { await Promise.resolve(); await nextTick(); } }

describe('Kimi btw conversation', () => {
  it('starts blank despite inherited context and shows only the new side conversation', async () => {
    let sent = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/transcript')) return Response.json({ code: 0, data: {
        agent_id: 'agent-side', has_more: false, items: [
          { kind: 'turn', turnId: 'inherited', ordinal: 1, state: 'completed', prompt: 'Parent history', steps: [] },
          ...(sent ? [{ kind: 'turn', turnId: 'new', ordinal: 2, state: 'completed', prompt: 'Follow-up question', steps: [{ stepId: 'step-1', frames: [{ kind: 'text', role: 'assistant', frameId: 'frame-1', text: 'Side answer' }] }] }] : []),
        ],
      } });
      if (url.pathname.endsWith('/prompts') && init?.method === 'POST') { sent = true; return Response.json({ code: 0, data: { prompt_id: 'p2', user_message_id: 'u2', status: 'running' } }); }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher });
    const root = document.createElement('div'); document.body.append(root);
    const app = createApp(defineComponent({ setup: () => () => h(KimiWebBtwWindow, { sessionId: 'session-1', agentId: 'agent-side', client }) }));
    app.use(createI18n({ legacy: false, locale: 'en' }));
    try {
      app.mount(root);
      await flushPromises();
      expect(root.textContent).not.toContain('Parent history');
      expect(root.textContent).not.toContain('Follow-up question');
      expect(fetcher.mock.calls[0]?.[0]).toContain('agent_id=agent-side');
      const textarea = root.querySelector('textarea');
      if (!textarea) throw new Error('Missing follow-up composer');
      textarea.value = 'Follow-up question';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await nextTick();
      root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flushPromises();
      const send = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/prompts') && init?.method === 'POST');
      expect(JSON.parse(String(send?.[1]?.body))).toEqual({ agent_id: 'agent-side', content: [{ type: 'text', text: 'Follow-up question' }] });
      expect(textarea.value).toBe('');
      expect(root.textContent).toContain('Follow-up question');
      expect(root.textContent).toContain('Side answer');
      expect(root.textContent).not.toContain('Parent history');
    } finally { app.unmount(); root.remove(); }
  });

  it('does not show stale thinking after a reply or a later completed turn', async () => {
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 0, data: {
      agent_id: 'agent-side', has_more: false, items: reads++ > 0 ? [
          { kind: 'turn', turnId: 'old', ordinal: 1, state: 'running', prompt: 'First', steps: [] },
          { kind: 'turn', turnId: 'latest', ordinal: 2, state: 'running', prompt: 'Second', steps: [{ stepId: 'step-2', frames: [{ kind: 'text', role: 'assistant', frameId: 'answer', text: 'Done' }] }] },
        ] : [],
    } }));
    const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher });
    const root = document.createElement('div'); document.body.append(root);
    const app = createApp(defineComponent({ setup: () => () => h(KimiWebBtwWindow, { sessionId: 'session-1', agentId: 'agent-side', client }) }));
    app.use(createI18n({ legacy: false, locale: 'en' }));
    try {
      app.mount(root);
      await flushPromises();
      expect(root.textContent).toContain('Done');
      expect(root.textContent).not.toContain('Thinking…');
    } finally { app.unmount(); root.remove(); }
  });

  it('opens blank first and submits an initial question after inherited context is identified', async () => {
    let release: (response: Response) => void = () => { throw new Error('Pending transcript missing'); };
    const transcript = new Promise<Response>((resolve) => { release = resolve; });
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input).includes('/transcript')) return reads++ === 0 ? transcript : Response.json({ code: 0, data: { agent_id: 'agent-side', has_more: false, items: [{ kind: 'turn', turnId: 'inherited', ordinal: 3, prompt: 'Parent history', steps: [] }] } });
      if (String(input).endsWith('/prompts') && init?.method === 'POST') return Response.json({ code: 0, data: { prompt_id: 'p1', user_message_id: 'u1', status: 'running' } });
      throw new Error('Unexpected request');
    });
    const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher });
    const root = document.createElement('div'); document.body.append(root);
    const app = createApp(defineComponent({ setup: () => () => h(KimiWebBtwWindow, { sessionId: 'session-1', agentId: 'agent-side', client, initialPrompt: 'First question' }) }));
    app.use(createI18n({ legacy: false, locale: 'en' }));
    try {
      app.mount(root);
      await flushPromises();
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/prompts'))).toBe(false);
      expect(root.textContent).not.toContain('First question');
      release(Response.json({ code: 0, data: { agent_id: 'agent-side', has_more: false, items: [{ kind: 'turn', turnId: 'inherited', ordinal: 3, prompt: 'Parent history', steps: [] }] } }));
      await flushPromises();
      const send = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/prompts') && init?.method === 'POST');
      expect(JSON.parse(String(send?.[1]?.body))).toEqual({ agent_id: 'agent-side', content: [{ type: 'text', text: 'First question' }] });
    } finally {
      app.unmount(); root.remove();
    }
  });
});
