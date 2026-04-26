import { computed, ref } from 'vue';
import {
  CodexAdapter,
  type CodexAccount,
  type CodexAccountRateLimitBucket,
  type CodexAdapterOptions,
  type CodexApp,
  type CodexAppListParams,
  type CodexAppListResult,
  type CodexCollaborationMode,
  type CodexCollaborationModeListResult,
  type CodexConfigBatchWriteParams,
  type CodexConfigReadResult,
  type CodexConfigRequirementsReadResult,
  type CodexConfigValueWriteParams,
  type CodexExperimentalFeature,
  type CodexExperimentalFeatureListResult,
  type CodexExternalAgentConfigDetectResult,
  type CodexExternalAgentConfigImportParams,
  type CodexExternalAgentConfigItem,
  type CodexFeedbackUploadParams,
  type CodexFsDirectoryEntry,
  type CodexModel,
  type CodexMcpServerInfo,
  type CodexPlugin,
  type CodexPromptInput,
  type CodexReviewStartParams,
  type CodexSkill,
  type CodexThread,
  type CodexThreadListParams,
  type CodexTurn,
  type CodexToolRequestUserInputParams,
  type CodexWindowsSandboxSetupStartResult,
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

export type CodexApprovalContext = {
  command?: string;
  cwd?: string;
  reason?: string;
  host?: string;
  protocol?: string;
  proposedAmendment?: string[];
  commandActions?: unknown[];
  additionalPermissions?: unknown[];
  fileChanges?: Array<{ path: string; kind: string; diff?: string }>;
  grantRoot?: string;
};

export type CodexServerRequestEntry = {
  id: CodexJsonRpcId;
  method: string;
  params?: unknown;
  threadId: string;
  turnId: string;
  availableDecisions: string[];
  context: CodexApprovalContext;
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

  if (item.type === 'commandExecution') {
    const command = Array.isArray(item.command)
      ? item.command.filter((c): c is string => typeof c === 'string').join(' ')
      : typeof item.command === 'string' ? item.command : '';
    const cwd = typeof item.cwd === 'string' ? item.cwd : '';
    const status = typeof item.status === 'string' ? item.status : '';
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
    const aggregatedOutput = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    const lines = [
      command ? `$ ${command}` : '',
      cwd ? `cwd: ${cwd}` : '',
      status ? `status: ${status}` : '',
      exitCode !== null ? `exit code: ${exitCode}` : '',
      aggregatedOutput ? `\n${aggregatedOutput}` : '',
    ].filter(Boolean);
    const text = lines.join('\n');
    return text ? [createEntry('system', text)] : [];
  }

  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .filter((c): c is Record<string, unknown> => isRecord(c))
      .map((c) => typeof c.path === 'string' ? c.path : '')
      .filter(Boolean);
    const status = typeof item.status === 'string' ? item.status : '';
    const text = [
      paths.length > 0 ? `File changes (${paths.length}):\n${paths.map((p) => `  ${p}`).join('\n')}` : 'File changes',
      status ? `status: ${status}` : '',
    ].filter(Boolean).join('\n');
    return text ? [createEntry('system', text)] : [];
  }

  if (item.type === 'reasoning') {
    const summary = typeof item.summary === 'string' ? item.summary : '';
    const text = summary ? `Reasoning: ${summary}` : '';
    return text ? [createEntry('system', text)] : [];
  }

  if (item.type === 'enteredReviewMode') {
    const review = typeof item.review === 'string' ? item.review : 'current changes';
    return [createEntry('system', `Entered review mode: ${review}`)];
  }

  if (item.type === 'exitedReviewMode') {
    const review = typeof item.review === 'string' ? item.review : '';
    return review ? [createEntry('system', `Review: ${review}`)] : [];
  }

  if (item.type === 'webSearch') {
    const query = typeof item.query === 'string' ? item.query : '';
    const action = isRecord(item.action) ? item.action : null;
    const actionType = typeof action?.type === 'string' ? action.type : '';
    const actionQuery = typeof action?.query === 'string' ? action.query : '';
    const actionUrl = typeof action?.url === 'string' ? action.url : '';
    const text = [
      query ? `Web search: ${query}` : '',
      actionType ? `action: ${actionType}` : '',
      actionQuery ? `query: ${actionQuery}` : '',
      actionUrl ? `url: ${actionUrl}` : '',
    ].filter(Boolean).join('\n');
    return text ? [createEntry('system', text)] : [];
  }

  if (item.type === 'imageView') {
    const path = typeof item.path === 'string' ? item.path : '';
    return path ? [createEntry('system', `Image: ${path}`)] : [];
  }

  if (item.type === 'mcpToolCall') {
    const server = typeof item.server === 'string' ? item.server : '';
    const tool = typeof item.tool === 'string' ? item.tool : '';
    const args = isRecord(item.arguments)
      ? JSON.stringify(item.arguments, null, 2)
      : '';
    const status = typeof item.status === 'string' ? item.status : '';
    const text = [
      server && tool ? `Tool call: ${server}.${tool}` : '',
      args ? `arguments:\n${args}` : '',
      status ? `status: ${status}` : '',
    ].filter(Boolean).join('\n');
    return text ? [createEntry('system', text)] : [];
  }

  if (item.type === 'dynamicToolCall' || item.type === 'collabToolCall') {
    const tool = typeof item.tool === 'string' ? item.tool : '';
    const status = typeof item.status === 'string' ? item.status : '';
    const text = [
      tool ? `Tool call: ${tool}` : '',
      status ? `status: ${status}` : '',
    ].filter(Boolean).join('\n');
    return text ? [createEntry('system', text)] : [];
  }

  if (item.type === 'contextCompaction') {
    return [createEntry('system', 'Context compaction completed')];
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
  'item/commandExecution/requestApproval': new Set([
    'accept', 'acceptForSession', 'decline', 'cancel',
    'acceptWithExecpolicyAmendment',
  ]),
  'item/fileChange/requestApproval': new Set([
    'accept', 'acceptForSession', 'decline', 'cancel',
  ]),
};

const PIN_STORAGE_KEY = 'vis.codex.pins.v1';
const HIDE_STORAGE_KEY = 'vis.codex.hidden.v1';

function extractApprovalContext(params: Record<string, unknown>): CodexApprovalContext {
  const context: CodexApprovalContext = {};

  // Command info
  const command = params.command;
  if (Array.isArray(command)) {
    context.command = command.filter((item): item is string => typeof item === 'string').join(' ');
  } else if (typeof command === 'string') {
    context.command = command;
  }

  // CWD
  if (typeof params.cwd === 'string') context.cwd = params.cwd;

  // Reason
  if (typeof params.reason === 'string') context.reason = params.reason;

  // Network approval context
  const networkCtx = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : null;
  if (networkCtx) {
    if (typeof networkCtx.host === 'string') context.host = networkCtx.host;
    if (typeof networkCtx.protocol === 'string') context.protocol = networkCtx.protocol;
  }

  // Execution policy amendment
  const amendment = isRecord(params.proposedExecpolicyAmendment)
    ? params.proposedExecpolicyAmendment.execpolicy_amendment
    : null;
  if (Array.isArray(amendment)) {
    context.proposedAmendment = amendment.filter((item): item is string => typeof item === 'string');
  }

  // Command actions
  if (Array.isArray(params.commandActions)) context.commandActions = params.commandActions;

  // Additional permissions (experimental)
  if (Array.isArray(params.additionalPermissions)) context.additionalPermissions = params.additionalPermissions;

  // File changes
  const changes = isRecord(params.changes) ? params.changes.changes : null;
  if (Array.isArray(changes)) {
    context.fileChanges = changes
      .filter((c): c is Record<string, unknown> => isRecord(c))
      .map((c) => ({
        path: typeof c.path === 'string' ? c.path : '',
        kind: typeof c.kind === 'string' ? c.kind : '',
        diff: typeof c.diff === 'string' ? c.diff : undefined,
      }))
      .filter((c) => c.path);
  }

  // Grant root
  if (typeof params.grantRoot === 'string') context.grantRoot = params.grantRoot;

  return context;
}

function loadThreadIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
  return new Set();
}

function saveThreadIdSet(key: string, set: Set<string>) {
  localStorage.setItem(key, JSON.stringify(Array.from(set)));
}

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

  return {
    threadId,
    turnId,
    availableDecisions,
    context: extractApprovalContext(request.params as Record<string, unknown>),
  };
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
  const pinnedThreadIds = ref<Set<string>>(loadThreadIdSet(PIN_STORAGE_KEY));
  const hiddenThreadIds = ref<Set<string>>(loadThreadIdSet(HIDE_STORAGE_KEY));
  const fsEntries = ref<CodexFsDirectoryEntry[]>([]);
  const fsCwd = ref('');
  const fsLoading = ref(false);
  const fsError = ref('');
  const previewFileContent = ref('');
  const previewFilePath = ref('');
  const sandboxPath = ref('~');
  const fsSuggestions = ref<string[]>([]);
  const fsShowSuggestions = ref(false);
  const homeDir = ref('');

   // Review mode state
   const reviewState = ref<'idle' | 'reviewing' | 'completed'>('idle');
   const reviewResult = ref('');
   const commandOutput = ref<Array<{ text: string; time: number }>>([]);

   // Account state
   const account = ref<CodexAccount>(null);
   const accountAuthMode = ref<string | null>(null);
   const accountPlanType = ref<string | null>(null);
   const accountRateLimits = ref<CodexAccountRateLimitBucket | null>(null);
   const loginPending = ref(false);
   const loginError = ref('');
   const deviceCodeInfo = ref<{ verificationUrl: string; userCode: string } | null>(null);

    const models = ref<CodexModel[]>([]);
    const modelsLoading = ref(false);
    const selectedModel = ref<string>('');
   const skills = ref<CodexSkill[]>([]);
   const skillsLoading = ref(false);
   const plugins = ref<CodexPlugin[]>([]);
   const pluginsLoading = ref(false);
   const mcpServers = ref<CodexMcpServerInfo[]>([]);
   const mcpServersLoading = ref(false);
    const config = ref<CodexConfigReadResult | null>(null);
    const configLoading = ref(false);
    const apps = ref<CodexApp[]>([]);
    const appsLoading = ref(false);
    const experimentalFeatures = ref<CodexExperimentalFeature[]>([]);
    const experimentalFeaturesLoading = ref(false);
    const collaborationModes = ref<CodexCollaborationMode[]>([]);
    const collaborationModesLoading = ref(false);
    const configRequirements = ref<CodexConfigRequirementsReadResult['requirements']>(null);
    const configRequirementsLoading = ref(false);
    const externalAgentConfigItems = ref<CodexExternalAgentConfigItem[]>([]);
    const externalAgentConfigLoading = ref(false);
    const externalAgentImportStatus = ref<{ success: boolean; error?: string } | null>(null);
    const windowsSandboxStatus = ref<{ mode: string; success: boolean; error?: string | null } | null>(null);
    const fuzzySearchResults = ref<Array<{ path: string; score: number }>>([]);
    const fuzzySearchQuery = ref('');
    const toolUserInputRequests = ref<Array<{ requestId: CodexJsonRpcId; questions: Array<{ id: string; text: string; isOther?: boolean }>; threadId: string; turnId: string }>>([]);
    const dynamicToolCalls = ref<Array<{ requestId: CodexJsonRpcId; toolName: string; arguments: Record<string, unknown>; threadId: string; turnId: string }>>([]);

    // New state for high/medium priority APIs
    const planItems = ref<Array<{ turnId: string; explanation?: string; plan: Array<{ step: string; status: string }> }>>([]);
    const diffState = ref<{ threadId: string; turnId: string; diff: string } | null>(null);
    const tokenUsage = ref<unknown>(null);
    const reasoningStreams = ref<Record<string, { summary: string; raw: string }>>({});
    const fileChangeOutputs = ref<Record<string, string>>({});
    const activeWatches = ref<Set<string>>(new Set());
    const loadedThreadIds = ref<string[]>([]);
    const steerInput = ref('');
    const showSteerInput = ref(false);
    const shellCommandInput = ref('');
    const showShellCommand = ref(false);
    const commandProcessId = ref<string | null>(null);

    let adapter: CodexAdapter | null = null;
  let unsubscribeNotifications: (() => void) | null = null;
  let unsubscribeServerRequests: (() => void) | null = null;
  let nextEventId = 1;
  let nextTranscriptId = 1;

  const connected = computed(() => status.value === 'connected' && initialized.value);

  const visibleThreads = computed(() => {
    const list = threads.value.filter((thread) => !hiddenThreadIds.value.has(thread.id));
    return list.sort((a, b) => {
      const aPinned = pinnedThreadIds.value.has(a.id) ? 1 : 0;
      const bPinned = pinnedThreadIds.value.has(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      const aTime = a.updatedAt ?? a.createdAt ?? 0;
      const bTime = b.updatedAt ?? b.createdAt ?? 0;
      return bTime - aTime;
    });
  });

  const fsBreadcrumbs = computed(() => {
    if (!fsCwd.value || fsCwd.value === '/') return [{ name: '/', path: '/' }];
    const parts = fsCwd.value.split('/').filter(Boolean);
    const crumbs = [{ name: '/', path: '/' }];
    for (let i = 0; i < parts.length; i += 1) {
      crumbs.push({
        name: parts[i]!,
        path: '/' + parts.slice(0, i + 1).join('/'),
      });
    }
    return crumbs;
  });

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
        toolUserInputRequests.value = toolUserInputRequests.value.filter((request) => request.requestId !== requestId);
        dynamicToolCalls.value = dynamicToolCalls.value.filter((request) => request.requestId !== requestId);
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
       // Handle exitedReviewMode
       if (isRecord(item) && item.type === 'exitedReviewMode') {
         reviewState.value = 'completed';
         const reviewText = typeof item.review === 'string' ? item.review : '';
         reviewResult.value = reviewText;
         pushTranscript('system', `Review completed: ${reviewText}`);
       }
       return;
     }

     if (notification.method === 'item/agentMessage/delta') {
       appendAssistantDelta(extractAgentDelta(notification.params));
       return;
     }

     // Review mode notifications
     if (notification.method === 'item/started') {
       const params = isRecord(notification.params) ? notification.params : null;
       const item = isRecord(params?.item) ? params.item : null;
       if (item?.type === 'enteredReviewMode') {
         reviewState.value = 'reviewing';
         reviewResult.value = '';
         const reviewText = typeof item.review === 'string' ? item.review : '';
         pushTranscript('system', `Review started: ${reviewText || 'current changes'}`);
         return;
       }
     }

     // Command execution output streaming
     if (notification.method === 'command/exec/outputDelta') {
       const params = isRecord(notification.params) ? notification.params : null;
       const delta = typeof params?.delta === 'string' ? params.delta : '';
       if (delta) {
         commandOutput.value.push({ text: delta, time: Date.now() });
       }
       return;
     }

     // Account notifications
     if (notification.method === 'account/updated') {
       const params = isRecord(notification.params) ? notification.params : null;
       accountAuthMode.value = typeof params?.authMode === 'string' ? params.authMode : null;
       accountPlanType.value = typeof params?.planType === 'string' ? params.planType : null;
       if (params?.authMode) {
         void refreshAccount();
       } else {
         account.value = null;
       }
       return;
     }

     if (notification.method === 'account/login/completed') {
       const params = isRecord(notification.params) ? notification.params : null;
       loginPending.value = false;
       if (params?.success === true) {
         loginError.value = '';
         deviceCodeInfo.value = null;
         void refreshAccount();
       } else {
         loginError.value = typeof params?.error === 'string' ? params.error : 'Login failed';
       }
       return;
     }

      if (notification.method === 'account/rateLimits/updated') {
        const params = isRecord(notification.params) ? notification.params : null;
        const rateLimits = isRecord(params?.rateLimits) ? params.rateLimits : null;
        if (rateLimits) {
          accountRateLimits.value = rateLimits as CodexAccountRateLimitBucket;
        }
        return;
      }

      if (notification.method === 'fs/changed') {
        const params = isRecord(notification.params) ? notification.params : null;
        const changedPaths = Array.isArray(params?.changedPaths) ? params.changedPaths : [];
        if (changedPaths.length > 0 && fsCwd.value) {
          void readDirectory(fsCwd.value);
        }
        return;
      }

      if (notification.method === 'skills/changed') {
        void refreshSkills();
        return;
      }

      if (notification.method === 'mcpServer/startupStatus/updated') {
        const params = isRecord(notification.params) ? notification.params : null;
        const name = typeof params?.name === 'string' ? params.name : '';
        const status = typeof params?.status === 'string' ? params.status : '';
        const error = typeof params?.error === 'string' ? params.error : undefined;
        const index = mcpServers.value.findIndex((s) => s.name === name);
        if (index !== -1) {
          mcpServers.value[index] = { ...mcpServers.value[index]!, status, error };
        }
        return;
      }

      if (notification.method === 'turn/diff/updated') {
        const params = isRecord(notification.params) ? notification.params : null;
        const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params?.turnId === 'string' ? params.turnId : '';
        const diff = typeof params?.diff === 'string' ? params.diff : '';
        if (threadId && turnId) {
          diffState.value = { threadId, turnId, diff };
        }
        return;
      }

      if (notification.method === 'turn/plan/updated') {
        const params = isRecord(notification.params) ? notification.params : null;
        const turnId = typeof params?.turnId === 'string' ? params.turnId : '';
        const explanation = typeof params?.explanation === 'string' ? params.explanation : undefined;
        const plan = Array.isArray(params?.plan) ? params.plan : [];
        if (turnId) {
          const existingIndex = planItems.value.findIndex((p) => p.turnId === turnId);
          const planEntry = {
            turnId,
            explanation,
            plan: plan.filter((p: unknown) => isRecord(p)).map((p: Record<string, unknown>) => ({
              step: typeof p.step === 'string' ? p.step : '',
              status: typeof p.status === 'string' ? p.status : '',
            })),
          };
          if (existingIndex !== -1) {
            planItems.value[existingIndex] = planEntry;
          } else {
            planItems.value.push(planEntry);
          }
        }
        return;
      }

      if (notification.method === 'item/plan/delta') {
        appendAssistantDelta(extractAgentDelta(notification.params));
        return;
      }

      if (notification.method === 'item/reasoning/summaryTextDelta') {
        const params = isRecord(notification.params) ? notification.params : null;
        const itemId = typeof params?.itemId === 'string' ? params.itemId : '';
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (itemId) {
          const existing = reasoningStreams.value[itemId] ?? { summary: '', raw: '' };
          reasoningStreams.value[itemId] = { ...existing, summary: existing.summary + delta };
        }
        return;
      }

      if (notification.method === 'item/reasoning/summaryPartAdded') {
        const params = isRecord(notification.params) ? notification.params : null;
        const itemId = typeof params?.itemId === 'string' ? params.itemId : '';
        if (itemId) {
          const existing = reasoningStreams.value[itemId] ?? { summary: '', raw: '' };
          reasoningStreams.value[itemId] = { ...existing, summary: existing.summary + '\n---\n' };
        }
        return;
      }

      if (notification.method === 'item/reasoning/textDelta') {
        const params = isRecord(notification.params) ? notification.params : null;
        const itemId = typeof params?.itemId === 'string' ? params.itemId : '';
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (itemId) {
          const existing = reasoningStreams.value[itemId] ?? { summary: '', raw: '' };
          reasoningStreams.value[itemId] = { ...existing, raw: existing.raw + delta };
        }
        return;
      }

      if (notification.method === 'item/fileChange/outputDelta') {
        const params = isRecord(notification.params) ? notification.params : null;
        const itemId = typeof params?.itemId === 'string' ? params.itemId : '';
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (itemId) {
          fileChangeOutputs.value[itemId] = (fileChangeOutputs.value[itemId] ?? '') + delta;
        }
        return;
      }

      if (notification.method === 'thread/tokenUsage/updated') {
        const params = isRecord(notification.params) ? notification.params : null;
        if (params) {
          tokenUsage.value = params;
        }
        return;
      }

      if (notification.method === 'app/list/updated') {
        const params = isRecord(notification.params) ? notification.params : null;
        const data = Array.isArray(params?.data) ? params.data : [];
        apps.value = data as CodexAppListResult['data'];
        return;
      }

      if (notification.method === 'externalAgentConfig/import/completed') {
        const params = isRecord(notification.params) ? notification.params : null;
        externalAgentImportStatus.value = {
          success: params?.success === true,
          error: typeof params?.error === 'string' ? params.error : undefined,
        };
        return;
      }

      if (notification.method === 'windowsSandbox/setupCompleted') {
        const params = isRecord(notification.params) ? notification.params : null;
        windowsSandboxStatus.value = {
          mode: typeof params?.mode === 'string' ? params.mode : '',
          success: params?.success === true,
          error: typeof params?.error === 'string' || params?.error === null ? params.error : undefined,
        };
        return;
      }

      if (notification.method === 'fuzzyFileSearch/sessionUpdated') {
        const params = isRecord(notification.params) ? notification.params as { files?: Array<{ path: string; score: number }>; query?: string } : null;
        fuzzySearchResults.value = Array.isArray(params?.files) ? params.files : [];
        fuzzySearchQuery.value = typeof params?.query === 'string' ? params.query : '';
        return;
      }

      if (notification.method === 'fuzzyFileSearch/sessionCompleted') {
        return;
      }

      if (notification.method === 'mcpServer/oauthLogin/completed') {
        const params = isRecord(notification.params) ? notification.params : null;
        const name = typeof params?.name === 'string' ? params.name : '';
        const success = params?.success === true;
        if (name && success) {
          void refreshMcpServers();
        }
        return;
      }
    }

  function handleServerRequest(request: CodexJsonRpcServerRequest) {
    const params = isRecord(request.params) ? request.params : null;

    if (request.method === 'account/chatgptAuthTokens/refresh') {
      adapter?.respondToServerRequest(request.id, { decline: {} });
      return;
    }

    if (request.method === 'tool/requestUserInput') {
      const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
      const turnId = typeof params?.turnId === 'string' ? params.turnId : '';
      const questions = Array.isArray(params?.questions) ? params.questions : [];
      if (threadId && turnId) {
        toolUserInputRequests.value = [
          ...toolUserInputRequests.value.filter((item) => item.requestId !== request.id),
          {
            requestId: request.id,
            questions: questions
              .filter((question): question is Record<string, unknown> => isRecord(question))
              .map((question) => ({
                id: typeof question.id === 'string' ? question.id : '',
                text: typeof question.text === 'string' ? question.text : '',
                isOther: typeof question.isOther === 'boolean' ? question.isOther : undefined,
              }))
              .filter((question) => question.id && question.text),
            threadId,
            turnId,
          },
        ];
      }
      return;
    }

    if (request.method === 'item/tool/call') {
      const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
      const turnId = typeof params?.turnId === 'string' ? params.turnId : '';
      const tool = isRecord(params?.tool) ? params.tool : null;
      const toolName = typeof tool?.name === 'string'
        ? tool.name
        : typeof params?.toolName === 'string' ? params.toolName : '';
      const args = isRecord(params?.arguments) ? params.arguments : {};
      if (threadId && turnId && toolName) {
        dynamicToolCalls.value = [
          ...dynamicToolCalls.value.filter((item) => item.requestId !== request.id),
          { requestId: request.id, toolName, arguments: args, threadId, turnId },
        ];
      }
      return;
    }

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
        context: scopedRequest.context,
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

    if (!homeDir.value) {
      try {
        const bridgeUrl = new URL(url.value);
        const httpUrl = `http://${bridgeUrl.host}/homedir`;
        const res = await fetch(httpUrl, { method: 'GET' });
        if (res.ok) {
          const data = await res.json() as { home?: string };
          if (data.home) homeDir.value = data.home;
        }
      } catch {
        homeDir.value = '';
      }
    }
    unsubscribeNotifications = adapter.onNotification(handleNotification);
    unsubscribeServerRequests = adapter.onServerRequest(handleServerRequest);

    try {
      await adapter.initialize();
      initialized.value = true;
      status.value = 'connected';
      await refreshThreads();
      await openAsSandbox('~');
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

  async function hydrateThread(threadId: string) {
    const read = await adapter?.readThread({ threadId, includeTurns: true });
    if (!read) return;
    upsertThread(read.thread);
    activeThreadId.value = read.thread.id;
    setTranscriptFromTurns(read.thread.turns ?? []);
  }

  async function startThread(cwd?: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    const params: { cwd?: string; model?: string } = {};
    if (cwd) params.cwd = cwd;
    if (selectedModel.value) params.model = selectedModel.value;
    const result = await adapter.startThread(params);
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

  async function forkThread(threadId: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    const result = await adapter.forkThread({ threadId });
    upsertThread(result.thread);
    activeThreadId.value = result.thread.id;
    transcript.value = [];
    activeTurn.value = null;
    pruneServerRequestsForActiveContext();
    await hydrateThread(result.thread.id);
    await refreshThreads();
    return result.thread;
  }

  async function rollbackThread(threadId: string, numTurns = 1) {
    if (!adapter) throw new Error('Codex is not connected.');
    const result = await adapter.rollbackThread({ threadId, numTurns });
    upsertThread(result.thread);
    await hydrateThread(result.thread.id);
    await refreshThreads();
    return result.thread;
  }

  function hideThread(threadId: string) {
    hiddenThreadIds.value = new Set([...hiddenThreadIds.value, threadId]);
    saveThreadIdSet(HIDE_STORAGE_KEY, hiddenThreadIds.value);
    if (activeThreadId.value === threadId) {
      activeThreadId.value = visibleThreads.value[0]?.id ?? '';
      transcript.value = [];
      activeTurn.value = null;
    }
  }

  function unhideThread(threadId: string) {
    const next = new Set(hiddenThreadIds.value);
    next.delete(threadId);
    hiddenThreadIds.value = next;
    saveThreadIdSet(HIDE_STORAGE_KEY, hiddenThreadIds.value);
  }

  function pinThread(threadId: string) {
    pinnedThreadIds.value = new Set([...pinnedThreadIds.value, threadId]);
    saveThreadIdSet(PIN_STORAGE_KEY, pinnedThreadIds.value);
  }

  function unpinThread(threadId: string) {
    const next = new Set(pinnedThreadIds.value);
    next.delete(threadId);
    pinnedThreadIds.value = next;
    saveThreadIdSet(PIN_STORAGE_KEY, pinnedThreadIds.value);
  }

  function expandPath(input: string): string {
    const trimmed = input.trim();
    if (trimmed === '~') return homeDir.value || '/';
    if (trimmed.startsWith('~/')) {
      const home = homeDir.value;
      if (home) return home + trimmed.slice(1);
    }
    return trimmed;
  }

  async function readDirectory(path: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    fsLoading.value = true;
    fsError.value = '';
    const resolved = expandPath(path);
    try {
      const result = await adapter.readDirectory({ path: resolved });
      fsEntries.value = result.entries;
      fsCwd.value = resolved;
    } catch (error) {
      fsError.value = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      fsLoading.value = false;
    }
  }

  async function navigateToParent() {
    if (!fsCwd.value || fsCwd.value === '/') return;
    const parent = fsCwd.value.split('/').slice(0, -1).join('/') || '/';
    await readDirectory(parent);
  }

  async function navigateToPath(path: string) {
    await readDirectory(path);
  }

  async function openAsSandbox(path: string) {
    if (!path || path.trim() === '') {
      fsError.value = 'Path cannot be empty';
      return;
    }
    const resolved = expandPath(path);
    sandboxPath.value = resolved;
    await readDirectory(resolved);
  }

  async function createThreadInSandbox() {
    const path = expandPath(sandboxPath.value || fsCwd.value || '');
    if (!path) throw new Error('No sandbox path selected.');
    await startThread(path);
  }

  function base64ToUtf8(base64: string): string {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function readFile(path: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    fsLoading.value = true;
    fsError.value = '';
    const resolved = expandPath(path);
    try {
      const result = await adapter.readFile({ path: resolved });
      previewFileContent.value = base64ToUtf8(result.dataBase64);
      previewFilePath.value = resolved;
    } catch (error) {
      fsError.value = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      fsLoading.value = false;
    }
  }

  function clearPreview() {
    previewFileContent.value = '';
    previewFilePath.value = '';
  }

  async function updatePathSuggestions(rawInput: string) {
    const input = rawInput.trim();
    if (!input || !adapter) {
      fsSuggestions.value = [];
      fsShowSuggestions.value = false;
      return;
    }
    const resolved = expandPath(input);
    try {
      const result = await adapter.readDirectory({ path: resolved });
      fsSuggestions.value = result.entries
        .filter((e) => e.isDirectory)
        .map((e) => (resolved.endsWith('/') ? `${resolved}${e.fileName}` : `${resolved}/${e.fileName}`));
      fsShowSuggestions.value = fsSuggestions.value.length > 0;
    } catch {
      const lastSlash = resolved.lastIndexOf('/');
      if (lastSlash > 0) {
        const parent = resolved.slice(0, lastSlash) || '/';
        const prefix = resolved.slice(lastSlash + 1).toLowerCase();
        try {
          const result = await adapter.readDirectory({ path: parent });
          fsSuggestions.value = result.entries
            .filter(
              (e) =>
                e.isDirectory &&
                e.fileName.toLowerCase().startsWith(prefix)
            )
            .map((e) =>
              parent === '/' ? `/${e.fileName}` : `${parent}/${e.fileName}`
            );
          fsShowSuggestions.value = fsSuggestions.value.length > 0;
        } catch {
          fsSuggestions.value = [];
          fsShowSuggestions.value = false;
        }
      } else if (lastSlash === 0) {
        const prefix = resolved.slice(1).toLowerCase();
        try {
          const result = await adapter.readDirectory({ path: '/' });
          fsSuggestions.value = result.entries
            .filter(
              (e) =>
                e.isDirectory &&
                e.fileName.toLowerCase().startsWith(prefix)
            )
            .map((e) => `/${e.fileName}`);
          fsShowSuggestions.value = fsSuggestions.value.length > 0;
        } catch {
          fsSuggestions.value = [];
          fsShowSuggestions.value = false;
        }
      } else {
        fsSuggestions.value = [];
        fsShowSuggestions.value = false;
      }
    }
  }

  function hidePathSuggestions() {
    fsShowSuggestions.value = false;
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
         ? { threadId: activeThreadId.value, text: prompt, model: selectedModel.value || undefined }
         : { text: prompt, model: selectedModel.value || undefined };
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

   // Review functions
   async function reviewThread(target: CodexReviewStartParams['target'], delivery: 'inline' | 'detached' = 'inline') {
     if (!adapter) throw new Error('Codex is not connected.');
     if (!activeThreadId.value) throw new Error('No active thread.');
     reviewState.value = 'idle';
     reviewResult.value = '';
     await adapter.reviewStart({
       threadId: activeThreadId.value,
       delivery,
       target,
     });
   }

   // Command execution functions
   async function executeCommand(argv: string[], options: { cwd?: string; sandboxPolicy?: unknown; timeoutMs?: number } = {}) {
     if (!adapter) throw new Error('Codex is not connected.');
     commandOutput.value = [];
     const result = await adapter.commandExec({
       command: argv,
       cwd: options.cwd,
       sandboxPolicy: options.sandboxPolicy,
       timeoutMs: options.timeoutMs,
       streamStdoutStderr: true,
     });
     if (result.stdout || result.stderr) {
       commandOutput.value.push({
         text: [result.stdout, result.stderr].filter(Boolean).join('\n'),
         time: Date.now(),
       });
     }
     return result;
   }

   // Account functions
   async function refreshAccount() {
     if (!adapter) return;
     try {
       const result = await adapter.readAccount({ refreshToken: false });
       account.value = result.account;
       accountAuthMode.value = result.account?.type ?? null;
     } catch {
       account.value = null;
     }
   }

   async function loginWithApiKey(apiKey: string) {
     if (!adapter) throw new Error('Codex is not connected.');
     loginPending.value = true;
     loginError.value = '';
     await adapter.startAccountLogin({ type: 'apiKey', apiKey });
   }

   async function loginWithChatgpt() {
     if (!adapter) throw new Error('Codex is not connected.');
     loginPending.value = true;
     loginError.value = '';
     deviceCodeInfo.value = null;
     const result = await adapter.startAccountLogin({ type: 'chatgpt' });
     if (result.authUrl) {
       window.open(result.authUrl, '_blank');
     }
   }

   async function loginWithDeviceCode() {
     if (!adapter) throw new Error('Codex is not connected.');
     loginPending.value = true;
     loginError.value = '';
     const result = await adapter.startAccountLogin({ type: 'chatgptDeviceCode' });
     if (result.verificationUrl && result.userCode) {
       deviceCodeInfo.value = {
         verificationUrl: result.verificationUrl,
         userCode: result.userCode,
       };
     }
   }

   async function cancelLogin(loginId: string) {
     if (!adapter) return;
     await adapter.cancelAccountLogin({ loginId });
     loginPending.value = false;
   }

   async function logoutAccount() {
     if (!adapter) return;
     await adapter.logoutAccount();
     account.value = null;
     accountAuthMode.value = null;
     accountPlanType.value = null;
     accountRateLimits.value = null;
   }

    async function refreshAccountRateLimits() {
      if (!adapter) return;
      try {
        const result = await adapter.readAccountRateLimits();
        accountRateLimits.value = result.rateLimits;
      } catch {
        accountRateLimits.value = null;
      }
    }

    async function fsWriteFile(path: string, content: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      const resolved = expandPath(path);
      await adapter.writeFile({ path: resolved, content });
    }

    async function fsCreateDirectory(path: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      const resolved = expandPath(path);
      await adapter.createDirectory({ path: resolved });
    }

    async function refreshModels(includeHidden = false) {
      if (!adapter) return;
      modelsLoading.value = true;
      try {
        const result = await adapter.listModels({ includeHidden });
        models.value = result.data;
        if (!selectedModel.value) {
          const defaultModel = result.data.find((m) => m.isDefault);
          if (defaultModel) {
            selectedModel.value = defaultModel.id;
          } else if (result.data[0]) {
            selectedModel.value = result.data[0].id;
          }
        }
      } catch {
        models.value = [];
      } finally {
        modelsLoading.value = false;
      }
    }

    function selectModel(modelId: string) {
      selectedModel.value = modelId;
    }

    async function refreshSkills() {
      if (!adapter) return;
      skillsLoading.value = true;
      try {
        const cwds = fsCwd.value ? [fsCwd.value] : [];
        const result = await adapter.listSkills({ cwds });
        skills.value = result.data.flatMap((entry) => entry.skills);
      } catch {
        skills.value = [];
      } finally {
        skillsLoading.value = false;
      }
    }

    async function toggleSkill(path: string, enabled: boolean) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.writeSkillConfig({ path, enabled });
      await refreshSkills();
    }

    async function refreshPlugins() {
      if (!adapter) return;
      pluginsLoading.value = true;
      try {
        const result = await adapter.listPlugins();
        plugins.value = result.marketplaces.flatMap((m) => m.plugins);
      } catch {
        plugins.value = [];
      } finally {
        pluginsLoading.value = false;
      }
    }

    async function installPlugin(marketplacePath: string, pluginName: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.installPlugin({ marketplacePath, pluginName });
      await refreshPlugins();
    }

    async function uninstallPlugin(marketplacePath: string, pluginName: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.uninstallPlugin({ marketplacePath, pluginName });
      await refreshPlugins();
    }

    async function addMarketplace(marketplace: { path?: string | null }) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.addMarketplace({ marketplace });
    }

    async function refreshMcpServers() {
      if (!adapter) return;
      mcpServersLoading.value = true;
      try {
        const result = await adapter.listMcpServerStatus({ detail: 'full' });
        mcpServers.value = result.data;
      } catch {
        mcpServers.value = [];
      } finally {
        mcpServersLoading.value = false;
      }
    }

    async function mcpOauthLogin(serverName: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.mcpServerOauthLogin({ serverName });
    }

    async function reloadMcpConfig() {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.reloadMcpServerConfig();
      await refreshMcpServers();
    }

    async function readMcpResource(serverName: string, uri: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.readMcpResource({ serverName, uri });
    }

    async function callMcpTool(threadId: string, serverName: string, tool: string, args?: Record<string, unknown>) {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.callMcpTool({ threadId, serverName, tool, arguments: args });
    }

    async function refreshConfig() {
      if (!adapter) return;
      configLoading.value = true;
      try {
        const result = await adapter.readConfig({ includeLayers: true });
        config.value = result;
      } catch {
        config.value = null;
      } finally {
        configLoading.value = false;
      }
    }

    async function refreshApps(params: CodexAppListParams = {}) {
      if (!adapter) throw new Error('Codex is not connected.');
      appsLoading.value = true;
      try {
        const result: CodexAppListResult = await adapter.listApps(params);
        apps.value = result.data;
        return result;
      } finally {
        appsLoading.value = false;
      }
    }

    async function writeConfigValue(keyPath: string, value: unknown, mergeStrategy?: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      const params: CodexConfigValueWriteParams = {
        keyPath,
        value,
        mergeStrategy: mergeStrategy as CodexConfigValueWriteParams['mergeStrategy'],
      };
      await adapter.writeConfigValue(params);
      await refreshConfig();
    }

    async function batchWriteConfig(edits: Array<{ keyPath: string; value: unknown; mergeStrategy?: string }>) {
      if (!adapter) throw new Error('Codex is not connected.');
      const params: CodexConfigBatchWriteParams = {
        edits: edits.map((edit) => ({
          keyPath: edit.keyPath,
          value: edit.value,
          mergeStrategy: edit.mergeStrategy as CodexConfigBatchWriteParams['edits'][number]['mergeStrategy'],
        })),
      };
      await adapter.batchWriteConfig(params);
      await refreshConfig();
    }

    async function refreshConfigRequirements() {
      if (!adapter) throw new Error('Codex is not connected.');
      configRequirementsLoading.value = true;
      try {
        const result: CodexConfigRequirementsReadResult = await adapter.readConfigRequirements();
        configRequirements.value = result.requirements;
        return result;
      } finally {
        configRequirementsLoading.value = false;
      }
    }

    async function detectExternalAgentConfig(includeHome?: boolean, cwds?: string[]) {
      if (!adapter) throw new Error('Codex is not connected.');
      externalAgentConfigLoading.value = true;
      try {
        const result: CodexExternalAgentConfigDetectResult = await adapter.detectExternalAgentConfig({ includeHome, cwds });
        externalAgentConfigItems.value = result.items;
        return result;
      } finally {
        externalAgentConfigLoading.value = false;
      }
    }

    async function importExternalAgentConfig(items: CodexExternalAgentConfigItem[]) {
      if (!adapter) throw new Error('Codex is not connected.');
      externalAgentImportStatus.value = null;
      const params: CodexExternalAgentConfigImportParams = {
        migrationItems: items.map((item) => ({
          itemType: item.itemType,
          description: item.description,
          cwd: item.cwd,
        })),
      };
      try {
        const result = await adapter.importExternalAgentConfig(params);
        externalAgentImportStatus.value = { success: true };
        return result;
      } catch (error) {
        externalAgentImportStatus.value = { success: false, error: error instanceof Error ? error.message : String(error) };
        throw error;
      }
    }

    async function refreshExperimentalFeatures() {
      if (!adapter) throw new Error('Codex is not connected.');
      experimentalFeaturesLoading.value = true;
      try {
        const result: CodexExperimentalFeatureListResult = await adapter.listExperimentalFeatures();
        experimentalFeatures.value = result.data;
        return result;
      } finally {
        experimentalFeaturesLoading.value = false;
      }
    }

    async function setExperimentalFeatureEnablement(name: string, enabled: boolean) {
      if (!adapter) throw new Error('Codex is not connected.');
      const result = await adapter.setExperimentalFeatureEnablement({ name, enabled });
      await refreshExperimentalFeatures();
      return result;
    }

    async function refreshCollaborationModes() {
      if (!adapter) throw new Error('Codex is not connected.');
      collaborationModesLoading.value = true;
      try {
        const result: CodexCollaborationModeListResult = await adapter.listCollaborationModes();
        collaborationModes.value = result.data;
        return result;
      } finally {
        collaborationModesLoading.value = false;
      }
    }

    async function startWindowsSandboxSetup(mode: 'elevated' | 'unelevated') {
      if (!adapter) throw new Error('Codex is not connected.');
      windowsSandboxStatus.value = null;
      const result: CodexWindowsSandboxSetupStartResult = await adapter.startWindowsSandboxSetup({ mode });
      windowsSandboxStatus.value = { mode, success: result.started, error: null };
      return result;
    }

    async function uploadFeedback(params: CodexFeedbackUploadParams) {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.uploadFeedback(params);
    }

    async function resizeCommandExec(processId: string, rows: number, cols: number) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.resizeCommandExec({ processId, size: { rows, cols } });
    }

    async function cleanThreadBackgroundTerminals(threadId: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.cleanThreadBackgroundTerminals({ threadId });
    }

    async function respondToToolUserInput(requestId: CodexJsonRpcId, responses: Array<{ questionId: string; response: string }>) {
      if (!adapter) throw new Error('Codex is not connected.');
      adapter.respondToServerRequest(requestId, { responses });
      toolUserInputRequests.value = toolUserInputRequests.value.filter((request) => request.requestId !== requestId);
    }

    async function respondToDynamicToolCall(requestId: CodexJsonRpcId, contentItems: unknown[]) {
      if (!adapter) throw new Error('Codex is not connected.');
      adapter.respondToServerRequest(requestId, { contentItems });
      dynamicToolCalls.value = dynamicToolCalls.value.filter((request) => request.requestId !== requestId);
    }

    async function steerTurn(expectedTurnId: string, text: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      if (!activeThreadId.value) throw new Error('No active thread.');
      await adapter.steerTurn({
        threadId: activeThreadId.value,
        input: [{ type: 'text', text }],
        expectedTurnId,
      });
    }

    async function updateThreadMetadata(threadId: string, gitInfo: { branch?: string; sha?: string; originUrl?: string } | null) {
      if (!adapter) throw new Error('Codex is not connected.');
      const result = await adapter.updateThreadMetadata({ threadId, gitInfo });
      upsertThread(result.thread);
    }

    async function startThreadCompaction(threadId: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.startThreadCompaction({ threadId });
    }

    async function runThreadShellCommand(threadId: string, command: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.runThreadShellCommand({ threadId, command });
    }

    async function injectThreadItems(threadId: string, items: unknown[]) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.injectThreadItems({ threadId, items });
    }

    async function refreshLoadedThreads() {
      if (!adapter) return;
      const result = await adapter.listLoadedThreads();
      loadedThreadIds.value = result.data;
    }

    async function refreshThreadTurns(threadId: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.listThreadTurns({ threadId });
    }

    async function readPlugin(pluginName: string, marketplacePath?: string, remoteMarketplaceName?: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.readPlugin({ pluginName, marketplacePath, remoteMarketplaceName });
    }

    async function sendAddCreditsNudge(creditType: 'credits' | 'usage_limit' = 'credits') {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.sendAddCreditsNudge({ creditType });
    }

    async function requestToolUserInput(params: CodexToolRequestUserInputParams) {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.requestUserInput(params);
    }

    async function fsRemove(path: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      const resolved = expandPath(path);
      await adapter.removeFile({ path: resolved });
    }

    async function fsWatch(watchId: string, path: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      const resolved = expandPath(path);
      await adapter.watchFile({ watchId, path: resolved });
      activeWatches.value = new Set([...activeWatches.value, watchId]);
    }

    async function fsUnwatch(watchId: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.unwatchFile({ watchId });
      const next = new Set(activeWatches.value);
      next.delete(watchId);
      activeWatches.value = next;
    }

    async function fsGetMetadata(path: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      const resolved = expandPath(path);
      return adapter.getFileMetadata({ path: resolved });
    }

    async function fsCopy(source: string, destination: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      const resolvedSource = expandPath(source);
      const resolvedDest = expandPath(destination);
      await adapter.copyFile({ sourcePath: resolvedSource, destinationPath: resolvedDest });
    }

    async function writeCommandExec(processId: string, deltaBase64?: string, closeStdin?: boolean) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.writeCommandExec({ processId, deltaBase64, closeStdin });
    }

    async function terminateCommandExec(processId: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.terminateCommandExec({ processId });
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
     visibleThreads,
     pinnedThreadIds,
     hiddenThreadIds,
      fsEntries,
      fsCwd,
      fsLoading,
      fsError,
      previewFileContent,
      previewFilePath,
      sandboxPath,
      fsBreadcrumbs,
      fsSuggestions,
      fsShowSuggestions,
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
     forkThread,
     rollbackThread,
     hideThread,
     unhideThread,
     pinThread,
     unpinThread,
     readDirectory,
     navigateToParent,
     navigateToPath,
     openAsSandbox,
     createThreadInSandbox,
      readFile,
      clearPreview,
      updatePathSuggestions,
      hidePathSuggestions,
      resolveServerRequest,
     sendPrompt,
     // New review state
     reviewState,
     reviewResult,
     commandOutput,
     // New account state
     account,
     accountAuthMode,
     accountPlanType,
     accountRateLimits,
     loginPending,
     loginError,
     deviceCodeInfo,
     // New methods
     reviewThread,
     executeCommand,
     refreshAccount,
     loginWithApiKey,
     loginWithChatgpt,
     loginWithDeviceCode,
     cancelLogin,
     logoutAccount,
      refreshAccountRateLimits,
      // New namespace state
       models,
       modelsLoading,
       selectedModel,
       skills,
       skillsLoading,
      plugins,
      pluginsLoading,
      mcpServers,
       mcpServersLoading,
       config,
       configLoading,
       apps,
       appsLoading,
       experimentalFeatures,
       experimentalFeaturesLoading,
       collaborationModes,
       collaborationModesLoading,
       configRequirements,
       configRequirementsLoading,
       externalAgentConfigItems,
       externalAgentConfigLoading,
       externalAgentImportStatus,
       windowsSandboxStatus,
       fuzzySearchResults,
       fuzzySearchQuery,
       toolUserInputRequests,
       dynamicToolCalls,
       // New namespace methods
       fsWriteFile,
       fsCreateDirectory,
        refreshModels,
       selectModel,
       refreshSkills,
      toggleSkill,
      refreshPlugins,
      installPlugin,
      uninstallPlugin,
      addMarketplace,
      refreshMcpServers,
      mcpOauthLogin,
      reloadMcpConfig,
       readMcpResource,
       callMcpTool,
        refreshConfig,
        refreshApps,
        writeConfigValue,
        batchWriteConfig,
        refreshConfigRequirements,
        detectExternalAgentConfig,
        importExternalAgentConfig,
        refreshExperimentalFeatures,
        setExperimentalFeatureEnablement,
        refreshCollaborationModes,
        startWindowsSandboxSetup,
        uploadFeedback,
        resizeCommandExec,
        cleanThreadBackgroundTerminals,
        respondToToolUserInput,
        respondToDynamicToolCall,
        // New high/medium priority state
        planItems,
       diffState,
       tokenUsage,
       reasoningStreams,
       fileChangeOutputs,
       activeWatches,
       loadedThreadIds,
       steerInput,
       showSteerInput,
       shellCommandInput,
       showShellCommand,
       commandProcessId,
       // New high/medium priority methods
       steerTurn,
       updateThreadMetadata,
       startThreadCompaction,
       runThreadShellCommand,
       injectThreadItems,
        refreshLoadedThreads,
        refreshThreadTurns,
        readPlugin,
        sendAddCreditsNudge,
        requestToolUserInput,
        fsRemove,
       fsWatch,
       fsUnwatch,
       fsGetMetadata,
       fsCopy,
       writeCommandExec,
       terminateCommandExec,
     };
   }
