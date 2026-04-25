import { computed, ref } from 'vue';
import {
  CodexAdapter,
  type CodexAdapterOptions,
  type CodexPromptInput,
  type CodexThread,
  type CodexThreadListParams,
  type CodexTurn,
} from '../backends/codex/codexAdapter';
import type {
  CodexJsonRpcId,
  CodexJsonRpcNotification,
  CodexJsonRpcServerRequest,
} from '../backends/codex/jsonRpcClient';

export type CodexConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export type CodexEventEntry = {
  id: number;
  method: string;
  params?: unknown;
  time: number;
};

export type CodexTranscriptEntry = {
  id: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  time: number;
};

export type CodexServerRequestEntry = {
  id: CodexJsonRpcId;
  method: string;
  params?: unknown;
  threadId: string;
  turnId: string;
  availableDecisions: string[];
  time: number;
};

export type CodexApiOptions = {
  url?: string;
  bridgeToken?: string;
  adapterFactory?: (options: CodexAdapterOptions) => CodexAdapter;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function appendBridgeToken(url: string, token?: string) {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

function extractThread(value: unknown): CodexThread | null {
  if (!isRecord(value)) return null;
  const thread = isRecord(value.thread) ? value.thread : value;
  return typeof thread.id === 'string' ? thread as CodexThread : null;
}

function extractTurn(value: unknown): CodexTurn | null {
  if (!isRecord(value)) return null;
  const turn = isRecord(value.turn) ? value.turn : value;
  return typeof turn.id === 'string' ? turn as CodexTurn : null;
}

function extractAgentDelta(params: unknown) {
  if (!isRecord(params)) return '';
  const directDelta = params.delta;
  if (typeof directDelta === 'string') return directDelta;

  const item = isRecord(params.item) ? params.item : null;
  const itemDelta = item?.delta;
  if (typeof itemDelta === 'string') return itemDelta;

  const text = params.text ?? item?.text;
  return typeof text === 'string' ? text : '';
}

function extractTextInput(value: unknown) {
  if (!isRecord(value)) return '';
  const text = value.text;
  return typeof text === 'string' ? text : '';
}

function extractItemTranscriptEntries(
  item: unknown,
  createEntry: (role: CodexTranscriptEntry['role'], text: string) => CodexTranscriptEntry,
) {
  if (!isRecord(item) || typeof item.type !== 'string') return [];

  if (item.type === 'userMessage') {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.map(extractTextInput).filter(Boolean).join('\n');
    return text ? [createEntry('user', text)] : [];
  }

  if (item.type === 'agentMessage') {
    const text = item.text;
    return typeof text === 'string' && text ? [createEntry('assistant', text)] : [];
  }

  if (item.type === 'plan') {
    const text = item.text;
    return typeof text === 'string' && text ? [createEntry('system', text)] : [];
  }

  return [];
}

function extractNameUpdate(params: unknown) {
  if (!isRecord(params)) return null;
  const thread = extractThread(params);
  if (thread) return thread;
  const threadId = params.threadId;
  const name = params.name;
  if (typeof threadId === 'string' && (typeof name === 'string' || name === null)) {
    return { id: threadId, name } satisfies CodexThread;
  }
  return null;
}

const APPROVAL_DECISIONS_BY_METHOD: Record<string, ReadonlySet<string>> = {
  'item/commandExecution/requestApproval': new Set(['accept', 'acceptForSession', 'decline', 'cancel']),
  'item/fileChange/requestApproval': new Set(['accept', 'acceptForSession', 'decline', 'cancel']),
};

function extractScopedApprovalRequest(
  request: CodexJsonRpcServerRequest,
  activeThreadId: string,
  activeTurnId: string | undefined,
) {
  const allowedDecisions = APPROVAL_DECISIONS_BY_METHOD[request.method];
  if (!allowedDecisions || !isRecord(request.params)) return null;

  const threadId = request.params.threadId;
  const turnId = request.params.turnId;
  if (typeof threadId !== 'string' || typeof turnId !== 'string') return null;
  if (threadId !== activeThreadId || turnId !== activeTurnId) return null;

  const availableDecisions = Array.isArray(request.params.availableDecisions)
    ? request.params.availableDecisions.filter((decision): decision is string => (
        typeof decision === 'string' && allowedDecisions.has(decision)
      ))
    : [];
  if (availableDecisions.length === 0) return null;

  return { threadId, turnId, availableDecisions };
}

export function useCodexApi(initialOptions: CodexApiOptions = {}) {
  const status = ref<CodexConnectionStatus>('idle');
  const url = ref(initialOptions.url ?? 'ws://localhost:23004/codex');
  const bridgeToken = ref(initialOptions.bridgeToken ?? '');
  const errorMessage = ref('');
  const threads = ref<CodexThread[]>([]);
  const activeThreadId = ref('');
  const activeTurn = ref<CodexTurn | null>(null);
  const transcript = ref<CodexTranscriptEntry[]>([]);
  const events = ref<CodexEventEntry[]>([]);
  const serverRequests = ref<CodexServerRequestEntry[]>([]);
  const pending = ref(false);
  const loadingThread = ref(false);
  const initialized = ref(false);

  let adapter: CodexAdapter | null = null;
  let unsubscribeNotifications: (() => void) | null = null;
  let unsubscribeServerRequests: (() => void) | null = null;
  let nextEventId = 1;
  let nextTranscriptId = 1;

  const connected = computed(() => status.value === 'connected' && initialized.value);

  function makeAdapter() {
    const factory = initialOptions.adapterFactory ?? ((options: CodexAdapterOptions) => new CodexAdapter(options));
    return factory({
      url: appendBridgeToken(url.value.trim(), bridgeToken.value.trim() || undefined),
      experimentalApi: true,
    });
  }

  function upsertThread(thread: CodexThread) {
    const index = threads.value.findIndex((item) => item.id === thread.id);
    if (index === -1) threads.value = [thread, ...threads.value];
    else threads.value[index] = { ...threads.value[index], ...thread };
    if (!activeThreadId.value) activeThreadId.value = thread.id;
  }

  function pushTranscript(role: CodexTranscriptEntry['role'], text: string) {
    if (!text) return;
    transcript.value.push({
      id: nextTranscriptId,
      role,
      text,
      time: Date.now(),
    });
    nextTranscriptId += 1;
  }

  function createTranscriptEntry(role: CodexTranscriptEntry['role'], text: string) {
    const entry = {
      id: nextTranscriptId,
      role,
      text,
      time: Date.now(),
    } satisfies CodexTranscriptEntry;
    nextTranscriptId += 1;
    return entry;
  }

  function setTranscriptFromTurns(turns: CodexTurn[] = []) {
    transcript.value = turns.flatMap((turn) => {
      const items = Array.isArray(turn.items) ? turn.items : [];
      return items.flatMap((item) => extractItemTranscriptEntries(item, createTranscriptEntry));
    });
  }

  function appendAssistantDelta(text: string) {
    if (!text) return;
    const last = transcript.value.at(-1);
    if (last?.role === 'assistant') {
      transcript.value[transcript.value.length - 1] = {
        ...last,
        text: `${last.text}${text}`,
      };
      return;
    }
    pushTranscript('assistant', text);
  }

  function handleNotification(notification: CodexJsonRpcNotification) {
    events.value.push({
      id: nextEventId,
      method: notification.method,
      params: notification.params,
      time: Date.now(),
    });
    nextEventId += 1;

    if (notification.method === 'thread/started') {
      const thread = extractThread(notification.params);
      if (thread) upsertThread(thread);
      return;
    }

    if (notification.method === 'thread/name/updated') {
      const thread = extractNameUpdate(notification.params);
      if (thread) upsertThread(thread);
      void refreshThreads();
      return;
    }

    if (
      notification.method === 'thread/status/changed' ||
      notification.method === 'thread/archived' ||
      notification.method === 'thread/unarchived' ||
      notification.method === 'thread/closed'
    ) {
      void refreshThreads();
      return;
    }

    if (notification.method === 'serverRequest/resolved') {
      const params = isRecord(notification.params) ? notification.params : null;
      const requestId = params?.requestId;
      serverRequests.value = serverRequests.value.filter((request) => {
        const requestParams = isRecord(request.params) ? request.params : null;
        return request.id !== requestId && requestParams?.requestId !== requestId && requestParams?.itemId !== requestId;
      });
      return;
    }

    if (notification.method === 'turn/started' || notification.method === 'turn/completed') {
      const turn = extractTurn(notification.params);
      if (turn) activeTurn.value = turn;
      pruneServerRequestsForActiveContext();
      if (notification.method === 'turn/completed') void refreshThreads();
      return;
    }

    if (notification.method === 'item/completed') {
      const params = isRecord(notification.params) ? notification.params : null;
      const item = params?.item;
      if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string') {
        const last = transcript.value.at(-1);
        if (last?.role === 'assistant') {
          transcript.value[transcript.value.length - 1] = { ...last, text: item.text };
        } else {
          pushTranscript('assistant', item.text);
        }
      }
      return;
    }

    if (notification.method === 'item/agentMessage/delta') {
      appendAssistantDelta(extractAgentDelta(notification.params));
    }
  }

  function handleServerRequest(request: CodexJsonRpcServerRequest) {
    const scopedRequest = extractScopedApprovalRequest(request, activeThreadId.value, activeTurn.value?.id);
    if (!scopedRequest) return;

    serverRequests.value = [
      ...serverRequests.value.filter((item) => item.id !== request.id),
      {
        id: request.id,
        method: request.method,
        params: request.params,
        threadId: scopedRequest.threadId,
        turnId: scopedRequest.turnId,
        availableDecisions: scopedRequest.availableDecisions,
        time: Date.now(),
      },
    ];
  }

  function pruneServerRequestsForActiveContext() {
    const threadId = activeThreadId.value;
    const turnId = activeTurn.value?.id;
    serverRequests.value = serverRequests.value.filter((request) => (
      request.threadId === threadId && request.turnId === turnId
    ));
  }

  async function connect(nextUrl = url.value) {
    disconnect();
    url.value = nextUrl.trim();
    status.value = 'connecting';
    errorMessage.value = '';
    adapter = makeAdapter();
    unsubscribeNotifications = adapter.onNotification(handleNotification);
    unsubscribeServerRequests = adapter.onServerRequest(handleServerRequest);

    try {
      await adapter.initialize();
      initialized.value = true;
      status.value = 'connected';
      await refreshThreads();
    } catch (error) {
      status.value = 'error';
      errorMessage.value = error instanceof Error ? error.message : String(error);
      disconnect(false);
      throw error;
    }
  }

  function disconnect(resetStatus = true) {
    unsubscribeNotifications?.();
    unsubscribeNotifications = null;
    unsubscribeServerRequests?.();
    unsubscribeServerRequests = null;
    adapter?.disconnect();
    adapter = null;
    initialized.value = false;
    activeTurn.value = null;
    serverRequests.value = [];
    if (resetStatus) status.value = 'idle';
  }

  async function refreshThreads(params: CodexThreadListParams = {}) {
    if (!adapter) return;
    const result = await adapter.listThreads({ limit: 50, sortKey: 'updated_at', ...params });
    threads.value = result.data;
    if (!activeThreadId.value && result.data[0]) activeThreadId.value = result.data[0].id;
  }

  async function selectThread(threadId: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    if (!threadId) return;
    activeThreadId.value = threadId;
    activeTurn.value = null;
    pruneServerRequestsForActiveContext();
    loadingThread.value = true;
    errorMessage.value = '';
    try {
      const read = await adapter.readThread({ threadId, includeTurns: true });
      upsertThread(read.thread);
      activeThreadId.value = read.thread.id;
      setTranscriptFromTurns(read.thread.turns ?? []);
      const resumed = await adapter.resumeThread({ threadId });
      upsertThread(resumed.thread);
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      loadingThread.value = false;
    }
  }

  async function startThread() {
    if (!adapter) throw new Error('Codex is not connected.');
    const result = await adapter.startThread();
    upsertThread(result.thread);
    activeThreadId.value = result.thread.id;
    transcript.value = [];
    activeTurn.value = null;
    pruneServerRequestsForActiveContext();
    return result.thread;
  }

  async function setThreadName(threadId: string, name: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    const normalizedName = name.trim();
    await adapter.setThreadName({ threadId, name: normalizedName || null });
    upsertThread({ id: threadId, name: normalizedName || null });
    await refreshThreads();
  }

  async function archiveThread(threadId: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    await adapter.archiveThread({ threadId });
    threads.value = threads.value.filter((thread) => thread.id !== threadId);
    if (activeThreadId.value === threadId) {
      activeThreadId.value = threads.value[0]?.id ?? '';
      transcript.value = [];
      activeTurn.value = null;
    }
    await refreshThreads();
    threads.value = threads.value.filter((thread) => thread.id !== threadId);
    if (activeThreadId.value === threadId) activeThreadId.value = threads.value[0]?.id ?? '';
  }

  async function unarchiveThread(threadId: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    const result = await adapter.unarchiveThread({ threadId });
    upsertThread(result.thread);
    activeThreadId.value = result.thread.id;
    activeTurn.value = null;
    pruneServerRequestsForActiveContext();
    await refreshThreads();
  }

  async function unsubscribeThread(threadId = activeThreadId.value) {
    if (!adapter) throw new Error('Codex is not connected.');
    if (!threadId) return;
    await adapter.unsubscribeThread({ threadId });
    if (activeThreadId.value === threadId) activeTurn.value = null;
  }

  async function interruptActiveTurn() {
    if (!adapter) throw new Error('Codex is not connected.');
    const turn = activeTurn.value;
    const turnId = turn?.id;
    if (!activeThreadId.value || !turnId) return;
    await adapter.interruptTurn({ threadId: activeThreadId.value, turnId });
    activeTurn.value = { ...turn, status: 'interrupted' };
    pending.value = false;
  }

  function resolveServerRequest(id: CodexJsonRpcId, decision: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    const request = serverRequests.value.find((item) => item.id === id);
    if (
      !request ||
      request.threadId !== activeThreadId.value ||
      request.turnId !== activeTurn.value?.id ||
      !request.availableDecisions.includes(decision)
    ) return;
    adapter.respondToServerRequest(id, decision);
    serverRequests.value = serverRequests.value.filter((request) => request.id !== id);
  }

  async function sendPrompt(text: string) {
    const prompt = text.trim();
    if (!prompt) return null;
    if (!adapter) throw new Error('Codex is not connected.');

    pending.value = true;
    errorMessage.value = '';
    pushTranscript('user', prompt);

    try {
      const input: CodexPromptInput = activeThreadId.value
        ? { threadId: activeThreadId.value, text: prompt }
        : { text: prompt };
      const result = await adapter.sendPrompt(input);
      activeThreadId.value = result.threadId;
      if (result.thread) upsertThread(result.thread);
      activeTurn.value = result.turn;
      return result;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      pending.value = false;
    }
  }

  return {
    status,
    url,
    bridgeToken,
    errorMessage,
    threads,
    activeThreadId,
    activeTurn,
    transcript,
    events,
    serverRequests,
    pending,
    loadingThread,
    initialized,
    connected,
    connect,
    disconnect,
    refreshThreads,
    selectThread,
    startThread,
    setThreadName,
    archiveThread,
    unarchiveThread,
    unsubscribeThread,
    interruptActiveTurn,
    resolveServerRequest,
    sendPrompt,
  };
}
