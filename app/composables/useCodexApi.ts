import { computed, ref, watch } from 'vue';
import {
  CodexAdapter,
  normalizeCodexMcpServerInfo,
  type CodexAccount,
  type CodexAccountRateLimitBucket,
  type CodexAccountUsageResult,
  type CodexAdapterOptions,
  type CodexApp,
  type CodexAppListParams,
  type CodexAppListResult,
  type CodexCollaborationMode,
  type CodexCollaborationModeListResult,
  type CodexCollaborationModePayload,
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
  type CodexFsReadFileResult,
  type CodexModel,
  type CodexModelProviderCapabilitiesResult,
  type CodexMcpServerInfo,
  type CodexPlugin,
  type CodexPermissionProfile,
    type CodexPromptInput,
    type CodexReviewStartParams,
    type CodexSkill,
    type CodexThread,
    type CodexThreadGoal,
    type CodexThreadGoalSetParams,
    type CodexThreadListResult,
    type CodexThreadListParams,
  type CodexThreadReadResult,
  type CodexTurn,
  type CodexWindowsSandboxSetupStartResult,
} from '../backends/codex/codexAdapter';
import { appendCodexBridgeToken, codexBridgeHttpUrl } from '../backends/codex/bridgeUrl';
import { createCodexCapabilityRegistry } from '../backends/codex/capabilityRegistry';
import type {
  CodexJsonRpcId,
  CodexJsonRpcNotification,
  CodexJsonRpcServerRequest,
} from '../backends/codex/jsonRpcClient';
import {
  buildCodexPermissionResponse,
  buildMcpElicitationResponse,
  parseCodexPermissionRequest,
  parseMcpElicitationRequest,
  type CodexPermissionReply,
  type CodexPermissionRequest,
  type McpElicitationAction,
  type McpElicitationRequest,
} from '../backends/codex/serverRequests';
import {
  buildDynamicToolCallResponse,
  buildToolUserInputResponse,
  parseDynamicToolCallRequest,
  parseToolUserInputRequest,
  type CodexDynamicToolCallRequest,
  type CodexDynamicToolOutput,
  type CodexToolUserInputRequest,
} from '../backends/codex/toolServerRequests';
import {
  codexAssistantMessageId,
  codexAssistantTextPartId,
  codexUserMessageId,
  normalizeCodexTurnItems,
  normalizeCodexTurnsToHistory,
  type CodexCanonicalHistoryEntry,
} from '../backends/codex/normalize';
import {
  clearCodexAuxiliaryHistory,
  loadCodexAuxiliaryHistory,
  mergeCodexAuxiliaryHistory,
  saveCodexAuxiliaryHistory,
} from '../backends/codex/auxiliaryHistory';
import type { ConfigMergeStrategy } from '../backends/types';
import { getPersistedCodexBridgeToken, getPersistedCodexBridgeUrl } from '../backends/registry';
import type { FilePart, MessageInfo, MessagePart, ReasoningPart, TextPart, ToolPart } from '../types/sse';
import { normalizeAbsolutePathNoParent } from '../utils/path';
import { StorageKeys, storageGet, storageSet } from '../utils/storageKeys';

/**
 * Read the persisted Codex active thread id from storage so the previously
 * selected thread can be restored on refresh. Returns empty string when no
 * value is stored or the storage backend is unavailable.
 */
function loadPersistedActiveThread(): string {
  const persisted = storageGet(StorageKeys.state.codexActiveThread);
  return typeof persisted === 'string' ? persisted : '';
}

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
  modelName?: string;
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

export type CodexConnectPhase = 'home' | 'handshake' | 'threads' | 'workspace' | 'panelData';

type CodexRealtimePartRecord<TPart extends MessagePart = MessagePart> = {
  info: MessageInfo;
  part: TPart;
  updatedAt: number;
};

function fileResultToDataUrl(path: string, result: CodexFsReadFileResult): string | undefined {
  const base64 = typeof result.dataBase64 === 'string'
    ? result.dataBase64
    : (typeof result.content === 'string' && result.encoding === 'base64' ? result.content : undefined);
  if (!base64) return undefined;
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const mime = extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : 'image/*';
  return `data:${mime};base64,${base64}`;
}

/**
 * Monotonic timestamp protection for Codex session metadata.
 * Prevents stale bridge data from regressing `createdAt`/`updatedAt` to older
 * values, which would otherwise cause previous sessions to "follow" the
 * latest session's time on refresh.
 */
function monotonicTimestamps(
  existing: Pick<CodexThread, 'createdAt' | 'updatedAt'> | undefined,
  incoming: Pick<CodexThread, 'createdAt' | 'updatedAt'> | undefined,
): { createdAt: number | undefined; updatedAt: number | undefined } {
  const pickGreater = (
    a: number | undefined,
    b: number | undefined,
  ): number | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
  };
  return {
    createdAt: pickGreater(existing?.createdAt, incoming?.createdAt),
    updatedAt: pickGreater(existing?.updatedAt, incoming?.updatedAt),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function isTextPart(part: MessagePart): part is TextPart {
  return part.type === 'text';
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

export type CodexPluginWithMarketplace = CodexPlugin & {
  marketplaceName: string;
  marketplacePath?: string;
};

export function useCodexApi(initialOptions: CodexApiOptions = {}) {
  const status = ref<CodexConnectionStatus>('idle');
  const reconnectOnMount = ref(storageGet(StorageKeys.state.codexPanelConnected) === '1');
  const url = ref(initialOptions.url ?? getPersistedCodexBridgeUrl());
  const bridgeToken = ref(initialOptions.bridgeToken ?? getPersistedCodexBridgeToken());
  const errorMessage = ref('');
  const threads = ref<CodexThread[]>([]);
  const activeThreadId = ref(loadPersistedActiveThread());
  watch(activeThreadId, (newId, oldId) => {
    if (newId && newId !== oldId) {
      storageSet(StorageKeys.state.codexActiveThread, newId);
    }
  });
  const activeTurn = ref<CodexTurn | null>(null);
  const transcript = ref<CodexTranscriptEntry[]>([]);
  const canonicalHistory = ref<CodexCanonicalHistoryEntry[]>([]);
  const events = ref<CodexEventEntry[]>([]);
  const serverRequests = ref<CodexServerRequestEntry[]>([]);
  const permissionRequests = ref<CodexPermissionRequest[]>([]);
  const elicitationRequests = ref<McpElicitationRequest[]>([]);
  const pending = ref(false);
  const loadingThread = ref(false);
  const initialized = ref(false);
  const hiddenThreadIds = ref<Set<string>>(new Set());
  const fsEntries = ref<CodexFsDirectoryEntry[]>([]);
  const fsCwd = ref('');
  const fsLoading = ref(false);
  const fsError = ref('');
  const previewFileContent = ref('');
  const previewFilePath = ref('');
  const sandboxPath = ref('');
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
	   const accountUsage = ref<CodexAccountUsageResult | null>(null);
	   const accountUsageLoading = ref(false);
   const loginPending = ref(false);
   const loginError = ref('');
   const deviceCodeInfo = ref<{ verificationUrl: string; userCode: string } | null>(null);

	    const models = ref<CodexModel[]>([]);
	    const modelsLoading = ref(false);
	    const modelProviderCapabilities = ref<CodexModelProviderCapabilitiesResult | null>(null);
	    const modelProviderCapabilitiesLoading = ref(false);
	    const permissionProfiles = ref<CodexPermissionProfile[]>([]);
	    const permissionProfilesLoading = ref(false);
	    const threadGoal = ref<CodexThreadGoal | null>(null);
	    const threadGoalThreadId = ref<string | null>(null);
	    const threadGoalLoading = ref(false);
    const selectedModel = ref<string>('');
   const skills = ref<CodexSkill[]>([]);
   const skillsLoading = ref(false);
    const plugins = ref<CodexPluginWithMarketplace[]>([]);
    const pluginMarketplaceCount = ref(0);
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
    const toolUserInputRequests = ref<CodexToolUserInputRequest[]>([]);
    const dynamicToolCalls = ref<CodexDynamicToolCallRequest[]>([]);
    const realtimeHistoryQueue = ref<CodexCanonicalHistoryEntry[]>([]);
    const realtimeMessageAliases = ref<Record<string, string>>({});
    const realtimeStreamingPart = ref<CodexRealtimePartRecord<TextPart> | null>(null);
    const realtimeReasoningPart = ref<CodexRealtimePartRecord<ReasoningPart> | null>(null);
    const realtimeToolParts = ref<Array<CodexRealtimePartRecord<ToolPart>>>([]);

    watch(realtimeHistoryQueue, (entries) => {
      const threadIds = new Set(entries.map((entry) => entry.info.sessionID));
      for (const threadId of threadIds) saveCodexAuxiliaryHistory(threadId, entries);
    }, { flush: 'sync' });

    // New state for high/medium priority APIs
	    const planItems = ref<Array<{ threadId: string; turnId: string; explanation?: string; plan: Array<{ step: string; status: string }> }>>([]);
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
    const capabilityRegistry = createCodexCapabilityRegistry();

    let adapter: CodexAdapter | null = null;
  let unsubscribeNotifications: (() => void) | null = null;
  let unsubscribeServerRequests: (() => void) | null = null;
  let nextEventId = 1;
  let nextTranscriptId = 1;
	  let threadSelectionGeneration = 0;
	  let accountRefreshGeneration = 0;
	  let threadGoalRefreshGeneration = 0;
	  let pluginsRefreshGeneration = 0;
	  let connectionGeneration = 0;
	  type ConnectionRequest = { sourceAdapter: CodexAdapter; generation: number };
	  const observedTurnIdsByThread = new Map<string, string[]>();
	  const invalidatedTurnIdsByThread = new Map<string, Set<string>>();

	  function recordObservedTurnId(threadId: string, turnId: string) {
	    if (!threadId || !turnId) return;
	    const ids = observedTurnIdsByThread.get(threadId) ?? [];
	    if (!ids.includes(turnId)) observedTurnIdsByThread.set(threadId, [...ids, turnId]);
	  }

	  function invalidateRecentTurnIds(threadId: string, count: number) {
	    const ids = observedTurnIdsByThread.get(threadId) ?? [];
	    const removed = ids.splice(Math.max(0, ids.length - Math.max(0, Math.floor(count))));
	    observedTurnIdsByThread.set(threadId, ids);
	    const invalidated = invalidatedTurnIdsByThread.get(threadId) ?? new Set<string>();
	    removed.forEach((turnId) => invalidated.add(turnId));
	    invalidatedTurnIdsByThread.set(threadId, invalidated);
	  }

	  function isInvalidatedTurnId(threadId: string, turnId: string) {
	    return invalidatedTurnIdsByThread.get(threadId)?.has(turnId) ?? false;
	  }
	  function captureConnection(): ConnectionRequest | null {
	    const sourceAdapter = adapter;
	    return sourceAdapter ? { sourceAdapter, generation: connectionGeneration } : null;
	  }

	  function isCurrentConnection(request: ConnectionRequest) {
	    return adapter === request.sourceAdapter && connectionGeneration === request.generation;
	  }

  const connected = computed(() => status.value === 'connected' && initialized.value);

  const visibleThreads = computed(() => {
    const list = threads.value.filter((thread) => !hiddenThreadIds.value.has(thread.id));
    return list.sort((a, b) => {
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
      url: appendCodexBridgeToken(url.value.trim(), bridgeToken.value.trim() || undefined),
      experimentalApi: true,
    });
  }

  function upsertThread(thread: CodexThread, refreshGitInfo = true) {
    const existing = threads.value.find((item) => item.id === thread.id);
    const monotonic = monotonicTimestamps(existing, thread);
    const normalizedThread = normalizeThreadCwd({
      ...existing,
      ...thread,
      cwd: thread.cwd ?? existing?.cwd,
      gitInfo: thread.gitInfo ?? existing?.gitInfo,
      createdAt: monotonic.createdAt,
      updatedAt: monotonic.updatedAt,
    });
    const index = threads.value.findIndex((item) => item.id === thread.id);
    if (index === -1) threads.value = [normalizedThread, ...threads.value];
    else threads.value[index] = { ...threads.value[index], ...normalizedThread };
    if (!activeThreadId.value) activeThreadId.value = normalizedThread.id;
    if (refreshGitInfo && !normalizedThread.gitInfo?.root) void upsertThreadWithGitInfo(normalizedThread);
  }

  function pushTranscript(role: CodexTranscriptEntry['role'], text: string, modelName?: string) {
    if (!text) return;
    transcript.value.push({
      id: nextTranscriptId,
      role,
      text,
      time: Date.now(),
      ...(modelName ? { modelName } : {}),
    });
    nextTranscriptId += 1;
  }

  function createTranscriptEntry(role: CodexTranscriptEntry['role'], text: string, modelName?: string) {
    const entry = {
      id: nextTranscriptId,
      role,
      text,
      time: Date.now(),
      ...(modelName ? { modelName } : {}),
    } satisfies CodexTranscriptEntry;
    nextTranscriptId += 1;
    return entry;
  }

  function setTranscriptFromTurns(turns: CodexTurn[] = []) {
    const activeThread = threads.value.find((thread) => thread.id === activeThreadId.value);
	  for (const turn of turns) recordObservedTurnId(activeThreadId.value, turn.id);
    const selectedModelInfo = parseSelectedCodexModel(selectedModel.value);
    const modelName = selectedModelInfo.modelID || selectedModelInfo.providerID;
    canonicalHistory.value = normalizeCodexTurnsToHistory({
      sessionId: activeThreadId.value ?? 'codex-thread',
      turns,
      model: {
        providerID: activeThread?.modelProvider || selectedModelInfo.providerID,
        modelID: selectedModelInfo.modelID || undefined,
      },
    });
    const textEntries = canonicalHistory.value.flatMap((entry) => {
      const role = entry.info.role === 'assistant' ? 'assistant' : 'user';
      return entry.parts
        .filter((part): part is TextPart => isTextPart(part) && Boolean(part.text))
        .map((part) => createTranscriptEntry(role, part.text, modelName));
    });
    const systemEntries = turns.flatMap((turn) => {
      const items = Array.isArray(turn.items) ? turn.items : [];
      return items
        .flatMap((item) => extractItemTranscriptEntries(item, (role, text) => createTranscriptEntry(role, text, modelName)))
        .filter((entry) => entry.role === 'system');
    });
    transcript.value = [...textEntries, ...systemEntries];
  }

  function appendAssistantDelta(text: string) {
    if (!text) return;
    const last = transcript.value.at(-1);
    if (last?.role === 'assistant') {
      transcript.value[transcript.value.length - 1] = {
        ...last,
        text: `${last.text}${text}`,
        modelName: last.modelName ?? currentSelectedModelName(),
      };
      return;
    }
    pushTranscript('assistant', text, currentSelectedModelName());
  }

  function parseSelectedCodexModel(value: string | undefined) {
    const normalized = value?.trim() ?? '';
    if (!normalized) return { providerID: 'codex', modelID: '' };
    const slashIndex = normalized.indexOf('/');
    if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
      return { providerID: 'codex', modelID: normalized };
    }
    const providerID = normalized.slice(0, slashIndex).trim() || 'codex';
    const modelID = normalized.slice(slashIndex + 1).trim() || normalized;
    return { providerID, modelID };
  }

  function currentSelectedModelName(): string {
    const info = parseSelectedCodexModel(selectedModel.value);
    return info.modelID || info.providerID;
  }

  function createCodexAssistantInfo(sessionId: string, messageId: string, createdAt: number, parentId = ''): MessageInfo {
    const model = parseSelectedCodexModel(selectedModel.value);
    return {
      id: messageId,
      sessionID: sessionId,
      role: 'assistant',
      time: { created: createdAt },
      parentID: parentId,
      modelID: model.modelID || 'codex',
      providerID: model.providerID,
      mode: 'codex',
      agent: 'codex',
      path: { cwd: '', root: '' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };
  }

  function currentRealtimeParentId(sessionId?: string) {
    const targetSessionId = sessionId?.trim() || activeThreadId.value || '';
    const queueParent = [...realtimeHistoryQueue.value]
      .reverse()
      .find((entry) => {
        if (entry.info.role !== 'user') return false;
        if (!targetSessionId) return true;
        return entry.info.sessionID === targetSessionId || entry.info.sessionID === 'codex-pending';
      })?.info.id;
    if (queueParent) return queueParent;
    const aliases = realtimeMessageAliases.value;
    return Object.values(aliases).at(-1) || '';
  }

  function buildRealtimeUserParts(
    sessionId: string,
    messageId: string,
    prompt: string,
    inputItems: CodexPromptInput['input'] | undefined,
    createdAt: number,
  ): MessagePart[] {
    const parts: MessagePart[] = [];
    if (prompt) {
      parts.push({
        id: `${messageId}:text`,
        sessionID: sessionId,
        messageID: messageId,
        type: 'text',
        text: prompt,
        time: { start: createdAt, end: createdAt },
      } satisfies TextPart);
    }
    inputItems?.forEach((item, index) => {
      if (item.type === 'image') {
        const mimeMatch = item.url.match(/^data:([^;,]+)/u);
        const mime = mimeMatch?.[1] || 'image/*';
        const extension = mime.split('/')[1]?.split('+')[0] || 'img';
        parts.push({
          id: `${messageId}:file:${index}`,
          sessionID: sessionId,
          messageID: messageId,
          type: 'file',
          mime,
          filename: `image-${index + 1}.${extension}`,
          url: item.url,
        } satisfies FilePart);
        return;
      }
      if (item.type === 'localImage') {
        const filename = item.path.split(/[\\/]/u).filter(Boolean).pop() || `image-${index + 1}`;
        const extension = filename.split('.').pop()?.toLowerCase() || '';
        parts.push({
          id: `${messageId}:file:${index}`,
          sessionID: sessionId,
          messageID: messageId,
          type: 'file',
          mime: extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : 'image/*',
          filename,
          url: item.path,
        } satisfies FilePart);
      }
    });
    return parts;
  }

  function setRealtimeAssistantCompleted(completedAt = Date.now()) {
    if (!realtimeStreamingPart.value) return;
    const current = realtimeStreamingPart.value;
    realtimeStreamingPart.value = {
      ...current,
      part: {
        ...current.part,
        time: { start: current.part.time?.start ?? current.info.time.created, end: completedAt },
      },
      updatedAt: completedAt,
    };
  }

  function setRealtimeReasoningCompleted(completedAt = Date.now()) {
    if (!realtimeReasoningPart.value) return;
    const current = realtimeReasoningPart.value;
    realtimeReasoningPart.value = {
      ...current,
      part: {
        ...current.part,
        time: { start: current.part.time.start, end: completedAt },
      },
      updatedAt: completedAt,
    };
  }

  function upsertRealtimeToolPart(record: CodexRealtimePartRecord<ToolPart>) {
    const index = realtimeToolParts.value.findIndex((entry) => entry.part.id === record.part.id);
    if (index === -1) {
      realtimeToolParts.value = [...realtimeToolParts.value, record];
      return;
    }
    const next = [...realtimeToolParts.value];
    next[index] = record;
    realtimeToolParts.value = next;
  }

  function updateRealtimeToolOutput(partId: string, appendText: string) {
    if (!appendText) return;
    const index = realtimeToolParts.value.findIndex((entry) => entry.part.id === partId);
    if (index === -1) return;
    const current = realtimeToolParts.value[index];
    if (!current) return;
    const state = current.part.state;
    if (state.status !== 'running') return;
    const next = [...realtimeToolParts.value];
    next[index] = {
      ...current,
      part: {
        ...current.part,
        state: {
          ...state,
          metadata: {
            ...state.metadata,
            output: `${typeof state.metadata?.output === 'string' ? state.metadata.output : ''}${appendText}`,
          },
        },
      },
      updatedAt: Date.now(),
    };
    realtimeToolParts.value = next;
  }

  function completeRealtimeToolPart(partId: string, finalizedPart?: ToolPart | null, finalOutput = '') {
    const index = realtimeToolParts.value.findIndex((entry) => entry.part.id === partId);
    if (index === -1) return null;
    const current = realtimeToolParts.value[index];
    if (!current) return null;
    const completedAt = Date.now();
    const state = current.part.state;
    const finalizedState = finalizedPart?.state;
    const runningMetadata = state.status === 'running' ? (state.metadata || {}) : {};
    const codexStatus = typeof runningMetadata.codexStatus === 'string' ? runningMetadata.codexStatus : '';
    const toolStatus = finalizedState?.status === 'error'
      ? 'error'
      : current.part.state.status === 'error'
      ? 'error'
      : (current.part.state.status === 'running' && codexStatus === 'declined')
        ? 'error'
      : (current.part.state.status === 'running' && codexStatus === 'failed')
          ? 'error'
          : 'completed';
    const currentOutput = state.status === 'completed'
      ? state.output
      : (state.status === 'running' && typeof state.metadata?.output === 'string' ? state.metadata.output : '');
    const finalizedOutput = finalizedState?.status === 'completed' ? finalizedState.output : '';
    const output = finalOutput
      ? `${currentOutput}${finalOutput}`
      : finalizedOutput || currentOutput;
    const title = finalizedState?.status === 'completed'
      ? finalizedState.title
      : state.status === 'completed'
        ? state.title
        : (state.status === 'running' ? (state.title || current.part.tool) : current.part.tool);
    const metadata = finalizedState?.status === 'completed' || finalizedState?.status === 'error'
      ? finalizedState.metadata
      : state.status === 'completed'
        ? state.metadata
        : (state.status === 'running' ? (state.metadata || { source: 'codex' }) : { source: 'codex' });
    const safeMetadata = metadata || { source: 'codex' };
    const input = finalizedState?.status === 'completed' || finalizedState?.status === 'error'
      ? finalizedState.input
      : state.input;
    const start = state.status === 'running' || state.status === 'completed' || state.status === 'error'
      ? state.time.start
      : current.info.time.created;
    const completedPart: ToolPart = toolStatus === 'error'
      ? {
        ...current.part,
        ...(finalizedPart ? { ...finalizedPart, id: current.part.id, callID: current.part.callID } : {}),
        state: {
          status: 'error',
          input,
          error: finalizedState?.status === 'error'
            ? finalizedState.error
            : output || codexStatus || 'Codex tool failed',
          metadata: safeMetadata,
          time: {
            start,
            end: completedAt,
          },
        },
      }
      : {
        ...current.part,
        ...(finalizedPart ? { ...finalizedPart, id: current.part.id, callID: current.part.callID } : {}),
        state: {
          status: 'completed',
          input,
          output,
          title,
          metadata: safeMetadata,
          time: {
            start,
            end: completedAt,
          },
        },
      };
    realtimeToolParts.value = realtimeToolParts.value.filter((_, entryIndex) => entryIndex !== index);
    const info = current.info.role === 'assistant'
      ? {
        ...current.info,
        time: { ...current.info.time, completed: current.info.time.completed ?? completedAt },
      }
      : current.info;
    return {
      info,
      part: completedPart,
      updatedAt: completedAt,
    } satisfies CodexRealtimePartRecord<ToolPart>;
  }

  function dedupeRealtimeHistoryQueue(entries: CodexCanonicalHistoryEntry[]) {
    const latestById = new Map<string, CodexCanonicalHistoryEntry>();
    for (const entry of entries) {
      latestById.set(entry.info.id, entry);
    }
    return Array.from(latestById.values());
  }

  function mergeRealtimeHistoryEntry(entry: CodexCanonicalHistoryEntry) {
    const existingIndex = realtimeHistoryQueue.value.findIndex((current) => current.info.id === entry.info.id);
    if (existingIndex === -1) {
      realtimeHistoryQueue.value = dedupeRealtimeHistoryQueue([
        ...realtimeHistoryQueue.value,
        entry,
      ]);
      return;
    }
    const existing = realtimeHistoryQueue.value[existingIndex];
    if (!existing) return;
    const partsById = new Map(existing.parts.map((part) => [part.id, part]));
    entry.parts.forEach((part) => {
      partsById.set(part.id, part);
    });
    const nextQueue = [...realtimeHistoryQueue.value];
    nextQueue[existingIndex] = {
      info: entry.info,
      parts: Array.from(partsById.values()),
    };
    realtimeHistoryQueue.value = dedupeRealtimeHistoryQueue(nextQueue);
  }

  function mergeRealtimeHistoryBundle(bundle: { messages: MessageInfo[]; parts: MessagePart[] }) {
    for (const info of bundle.messages) {
      mergeRealtimeHistoryEntry({
        info,
        parts: bundle.parts.filter((part) => part.messageID === info.id),
      });
    }
  }

  function persistRealtimeAuxiliaryHistory(threadId: string) {
    if (!threadId) return;
    const entries = [...realtimeHistoryQueue.value];
    if (realtimeReasoningPart.value) {
      entries.push({ info: realtimeReasoningPart.value.info, parts: [realtimeReasoningPart.value.part] });
    }
    for (const tool of realtimeToolParts.value) {
      entries.push({ info: tool.info, parts: [tool.part] });
    }
    saveCodexAuxiliaryHistory(threadId, entries);
  }

  function persistCompletedAuxiliaryNotification(threadId: string, turnId: string, item: Record<string, unknown>) {
    if (typeof item.type !== 'string') return;
    const bundle = normalizeCodexTurnItems({
      sessionId: threadId,
      turnId: turnId || `${threadId}:realtime`,
      items: [item],
      parentMessageId: turnId ? codexUserMessageId(turnId, 0) : undefined,
    });
    const entries = bundle.messages.map((info) => ({
      info,
      parts: bundle.parts.filter((part) => part.messageID === info.id),
    }));
    saveCodexAuxiliaryHistory(
      threadId,
      mergeCodexAuxiliaryHistory(threadId, loadCodexAuxiliaryHistory(threadId), entries),
    );
  }

   function handleNotification(notification: CodexJsonRpcNotification) {
     events.value.push({
       id: nextEventId,
       method: notification.method,
       params: notification.params,
       time: Date.now(),
     });
     nextEventId += 1;

     const notificationParams = isRecord(notification.params) ? notification.params : null;
     const notificationThreadId = typeof notificationParams?.threadId === 'string'
       ? notificationParams.threadId
       : '';
	     const notificationTurnId = typeof notificationParams?.turnId === 'string'
	       ? notificationParams.turnId
	       : '';
	     if (notificationThreadId && notificationTurnId) {
	       if (isInvalidatedTurnId(notificationThreadId, notificationTurnId)) return;
	       recordObservedTurnId(notificationThreadId, notificationTurnId);
	     }
     const isRealtimeThreadNotification = notification.method.startsWith('item/')
       || notification.method.startsWith('turn/')
       || notification.method.startsWith('command/');
     if (isRealtimeThreadNotification
       && notificationThreadId
       && notificationThreadId !== activeThreadId.value) {
       if (notification.method === 'item/completed' && isRecord(notificationParams?.item)) {
         persistCompletedAuxiliaryNotification(notificationThreadId, notificationTurnId, notificationParams.item);
       }
       if (notification.method === 'turn/completed') void refreshThreads();
       return;
     }

     if (notification.method === 'thread/started') {
       const thread = extractThread(notification.params);
       if (thread) void upsertThreadWithGitInfo(thread);
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
         permissionRequests.value = permissionRequests.value.filter((request) => request.requestId !== requestId);
         elicitationRequests.value = elicitationRequests.value.filter((request) => request.requestId !== requestId);
         return;
       }

      if (notification.method === 'turn/started' || notification.method === 'turn/completed') {
        const turn = extractTurn(notification.params);
        if (turn) activeTurn.value = turn;
        pruneServerRequestsForActiveContext();
        if (notification.method === 'turn/completed') {
          setRealtimeAssistantCompleted();
          setRealtimeReasoningCompleted();
          realtimeStreamingPart.value = realtimeStreamingPart.value
            ? { ...realtimeStreamingPart.value, updatedAt: Date.now() }
            : null;
          realtimeReasoningPart.value = realtimeReasoningPart.value
            ? { ...realtimeReasoningPart.value, updatedAt: Date.now() }
            : null;
          void refreshThreads();
          const completedThreadId = notificationThreadId || activeThreadId.value;
          if (completedThreadId) void hydrateThread(completedThreadId);
        }
        return;
      }

      if (notification.method === 'item/completed') {
        const params = isRecord(notification.params) ? notification.params : null;
        const item = params?.item;
        if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string') {
          const last = transcript.value.at(-1);
          if (last?.role === 'assistant') {
            transcript.value[transcript.value.length - 1] = {
              ...last,
              text: item.text,
              modelName: last.modelName ?? currentSelectedModelName(),
            };
          } else {
            pushTranscript('assistant', item.text, currentSelectedModelName());
          }
          if (realtimeStreamingPart.value) {
            const completedAt = Date.now();
            realtimeStreamingPart.value = {
              ...realtimeStreamingPart.value,
              part: {
                ...realtimeStreamingPart.value.part,
                text: item.text,
                time: {
                  start: realtimeStreamingPart.value.part.time?.start ?? realtimeStreamingPart.value.info.time.created,
                  end: completedAt,
                },
              },
              updatedAt: completedAt,
            };
          }
        }
        if (isRecord(item) && item.type === 'reasoning') {
          if (realtimeReasoningPart.value) {
            const completedAt = Date.now();
            const finalPart = realtimeReasoningPart.value.part;
            mergeRealtimeHistoryEntry({
              info: realtimeReasoningPart.value.info,
              parts: [{ ...finalPart, time: { start: finalPart.time.start, end: completedAt } }],
            });
          }
        }
        const realtimeSessionId = notificationThreadId || activeThreadId.value || 'codex-thread';
        const realtimeTurnId = notificationTurnId || activeTurn.value?.id || `${realtimeSessionId}:realtime`;
        const normalizedBundle = isRecord(item) && typeof item.type === 'string'
          ? normalizeCodexTurnItems({
            sessionId: realtimeSessionId,
            turnId: realtimeTurnId,
            items: [item],
            parentMessageId: currentRealtimeParentId(realtimeSessionId),
          })
          : null;
        const normalizedToolPart = normalizedBundle?.parts.find((part): part is ToolPart => part.type === 'tool') ?? null;
        let completedToolMerged = false;
        if (isRecord(item) && typeof item.type === 'string') {
          const itemId = typeof item.id === 'string' ? item.id : '';
          const itemStatus = typeof item.status === 'string' ? item.status : '';
          if (itemId && itemStatus) {
            const index = realtimeToolParts.value.findIndex((entry) => entry.part.id === itemId);
            if (index !== -1) {
              const current = realtimeToolParts.value[index];
              if (current?.part.state.status === 'running') {
                const next = [...realtimeToolParts.value];
                next[index] = {
                  ...current,
                  part: {
                    ...current.part,
                    state: {
                      ...current.part.state,
                      metadata: {
                        ...current.part.state.metadata,
                        codexStatus: itemStatus,
                      },
                    },
                  },
                  updatedAt: Date.now(),
                };
                realtimeToolParts.value = next;
              }
            }
          }
          if (itemId) {
            const finalOutput = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
            const completedTool = completeRealtimeToolPart(itemId, normalizedToolPart, finalOutput);
            if (completedTool) {
              mergeRealtimeHistoryEntry({ info: completedTool.info, parts: [completedTool.part] });
              completedToolMerged = true;
            }
          }
        }
        // Handle exitedReviewMode
        if (isRecord(item) && item.type === 'exitedReviewMode') {
          reviewState.value = 'completed';
          const reviewText = typeof item.review === 'string' ? item.review : '';
          reviewResult.value = reviewText;
          pushTranscript('system', `Review completed: ${reviewText}`, currentSelectedModelName());
        }
        // Bridge completed items into the shared message model for OutputPanel realtime display
        if (isRecord(item) && typeof item.type === 'string' && !completedToolMerged) {
          const bundle = normalizedBundle ?? { messages: [], parts: [] };
          if (bundle.messages.length > 0 || bundle.parts.length > 0) {
            mergeRealtimeHistoryBundle(bundle);
          }
        }
        return;
      }

      if (notification.method === 'item/agentMessage/delta') {
        const delta = extractAgentDelta(notification.params);
        appendAssistantDelta(delta);
        if (delta && realtimeStreamingPart.value) {
          const current = realtimeStreamingPart.value.part;
          realtimeStreamingPart.value = {
            info: realtimeStreamingPart.value.info,
            part: { ...current, text: current.text + delta },
            updatedAt: Date.now(),
          };
        }
        return;
     }

     // Review mode notifications and tool item bridging
     if (notification.method === 'item/started') {
       const params = isRecord(notification.params) ? notification.params : null;
       const item = isRecord(params?.item) ? params.item : null;
       if (item?.type === 'enteredReviewMode') {
         reviewState.value = 'reviewing';
         reviewResult.value = '';
         const reviewText = typeof item.review === 'string' ? item.review : '';
         pushTranscript('system', `Review started: ${reviewText || 'current changes'}`, currentSelectedModelName());
         return;
       }
         if (item && typeof item.type === 'string' && item.type !== 'userMessage' && item.type !== 'agentMessage') {
            const realtimeSessionId = notificationThreadId || activeThreadId.value || 'codex-thread';
            const turnId = notificationTurnId || activeTurn.value?.id || `${realtimeSessionId}:realtime`;
            const bundle = normalizeCodexTurnItems({
              sessionId: realtimeSessionId,
              turnId,
              items: [item],
              parentMessageId: currentRealtimeParentId(realtimeSessionId),
            });
           for (const part of bundle.parts) {
             if (part.type === 'tool') {
                upsertRealtimeToolPart({
                  info: createCodexAssistantInfo(
                    realtimeSessionId,
                    part.messageID,
                    Date.now(),
                    currentRealtimeParentId(realtimeSessionId),
                  ),
                 part: { ...part, state: { ...part.state, status: 'running' } as ToolPart['state'] },
                 updatedAt: Date.now(),
               });
            }
          }
        }
        return;
      }

     // Command execution output streaming
      if (
        notification.method === 'command/exec/outputDelta'
        || notification.method === 'item/commandExecution/outputDelta'
      ) {
        const params = isRecord(notification.params) ? notification.params : null;
        const callId = typeof params?.callId === 'string'
          ? params.callId
          : typeof params?.itemId === 'string'
            ? params.itemId
            : '';
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (delta) {
          commandOutput.value.push({ text: delta, time: Date.now() });
          if (callId) updateRealtimeToolOutput(callId, delta);
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
        capabilityRegistry.markSupported('turn/plan/updated');
        const params = isRecord(notification.params) ? notification.params : null;
        const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params?.turnId === 'string' ? params.turnId : '';
        const explanation = typeof params?.explanation === 'string' ? params.explanation : undefined;
        const plan = Array.isArray(params?.plan) ? params.plan : [];
        if (threadId && turnId) {
          const existingIndex = planItems.value.findIndex(
            (entry) => entry.threadId === threadId && entry.turnId === turnId,
          );
          const planEntry = {
            threadId,
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
         if (delta && itemId) {
           const threadId = notificationThreadId || activeThreadId.value || 'codex-thread';
           const messageId = codexAssistantMessageId(notificationTurnId || activeTurn.value?.id || `reasoning:${threadId}`);
          const existing = realtimeReasoningPart.value?.part;
          const accumulated = existing?.id === `${itemId}:reasoning`
            ? existing.text + delta
            : delta;
           realtimeReasoningPart.value = {
             info: createCodexAssistantInfo(threadId, messageId, Date.now(), currentRealtimeParentId(threadId)),
             part: {
              id: `${itemId}:reasoning`,
              sessionID: threadId,
              messageID: messageId,
              type: 'reasoning',
              text: accumulated,
              time: { start: realtimeReasoningPart.value?.part.time.start ?? Date.now() },
            },
            updatedAt: Date.now(),
          };
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
        if (itemId && realtimeReasoningPart.value) {
          const current = realtimeReasoningPart.value.part;
          realtimeReasoningPart.value = {
            info: realtimeReasoningPart.value.info,
            part: { ...current, text: current.text + '\n---\n' },
            updatedAt: Date.now(),
          };
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
         if (delta && itemId) {
           const threadId = notificationThreadId || activeThreadId.value || 'codex-thread';
           const messageId = codexAssistantMessageId(notificationTurnId || activeTurn.value?.id || `reasoning:${threadId}`);
          const existing = realtimeReasoningPart.value?.part;
          const accumulated = existing?.id === `${itemId}:reasoning`
            ? existing.text + delta
            : delta;
           realtimeReasoningPart.value = {
             info: createCodexAssistantInfo(threadId, messageId, Date.now(), currentRealtimeParentId(threadId)),
             part: {
              id: `${itemId}:reasoning`,
              sessionID: threadId,
              messageID: messageId,
              type: 'reasoning',
              text: accumulated,
              time: { start: realtimeReasoningPart.value?.part.time.start ?? Date.now() },
            },
            updatedAt: Date.now(),
          };
        }
        return;
      }

      if (notification.method === 'item/fileChange/outputDelta') {
        const params = isRecord(notification.params) ? notification.params : null;
        const itemId = typeof params?.itemId === 'string' ? params.itemId : '';
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (itemId) {
          fileChangeOutputs.value[itemId] = (fileChangeOutputs.value[itemId] ?? '') + delta;
          if (delta) updateRealtimeToolOutput(itemId, delta);
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
    const permissionRequest = parseCodexPermissionRequest(request);
    if (permissionRequest) {
      permissionRequests.value = [
        ...permissionRequests.value.filter((item) => item.dialogId !== permissionRequest.dialogId),
        permissionRequest,
      ];
      return;
    }

    const elicitationRequest = parseMcpElicitationRequest(request);
    if (elicitationRequest) {
      elicitationRequests.value = [
        ...elicitationRequests.value.filter((item) => item.dialogId !== elicitationRequest.dialogId),
        elicitationRequest,
      ];
      return;
    }

    if (request.method === 'account/chatgptAuthTokens/refresh') {
      adapter?.respondToServerRequest(request.id, { decline: {} });
      return;
    }

    const toolUserInputRequest = parseToolUserInputRequest(request);
    if (toolUserInputRequest) {
      toolUserInputRequests.value = [
        ...toolUserInputRequests.value.filter((item) => item.requestId !== request.id),
        toolUserInputRequest,
      ];
      return;
    }

    const dynamicToolCall = parseDynamicToolCallRequest(request);
    if (dynamicToolCall) {
      dynamicToolCalls.value = [
        ...dynamicToolCalls.value.filter((item) => item.requestId !== request.id),
        dynamicToolCall,
      ];
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
    permissionRequests.value = permissionRequests.value.filter((request) => (
      request.sessionID === threadId && request.turnId === turnId
    ));
    elicitationRequests.value = elicitationRequests.value.filter((request) => (
      request.sessionID === threadId && (request.turnId === null || request.turnId === turnId)
    ));
    toolUserInputRequests.value = toolUserInputRequests.value.filter((request) => (
      request.threadId === threadId && request.turnId === turnId
    ));
    dynamicToolCalls.value = dynamicToolCalls.value.filter((request) => (
      request.threadId === threadId && request.turnId === turnId
    ));
  }

  async function refreshHomeDir(force = false, request: ConnectionRequest | null = captureConnection()) {
    if (!request) return homeDir.value;
    if (homeDir.value && !force) return homeDir.value;
    try {
      const httpUrl = codexBridgeHttpUrl(
        appendCodexBridgeToken(url.value.trim(), bridgeToken.value.trim() || undefined),
        '/homedir',
      );
      const res = await fetch(httpUrl, { method: 'GET' });
      if (!isCurrentConnection(request)) return homeDir.value;
      if (res.ok) {
        const data = await res.json() as { home?: string };
        if (!isCurrentConnection(request)) return homeDir.value;
        const home = data.home?.trim();
        if (home) {
          homeDir.value = home;
          return homeDir.value;
        }
      }
    } catch {
      if (!isCurrentConnection(request)) return homeDir.value;
      if (!homeDir.value) homeDir.value = '/';
    }
    if (!homeDir.value) homeDir.value = '/';
    return homeDir.value;
  }

  async function connect(nextUrl = url.value, onPhase?: (phase: CodexConnectPhase) => void) {
    teardownConnection(true);
    url.value = nextUrl.trim();
    status.value = 'connecting';
    errorMessage.value = '';
    adapter = makeAdapter();
    const request = captureConnection();
    if (!request) return;
    const sourceAdapter = request.sourceAdapter;

    if (import.meta.env.DEV) console.time('codex-connect');

    onPhase?.('home');
    await refreshHomeDir(false, request);
    if (!isCurrentConnection(request)) return;
    unsubscribeNotifications = sourceAdapter.onNotification(handleNotification);
    unsubscribeServerRequests = sourceAdapter.onServerRequest(handleServerRequest);

    try {
      onPhase?.('handshake');
      await sourceAdapter.initialize();
      if (!isCurrentConnection(request)) return;
      initialized.value = true;
      status.value = 'connected';
      reconnectOnMount.value = true;
      storageSet(StorageKeys.state.codexPanelConnected, '1');

      onPhase?.('threads');
      await Promise.allSettled([refreshThreads({}, false)]);
      onPhase?.('workspace');
      onPhase?.('panelData');
      void Promise.allSettled([
        refreshConfiguredProviderThreads(),
        openAsSandbox(selectedSandboxCwd() || homeDir.value || '/'),
        preloadPanelData(),
      ]);
    } catch (error) {
      if (!isCurrentConnection(request)) return;
      status.value = 'error';
      errorMessage.value = error instanceof Error ? error.message : String(error);
      teardownConnection(false);
      if (import.meta.env.DEV) console.timeEnd('codex-connect');
      throw error;
    }
    if (import.meta.env.DEV) console.timeEnd('codex-connect');
  }

  async function restoreConnection() {
    if (!reconnectOnMount.value || connected.value || status.value === 'connecting') return;
    await connect(url.value);
  }

  function teardownConnection(resetStatus: boolean) {
    connectionGeneration += 1;
    threadSelectionGeneration += 1;
    accountRefreshGeneration += 1;
    threadGoalRefreshGeneration += 1;
    pluginsRefreshGeneration += 1;
    unsubscribeNotifications?.();
    unsubscribeNotifications = null;
    unsubscribeServerRequests?.();
    unsubscribeServerRequests = null;
    adapter?.disconnect();
    adapter = null;
    capabilityRegistry.reset();
    initialized.value = false;
    activeTurn.value = null;
    serverRequests.value = [];
    permissionRequests.value = [];
    elicitationRequests.value = [];
    toolUserInputRequests.value = [];
    dynamicToolCalls.value = [];
    threadGoal.value = null;
    threadGoalThreadId.value = null;
    threadGoalLoading.value = false;
    loadingThread.value = false;
    if (resetStatus) status.value = 'idle';
  }

  function disconnectTransport() {
    teardownConnection(true);
  }

  function disconnect() {
    disconnectTransport();
    reconnectOnMount.value = false;
    storageSet(StorageKeys.state.codexPanelConnected, '0');
  }

  async function fetchThreadList(
    params: CodexThreadListParams = {},
    includeConfiguredProviders = true,
    request: ConnectionRequest | null = captureConnection(),
  ) {
    if (!request) return;
    const baseParams = { limit: 50, sortKey: 'updated_at' as const, modelProviders: null, ...params };
    const result = await listThreadsAcrossConfiguredProviders(baseParams, includeConfiguredProviders, request);
    if (!isCurrentConnection(request)) return;
    const existingThreads = threads.value;
    return result.data.map((thread) => {
      const existing = existingThreads.find((item) => item.id === thread.id);
      const monotonic = monotonicTimestamps(existing, thread);
      return normalizeThreadCwd({
        ...existing,
        ...thread,
        cwd: thread.cwd ?? existing?.cwd,
        gitInfo: thread.gitInfo ?? existing?.gitInfo,
        createdAt: monotonic.createdAt,
        updatedAt: monotonic.updatedAt,
      });
    });
  }

  async function configuredThreadModelProviderIds(request: ConnectionRequest) {
    if (!isCurrentConnection(request)) return null;
    const { sourceAdapter } = request;
    const providerIds = new Set<string>(['openai']);
    const collect = (rawConfig: unknown) => {
      if (!isRecord(rawConfig)) return;
      const activeProvider = typeof rawConfig.model_provider === 'string' ? rawConfig.model_provider.trim() : '';
      if (activeProvider) providerIds.add(activeProvider);
      const modelProviders = isRecord(rawConfig.model_providers) ? rawConfig.model_providers : null;
      if (modelProviders) {
        Object.keys(modelProviders)
          .map((providerId) => providerId.trim())
          .filter(Boolean)
          .forEach((providerId) => providerIds.add(providerId));
      }
    };

    let configResult = config.value;
    if (!configResult && typeof sourceAdapter.readConfig === 'function') {
      try {
        configResult = await sourceAdapter.readConfig({ includeLayers: true });
        if (!isCurrentConnection(request)) return null;
        config.value = configResult;
      } catch {
        if (!isCurrentConnection(request)) return null;
        configResult = null;
      }
    }
    collect(configResult?.config);
    for (const layer of configResult?.layers ?? []) collect(layer.config);
    return isCurrentConnection(request) ? Array.from(providerIds) : null;
  }

  async function listThreadsAcrossConfiguredProviders(
    params: CodexThreadListParams & { limit: number; sortKey: 'updated_at' | 'created_at'; modelProviders?: string[] | null },
    includeConfiguredProviders = true,
    request: ConnectionRequest | null = captureConnection(),
  ): Promise<CodexThreadListResult> {
    if (!request || !isCurrentConnection(request)) return { data: [], nextCursor: null };
    const currentAdapter = request.sourceAdapter;
    if (!includeConfiguredProviders || (params.modelProviders !== undefined && params.modelProviders !== null)) {
      return currentAdapter.listThreads(params);
    }

    const providerIds = await configuredThreadModelProviderIds(request);
    if (!providerIds || !isCurrentConnection(request)) return { data: [], nextCursor: null };
    if (providerIds.length <= 1) return currentAdapter.listThreads(params);

    const requests = [
      currentAdapter.listThreads(params),
      ...providerIds.map((providerId) => currentAdapter.listThreads({ ...params, modelProviders: [providerId] })),
    ];
    const results = await Promise.allSettled(requests);
    if (!isCurrentConnection(request)) return { data: [], nextCursor: null };
    const merged = new Map<string, CodexThread>();
    let nextCursor: string | null = null;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      nextCursor ??= result.value.nextCursor;
      for (const thread of result.value.data) {
        const existing = merged.get(thread.id);
        const monotonic = monotonicTimestamps(existing, thread);
        merged.set(thread.id, { ...existing, ...thread, createdAt: monotonic.createdAt, updatedAt: monotonic.updatedAt });
      }
    }
    return {
      data: Array.from(merged.values()).sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)),
      nextCursor,
    };
  }

  async function refreshConfiguredProviderThreads() {
    const request = captureConnection();
    if (!request) return;
    const { sourceAdapter } = request;
    const providerIds = await configuredThreadModelProviderIds(request);
    if (!providerIds || !isCurrentConnection(request) || providerIds.length <= 1) return;
    const results = await Promise.allSettled(providerIds.map((providerId) => sourceAdapter.listThreads({
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: [providerId],
    })));
    if (!isCurrentConnection(request)) return;
    const merged = new Map(threads.value.map((thread) => [thread.id, thread]));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const thread of result.value.data) {
        const existing = merged.get(thread.id);
        const monotonic = monotonicTimestamps(existing, thread);
        merged.set(thread.id, normalizeThreadCwd({
          ...existing,
          ...thread,
          cwd: thread.cwd ?? existing?.cwd,
          gitInfo: thread.gitInfo ?? existing?.gitInfo,
          createdAt: monotonic.createdAt,
          updatedAt: monotonic.updatedAt,
        }));
      }
    }
    const enrichedThreads = await Promise.all([...merged.values()].map(enrichThreadWithGitInfo));
    if (isCurrentConnection(request)) {
      threads.value = enrichedThreads.sort(
        (left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0),
      );
    }
  }

  async function refreshThreads(params: CodexThreadListParams = {}, includeConfiguredProviders = true) {
    const request = captureConnection();
    const normalizedThreads = await fetchThreadList(params, includeConfiguredProviders, request);
    if (!request || !isCurrentConnection(request) || !normalizedThreads) return;
    const existingThreads = threads.value;
    const returnedThreadIds = new Set(normalizedThreads.map((thread) => thread.id));
    const activeLocalThread = activeThreadId.value
      ? existingThreads.find((thread) => thread.id === activeThreadId.value)
      : undefined;
    if (activeLocalThread && !returnedThreadIds.has(activeLocalThread.id)) {
      normalizedThreads.push(normalizeThreadCwd(activeLocalThread));
    }
    const enrichedThreads = await Promise.all(normalizedThreads.map(enrichThreadWithGitInfo));
    if (!isCurrentConnection(request)) return;
    threads.value = enrichedThreads;
    if (!loadingThread.value) {
      if (activeThreadId.value && !enrichedThreads.some((thread) => thread.id === activeThreadId.value)) {
        activeThreadId.value = enrichedThreads[0]?.id ?? '';
      } else if (!activeThreadId.value && enrichedThreads[0]) {
        activeThreadId.value = enrichedThreads[0].id;
      }
    }
  }

  async function preloadPanelData() {
    if (!adapter) return;
    await Promise.allSettled([
      refreshAccount(),
      refreshAccountRateLimits(),
      refreshModels(),
      refreshSkills(),
      refreshPlugins(),
      refreshMcpServers(),
      refreshConfig(),
      refreshApps(),
      refreshExperimentalFeatures(),
      refreshCollaborationModes(),
      refreshConfigRequirements(),
      refreshLoadedThreads(),
    ]);
  }

  const gitInfoByDirectory = new Map<string, NonNullable<CodexThread['gitInfo']>>();
  const gitInfoRequests = new Map<string, Promise<CodexThread['gitInfo'] | null>>();

  function parseVcsInfo(raw: unknown): CodexThread['gitInfo'] | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const root = typeof record.root === 'string' ? expandPath(record.root).trim() : '';
    const branch = typeof record.branch === 'string' ? record.branch.trim() : '';
    const sha = typeof record.sha === 'string' ? record.sha.trim() : '';
    const commonRoot = typeof record.commonRoot === 'string' ? expandPath(record.commonRoot).trim() : '';
    const worktreeRoot = typeof record.worktreeRoot === 'string' ? expandPath(record.worktreeRoot).trim() : '';
    if (!root) return null;
    return {
      root,
      ...(branch ? { branch } : {}),
      ...(sha ? { sha } : {}),
      ...(commonRoot ? { commonRoot } : {}),
      ...(worktreeRoot ? { worktreeRoot } : {}),
    };
  }

  function sanitizeThreadGitInfo(gitInfo: CodexThread['gitInfo']): CodexThread['gitInfo'] {
    if (!gitInfo) return gitInfo;
    const { originUrl: _originUrl, ...safeGitInfo } = gitInfo as NonNullable<CodexThread['gitInfo']> & { originUrl?: unknown };
    return safeGitInfo;
  }

  async function resolveThreadGitInfo(directory: string): Promise<CodexThread['gitInfo'] | null> {
    const cwd = expandPath(directory).trim();
    const connection = captureConnection();
    if (!connection || !cwd) return null;
    const cacheKey = `${connection.generation}:${cwd}`;
    if (gitInfoByDirectory.has(cacheKey)) return gitInfoByDirectory.get(cacheKey) ?? null;
    const existing = gitInfoRequests.get(cacheKey);
    if (existing) return existing;
    const request = (async () => {
      try {
        const raw = await connection.sourceAdapter.getVcsInfo?.(cwd);
        if (!isCurrentConnection(connection)) return null;
        const info = parseVcsInfo(raw);
        if (info?.root) gitInfoByDirectory.set(cacheKey, info);
        return info;
      } catch {
        return null;
      } finally {
        gitInfoRequests.delete(cacheKey);
      }
    })();
    gitInfoRequests.set(cacheKey, request);
    return request;
  }

  async function enrichThreadWithGitInfo(thread: CodexThread): Promise<CodexThread> {
    const normalizedThread = normalizeThreadCwd(thread);
    const cwd = normalizedThread.cwd?.trim();
    if (!cwd) return normalizedThread;
    if (
      normalizedThread.gitInfo?.root &&
      normalizedThread.gitInfo.commonRoot
    ) {
      return normalizedThread;
    }
    const gitInfo = await resolveThreadGitInfo(cwd);
    return gitInfo?.root
      ? { ...normalizedThread, gitInfo: { ...gitInfo, ...normalizedThread.gitInfo } }
      : normalizedThread;
  }

  async function upsertThreadWithGitInfo(thread: CodexThread) {
    const enrichedThread = await enrichThreadWithGitInfo(thread);
    upsertThread(enrichedThread, false);
  }

  function isUnmaterializedThreadError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /not materialized/i.test(message) ||
      /includeTurns is unavailable/i.test(message) ||
      /no rollout found/i.test(message);
  }

  function mergeThreadReadResult(
    read: CodexThreadReadResult | undefined,
    threadId: string,
  ): CodexThreadReadResult {
    const existing = threads.value.find((item) => item.id === threadId);
    const thread = (read?.thread ?? { id: threadId }) as CodexThread;
    const monotonic = monotonicTimestamps(existing, thread);
    return {
      ...read,
      thread: {
        ...existing,
        ...thread,
        id: thread.id || existing?.id || threadId,
        cwd: thread.cwd ?? existing?.cwd,
        gitInfo: thread.gitInfo ?? existing?.gitInfo,
        createdAt: monotonic.createdAt,
        updatedAt: monotonic.updatedAt,
      },
    };
  }

  async function readThreadForHistory(
    threadId: string,
    sourceAdapter: CodexAdapter | null = adapter,
  ): Promise<CodexThreadReadResult> {
    if (!sourceAdapter) throw new Error('Codex is not connected.');
    try {
      const read = await sourceAdapter.readThread({ threadId, includeTurns: true });
      return mergeThreadReadResult(read, threadId);
    } catch (error) {
      if (!isUnmaterializedThreadError(error)) throw error;
      const read = await sourceAdapter.readThread({ threadId, includeTurns: false });
      return mergeThreadReadResult(read, threadId);
    }
  }

  async function hydrateThreadImages(entries: CodexCanonicalHistoryEntry[]) {
    const nextEntries = await Promise.all(entries.map(async (entry) => {
      const parts = await Promise.all(entry.parts.map(async (part) => {
        if (part.type !== 'file') return part;
        if (part.url.startsWith('data:') || part.url.startsWith('http://') || part.url.startsWith('https://')) return part;
        if (!part.mime.startsWith('image/')) return part;
        try {
          const raw = await readFileRaw(part.url);
          const dataUrl = fileResultToDataUrl(part.url, raw);
          return dataUrl ? { ...part, url: dataUrl } : part;
        } catch {
          return part;
        }
      }));
      return { ...entry, parts };
    }));
    return nextEntries;
  }

  function restoreAuxiliaryHistory(threadId: string) {
    const serverParts = new Set(canonicalHistory.value.flatMap((entry) => entry.parts.map((part) => part.id)));
    const serverInfo = new Map(canonicalHistory.value.map((entry) => [entry.info.id, entry.info]));
    const missingEntries = loadCodexAuxiliaryHistory(threadId)
      .map((entry) => ({
        info: serverInfo.get(entry.info.id) ?? entry.info,
        parts: entry.parts.filter((part) => !serverParts.has(part.id)),
      }))
      .filter((entry) => entry.parts.length > 0);
    realtimeHistoryQueue.value = mergeCodexAuxiliaryHistory(threadId, missingEntries);
  }

  async function selectThread(threadId: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    if (!threadId) return;
    const sourceAdapter = adapter;
    const selectionGeneration = ++threadSelectionGeneration;
    const isCurrentSelection = () => (
      adapter === sourceAdapter
      && threadSelectionGeneration === selectionGeneration
      && activeThreadId.value === threadId
    );
    persistRealtimeAuxiliaryHistory(activeThreadId.value);
    activeThreadId.value = threadId;
    activeTurn.value = null;
    threadGoalRefreshGeneration += 1;
    threadGoal.value = null;
    threadGoalThreadId.value = null;
    threadGoalLoading.value = false;
    pruneServerRequestsForActiveContext();
    realtimeHistoryQueue.value = [];
    realtimeMessageAliases.value = {};
    realtimeStreamingPart.value = null;
    realtimeReasoningPart.value = null;
    realtimeToolParts.value = [];
    loadingThread.value = true;
    errorMessage.value = '';
    try {
      let read = await readThreadForHistory(threadId, sourceAdapter);
      if (!isCurrentSelection()) return;
      upsertThread(read.thread);
      setTranscriptFromTurns(read.thread.turns ?? []);
      const hydratedHistory = await hydrateThreadImages(canonicalHistory.value);
      if (!isCurrentSelection()) return;
      canonicalHistory.value = hydratedHistory;
      try {
        const resumed = await sourceAdapter.resumeThread({ threadId });
        if (!isCurrentSelection()) return;
        upsertThread(resumed.thread);
        if ((read.thread.turns?.length ?? 0) === 0) {
          read = await readThreadForHistory(threadId, sourceAdapter);
          if (!isCurrentSelection()) return;
          upsertThread(read.thread);
          setTranscriptFromTurns(read.thread.turns ?? []);
          const resumedHistory = await hydrateThreadImages(canonicalHistory.value);
          if (!isCurrentSelection()) return;
          canonicalHistory.value = resumedHistory;
        }
      } catch (error) {
        if (!isUnmaterializedThreadError(error)) throw error;
      }
      if (!isCurrentSelection()) return;
      restoreAuxiliaryHistory(threadId);
    } catch (error) {
      if (!isCurrentSelection()) return;
      errorMessage.value = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (threadSelectionGeneration === selectionGeneration) loadingThread.value = false;
    }
  }

  async function hydrateThread(threadId: string) {
    const sourceAdapter = adapter;
    if (!sourceAdapter) return;
    const selectionGeneration = threadSelectionGeneration;
    const read = await readThreadForHistory(threadId, sourceAdapter);
    if (adapter !== sourceAdapter
      || threadSelectionGeneration !== selectionGeneration
      || activeThreadId.value !== threadId) {
      return;
    }
    upsertThread(read.thread);
    setTranscriptFromTurns(read.thread.turns ?? []);
  }

  async function startThread(cwd?: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    const params: { cwd?: string; model?: string } = {};
    if (cwd) params.cwd = expandPath(cwd);
    const selectedCodexModel = parseSelectedCodexModel(selectedModel.value).modelID;
    if (selectedCodexModel) params.model = selectedCodexModel;
    const result = await adapter.startThread(params);
    const thread = params.cwd && !result.thread.cwd ? { ...result.thread, cwd: params.cwd } : result.thread;
    const gitInfo = thread.cwd ? await resolveThreadGitInfo(thread.cwd) : null;
    const enrichedThread = gitInfo?.root ? { ...thread, gitInfo } : thread;
    upsertThread(enrichedThread, false);
    activeThreadId.value = enrichedThread.id;
    transcript.value = [];
    canonicalHistory.value = [];
    realtimeHistoryQueue.value = [];
    realtimeStreamingPart.value = null;
    realtimeReasoningPart.value = null;
    realtimeToolParts.value = [];
    activeTurn.value = null;
    pruneServerRequestsForActiveContext();
    return enrichedThread;
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
    const removeArchivedThread = () => {
      threads.value = threads.value.filter((thread) => thread.id !== threadId);
      if (activeThreadId.value === threadId) {
        activeThreadId.value = threads.value[0]?.id ?? '';
        transcript.value = [];
        activeTurn.value = null;
      }
    };
    try {
      await adapter.archiveThread({ threadId });
    } catch (error) {
      if (!isUnmaterializedThreadError(error)) throw error;
      hideThread(threadId);
      return;
    }
    removeArchivedThread();
    await refreshThreads();
    removeArchivedThread();
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
	  invalidateRecentTurnIds(threadId, numTurns);
    clearCodexAuxiliaryHistory(threadId);
    realtimeHistoryQueue.value = realtimeHistoryQueue.value.filter((entry) => entry.info.sessionID !== threadId);
    if (activeThreadId.value === threadId) {
      realtimeReasoningPart.value = null;
      realtimeToolParts.value = [];
    }
    upsertThread(result.thread);
    await hydrateThread(result.thread.id);
    await refreshThreads();
    return result.thread;
  }

  function hideThread(threadId: string) {
    hiddenThreadIds.value = new Set([...hiddenThreadIds.value, threadId]);
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
  }

  function expandPath(input: string): string {
    const trimmed = input.trim();
    const home = homeDir.value || '/';
    if (trimmed === '~') return home;
    if (trimmed.startsWith('~/')) {
      return normalizeAbsolutePathNoParent(`${home.replace(/\/+$/u, '')}/${trimmed.slice(2).replace(/^\/+/, '')}`);
    }
    if (!trimmed) return '';
    if (trimmed.startsWith('/')) return normalizeAbsolutePathNoParent(trimmed);
    return normalizeAbsolutePathNoParent(`${home.replace(/\/+$/u, '')}/${trimmed}`);
  }

  function normalizeCwd(input: string) {
    const expanded = expandPath(input).trim();
    if (expanded === '/') return expanded;
    return expanded.replace(/\/+$/u, '');
  }

  function activeThreadCwd() {
    const cwd = threads.value.find((thread) => thread.id === activeThreadId.value)?.cwd?.trim();
    return cwd ? normalizeCwd(cwd) : undefined;
  }

  function firstUsableCwd(...candidates: Array<string | undefined>) {
    for (const candidate of candidates) {
      const trimmed = candidate?.trim();
      if (!trimmed) continue;
      const normalized = normalizeCwd(trimmed);
      if (normalized) return normalized;
    }
    return undefined;
  }

  function selectedSandboxCwd() {
    return firstUsableCwd(sandboxPath.value, fsCwd.value, activeThreadCwd());
  }

  function normalizeThreadCwd(thread: CodexThread): CodexThread {
    const cwd = thread.cwd?.trim();
    const gitInfo = sanitizeThreadGitInfo(thread.gitInfo);
    const baseThread = gitInfo === thread.gitInfo ? thread : { ...thread, gitInfo };
    if (!cwd) return baseThread;
    const expanded = expandPath(cwd);
    return expanded === cwd ? baseThread : { ...baseThread, cwd: expanded };
  }

  async function readDirectory(path: string) {
    const request = captureConnection();
    if (!request) throw new Error('Codex is not connected.');
    fsLoading.value = true;
    fsError.value = '';
    const resolved = expandPath(path);
    try {
      const result = await request.sourceAdapter.readDirectory({ path: resolved });
      if (!isCurrentConnection(request)) return;
      fsEntries.value = result.entries;
      fsCwd.value = resolved;
    } catch (error) {
      if (!isCurrentConnection(request)) return;
      fsError.value = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (isCurrentConnection(request)) fsLoading.value = false;
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
    const path = selectedSandboxCwd();
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

  function codexFileResultToText(result: { dataBase64?: string; content?: string; encoding?: string }) {
    if (typeof result.content === 'string' && result.encoding !== 'base64') return result.content;
    if (typeof result.content === 'string' && result.encoding === 'base64') return base64ToUtf8(result.content);
    if (typeof result.dataBase64 === 'string') return base64ToUtf8(result.dataBase64);
    return '';
  }

  function decodeReadFileText(result: { dataBase64?: string; content?: string; encoding?: string }) {
    return codexFileResultToText(result);
  }

  async function readFile(path: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    fsLoading.value = true;
    fsError.value = '';
    const resolved = expandPath(path);
    try {
      const result = await adapter.readFile({ path: resolved });
      previewFileContent.value = codexFileResultToText(result);
      previewFilePath.value = resolved;
    } catch (error) {
      fsError.value = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      fsLoading.value = false;
    }
  }

  async function readFileRaw(path: string): Promise<CodexFsReadFileResult> {
    if (!adapter) throw new Error('Codex is not connected.');
    return adapter.readFile({ path: expandPath(path) });
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
    adapter.respondToServerRequest(id, { decision });
    serverRequests.value = serverRequests.value.filter((request) => request.id !== id);
  }

  function replyPermissionRequest(dialogId: string, reply: CodexPermissionReply) {
    if (!adapter) throw new Error('Codex is not connected.');
    const request = permissionRequests.value.find((item) => item.dialogId === dialogId);
    if (!request) return;
    adapter.respondToServerRequest(
      request.requestId,
      buildCodexPermissionResponse(request.requestedPermissions, reply),
    );
    permissionRequests.value = permissionRequests.value.filter((item) => item.dialogId !== dialogId);
  }

  function replyElicitationRequest(
    dialogId: string,
    action: McpElicitationAction,
    content?: Record<string, unknown>,
  ) {
    if (!adapter) throw new Error('Codex is not connected.');
    const request = elicitationRequests.value.find((item) => item.dialogId === dialogId);
    if (!request) return;
    adapter.respondToServerRequest(request.requestId, buildMcpElicitationResponse(action, content));
    elicitationRequests.value = elicitationRequests.value.filter((item) => item.dialogId !== dialogId);
  }

  function resolvePromptCwd(cwd: string | undefined, threadId: string) {
    const explicitCwd = cwd?.trim();
    if (explicitCwd) return normalizeCwd(explicitCwd);
    const threadCwd = threads.value.find((thread) => thread.id === threadId)?.cwd?.trim();
    return threadCwd ? normalizeCwd(threadCwd) : undefined;
  }

  async function sendPrompt(
    text: string,
    options: { model?: string; effort?: string; cwd?: string; threadId?: string; input?: CodexPromptInput['input']; forceNewThread?: boolean; collaborationMode?: CodexCollaborationModePayload } = {},
  ) {
    const prompt = text.trim();
    const inputItems = options.input?.filter((item) => item.type !== 'text' || item.text.trim().length > 0) ?? [];
    if (!prompt && inputItems.length === 0) return null;
    if (!adapter) throw new Error('Codex is not connected.');

    pending.value = true;
    errorMessage.value = '';
    pushTranscript('user', prompt);

    const pendingTurnId = `pending-turn:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const targetThreadId = options.forceNewThread ? '' : (options.threadId ?? activeThreadId.value);
    const userMessageId = codexUserMessageId(pendingTurnId, 0);
    const sessionId = targetThreadId || 'codex-pending';
    const now = Date.now();
    const selectedModelInfo = parseSelectedCodexModel(selectedModel.value);
    const userInfo: MessageInfo = {
      id: userMessageId,
      sessionID: sessionId,
      role: 'user',
      time: { created: now },
      agent: 'codex',
      model: { providerID: selectedModelInfo.providerID, modelID: selectedModelInfo.modelID || 'unknown' },
    };
    const userParts = buildRealtimeUserParts(sessionId, userMessageId, prompt, inputItems, now);
    realtimeHistoryQueue.value = dedupeRealtimeHistoryQueue([
      ...realtimeHistoryQueue.value,
      { info: userInfo, parts: userParts },
    ]);

    try {
      const model = options.model?.trim() || parseSelectedCodexModel(selectedModel.value).modelID || undefined;
      const cwd = resolvePromptCwd(options.cwd, targetThreadId);
      const input: CodexPromptInput = { text: prompt };
      if (inputItems.length > 0) input.input = inputItems;
      if (targetThreadId) input.threadId = targetThreadId;
      if (model) input.model = model;
      if (options.effort) input.effort = options.effort;
      if (options.collaborationMode) input.collaborationMode = options.collaborationMode;
      if (cwd) input.cwd = cwd;
      const result = await adapter.sendPrompt(input);
      activeThreadId.value = result.threadId;
      if (result.thread) upsertThread(result.thread);
      activeTurn.value = result.turn;

      const finalizedTurnId = result.turn.id || pendingTurnId;
      recordObservedTurnId(result.threadId, finalizedTurnId);
      const finalizedUserMessageId = codexUserMessageId(finalizedTurnId, 0);
      if (realtimeHistoryQueue.value.length > 0) {
        let updated = false;
        const nextQueue = realtimeHistoryQueue.value.map((entry) => {
          if (entry.info.id !== userMessageId) return entry;
          updated = true;
          return {
            info: { ...entry.info, id: finalizedUserMessageId, sessionID: result.threadId },
            parts: entry.parts.map((part) => ({
              ...part,
              id: part.id.startsWith(`${userMessageId}:`) ? `${finalizedUserMessageId}${part.id.slice(userMessageId.length)}` : part.id,
              sessionID: result.threadId,
              messageID: finalizedUserMessageId,
            })),
          };
        });
        if (updated) {
          realtimeHistoryQueue.value = dedupeRealtimeHistoryQueue(nextQueue);
        }
      }
      realtimeMessageAliases.value = {
        ...realtimeMessageAliases.value,
        [userMessageId]: finalizedUserMessageId,
      };

      const assistantMessageId = codexAssistantMessageId(finalizedTurnId);
      const assistantPartId = codexAssistantTextPartId(finalizedTurnId);
      realtimeStreamingPart.value = {
        info: createCodexAssistantInfo(result.threadId, assistantMessageId, Date.now(), finalizedUserMessageId),
        part: {
          id: assistantPartId,
          sessionID: result.threadId,
          messageID: assistantMessageId,
          type: 'text',
          text: '',
          time: { start: Date.now() },
        },
        updatedAt: Date.now(),
      };

      return result;
    } catch (error) {
      realtimeHistoryQueue.value = realtimeHistoryQueue.value.filter((entry) => entry.info.id !== userMessageId);
      const nextAliases = { ...realtimeMessageAliases.value };
      delete nextAliases[userMessageId];
      realtimeMessageAliases.value = nextAliases;
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
	     const sourceAdapter = adapter;
	     if (!sourceAdapter) return;
	     const refreshGeneration = ++accountRefreshGeneration;
	     try {
	       const result = await sourceAdapter.readAccount({ refreshToken: false });
	       if (adapter !== sourceAdapter || accountRefreshGeneration !== refreshGeneration) return;
	       account.value = result.account;
	       accountAuthMode.value = result.account?.type ?? null;
	     } catch {
	       if (adapter !== sourceAdapter || accountRefreshGeneration !== refreshGeneration) return;
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
      const request = captureConnection();
      if (!request) return;
      try {
        const result = await request.sourceAdapter.readAccountRateLimits();
        if (!isCurrentConnection(request)) return;
        accountRateLimits.value = result.rateLimits;
      } catch {
        if (isCurrentConnection(request)) accountRateLimits.value = null;
      }
    }

    async function refreshAccountUsage() {
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      accountUsageLoading.value = true;
      try {
        const result = await capabilityRegistry.run('account/usage/read', () =>
          request.sourceAdapter.readAccountUsage(),
        );
        if (isCurrentConnection(request)) accountUsage.value = result;
        return result;
      } finally {
        if (isCurrentConnection(request)) accountUsageLoading.value = false;
      }
    }

    async function refreshModelProviderCapabilities() {
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      modelProviderCapabilitiesLoading.value = true;
      try {
        const result = await capabilityRegistry.run('modelProvider/capabilities/read', () =>
          request.sourceAdapter.readModelProviderCapabilities(),
        );
        if (isCurrentConnection(request)) modelProviderCapabilities.value = result;
        return result;
      } finally {
        if (isCurrentConnection(request)) modelProviderCapabilitiesLoading.value = false;
      }
    }

    async function refreshPermissionProfiles(cwd?: string) {
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      permissionProfilesLoading.value = true;
      try {
        const result = await capabilityRegistry.run('permissionProfile/list', () =>
          request.sourceAdapter.listPermissionProfiles({ cwd: cwd || undefined }),
        );
        if (isCurrentConnection(request)) permissionProfiles.value = result.data;
        return result;
      } finally {
        if (isCurrentConnection(request)) permissionProfilesLoading.value = false;
      }
    }

    async function refreshThreadGoal(threadId = activeThreadId.value) {
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      if (!threadId) return { goal: null };
      const refreshGeneration = ++threadGoalRefreshGeneration;
      if (activeThreadId.value === threadId) {
        threadGoal.value = null;
        threadGoalThreadId.value = null;
      }
      threadGoalLoading.value = true;
      try {
        const result = await capabilityRegistry.run('thread/goal/get', () =>
          request.sourceAdapter.getThreadGoal({ threadId }),
        );
        if (
          isCurrentConnection(request)
          && threadGoalRefreshGeneration === refreshGeneration
          && activeThreadId.value === threadId
        ) {
          threadGoal.value = result.goal;
          threadGoalThreadId.value = threadId;
        }
        return result;
      } finally {
        if (isCurrentConnection(request) && threadGoalRefreshGeneration === refreshGeneration) {
          threadGoalLoading.value = false;
        }
      }
    }

    async function setThreadGoal(params: Omit<CodexThreadGoalSetParams, 'threadId'>) {
      const request = captureConnection();
      if (!request || !activeThreadId.value) throw new Error('Codex thread is not selected.');
      const threadId = activeThreadId.value;
      if (threadGoalThreadId.value !== threadId) throw new Error('Codex thread goal is not loaded.');
      const refreshGeneration = ++threadGoalRefreshGeneration;
      threadGoalLoading.value = true;
      try {
        const result = await capabilityRegistry.run('thread/goal/set', () =>
          request.sourceAdapter.setThreadGoal({ threadId, ...params }),
        );
        if (
          isCurrentConnection(request)
          && threadGoalRefreshGeneration === refreshGeneration
          && activeThreadId.value === threadId
        ) {
          threadGoal.value = result.goal;
          threadGoalThreadId.value = threadId;
        }
        return result;
      } finally {
        if (isCurrentConnection(request) && threadGoalRefreshGeneration === refreshGeneration) {
          threadGoalLoading.value = false;
        }
      }
    }

    async function clearThreadGoal() {
      const request = captureConnection();
      if (!request || !activeThreadId.value) throw new Error('Codex thread is not selected.');
      const threadId = activeThreadId.value;
      if (threadGoalThreadId.value !== threadId) throw new Error('Codex thread goal is not loaded.');
      const refreshGeneration = ++threadGoalRefreshGeneration;
      threadGoalLoading.value = true;
      try {
        const result = await capabilityRegistry.run('thread/goal/clear', () =>
          request.sourceAdapter.clearThreadGoal({ threadId }),
        );
        if (
          isCurrentConnection(request)
          && threadGoalRefreshGeneration === refreshGeneration
          && activeThreadId.value === threadId
        ) {
          threadGoal.value = null;
          threadGoalThreadId.value = threadId;
        }
        return result;
      } finally {
        if (isCurrentConnection(request) && threadGoalRefreshGeneration === refreshGeneration) {
          threadGoalLoading.value = false;
        }
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
      const request = captureConnection();
      if (!request) return;
      modelsLoading.value = true;
      try {
        const result = await request.sourceAdapter.listModels({ includeHidden });
        if (!isCurrentConnection(request)) return;
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
        if (isCurrentConnection(request)) models.value = [];
      } finally {
        if (isCurrentConnection(request)) modelsLoading.value = false;
      }
    }

    async function listProviders() {
      if (!adapter) throw new Error('Codex is not connected.');
      return adapter.listProviders();
    }

    function selectModel(modelId: string) {
      selectedModel.value = modelId;
    }

    async function refreshSkills() {
      const request = captureConnection();
      if (!request) return;
      skillsLoading.value = true;
      try {
        const cwds = fsCwd.value ? [fsCwd.value] : [];
        const result = await request.sourceAdapter.listSkills({ cwds });
        if (!isCurrentConnection(request)) return;
        skills.value = result.data.flatMap((entry) => entry.skills);
      } catch {
        if (isCurrentConnection(request)) skills.value = [];
      } finally {
        if (isCurrentConnection(request)) skillsLoading.value = false;
      }
    }

    async function toggleSkill(path: string, enabled: boolean) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.writeSkillConfig({ path, enabled });
      await refreshSkills();
    }

    async function refreshPlugins() {
      const request = captureConnection();
      if (!request) return;
      const refreshGeneration = ++pluginsRefreshGeneration;
      pluginsLoading.value = true;
      try {
        const result = await request.sourceAdapter.listPlugins();
        if (!isCurrentConnection(request) || pluginsRefreshGeneration !== refreshGeneration) return;
        pluginMarketplaceCount.value = result.marketplaces.length;
        plugins.value = result.marketplaces.flatMap((marketplace) =>
          marketplace.plugins.map((plugin) => ({
            ...plugin,
            marketplaceName: marketplace.name,
            marketplacePath: marketplace.path ?? undefined,
          })),
        );
      } catch {
        if (isCurrentConnection(request) && pluginsRefreshGeneration === refreshGeneration) {
          pluginMarketplaceCount.value = 0;
          plugins.value = [];
        }
      } finally {
        if (isCurrentConnection(request) && pluginsRefreshGeneration === refreshGeneration) {
          pluginsLoading.value = false;
        }
      }
    }

    async function installPlugin(
      marketplacePath: string | undefined,
      pluginName: string,
      remoteMarketplaceName?: string,
    ) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.installPlugin({ marketplacePath, remoteMarketplaceName, pluginName });
      await refreshPlugins();
    }

    async function uninstallPlugin(
      marketplacePath: string | undefined,
      pluginName: string,
      remoteMarketplaceName?: string,
    ) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.uninstallPlugin({ marketplacePath, remoteMarketplaceName, pluginName });
      await refreshPlugins();
    }

    async function addMarketplace(marketplace: { path?: string | null }) {
      if (!adapter) throw new Error('Codex is not connected.');
      await adapter.addMarketplace({ marketplace });
    }

    async function refreshMcpServers() {
      const request = captureConnection();
      if (!request) return;
      mcpServersLoading.value = true;
      try {
        const result = await request.sourceAdapter.listMcpServerStatus({ detail: 'full' });
        if (!isCurrentConnection(request)) return;
        mcpServers.value = result.data.map(normalizeCodexMcpServerInfo);
      } catch {
        if (isCurrentConnection(request)) mcpServers.value = [];
      } finally {
        if (isCurrentConnection(request)) mcpServersLoading.value = false;
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
      const request = captureConnection();
      if (!request) return;
      configLoading.value = true;
      try {
        const result = await request.sourceAdapter.readConfig({ includeLayers: true });
        if (!isCurrentConnection(request)) return;
        config.value = result;
      } catch {
        if (isCurrentConnection(request)) config.value = null;
      } finally {
        if (isCurrentConnection(request)) configLoading.value = false;
      }
    }

    async function refreshApps(params: CodexAppListParams = {}) {
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      appsLoading.value = true;
      try {
        const result: CodexAppListResult = await request.sourceAdapter.listApps(params);
        if (isCurrentConnection(request)) apps.value = result.data;
        return result;
      } finally {
        if (isCurrentConnection(request)) appsLoading.value = false;
      }
    }

    async function writeConfigValue(keyPath: string, value: unknown, mergeStrategy?: ConfigMergeStrategy) {
      if (!adapter) throw new Error('Codex is not connected.');
      const params: CodexConfigValueWriteParams = {
        keyPath,
        value,
        mergeStrategy,
      };
      await adapter.writeConfigValue(params);
      await refreshConfig();
    }

    async function batchWriteConfig(edits: Array<{ keyPath: string; value: unknown; mergeStrategy?: ConfigMergeStrategy }>) {
      if (!adapter) throw new Error('Codex is not connected.');
      const params: CodexConfigBatchWriteParams = {
        edits: edits.map((edit) => ({
          keyPath: edit.keyPath,
          value: edit.value,
          mergeStrategy: edit.mergeStrategy,
        })),
      };
      await adapter.batchWriteConfig(params);
      await refreshConfig();
    }

    async function refreshConfigRequirements() {
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      configRequirementsLoading.value = true;
      try {
        const result: CodexConfigRequirementsReadResult = await capabilityRegistry.run(
          'configRequirements/read',
          () => request.sourceAdapter.readConfigRequirements(),
        );
        if (isCurrentConnection(request)) configRequirements.value = result.requirements;
        return result;
      } finally {
        if (isCurrentConnection(request)) configRequirementsLoading.value = false;
      }
    }

    async function detectExternalAgentConfig(includeHome?: boolean, cwds?: string[]) {
      if (!adapter) throw new Error('Codex is not connected.');
      const sourceAdapter = adapter;
      externalAgentConfigLoading.value = true;
      try {
        const result: CodexExternalAgentConfigDetectResult = await capabilityRegistry.run(
          'externalAgentConfig/detect',
          () => sourceAdapter.detectExternalAgentConfig({ includeHome, cwds }),
        );
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
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      experimentalFeaturesLoading.value = true;
      try {
        const result: CodexExperimentalFeatureListResult = await request.sourceAdapter.listExperimentalFeatures();
        if (isCurrentConnection(request)) experimentalFeatures.value = result.data;
        return result;
      } finally {
        if (isCurrentConnection(request)) experimentalFeaturesLoading.value = false;
      }
    }

    async function setExperimentalFeatureEnablement(name: string, enabled: boolean) {
      if (!adapter) throw new Error('Codex is not connected.');
      const result = await adapter.setExperimentalFeatureEnablement({ name, enabled });
      await refreshExperimentalFeatures();
      return result;
    }

    async function refreshCollaborationModes() {
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      collaborationModesLoading.value = true;
      try {
        const result: CodexCollaborationModeListResult = await request.sourceAdapter.listCollaborationModes();
        if (isCurrentConnection(request)) collaborationModes.value = Array.isArray(result.data) ? result.data : [];
        return result;
      } catch (error) {
        if (!isCurrentConnection(request)) return { data: [] };
        collaborationModes.value = [];
        if (typeof console !== 'undefined') {
          console.warn(
            '[Codex] collaborationMode/list failed (the experimental API may not be enabled on this Codex server):',
            error,
          );
        }
        return { data: [] };
      } finally {
        if (isCurrentConnection(request)) collaborationModesLoading.value = false;
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
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      await capabilityRegistry.run('thread/backgroundTerminals/clean', () =>
        request.sourceAdapter.cleanThreadBackgroundTerminals({ threadId }),
      );
    }

    async function respondToToolUserInput(
      requestId: CodexJsonRpcId,
      responses: Array<{ questionId: string; response: string }>,
    ) {
      if (!adapter) throw new Error('Codex is not connected.');
      adapter.respondToServerRequest(requestId, buildToolUserInputResponse(
        responses.map((response) => ({ questionId: response.questionId, answers: [response.response] })),
      ));
      toolUserInputRequests.value = toolUserInputRequests.value.filter((request) => request.requestId !== requestId);
    }

    async function respondToDynamicToolCall(
      requestId: CodexJsonRpcId,
      contentItems: CodexDynamicToolOutput[],
      success = true,
    ) {
      if (!adapter) throw new Error('Codex is not connected.');
      adapter.respondToServerRequest(requestId, buildDynamicToolCallResponse(contentItems, success));
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

  async function updateThreadMetadata(threadId: string, gitInfo: { branch?: string; sha?: string; root?: string; commonRoot?: string; worktreeRoot?: string } | null) {
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
      const request = captureConnection();
      if (!request) return;
      const result = await capabilityRegistry.run('thread/loaded/list', () =>
        request.sourceAdapter.listLoadedThreads(),
      );
      if (isCurrentConnection(request)) loadedThreadIds.value = result.data;
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

    async function fsRemove(path: string) {
      if (!adapter) throw new Error('Codex is not connected.');
      const resolved = expandPath(path);
      await adapter.removeFile({ path: resolved });
      if (previewFilePath.value === resolved) clearPreview();
      if (fsCwd.value) await readDirectory(fsCwd.value);
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
      if (fsCwd.value) await readDirectory(fsCwd.value);
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
     reconnectOnMount,
     url,
     bridgeToken,
     errorMessage,
     threads,
     activeThreadId,
     activeTurn,
     transcript,
      canonicalHistory,
      realtimeHistoryQueue,
      realtimeMessageAliases,
      realtimeStreamingPart,
     realtimeReasoningPart,
     realtimeToolParts,
	     events,
	     serverRequests,
	     permissionRequests,
	     elicitationRequests,
     pending,
     loadingThread,
     initialized,
     connected,
       visibleThreads,
      hiddenThreadIds,
      fsEntries,
      fsCwd,
      fsLoading,
      fsError,
      previewFileContent,
      previewFilePath,
      sandboxPath,
      selectedSandboxCwd,
      homeDir,
      fsBreadcrumbs,
      fsSuggestions,
      fsShowSuggestions,
      connect,
      restoreConnection,
      disconnectTransport,
     disconnect,
      refreshHomeDir,
      refreshThreads,
      preloadPanelData,
      selectThread,
     startThread,
     setThreadName,
     archiveThread,
     unsubscribeThread,
     interruptActiveTurn,
     forkThread,
     rollbackThread,
      hideThread,
      unhideThread,
      readDirectory,
     navigateToParent,
     navigateToPath,
     openAsSandbox,
     createThreadInSandbox,
      readFile,
      readFileRaw,
      decodeReadFileText,
      clearPreview,
      updatePathSuggestions,
      hidePathSuggestions,
	      resolveServerRequest,
	      replyPermissionRequest,
	      replyElicitationRequest,
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
	     accountUsage,
	     accountUsageLoading,
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
	      refreshAccountUsage,
	      refreshModelProviderCapabilities,
	      refreshPermissionProfiles,
	      refreshThreadGoal,
	      setThreadGoal,
	      clearThreadGoal,
      // New namespace state
       models,
	       modelsLoading,
	       modelProviderCapabilities,
	       modelProviderCapabilitiesLoading,
	       permissionProfiles,
	       permissionProfilesLoading,
	       threadGoal,
	       threadGoalThreadId,
	       threadGoalLoading,
       selectedModel,
       skills,
       skillsLoading,
      plugins,
      pluginMarketplaceCount,
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
       runtimeCapabilities: capabilityRegistry.states,
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
         listProviders,
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
        fsRemove,
       fsWatch,
       fsUnwatch,
       fsGetMetadata,
       fsCopy,
       writeCommandExec,
       terminateCommandExec,
     };
   }
