import { createApp, defineComponent, h, nextTick, ref, watch, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexAdapter, type CodexAdapterOptions } from '../backends/codex/codexAdapter';
import { CodexTestSocket } from '../backends/codex/codexTestSocket';
import FloatingWindow from '../components/FloatingWindow.vue';
import ReasoningContent from '../components/ToolWindow/Reasoning.vue';
import SubagentContent from '../components/ToolWindow/Subagent.vue';
import type { MessagePart } from '../types/sse';
import { extractFileRead, type ToolRenderersHelpers } from '../utils/toolRenderers';
import { useCodexApi } from './useCodexApi';
import { useCodexMessageBridge } from './useCodexMessageBridge';
import { useFloatingWindows } from './useFloatingWindows';
import { useReasoningWindows } from './useReasoningWindows';
import { useSubagentWindows } from './useSubagentWindows';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../utils/workerRenderer', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/workerRenderer')>();
  return {
    ...original,
    startRenderWorkerHtml: (request: { code: string }) => ({
      promise: Promise.resolve(`<p>${request.code}</p>`),
      cancel: () => undefined,
    }),
  };
});

type RpcRequest = { readonly id: number; readonly method: string; readonly params: unknown };
const apps: App[] = [];

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

class PopupWireSocket extends CodexTestSocket {
  private readonly reads = new Map<string, number>();
  private readonly resumes = new Map<string, number>();

  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols);
    queueMicrotask(() => this.emitOpen());
  }

  override send(data: string) {
    super.send(data);
    const raw: unknown = JSON.parse(data);
    const id = property(raw, 'id');
    const method = property(raw, 'method');
    if (typeof id !== 'number' || typeof method !== 'string') return;
    const request = { id, method, params: property(raw, 'params') } satisfies RpcRequest;
    queueMicrotask(() => this.reply(request));
  }

  private reply(request: RpcRequest) {
    const threadId = property(request.params, 'threadId');
    if (request.method === 'thread/read' && typeof threadId === 'string') {
      const count = (this.reads.get(threadId) ?? 0) + 1;
      this.reads.set(threadId, count);
      if (threadId === 'child-retry' && count === 1) {
        this.reject(request.id, 'thread child-retry is not materialized yet; includeTurns is unavailable before first user message', -32600);
        return;
      }
      const historical = threadId === 'child-retry' && count >= 3
        ? [{ id: 'retry-turn', status: 'completed', items: [{ id: 'retry-text', type: 'agentMessage', text: 'Recovered from history' }] }]
        : threadId === 'history-parent'
          ? [{ id: 'history-turn', status: 'completed', items: [{ id: 'old-spawn', type: 'subAgentActivity', agentThreadId: 'historical-child' }] }]
          : [];
      this.respond(request.id, { thread: { id: threadId, status: threadId === 'historical-child' ? { type: 'idle' } : { type: 'active' }, turns: historical } });
      return;
    }
    if (request.method === 'thread/resume' && typeof threadId === 'string') {
      const count = (this.resumes.get(threadId) ?? 0) + 1;
      this.resumes.set(threadId, count);
      if (threadId === 'child-retry' && count === 1) {
        this.reject(request.id, 'Child temporarily unavailable', -32603);
        return;
      }
      this.respond(request.id, { thread: { id: threadId, turns: [] } });
      return;
    }
    const results: Record<string, unknown> = {
      initialize: {},
      'thread/list': { data: [{ id: 'parent', status: { type: 'active' } }], nextCursor: null },
      'config/read': { config: {}, layers: [] },
      'fs/readDirectory': { entries: [] },
      'account/read': { account: null },
      'account/rateLimits/read': { rateLimits: null },
      'model/list': { data: [] },
      'skills/list': { data: [] },
      'plugin/list': { data: [] },
      'mcpServer/status/list': { data: [] },
      'app/list': { data: [] },
      'experimentalFeature/list': { data: [] },
      'collaborationMode/list': { data: [] },
      'configRequirements/read': { requirements: null },
      'thread/loaded/list': { data: [] },
    };
    this.respond(request.id, results[request.method] ?? {});
  }
}

const toolHelpers: ToolRenderersHelpers = {
  FILE_READ_EVENT_TYPES: new Set(), FILE_WRITE_EVENT_TYPES: new Set(), MESSAGE_EVENT_TYPES: new Set(),
  parsePatchTextBlocks: () => [], guessLanguage: () => 'text', shouldRenderToolWindow: () => true,
  extractToolOutputText: (value) => typeof value === 'string' ? value : undefined,
  formatToolValue: String,
  renderWorkerHtml: async ({ code }) => `<pre>${code}</pre>`,
  renderReadHtmlFromApi: async ({ fallbackText }) => `<pre>${fallbackText ?? ''}</pre>`,
  resolveReadWritePath: () => '', guessLanguageFromPath: () => 'text', resolveReadRange: () => ({}),
  renderEditDiffHtml: () => '', formatGlobToolTitle: () => '', formatListToolTitle: () => '',
  formatWebfetchToolTitle: () => '', formatQueryToolTitle: () => '', formatTaskToolOutput: String,
  GrepContent: defineComponent(() => () => null), GlobContent: defineComponent(() => () => null),
  WebContent: defineComponent(() => () => null),
};

function notification(socket: PopupWireSocket, method: string, params: Record<string, unknown>) {
  socket.respond({ method, params });
}

async function flushUi() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

// allow: SIZE_OK — one end-to-end fixture keeps the wire, bridge, managers, and real components connected.
async function mountPopupChain() {
  let api: ReturnType<typeof useCodexApi> | undefined;
  let windows: ReturnType<typeof useFloatingWindows> | undefined;
  const suppress = ref(false);
  const target = document.createElement('div');
  document.body.append(target);
  const app = createApp(defineComponent({
    setup() {
      const codex = useCodexApi({
        url: 'ws://popup.test',
        adapterFactory: (options: CodexAdapterOptions) => new CodexAdapter({ ...options, webSocketCtor: PopupWireSocket }),
      });
      const selectedSessionId = ref('');
      watch(codex.activeThreadId, (id) => { selectedSessionId.value = id; }, { immediate: true, flush: 'sync' });
      const fw = useFloatingWindows();
      const reasoning = useReasoningWindows({ selectedSessionId, fw, reasoningComponent: ReasoningContent, theme: () => 'github-dark', reasoningCloseDelayMs: 20, suppressAutoWindows: suppress, t: (key) => key });
      const subagents = useSubagentWindows({ selectedSessionId, fw, subagentComponent: SubagentContent, theme: () => 'github-dark', closeDelayMs: 20, suppressAutoWindows: suppress });
      const syncTools = (entries: Array<{ parts: MessagePart[] }>) => {
        for (const part of entries.flatMap((entry) => entry.parts)) {
          if (part.type !== 'tool') continue;
          const extracted = extractFileRead({ payload: { properties: { part } } }, 'message.part.updated', toolHelpers, (key) => key);
          const item = Array.isArray(extracted) ? extracted[0] : extracted;
          if (!item?.callId) continue;
          void fw.open(item.callId, { content: item.content, variant: item.variant, title: item.title, status: item.toolStatus === 'running' || item.toolStatus === 'completed' || item.toolStatus === 'error' ? item.toolStatus : undefined });
        }
      };
      useCodexMessageBridge({
        activeBackendKind: ref('codex'), selectedSessionId, codexPendingSessionLock: ref(''),
        history: codex.canonicalHistory, codexApi: codex,
        msg: { loadHistory: () => undefined, updateMessage: () => undefined, updatePart: () => undefined, removeMessage: () => undefined },
        syncRealtimeToolWindows: syncTools,
        updateReasoningExpiry: reasoning.updateReasoningExpiry,
        onLiveReasoning: (info, part) => reasoning.handlePart(part, info),
        onLiveSubagent: (info, part) => subagents.handlePart(part, info),
      });
      api = codex;
      windows = fw;
      return () => h('main', fw.entries.value.map((entry) => h(FloatingWindow, { entry, manager: fw })));
    },
  }));
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  app.mount(target);
  apps.push(app);
  if (!api || !windows) throw new Error('Popup chain did not mount');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ home: '/workspace' }), { status: 200 })));
  await api.connect();
  await flushUi();
  const socket = CodexTestSocket.instances.at(-1);
  if (!(socket instanceof PopupWireSocket)) throw new Error('Popup wire socket missing');
  return { api, windows, suppress, socket, target };
}

describe('Codex live popup integration', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); PopupWireSocket.instances = []; });
  afterEach(() => {
    apps.splice(0).forEach((app) => app.unmount());
    PopupWireSocket.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('carries child work from the Codex wire into isolated visible windows and closes only its owner', async () => {
    const { api, windows, suppress, socket, target } = await mountPopupChain();
    const spawn = (child: string) => notification(socket, 'item/completed', { threadId: 'parent', turnId: 'parent-turn', item: { id: `spawn-${child}`, type: 'subAgentActivity', agentThreadId: child, agentPath: `/root/${child}` } });
    const delta = (child: string, itemId: string, text: string) => notification(socket, 'item/agentMessage/delta', { threadId: child, turnId: `${child}-turn`, itemId, delta: text });

    spawn('child-retry');
    await vi.waitFor(() => expect(socket.sent.filter((entry) => entry.includes('thread/resume') && entry.includes('child-retry'))).toHaveLength(1));
    spawn('child-retry');
    await vi.waitFor(() => expect(target.textContent).toContain('Recovered from history'));

    spawn('child-one');
    spawn('child-two');
    await flushUi();
    delta('child-one', 'answer', 'First child message');
    await vi.waitFor(() => expect(target.textContent).toContain('First child message'));
    delta('child-one', 'answer', ' appended');
    delta('child-two', 'answer', 'Second child message');
    await vi.waitFor(() => {
      expect(target.textContent).toContain('First child message appended');
      expect(target.textContent).toContain('Second child message');
      expect(windows.entries.value.filter((entry) => entry.key.startsWith('subagent:')).map((entry) => entry.key)).toEqual(expect.arrayContaining(['subagent:child-one', 'subagent:child-two']));
    });

    notification(socket, 'item/reasoning/summaryTextDelta', { threadId: 'child-one', turnId: 'child-one-turn', itemId: 'reasoning', summaryIndex: 0, delta: 'Inspecting child state' });
    notification(socket, 'item/commandExecution/outputDelta', { threadId: 'child-one', turnId: 'child-one-turn', itemId: 'shell', delta: 'command output' });
    await vi.waitFor(() => {
      expect(target.textContent).toContain('Inspecting child state');
      expect(target.textContent).toContain('command output');
      expect(target.querySelector('.code-content.is-term')).not.toBeNull();
    });

    suppress.value = true;
    spawn('child-suppressed');
    await flushUi();
    delta('child-suppressed', 'answer', 'suppressed output');
    await flushUi();
    expect(windows.has('subagent:child-suppressed')).toBe(false);
    await api.selectThread('other-parent');
    delta('child-one', 'guarded', 'wrong parent output');
    await flushUi();
    expect(target.textContent).not.toContain('wrong parent output');

    windows.closeAll();
    suppress.value = false;
    await api.selectThread('history-parent');
    await flushUi();
    expect(windows.entries.value).toHaveLength(0);

    await api.selectThread('parent');
    spawn('child-one');
    spawn('child-two');
    await flushUi();
    delta('child-one', 'closing', 'close this child');
    delta('child-two', 'staying', 'keep this child');
    await vi.waitFor(() => expect(windows.has('subagent:child-two')).toBe(true));
    notification(socket, 'turn/completed', { threadId: 'child-one', turn: { id: 'child-one-turn', status: 'completed' } });
    await vi.advanceTimersByTimeAsync(20);
    await flushUi();
    expect(windows.has('subagent:child-one')).toBe(false);
    expect(windows.has('subagent:child-two')).toBe(true);
    api.disconnect();
  });
});
