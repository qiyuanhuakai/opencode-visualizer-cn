import { createApp, defineComponent, h, nextTick, ref, shallowRef } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKimiWebClient } from '../../utils/kimiWeb';
import KimiWebAgentManager from './KimiWebAgentManager.vue';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function flushPromises() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick(); } }
function setup() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/children')) return Response.json({ code: 0, data: init?.method === 'POST' ? { id: 'child', title: 'Child', workspace_id: 'workspace', metadata: { cwd: '/repo' } } : { items: [{ id: 'child', title: 'Child', busy: false, agent_config: { model: 'provider/model' } }], has_more: false } });
    if (url.pathname.endsWith('/tasks')) return Response.json({ code: 0, data: { items: [{ id: 'task', kind: 'subagent', description: 'Research', status: 'running' }, { id: 'shell', kind: 'bash', description: 'Shell', status: 'running' }] } });
    if (url.pathname.endsWith('/models')) return Response.json({ code: 0, data: { items: [{ model: 'provider/model', provider: 'provider', support_efforts: ['high'] }] } });
    if (url.pathname.endsWith('/config')) return Response.json({ code: 0, data: init?.method === 'POST' ? {} : { default_model: 'provider/model' } });
    if (url.pathname.endsWith('/status')) return Response.json({ code: 0, data: { model: 'provider/model', permission: 'manual', thinking_level: 'high' } });
    return Response.json({ code: 0, data: { id: 'child', workspace_id: 'workspace', metadata: { cwd: '/repo' } } });
  });
  const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher });
  return { fetcher, ...mountClient(client) };
}
function mountClient(initialClient: ReturnType<typeof createKimiWebClient>) {
  const sessionId = ref('parent');
  const client = shallowRef(initialClient);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const onOpenSession = vi.fn();
  const onSessionUpdated = vi.fn();
  const app = createApp(defineComponent({ setup: () => () => h(KimiWebAgentManager, { sessionId: sessionId.value, client: client.value, onOpenSession, onSessionUpdated }) }));
  app.use(createI18n({ legacy: false, locale: 'en' }));
  app.mount(root);
  cleanups.push(() => { app.unmount(); root.remove(); });
  const click = (text: string) => Array.from(root.querySelectorAll('button')).find((button) => button.textContent === text)?.click();
  return { root, click, onOpenSession, onSessionUpdated, sessionId, client };
}

describe('Kimi agent manager', () => {
  it('saves the default model for newly spawned subagents through global config', async () => {
    const { root, fetcher } = setup();
    await flushPromises();
    expect((root.querySelector('select[aria-label="Default subagent model"]') as HTMLSelectElement)?.value).toBe('provider/model');
    root.querySelector('form.toolbar')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/config') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ secondary_model: { default_model: 'provider/model' } });
  });
  it('binds a settings write to its original child and discards completion after a parent switch', async () => {
    const { root, click, fetcher, sessionId, onSessionUpdated } = setup();
    await flushPromises();
    click('Settings');
    await flushPromises();
    let release: (response: Response) => void = () => { throw new Error('Deferred response not initialized'); };
    const late = new Promise<Response>((resolve) => { release = resolve; });
    fetcher.mockImplementationOnce(async () => late);
    root.querySelector('form.settings')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    sessionId.value = 'next-parent';
    await flushPromises();
    release(Response.json({ code: 0, data: { id: 'child' } }));
    await flushPromises();
    expect(onSessionUpdated).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain('Settings saved');
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/status'))).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/sessions/child/profile'))).toBe(true);
  });

  it.each(['session', 'client'])('replaces an in-flight load when its %s changes and ignores the late old response', async (change) => {
    let release: (response: Response) => void = () => { throw new Error('Deferred response not initialized'); };
    const late = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).includes('/parent/children') ? late : Response.json({ code: 0, data: { items: [{ id: 'new', title: 'New child' }], has_more: false } }));
    const original = createKimiWebClient({ baseUrl: 'http://old.test', fetcher });
    const { root, sessionId, client } = mountClient(original);
    await flushPromises();
    if (change === 'session') sessionId.value = 'next';
    else client.value = createKimiWebClient({ baseUrl: 'http://new.test', fetcher: async () => Response.json({ code: 0, data: { items: [{ id: 'new', title: 'New child' }], has_more: false } }) });
    await flushPromises();
    expect(root.textContent).toContain('New child');
    release(Response.json({ code: 0, data: { items: [{ id: 'old', title: 'Old child' }], has_more: false } }));
    await flushPromises();
    expect(root.textContent).toContain('New child');
    expect(root.textContent).not.toContain('Old child');
    expect(root.getAttribute('aria-busy')).not.toBe('true');
  });

  it('creates a child through the current parent and prevents a duplicate submission', async () => {
    const { root, fetcher, onSessionUpdated } = setup();
    await flushPromises();
    const input = root.querySelector('input');
    if (!input) throw new Error('Missing child title input');
    input.value = 'New child';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const form = root.querySelector('form.child-form');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    const creates = fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/sessions/parent/children') && init?.method === 'POST');
    expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ parent_session_id: 'parent' }) }));
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0]?.[1]?.body))).toEqual({ title: 'New child' });
  });

  it('opens only actual child sessions and cancels subagent tasks inside their owning session', async () => {
    const { root, click, fetcher, onOpenSession } = setup();
    await flushPromises();
    expect(root.textContent).toContain('Child conversations');
    expect(root.textContent).toContain('Subagents in this conversation');
    expect(root.textContent).not.toContain('Shell');
    click('Open');
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'child' }));
    click('Stop');
    await flushPromises();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/sessions/parent/tasks/task:cancel'))).toBe(true);
  });

  it('loads effective settings when opening and saves the selected settings', async () => {
    const { root, click, fetcher } = setup();
    await flushPromises();
    click('Settings');
    await flushPromises();
    expect(root.querySelector('form.settings select:nth-of-type(2)')?.getAttribute('value') ?? (root.querySelectorAll('form.settings select')[1] as HTMLSelectElement)?.value).toBe('high');
    root.querySelector('form.settings')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    const saveCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/child/profile'));
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({ agent_config: { model: 'provider/model', permission_mode: 'manual', thinking: 'high' } });
    expect(root.textContent).toContain('Settings saved');
  });

  it('reports a successful profile write even when subsequent reads would fail', async () => {
    const { root, click, fetcher, onSessionUpdated } = setup();
    await flushPromises();
    click('Settings');
    await flushPromises();
    const saved = { id: 'child', title: 'Saved child', workspace_id: 'workspace', metadata: { cwd: '/repo' }, agent_config: { model: 'provider/model' } };
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/child/profile') && init?.method === 'POST') return Response.json({ code: 0, data: saved });
      throw new Error('Status temporarily unavailable');
    });
    root.querySelector('form.settings')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(onSessionUpdated).toHaveBeenCalledWith(saved);
    expect(root.textContent).toContain('Settings saved');
    expect(root.textContent).toContain('Saved child');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps load failures distinct from a successfully empty list', async () => {
    const { root, click, fetcher } = setup();
    await flushPromises();
    fetcher.mockRejectedValue(new Error('Offline'));
    click('Refresh');
    await flushPromises();
    expect(Boolean(root.querySelector('[role="alert"]'))).toBe(true);
    expect(root.textContent).toContain('Child');
  });

  it('shows a task cancellation rejection without pretending the running task stopped', async () => {
    const { root, click, fetcher } = setup();
    await flushPromises();
    fetcher.mockImplementationOnce(async () => Response.json({ code: 40910, msg: 'Task cannot be stopped', data: null }));
    click('Stop');
    await flushPromises();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Task cannot be stopped');
    expect(root.textContent).toContain('running');
  });

  it('shows a permission rejection without reporting settings saved', async () => {
    const { root, click, fetcher } = setup();
    await flushPromises();
    click('Settings');
    await flushPromises();
    fetcher.mockImplementationOnce(async () => Response.json({ code: 40001, msg: 'Permission rejected', data: null }));
    root.querySelector('form.settings')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Permission rejected');
    expect(root.textContent).not.toContain('Settings saved');
  });

  it('shows an explicit empty state only after successful loading', async () => {
    const { root, click, fetcher } = setup();
    await flushPromises();
    fetcher.mockImplementation(async () => Response.json({ code: 0, data: { items: [], has_more: false } }));
    click('Refresh');
    await flushPromises();
    expect(root.textContent?.match(/None yet/g)).toHaveLength(2);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });
});
