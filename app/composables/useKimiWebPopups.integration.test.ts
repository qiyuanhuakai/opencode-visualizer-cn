import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BackendKind } from '../backends/types';
import { kimiWebMessagesToHistoryEntries } from '../backends/kimiWeb/historyEntries';
import FloatingWindow from '../components/FloatingWindow.vue';
import ReasoningContent from '../components/ToolWindow/Reasoning.vue';
import SubagentContent from '../components/ToolWindow/Subagent.vue';
import type { MessageInfo, MessagePart, ToolPart } from '../types/sse';
import { extractFileRead, extractPatch, type ToolRenderersHelpers } from '../utils/toolRenderers';
import { isPluginToolName } from '../utils/pluginCompatibility';
import { normalizeToolName } from '../utils/toolNames';
import { shouldSkipAutoOpenWebTool } from '../utils/codexToolWindows';
import type { KimiWebMessage, KimiWebPage, KimiWebSnapshot } from '../utils/kimiWeb';
import type {
  KimiWebWsAck,
  KimiWebWsCloseInfo,
  KimiWebWsCursor,
  KimiWebWsFrame,
  KimiWebWsResyncRequest,
} from '../utils/kimiWebWs';
import { useFloatingWindows } from './useFloatingWindows';
import { useKimiWebMessageBridge, type KimiWebMessageSource } from './useKimiWebMessageBridge';
import type { KimiWebReconcilePartKind } from './kimiWebMessageReconcile';
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

/**
 * Kimi Web live popup integration (Todo 16).
 *
 * Mirrors `useCodexPopups.integration.test.ts`: the mounted chain is
 * client (fixture frames) -> useKimiWebMessageBridge -> the three popup
 * callbacks -> the real window managers -> the real FloatingWindow components.
 * The wiring inside `mountPopupChain` is a line-for-line mirror of the App.vue
 * kimi-web popup block (bridge construction + `syncKimiWebToolWindow` /
 * `isKimiWebPopupSession` / `reconcileKimiWebPopup`); if App.vue drifts from
 * this harness the Codex precedent says the visual contract is what breaks.
 *
 * Frames come from the real kimi web 0.43.0 fixtures (Todo 13); second
 * subagents are the same real frames re-addressed to another agentId, which the
 * normalizer treats identically (kimi hierarchy is session -> agent -> turn).
 */

const SESSION_ID = 'session_e0158012-f869-4d98-b4d4-5921a8686e24';
const OTHER_SESSION_ID = 'session_5bd03fc9-0077-4e87-a8fd-1d4e1f716acd';
const EPOCH = 'ep_01M30ZNJTBH5G6NKA2S115YMPJ';
const CLOSE_DELAY_MS = 20;
const READ_CALL_ID = 'tool_LLLyHODIa03gVnx5RCNr8z20';

const FIXTURES_DIR = [
  join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures'),
  join(process.cwd(), 'backends', 'kimiWeb', 'fixtures'),
].find((directory) => existsSync(directory)) ?? join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures');

function fixtureFrames(name: string): KimiWebWsFrame[] {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): KimiWebWsFrame => JSON.parse(line));
}

const liveFrames = fixtureFrames('wire-session-live.jsonl');
const derivedFrames = fixtureFrames('wire-spec-derived.jsonl');

function frame(type: string, occurrence = 0): KimiWebWsFrame {
  const found = [...liveFrames, ...derivedFrames].filter((entry) => entry.type === type)[occurrence];
  if (!found) throw new Error(`Missing fixture frame: ${type}[${occurrence}]`);
  return found;
}

const fx = {
  turnStarted: frame('turn.started'),
  turnEnded: frame('turn.ended'),
  thinking: frame('thinking.delta'),
  assistant: frame('assistant.delta'),
  toolStarted: frame('tool.call.started'),
  toolResult: frame('tool.result'),
  agentToolStarted: frame('tool.call.started', 1),
  agentToolResult: frame('tool.result', 1),
  subagentSpawned: frame('subagent.spawned'),
  subagentCompleted: frame('subagent.completed'),
  subagentFailed: derivedFrames.find((entry) => entry.type === 'subagent.failed')!,
  promptCompleted: frame('prompt.completed'),
};

type FramePatch = Record<string, unknown> & { payload?: Record<string, unknown> };

function cloneFrame(base: KimiWebWsFrame, patch: FramePatch = {}): KimiWebWsFrame {
  const { payload, ...rest } = patch;
  const basePayload = base.payload ?? {};
  return {
    ...base,
    ...rest,
    payload: payload ? { ...basePayload, ...payload } : base.payload,
  };
}

/** Durable/volatile seq bookkeeping that matches the bridge's live cursor rule. */
class Feed {
  seq: number;

  constructor(
    private readonly source: FakeSource,
    startSeq: number,
  ) {
    this.seq = startSeq;
  }

  durable(base: KimiWebWsFrame, patch: FramePatch = {}) {
    this.seq += 1;
    this.source.emitFrame(cloneFrame(base, { seq: this.seq, epoch: EPOCH, ...patch }));
  }

  volatile(base: KimiWebWsFrame, patch: FramePatch = {}) {
    this.source.emitFrame(cloneFrame(base, { seq: this.seq, epoch: EPOCH, volatile: true, ...patch }));
  }
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

class FakeSource implements KimiWebMessageSource {
  private readonly frameListeners = new Set<(value: KimiWebWsFrame) => void>();
  private readonly resyncListeners = new Set<(value: KimiWebWsResyncRequest) => void>();
  private readonly closeListeners = new Set<(value: KimiWebWsCloseInfo) => void>();
  private readonly reconnectStartListeners = new Set<() => void>();
  private readonly reconnectReadyListeners = new Set<(value: KimiWebWsAck) => void>();
  private ackResolve: ((ack: KimiWebWsAck) => void) | undefined;
  readonly ackPromise = new Promise<KimiWebWsAck>((resolve) => {
    this.ackResolve = resolve;
  });

  constructor(private readonly sessionIds: string[]) {}

  subscribe(_sessionIds: string[], _cursors?: Record<string, KimiWebWsCursor>) {
    return this.ackPromise;
  }

  subscriptions() {
    return this.sessionIds;
  }

  onFrame(listener: (value: KimiWebWsFrame) => void) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onResyncRequired(listener: (value: KimiWebWsResyncRequest) => void) {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  onClose(listener: (value: KimiWebWsCloseInfo) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onReconnectStart(listener: () => void) {
    this.reconnectStartListeners.add(listener);
    return () => this.reconnectStartListeners.delete(listener);
  }

  onReconnectReady(listener: (value: KimiWebWsAck) => void) {
    this.reconnectReadyListeners.add(listener);
    return () => this.reconnectReadyListeners.delete(listener);
  }

  emitFrame(value: KimiWebWsFrame) {
    for (const listener of this.frameListeners) listener(value);
  }

  emitResync(sessionId = SESSION_ID) {
    for (const listener of this.resyncListeners) {
      listener({ sessionId, reason: 'buffer_overflow', currentSeq: 21, epoch: EPOCH, source: 'frame' });
    }
  }

  emitClose() {
    for (const listener of this.closeListeners) {
      listener({
        code: 1001,
        reason: 'heartbeat timeout',
        wasClean: true,
        manual: false,
        classification: { kind: 'heartbeat-timeout', detail: 'heartbeat timeout' },
      });
    }
  }

  emitReconnectStart() {
    for (const listener of this.reconnectStartListeners) listener();
  }

  emitReconnectReady(cursors: Record<string, KimiWebWsCursor>) {
    const value: KimiWebWsAck = {
      id: 'reconnect-hello',
      code: 0,
      payload: { cursors, resync_required: [] },
    };
    for (const listener of this.reconnectReadyListeners) listener(value);
  }

  ack(cursors: Record<string, KimiWebWsCursor>) {
    this.ackResolve?.({
      id: 'subscribe-1',
      code: 0,
      payload: { cursors, resync_required: [] },
    });
  }
}

// Mirror of App.vue's TOOL_WINDOW_HIDDEN / TOOL_WINDOW_SUPPORTED /
// shouldRenderToolWindow (L8389-8418). The kimi tool popup must apply the same
// allow list; keep both copies in sync.
const TOOL_WINDOW_HIDDEN = new Set([
  'question',
  'todoread',
  'todowrite',
  'lsp',
  'plan_enter',
  'plan_exit',
  'task',
]);
const TOOL_WINDOW_SUPPORTED = new Set([
  'apply_patch',
  'bash',
  'codesearch',
  'edit',
  'glob',
  'grep',
  'list',
  'multiedit',
  'read',
  'task',
  'webfetch',
  'websearch',
  'write',
]);

function shouldRenderToolWindow(tool: string) {
  if (isPluginToolName(tool)) return true;
  const normalizedTool = normalizeToolName(tool);
  return !TOOL_WINDOW_HIDDEN.has(normalizedTool) && TOOL_WINDOW_SUPPORTED.has(normalizedTool);
}

const toolHelpers: ToolRenderersHelpers = {
  FILE_READ_EVENT_TYPES: new Set(), FILE_WRITE_EVENT_TYPES: new Set(), MESSAGE_EVENT_TYPES: new Set(),
  parsePatchTextBlocks: () => [], guessLanguage: () => 'text', shouldRenderToolWindow,
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

const translate = (key: string) => key;

/** Mirror of App.vue openToolPartAsWindow (L8826) without the keyPrefix overrides. */
function openKimiWebToolWindow(fw: ReturnType<typeof useFloatingWindows>, toolPart: ToolPart) {
  if (shouldSkipAutoOpenWebTool(toolPart)) return;
  const payload = {
    type: 'message.part.updated',
    payload: {
      type: 'message.part.updated',
      properties: { part: toolPart },
    },
  };

  const patchEvents = extractPatch(payload, toolHelpers, translate);
  if (patchEvents) {
    patchEvents.forEach((patchEvent, index) => {
      const key = patchEvent.callId ?? `apply_patch:${index}`;
      fw.open(key, {
        content: toolHelpers.renderEditDiffHtml({
          diff: '',
          code: patchEvent.code,
          after: patchEvent.after,
          patch: patchEvent.patch,
          lang: patchEvent.lang ?? 'text',
        }),
        variant: 'diff',
        status:
          patchEvent.toolStatus === 'running' ||
          patchEvent.toolStatus === 'completed' ||
          patchEvent.toolStatus === 'error'
            ? patchEvent.toolStatus
            : undefined,
        title: patchEvent.title,
        closable: true,
      });
    });
    return;
  }

  const fileReadResult = extractFileRead(payload, 'message.part.updated', toolHelpers, translate);
  const fileReads = fileReadResult
    ? Array.isArray(fileReadResult)
      ? fileReadResult
      : [fileReadResult]
    : null;
  if (!fileReads) return;
  fileReads.forEach((entry) => {
    if (!entry.callId) return;
    fw.open(entry.callId, {
      content: entry.content,
      variant: entry.variant,
      title: entry.title,
      status:
        entry.toolStatus === 'running' ||
        entry.toolStatus === 'completed' ||
        entry.toolStatus === 'error'
          ? entry.toolStatus
          : undefined,
      closable: true,
    });
  });
}

function toolWindowStatus(part: ToolPart): 'running' | 'completed' | 'error' | undefined {
  return part.state.status === 'running' || part.state.status === 'completed' || part.state.status === 'error'
    ? part.state.status
    : undefined;
}

function snapshotFixture(asOfSeq = 21): KimiWebSnapshot {
  return {
    as_of_seq: asOfSeq,
    epoch: EPOCH,
    session: {
      id: SESSION_ID,
      workspace_id: 'workspace-1',
      title: 'Fixture',
      busy: true,
      main_turn_active: true,
      pending_interaction: 'none',
      archived: false,
    },
    messages: { items: [] },
    in_flight_turn: null,
  };
}

async function flushUi() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

type PopupChain = {
  source: FakeSource;
  bridge: ReturnType<typeof useKimiWebMessageBridge>;
  windows: ReturnType<typeof useFloatingWindows>;
  subagents: ReturnType<typeof useSubagentWindows>;
  suppress: Ref<boolean>;
  selectedSessionId: Ref<string>;
  activeBackendKind: Ref<BackendKind>;
  target: HTMLDivElement;
};

const apps: App[] = [];

// allow: SIZE_OK — one end-to-end fixture keeps the wire, bridge, managers, and real components connected.
async function mountPopupChain(options: {
  sessionIds?: string[];
  getSnapshot?: () => Promise<KimiWebSnapshot>;
  getMessages?: () => Promise<KimiWebPage<KimiWebMessage>>;
} = {}): Promise<PopupChain> {
  const source = new FakeSource(options.sessionIds ?? [SESSION_ID]);
  const suppress = ref(false);
  const selectedSessionId = ref(SESSION_ID);
  const activeBackendKind = ref<BackendKind>('kimi-web');
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, MessagePart>();
  const msg = {
    updateMessage: (info: MessageInfo) => {
      messages.set(info.id, info);
    },
    updatePart: (part: MessagePart) => {
      parts.set(part.id, part);
    },
    loadHistory: (entries: Array<{ info: MessageInfo; parts: MessagePart[] }>) => {
      for (const entry of entries) {
        if (!entry?.info || !Array.isArray(entry.parts)) continue;
        messages.set(entry.info.id, entry.info);
        for (const part of entry.parts) parts.set(part.id, part);
      }
    },
    removeMessage: (messageId: string) => {
      messages.delete(messageId);
      for (const [partId, part] of parts) {
        if (part.messageID === messageId) parts.delete(partId);
      }
    },
  };
  let bridge: ReturnType<typeof useKimiWebMessageBridge> | undefined;
  let windows: ReturnType<typeof useFloatingWindows> | undefined;
  let subagents: ReturnType<typeof useSubagentWindows> | undefined;
  const target = document.createElement('div');
  document.body.append(target);
  const app = createApp(defineComponent({
    setup() {
      const fw = useFloatingWindows();
      const reasoning = useReasoningWindows({
        selectedSessionId,
        fw,
        reasoningComponent: ReasoningContent,
        theme: () => 'github-dark',
        reasoningCloseDelayMs: CLOSE_DELAY_MS,
        suppressAutoWindows: suppress,
        t: translate,
      });
      const subagentWindows = useSubagentWindows({
        selectedSessionId,
        fw,
        subagentComponent: SubagentContent,
        theme: () => 'github-dark',
        closeDelayMs: CLOSE_DELAY_MS,
        suppressAutoWindows: suppress,
      });

      // ----- App.vue mirror: kimi-web popup wiring (Todo 16) -----
      const lastKimiWebToolWindowSignature = new Map<string, string>();

      // Only the selected session and its descendants may drive popups. Kimi
      // subagent parts carry the synthesized `{session}:{agent}:{turn}` identity
      // (normalize.ts kimiWebSubagentSessionId), so a descendant is a prefixed
      // extension of the selected session — the Codex parent filter
      // (useCodexMessageBridge.ts L197-209) without a thread tree.
      function isKimiWebPopupSession(sessionID: string) {
        if (activeBackendKind.value !== 'kimi-web') return false;
        const selected = selectedSessionId.value;
        if (!selected || !sessionID) return false;
        return sessionID === selected || sessionID.startsWith(`${selected}:`);
      }

      // Live tool parts: same gating, signature dedup and fw.updateOptions state
      // sync as App.vue syncRealtimeCodexToolWindows (L8905).
      function syncKimiWebToolWindow(part: MessagePart) {
        if (part.type !== 'tool') return;
        if (suppress.value) return;
        if (!isKimiWebPopupSession(part.sessionID)) return;
        if (!shouldRenderToolWindow(part.tool)) return;
        const contentSignature =
          part.state.status === 'completed'
            ? part.state.output
            : part.state.status === 'error'
              ? part.state.error
              : part.state.status === 'running'
                ? part.state.metadata?.output || ''
                : '';
        const windowKey = part.callID || part.id;
        const signature = `${part.tool}:${part.state.status}:${contentSignature}:${JSON.stringify(part.state.input ?? {})}`;
        if (lastKimiWebToolWindowSignature.get(windowKey) === signature) return;
        lastKimiWebToolWindowSignature.set(windowKey, signature);
        openKimiWebToolWindow(fw, part);
        fw.updateOptions(windowKey, { status: toolWindowStatus(part) });
      }

      // Restore-period reconciliation (Todo 22 seam): terminal replay/rebuild
      // parts may only update/close windows that are already open (fw.has gate);
      // they never open a new one. Chosen over closing transient auto-windows
      // when entering rebuilding because a rebuild does not mean the subagent
      // finished — force-closing would destroy review context for still-running
      // work, while this seam closes precisely the windows whose parts actually
      // terminated, including minimized ones (fw.close removes dock entries and
      // fw.open never un-minimizes an existing entry).
      function reconcileKimiWebPopup(info: MessageInfo, part: MessagePart, kind: KimiWebReconcilePartKind) {
        if (kind === 'tool') {
          if (part.type !== 'tool') return;
          const windowKey = part.callID || part.id;
          if (!fw.has(windowKey)) return;
          openKimiWebToolWindow(fw, part);
          fw.updateOptions(windowKey, { status: toolWindowStatus(part) });
          return;
        }
        if (part.type === 'reasoning') {
          // The kimi bridge delivers subagent reasoning through onLiveSubagent
          // (kimiWebMessageOps applyLivePart) where Codex delivers it through
          // onLiveReasoning; routing by type keeps the visual result identical.
          const windowKey = `reasoning:${part.sessionID || selectedSessionId.value || 'main'}`;
          if (fw.has(windowKey)) reasoning.handlePart(part, info);
        } else {
          const windowKey = `subagent:${part.sessionID}`;
          if (fw.has(windowKey)) subagentWindows.handlePart(part, info);
        }
        if (kind !== 'subagent') return;
        // Subagent deltas are volatile and never replayed, so after the reconnect
        // normalizer reset the bridge can no longer deliver a terminal part for the
        // subagent's sibling window — close it here or it stays open forever.
        const siblingKey = part.type === 'reasoning'
          ? `subagent:${part.sessionID}`
          : `reasoning:${part.sessionID}`;
        if (!fw.has(siblingKey)) return;
        if (part.type === 'reasoning') void fw.close(siblingKey);
        else reasoning.scheduleReasoningClose(part.sessionID);
      }

      bridge = useKimiWebMessageBridge({
        client: source,
        restClient: {
          getSnapshot: options.getSnapshot ?? (async () => snapshotFixture()),
          getMessages: options.getMessages ?? (async () => ({ items: [], has_more: false })),
        },
        msg,
        applySnapshot: (snapshot) =>
          bridge!.applyHistory(kimiWebMessagesToHistoryEntries(snapshot.messages.items)),
        onToolPart: (part) => syncKimiWebToolWindow(part),
        onLiveReasoning: (info, part) => {
          if (!isKimiWebPopupSession(part.sessionID)) return;
          reasoning.handlePart(part, info);
        },
        onLiveSubagent: (info, part) => {
          if (!isKimiWebPopupSession(part.sessionID)) return;
          if (part.type === 'reasoning') {
            reasoning.handlePart(part, info);
            return;
          }
          subagentWindows.handlePart(part, info);
        },
        onReconcilePart: reconcileKimiWebPopup,
      });
      // ----- end App.vue mirror -----

      windows = fw;
      subagents = subagentWindows;
      return () => h('main', fw.entries.value.map((entry) => h(FloatingWindow, { entry, manager: fw })));
    },
  }));
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  app.mount(target);
  apps.push(app);
  if (!bridge || !windows || !subagents) throw new Error('Popup chain did not mount');
  return { source, bridge, windows, subagents, suppress, selectedSessionId, activeBackendKind, target };
}

async function enterLive(chain: PopupChain, cursors: Record<string, KimiWebWsCursor>) {
  const subscribing = chain.bridge.subscribe(Object.keys(cursors), cursors);
  chain.source.ack(cursors);
  await subscribing;
  await flushUi();
}

describe('Kimi Web live popup integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    apps.splice(0).forEach((app) => app.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('opens tool, reasoning and subagent windows from live kimi wire frames', async () => {
    const chain = await mountPopupChain();
    const feed = new Feed(chain.source, 21);
    await enterLive(chain, { [SESSION_ID]: { seq: 21, epoch: EPOCH } });

    // reasoning: the main agent's aggregated thinking part
    feed.volatile(fx.thinking, { payload: { agentId: 'main', turnId: 1, delta: 'Just read it.' } });
    await vi.waitFor(() => expect(chain.target.textContent).toContain('Just read it.'));
    expect(chain.windows.has(`reasoning:${SESSION_ID}`)).toBe(true);

    // tool: pending opens nothing, the completed result opens the window
    feed.durable(fx.toolStarted, { payload: { toolCallId: READ_CALL_ID, name: 'Read', agentId: 'main', turnId: 1 } });
    await flushUi();
    expect(chain.windows.has(READ_CALL_ID)).toBe(false);
    feed.durable(fx.toolResult, { payload: { toolCallId: READ_CALL_ID, agentId: 'main', turnId: 1 } });
    await vi.waitFor(() => expect(chain.windows.has(READ_CALL_ID)).toBe(true));
    expect(chain.windows.get(READ_CALL_ID)?.status).toBe('completed');

    // subagent: the synthesized identity gets its own window
    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-0', turnId: 0, delta: 'First child answer' } });
    await vi.waitFor(() => expect(chain.target.textContent).toContain('First child answer'));
    expect(chain.windows.has(`subagent:${SESSION_ID}:agent-0:0`)).toBe(true);

    // the Agent tool itself is hidden from the tool allow list (task synonym)
    feed.durable(fx.agentToolStarted, { payload: { agentId: 'main', turnId: 2 } });
    await flushUi();
    expect(chain.windows.has('tool_3ydieXPUScwcnZ3KzDPcfeDx')).toBe(false);

    // turn end terminates the main reasoning window through the part's own time.end
    feed.durable(fx.turnEnded, { payload: { agentId: 'main', turnId: 1, reason: 'completed' } });
    await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
    await flushUi();
    expect(chain.windows.has(`reasoning:${SESSION_ID}`)).toBe(false);
    expect(chain.windows.has(`subagent:${SESSION_ID}:agent-0:0`)).toBe(true);
  });

  it('keeps replay, snapshot rebuild and history frames from opening new windows', async () => {
    const snapshotRequest = deferred<KimiWebSnapshot>();
    const chain = await mountPopupChain({ getSnapshot: () => snapshotRequest.promise });
    const feed = new Feed(chain.source, 21);
    const subscribing = chain.bridge.subscribe([SESSION_ID], { [SESSION_ID]: { seq: 21, epoch: EPOCH } });

    // replay window: subscribe sent, matching ack not received yet
    feed.durable(fx.toolStarted, { payload: { toolCallId: 'replay-read', name: 'Read', agentId: 'main', turnId: 1 } });
    feed.durable(fx.toolResult, { payload: { toolCallId: 'replay-read', agentId: 'main', turnId: 1 } });
    feed.volatile(fx.thinking, { payload: { agentId: 'main', turnId: 1, delta: 'replayed thinking' } });
    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-0', turnId: 0, delta: 'replayed child' } });
    await flushUi();
    expect(chain.windows.entries.value).toHaveLength(0);

    // history load never opens windows either
    const historyRow: KimiWebMessage = {
      id: 'msg_history_1',
      session_id: SESSION_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'historical answer' }],
      created_at: '2026-09-21T03:27:08.130Z',
    };
    chain.bridge.applyHistory(kimiWebMessagesToHistoryEntries([historyRow]));
    await flushUi();
    expect(chain.windows.entries.value).toHaveLength(0);

    // the matching ack ends replay; the first live frame restores live semantics
    chain.source.ack({ [SESSION_ID]: { seq: feed.seq, epoch: EPOCH } });
    await subscribing;
    await flushUi();
    expect(chain.windows.entries.value).toHaveLength(0);
    feed.durable(fx.toolStarted, { payload: { toolCallId: 'live-read', name: 'Read', agentId: 'main', turnId: 1 } });
    feed.durable(fx.toolResult, { payload: { toolCallId: 'live-read', agentId: 'main', turnId: 1 } });
    await vi.waitFor(() => expect(chain.windows.has('live-read')).toBe(true));

    // snapshot rebuild: buffered terminal parts reconcile against nothing open.
    // as_of_seq 26 = the live cursor at resync; a stale value makes the bridge
    // see a durable gap and restart the rebuild in a loop.
    chain.source.emitResync();
    feed.durable(fx.toolStarted, { payload: { toolCallId: 'rebuild-read', name: 'Read', agentId: 'main', turnId: 1 } });
    feed.durable(fx.toolResult, { payload: { toolCallId: 'rebuild-read', agentId: 'main', turnId: 1 } });
    snapshotRequest.resolve(snapshotFixture(26));
    await vi.waitFor(() => expect(chain.bridge.syncState(SESSION_ID).kind).toBe('live'));
    await flushUi();
    expect(chain.windows.has('rebuild-read')).toBe(false);
    expect(chain.windows.has('live-read')).toBe(true);

    // and live frames after the rebuild open again
    feed.durable(fx.toolStarted, { payload: { toolCallId: 'post-rebuild-read', name: 'Read', agentId: 'main', turnId: 1 } });
    feed.durable(fx.toolResult, { payload: { toolCallId: 'post-rebuild-read', agentId: 'main', turnId: 1 } });
    await vi.waitFor(() => expect(chain.windows.has('post-rebuild-read')).toBe(true));
  });

  it('blocks every live popup path while suppressAutoWindows is on', async () => {
    const chain = await mountPopupChain();
    chain.suppress.value = true;
    const feed = new Feed(chain.source, 21);
    await enterLive(chain, { [SESSION_ID]: { seq: 21, epoch: EPOCH } });

    feed.durable(fx.toolStarted, { payload: { toolCallId: 'suppressed-read', name: 'Read', agentId: 'main', turnId: 1 } });
    feed.durable(fx.toolResult, { payload: { toolCallId: 'suppressed-read', agentId: 'main', turnId: 1 } });
    feed.volatile(fx.thinking, { payload: { agentId: 'main', turnId: 1, delta: 'suppressed thinking' } });
    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-0', turnId: 0, delta: 'suppressed child' } });
    await flushUi();
    expect(chain.windows.entries.value).toHaveLength(0);

    // flipping the switch off restores popups for new frames
    chain.suppress.value = false;
    feed.durable(fx.toolStarted, { payload: { toolCallId: 'after-suppress-read', name: 'Read', agentId: 'main', turnId: 1 } });
    feed.durable(fx.toolResult, { payload: { toolCallId: 'after-suppress-read', agentId: 'main', turnId: 1 } });
    await vi.waitFor(() => expect(chain.windows.has('after-suppress-read')).toBe(true));
  });

  it('gives two parallel subagents their own window and closes each with its own time.end', async () => {
    const chain = await mountPopupChain();
    const feed = new Feed(chain.source, 21);
    await enterLive(chain, { [SESSION_ID]: { seq: 21, epoch: EPOCH } });
    const keyZero = `subagent:${SESSION_ID}:agent-0:0`;
    const keyOne = `subagent:${SESSION_ID}:agent-1:0`;

    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-0', turnId: 0, delta: 'First child answer' } });
    await vi.waitFor(() => expect(chain.windows.has(keyZero)).toBe(true));

    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-1', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-1', turnId: 0, delta: 'Second child answer' } });
    await vi.waitFor(() => expect(chain.windows.has(keyOne)).toBe(true));

    // each window carries only its own text (the synthesized key separates them)
    await vi.waitFor(() => {
      expect(chain.target.textContent).toContain('First child answer');
      expect(chain.target.textContent).toContain('Second child answer');
    });
    expect(chain.subagents.entriesBySession.get(`${SESSION_ID}:agent-0:0`)?.map((entry) => entry.text))
      .toEqual(['First child answer']);
    expect(chain.subagents.entriesBySession.get(`${SESSION_ID}:agent-1:0`)?.map((entry) => entry.text))
      .toEqual(['Second child answer']);

    // each closes with its own terminal part
    feed.durable(fx.subagentCompleted, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
    await flushUi();
    expect(chain.windows.has(keyZero)).toBe(false);
    expect(chain.windows.has(keyOne)).toBe(true);

    feed.durable(fx.subagentCompleted, { payload: { subagentId: 'agent-1', agentId: 'main' } });
    await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
    await flushUi();
    expect(chain.windows.has(keyZero)).toBe(false);
    expect(chain.windows.has(keyOne)).toBe(false);
  });

  it('closes a failed subagent window even without a terminal text delta', async () => {
    const chain = await mountPopupChain();
    const feed = new Feed(chain.source, 21);
    await enterLive(chain, { [SESSION_ID]: { seq: 21, epoch: EPOCH } });
    const key = `subagent:${SESSION_ID}:agent-2:0`;

    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-2', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-2', turnId: 0, delta: 'partial child output' } });
    await vi.waitFor(() => expect(chain.windows.has(key)).toBe(true));

    // subagent.failed with no further text delta: the normalizer still emits the
    // terminal text part (forceText), so the part's own time.end closes it.
    feed.durable(fx.subagentFailed, { payload: { subagentId: 'agent-2', agentId: 'main' } });
    await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
    await flushUi();
    expect(chain.windows.has(key)).toBe(false);

    // a misleading prompt.completed afterwards must not leave or reopen anything
    feed.durable(fx.promptCompleted, { payload: { agentId: 'main' } });
    await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
    await flushUi();
    expect(chain.windows.has(key)).toBe(false);
    expect(chain.windows.entries.value.filter((entry) => entry.key.startsWith('subagent:'))).toHaveLength(0);
  });

  it('keeps non-current-session descendants out of the selected session windows', async () => {
    const chain = await mountPopupChain({ sessionIds: [SESSION_ID, OTHER_SESSION_ID] });
    const selectedFeed = new Feed(chain.source, 30);
    const otherFeed = new Feed(chain.source, 30);
    await enterLive(chain, {
      [SESSION_ID]: { seq: 30, epoch: EPOCH },
      [OTHER_SESSION_ID]: { seq: 30, epoch: EPOCH },
    });

    // a sibling session's subagent streams while SESSION_ID is selected
    otherFeed.durable(fx.subagentSpawned, {
      session_id: OTHER_SESSION_ID,
      payload: { subagentId: 'agent-0', agentId: 'main', sessionId: OTHER_SESSION_ID },
    });
    otherFeed.volatile(fx.assistant, {
      session_id: OTHER_SESSION_ID,
      payload: { agentId: 'agent-0', turnId: 0, delta: 'other session child', sessionId: OTHER_SESSION_ID },
    });
    await flushUi();
    expect(chain.windows.has(`subagent:${OTHER_SESSION_ID}:agent-0:0`)).toBe(false);
    expect(chain.windows.entries.value).toHaveLength(0);

    // the selected session's own subagent still pops up
    selectedFeed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    selectedFeed.volatile(fx.assistant, { payload: { agentId: 'agent-0', turnId: 0, delta: 'selected session child' } });
    await vi.waitFor(() => expect(chain.windows.has(`subagent:${SESSION_ID}:agent-0:0`)).toBe(true));
  });

  it('drops stale live frames after the backend switches away from kimi-web', async () => {
    const chain = await mountPopupChain();
    const feed = new Feed(chain.source, 21);
    await enterLive(chain, { [SESSION_ID]: { seq: 21, epoch: EPOCH } });

    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-0', turnId: 0, delta: 'before switch' } });
    await vi.waitFor(() => expect(chain.windows.has(`subagent:${SESSION_ID}:agent-0:0`)).toBe(true));

    chain.activeBackendKind.value = 'codex';
    await flushUi();
    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-1', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-1', turnId: 0, delta: 'stale after switch' } });
    feed.durable(fx.toolStarted, { payload: { toolCallId: 'stale-read', name: 'Read', agentId: 'main', turnId: 1 } });
    feed.durable(fx.toolResult, { payload: { toolCallId: 'stale-read', agentId: 'main', turnId: 1 } });
    await flushUi();
    expect(chain.windows.has(`subagent:${SESSION_ID}:agent-1:0`)).toBe(false);
    expect(chain.windows.has('stale-read')).toBe(false);

    // switching back restores popups for new frames
    chain.activeBackendKind.value = 'kimi-web';
    await flushUi();
    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-3', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-3', turnId: 0, delta: 'after switch back' } });
    await vi.waitFor(() => expect(chain.windows.has(`subagent:${SESSION_ID}:agent-3:0`)).toBe(true));
  });

  it('reconcile-closes an already-open subagent window when the subagent completes during a disconnect', async () => {
    const chain = await mountPopupChain();
    const feed = new Feed(chain.source, 21);
    await enterLive(chain, { [SESSION_ID]: { seq: 21, epoch: EPOCH } });
    const subagentKey = `subagent:${SESSION_ID}:agent-0:0`;
    const reasoningKey = `reasoning:${SESSION_ID}:agent-0:0`;

    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    feed.volatile(fx.thinking, { payload: { agentId: 'agent-0', turnId: 0, delta: 'child thinking' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-0', turnId: 0, delta: 'child answer' } });
    await vi.waitFor(() => {
      expect(chain.windows.has(subagentKey)).toBe(true);
      expect(chain.windows.has(reasoningKey)).toBe(true);
    });

    // the subagent finishes while the transport is down
    chain.source.emitClose();
    chain.source.emitReconnectStart();
    await flushUi();

    // the server replays the durable terminal frame after the cursor; no new
    // live frames follow the reconnect
    feed.durable(fx.subagentCompleted, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    chain.source.emitReconnectReady({ [SESSION_ID]: { seq: feed.seq, epoch: EPOCH } });
    await flushUi();
    await vi.waitFor(() => expect(chain.bridge.syncState(SESSION_ID).kind).toBe('live'));

    await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
    await flushUi();
    expect(chain.windows.has(subagentKey)).toBe(false);
    expect(chain.windows.has(reasoningKey)).toBe(false);
  });

  it('reconcile-closes a minimized subagent window without restoring it', async () => {
    const chain = await mountPopupChain();
    const feed = new Feed(chain.source, 21);
    await enterLive(chain, { [SESSION_ID]: { seq: 21, epoch: EPOCH } });
    const subagentKey = `subagent:${SESSION_ID}:agent-0:0`;

    feed.durable(fx.subagentSpawned, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    feed.volatile(fx.assistant, { payload: { agentId: 'agent-0', turnId: 0, delta: 'child answer' } });
    await vi.waitFor(() => expect(chain.windows.has(subagentKey)).toBe(true));

    // the user minimized the window into the dock before the disconnect
    chain.windows.minimize(subagentKey);
    expect(chain.windows.get(subagentKey)?.minimized).toBe(true);

    chain.source.emitClose();
    chain.source.emitReconnectStart();
    await flushUi();
    feed.durable(fx.subagentCompleted, { payload: { subagentId: 'agent-0', agentId: 'main' } });
    await flushUi();

    // the reconcile update must not un-minimize the dock entry (checked before
    // any timer advance, which would fire the close delay)
    expect(chain.windows.get(subagentKey)?.minimized).toBe(true);

    chain.source.emitReconnectReady({ [SESSION_ID]: { seq: feed.seq, epoch: EPOCH } });
    await flushUi();
    await vi.waitFor(() => expect(chain.bridge.syncState(SESSION_ID).kind).toBe('live'));

    await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
    await flushUi();
    // the terminal part still closes it
    expect(chain.windows.has(subagentKey)).toBe(false);
  });
});
