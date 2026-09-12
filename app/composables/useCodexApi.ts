import { codexReasoningText } from '../backends/codex/reasoning';
import { createCodexSubagentStreams } from '../backends/codex/subagentStreams';
import { createCodexThreadActivity } from '../backends/codex/threadActivity';
import { migrateCodexAuxiliaryHistory } from '../backends/codex/auxiliaryHistoryIdentity';
import { computed, ref, watch } from 'vue';
import {
  CodexAdapter,
  extractStatusType,
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
import { isUnmaterializedThreadError } from '../backends/codex/errors';
import { createCodexHistoryReader } from '../backends/codex/history';
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
  extractItemTranscriptEntries,
  type CodexTranscriptEntry,
} from '../backends/codex/transcriptEntries';
import {
  clearCodexAuxiliaryHistory,
  loadCodexAuxiliaryHistory,
  mergeCodexAuxiliaryHistory,
  saveCodexAuxiliaryHistory,
} from '../backends/codex/auxiliaryHistory';
import { restoreCodexMessageEfforts, saveCodexTurnEffort } from '../backends/codex/messageEffort';
import { initializeCodexAuxiliaryStorage } from '../backends/codex/auxiliaryStorage';
import { createCodexMessageModels } from '../backends/codex/messageModels';
import { codexRollbackCount } from '../backends/codex/rollbackTarget';
import type { ConfigMergeStrategy } from '../backends/types';
import { getPersistedCodexBridgeToken, getPersistedCodexBridgeUrl } from '../backends/registry';
import type {
  FilePart,
  MessageInfo,
  AssistantMessageInfo,
  MessagePart,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolState,
} from '../types/sse';
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

type CodexConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

type CodexEventEntry = {
  id: number;
  method: string;
  params?: unknown;
  time: number;
};

export type { CodexTranscriptEntry } from '../backends/codex/transcriptEntries';

type CodexApprovalContext = {
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

type CodexServerRequestEntry = {
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
  onTaskCompleted?: (completion: { sessionId: string; completionId: string }) => void;
};

type CodexConnectPhase = 'home' | 'handshake' | 'threads' | 'workspace' | 'panelData';

type CodexRealtimePartRecord<TPart extends MessagePart = MessagePart> = {
  info: MessageInfo;
  part: TPart;
  updatedAt: number;
};

type RealtimeToolCompletionState =
  | Extract<ToolState, { status: 'completed' }>
  | Extract<ToolState, { status: 'error' }>;

type RealtimeToolCompletionInput = {
  readonly state: ToolState;
  readonly finalizedState: ToolState | undefined;
  readonly tool: string;
  readonly finalOutput: string;
  readonly createdAt: number;
  readonly completedAt: number;
};

type RealtimeToolStateFields = {
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly time?: { readonly start: number };
};

type RealtimeToolCurrentStateFields = {
  readonly currentOutput: string;
  readonly currentTitle: string;
  readonly currentMetadata: Record<string, unknown>;
  readonly start: number;
  readonly codexStatus: string;
};

type RealtimeToolCompletionBase = {
  readonly state: ToolState;
  readonly finalizedState: ToolState | undefined;
  readonly finalOutput: string;
  readonly completedAt: number;
  readonly fallbackMetadata: Record<string, unknown>;
  readonly currentOutput: string;
  readonly output: string;
  readonly currentTitle: string;
  readonly currentMetadata: Record<string, unknown>;
  readonly start: number;
  readonly codexStatus: string;
};

function resolveRealtimeToolCurrentState(
  input: RealtimeToolCompletionInput,
): RealtimeToolCurrentStateFields {
  const state = input.state;
  const fallbackMetadata = { source: 'codex' };
  const stateFields: RealtimeToolStateFields = state;
  const stateMetadata: Record<string, unknown> = stateFields.metadata || fallbackMetadata;
  const currentOutputByStatus: Record<ToolState['status'], string> = {
    pending: '',
    running: typeof stateMetadata.output === 'string' ? stateMetadata.output : '',
    completed: stateFields.output || '',
    error: '',
  };
  const titleByStatus: Record<ToolState['status'], string> = {
    pending: input.tool,
    running: stateFields.title || input.tool,
    completed: stateFields.title || '',
    error: input.tool,
  };
  const codexStatusByStatus: Record<ToolState['status'], string> = {
    pending: '',
    running: typeof stateMetadata.codexStatus === 'string' ? stateMetadata.codexStatus : '',
    completed: '',
    error: '',
  };
  return {
    currentOutput: currentOutputByStatus[state.status],
    currentTitle: titleByStatus[state.status],
    currentMetadata: stateMetadata,
    start: stateFields.time ? stateFields.time.start : input.createdAt,
    codexStatus: codexStatusByStatus[state.status],
  };
}

function resolveRealtimeToolCompletionBase(
  input: RealtimeToolCompletionInput,
): RealtimeToolCompletionBase {
  const current = resolveRealtimeToolCurrentState(input);
  const fallbackMetadata = { source: 'codex' };
  const finalState = input.finalizedState || { status: 'none' as const };
  const finalizedOutput = finalState.status === 'completed' ? finalState.output : undefined;
  const output = input.finalOutput
    ? `${current.currentOutput}${input.finalOutput}`
    : ([finalizedOutput, current.currentOutput].find(Boolean) ?? '');
  return {
    state: input.state,
    finalizedState: input.finalizedState,
    finalOutput: input.finalOutput,
    completedAt: input.completedAt,
    fallbackMetadata,
    ...current,
    output,
  };
}

function buildRealtimeToolSuccessState(
  base: RealtimeToolCompletionBase,
): Extract<ToolState, { status: 'completed' }> {
  const finalState = base.finalizedState || { status: 'none' as const };
  return {
    status: 'completed',
    input: finalState.status === 'completed' ? finalState.input : base.state.input,
    output: base.output,
    title: finalState.status === 'completed' ? finalState.title : base.currentTitle,
    metadata:
      finalState.status === 'completed'
        ? finalState.metadata || base.fallbackMetadata
        : base.currentMetadata,
    time: { start: base.start, end: base.completedAt },
  };
}

function buildRealtimeToolErrorState(
  base: RealtimeToolCompletionBase,
): Extract<ToolState, { status: 'error' }> {
  const finalState = base.finalizedState || { status: 'none' as const };
  const output = base.output;
  const fallbackError =
    [output, base.codexStatus, 'Codex tool failed'].find(Boolean) || 'Codex tool failed';
  return {
    status: 'error',
    input:
      finalState.status === 'completed' || finalState.status === 'error'
        ? finalState.input
        : base.state.input,
    error: finalState.status === 'error' ? finalState.error : fallbackError,
    metadata:
      finalState.status === 'completed' || finalState.status === 'error'
        ? finalState.metadata || base.fallbackMetadata
        : base.currentMetadata,
    time: { start: base.start, end: base.completedAt },
  };
}

function resolveRealtimeToolCompletion(
  input: RealtimeToolCompletionInput,
): RealtimeToolCompletionState {
  const base = resolveRealtimeToolCompletionBase(input);
  const finalState = base.finalizedState || { status: 'none' as const };
  const failedWhileRunning =
    base.state.status === 'running' && ['declined', 'failed'].includes(base.codexStatus);
  const isError = [
    finalState.status === 'error',
    base.state.status === 'error',
    failedWhileRunning,
  ].some(Boolean);
  if (isError) return buildRealtimeToolErrorState(base);
  return buildRealtimeToolSuccessState(base);
}

function fileResultToDataUrl(path: string, result: CodexFsReadFileResult): string | undefined {
  const base64 =
    typeof result.dataBase64 === 'string'
      ? result.dataBase64
      : typeof result.content === 'string' && result.encoding === 'base64'
        ? result.content
        : undefined;
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
  const pickGreater = (a: number | undefined, b: number | undefined): number | undefined => {
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

function isThreadGoal(value: unknown): value is CodexThreadGoal {
  if (!isRecord(value)) return false;
  return (
    typeof value.threadId === 'string' &&
    typeof value.objective === 'string' &&
    (value.status === 'active' ||
      value.status === 'paused' ||
      value.status === 'blocked' ||
      value.status === 'usageLimited' ||
      value.status === 'budgetLimited' ||
      value.status === 'complete') &&
    (value.tokenBudget === null || typeof value.tokenBudget === 'number') &&
    typeof value.tokensUsed === 'number' &&
    typeof value.timeUsedSeconds === 'number' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

function extractThread(value: unknown): CodexThread | null {
  if (!isRecord(value)) return null;
  const thread = isRecord(value.thread) ? value.thread : value;
  return typeof thread.id === 'string' ? (thread as CodexThread) : null;
}

function extractTurn(value: unknown): CodexTurn | null {
  if (!isRecord(value)) return null;
  const turn = isRecord(value.turn) ? value.turn : value;
  return typeof turn.id === 'string' ? (turn as CodexTurn) : null;
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

function extractItemDelta(params: unknown) {
  const record = isRecord(params) ? params : null;
  return {
    itemId: typeof record?.itemId === 'string' ? record.itemId : '',
    delta: typeof record?.delta === 'string' ? record.delta : '',
  };
}

function isTextPart(part: MessagePart): part is TextPart {
  return part.type === 'text';
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
    'accept',
    'acceptForSession',
    'decline',
    'cancel',
    'acceptWithExecpolicyAmendment',
  ]),
  'item/fileChange/requestApproval': new Set(['accept', 'acceptForSession', 'decline', 'cancel']),
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
    context.proposedAmendment = amendment.filter(
      (item): item is string => typeof item === 'string',
    );
  }

  // Command actions
  if (Array.isArray(params.commandActions)) context.commandActions = params.commandActions;

  // Additional permissions (experimental)
  if (Array.isArray(params.additionalPermissions))
    context.additionalPermissions = params.additionalPermissions;

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
    ? request.params.availableDecisions.filter(
        (decision): decision is string =>
          typeof decision === 'string' && allowedDecisions.has(decision),
      )
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
  const threadActivity = createCodexThreadActivity();
  let threadStatusRevision = 0;
  const liveThreadStatuses = new Map<string, { revision: number; status: unknown }>();
  watch(
    () => threads.value.map((thread) => [thread.id, thread.status] as const),
    (states) => {
      for (const [id, threadStatus] of states) threadActivity.observe(id, threadStatus);
    },
    { flush: 'sync' },
  );
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
  const messageModels = createCodexMessageModels(() => url.value);
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
  const collaborationModesError = ref<string | null>(null);
  const configRequirements = ref<CodexConfigRequirementsReadResult['requirements']>(null);
  const configRequirementsLoading = ref(false);
  const externalAgentConfigItems = ref<CodexExternalAgentConfigItem[]>([]);
  const externalAgentConfigLoading = ref(false);
  const externalAgentImportStatus = ref<{ success: boolean; error?: string } | null>(null);
  const windowsSandboxStatus = ref<{
    mode: string;
    success: boolean;
    error?: string | null;
  } | null>(null);
  const fuzzySearchResults = ref<Array<{ path: string; score: number }>>([]);
  const fuzzySearchQuery = ref('');
  const toolUserInputRequests = ref<CodexToolUserInputRequest[]>([]);
  const dynamicToolCalls = ref<CodexDynamicToolCallRequest[]>([]);
  const realtimeHistoryQueue = ref<CodexCanonicalHistoryEntry[]>([]);
  const realtimeMessageAliases = ref<Record<string, string>>({});
  const realtimeCompletedPart = ref<CodexRealtimePartRecord<ToolPart> | null>(null);
  const realtimeSubagentPart = ref<{ parentThreadId: string; info: AssistantMessageInfo; part: MessagePart } | null>(null);
  const subscribedSubagents = new Set<string>();
  let subagentStreamGeneration = 0;
  const subagentStreams = createCodexSubagentStreams({
    getSelectedParent: () => activeThreadId.value,
    publish: (info, part) => { realtimeSubagentPart.value = { parentThreadId: activeThreadId.value, info, part }; },
    onDiscover: (threadId, live) => { void subscribeSubagent(threadId, live); },
  });

  async function subscribeSubagent(threadId: string, live: boolean) {
    const request = captureConnection();
    const parentId = activeThreadId.value;
    const generation = subagentStreamGeneration;
    if (!request || !parentId) return;
    const current = () => isCurrentConnection(request) && activeThreadId.value === parentId && generation === subagentStreamGeneration;
    try {
      const read = await request.sourceAdapter.readThread({ threadId, includeTurns: true });
      if (!current() || read.thread.id !== threadId) return;
      subagentStreams.registerHistory(read.thread);
      if (!live && extractStatusType(read.thread.status) !== 'active') return;
      subscribedSubagents.add(threadId);
      const resumed = await request.sourceAdapter.resumeThread({ threadId });
      if (!current()) {
        if (isCurrentConnection(request) && activeThreadId.value !== threadId && !subscribedSubagents.has(threadId)) {
          await request.sourceAdapter.unsubscribeThread({ threadId });
        }
        return;
      }
      subagentStreams.registerHistory(resumed.thread, undefined, live);
    } catch {
      if (current()) console.warn('[codex] Unable to subscribe to subagent activity', threadId);
    }
  }

  function resetSubagentStreams() {
    subagentStreamGeneration += 1;
    subagentStreams.reset();
    realtimeSubagentPart.value = null;
    for (const threadId of subscribedSubagents) {
      if (adapter && threadId !== activeThreadId.value) void adapter.unsubscribeThread({ threadId }).catch(() => {
        console.warn('[codex] Unable to unsubscribe from subagent activity', threadId);
      });
    }
    subscribedSubagents.clear();
  }
  watch(activeThreadId, resetSubagentStreams, { flush: 'sync' });
  const realtimeStreamingPart = ref<CodexRealtimePartRecord<TextPart> | null>(null);
  const realtimeReasoningPart = ref<CodexRealtimePartRecord<ReasoningPart> | null>(null);
  const realtimeToolParts = ref<Array<CodexRealtimePartRecord<ToolPart>>>([]);

  watch(
    realtimeHistoryQueue,
    (entries) => {
      const threadIds = new Set(entries.map((entry) => entry.info.sessionID));
      for (const threadId of threadIds) saveCodexAuxiliaryHistory(threadId, entries);
    },
    { flush: 'sync' },
  );

  // New state for high/medium priority APIs
  const planItems = ref<
    Array<{
      threadId: string;
      turnId: string;
      explanation?: string;
      plan: Array<{ step: string; status: string }>;
    }>
  >([]);
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
  const historyReaders = new WeakMap<CodexAdapter, ReturnType<typeof createCodexHistoryReader>>();
  let unsubscribeNotifications: (() => void) | null = null;
  let unsubscribeServerRequests: (() => void) | null = null;
  let nextEventId = 1;
  let nextTranscriptId = 1;
  let threadSelectionGeneration = 0;
  let accountRefreshGeneration = 0;
  let threadGoalRefreshGeneration = 0;
  let collaborationModesRefreshGeneration = 0;
  let pluginsRefreshGeneration = 0;
  let connectionGeneration = 0;
  type ConnectionRequest = { sourceAdapter: CodexAdapter; generation: number };
  type ThreadGoalMutation = {
    readonly request: ConnectionRequest;
    readonly threadId: string;
    readonly isCurrent: () => boolean;
  };
  const observedTurnIdsByThread = new Map<string, string[]>();
  const invalidatedTurnIdsByThread = new Map<string, Set<string>>();
  const liveTurnGenerations = new Map<string, number>();

  function liveTurnKey(threadId: string, turnId: string) {
    return `${threadId}\0${turnId}`;
  }

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

  function beginThreadGoalMutation(): ThreadGoalMutation {
    const request = captureConnection();
    if (!request || !activeThreadId.value) throw new Error('Codex thread is not selected.');
    const threadId = activeThreadId.value;
    if (threadGoalThreadId.value !== threadId) throw new Error('Codex thread goal is not loaded.');
    const refreshGeneration = ++threadGoalRefreshGeneration;
    threadGoalLoading.value = true;
    return {
      request,
      threadId,
      isCurrent: () =>
        isCurrentConnection(request) &&
        threadGoalRefreshGeneration === refreshGeneration &&
        activeThreadId.value === threadId,
    };
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
    const factory =
      initialOptions.adapterFactory ??
      ((options: CodexAdapterOptions) => new CodexAdapter(options));
    return factory({
      url: appendCodexBridgeToken(url.value.trim(), bridgeToken.value.trim() || undefined),
      experimentalApi: true,
    });
  }

  function reconcileThreadStatus(thread: CodexThread, revision: number): CodexThread {
    const live = liveThreadStatuses.get(thread.id);
    const existing = threads.value.find((item) => item.id === thread.id);
    return {
      ...thread,
      status: live && live.revision > revision ? live.status : (thread.status ?? existing?.status),
    };
  }

  function updateThreadStatus(threadId: string, threadStatus: unknown) {
    liveThreadStatuses.set(threadId, { revision: ++threadStatusRevision, status: threadStatus });
    upsertThread({ id: threadId, status: threadStatus }, false);
  }

  function upsertThread(thread: CodexThread, refreshGitInfo = true, revision = threadStatusRevision) {
    thread = reconcileThreadStatus(thread, revision);
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
    if (refreshGitInfo && !normalizedThread.gitInfo?.root)
      void upsertThreadWithGitInfo(normalizedThread);
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

  function createTranscriptEntry(
    role: CodexTranscriptEntry['role'],
    text: string,
    modelName?: string,
  ) {
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
    subagentStreams.registerHistory({ id: activeThreadId.value, turns });
    assistantTranscriptIds.clear();
    const activeThread = threads.value.find((thread) => thread.id === activeThreadId.value);
    for (const turn of turns) recordObservedTurnId(activeThreadId.value, turn.id);
    const selectedModelInfo = parseSelectedCodexModel(selectedModel.value);
    const modelName = selectedModelInfo.modelID || selectedModelInfo.providerID;
    canonicalHistory.value = messageModels.restore(activeThreadId.value, restoreCodexMessageEfforts(activeThreadId.value, normalizeCodexTurnsToHistory({
      sessionId: activeThreadId.value ?? 'codex-thread',
      turns,
      model: {
        providerID: activeThread?.modelProvider || selectedModelInfo.providerID,
        modelID: selectedModelInfo.modelID || undefined,
      },
    })), [...canonicalHistory.value, ...realtimeHistoryQueue.value]);
    const textEntries = canonicalHistory.value.flatMap((entry) => {
      const role = entry.info.role === 'assistant' ? 'assistant' : 'user';
      return entry.parts
        .filter((part): part is TextPart => isTextPart(part) && Boolean(part.text))
        .map((part) => createTranscriptEntry(role, part.text, modelName));
    });
    const systemEntries = turns.flatMap((turn) => {
      const items = Array.isArray(turn.items) ? turn.items : [];
      return items
        .flatMap((item) =>
          extractItemTranscriptEntries(item, (role, text) =>
            createTranscriptEntry(role, text, modelName),
          ),
        )
        .filter((entry) => entry.role === 'system');
    });
    transcript.value = [...textEntries, ...systemEntries];
  }

  const assistantTranscriptIds = new Map<string, number>();
  const assistantContexts = new Map<string, { parentId: string; createdAt: number }>();
  const observedTurnUsers = new Map<string, Set<string>>();
  let latestAssistantCreatedAt = 0;

  function updateAssistantItem(sessionId: string, turnId: string, itemId: string, text: string, completed: boolean, createdAt?: number) {
    const messageId = codexAssistantMessageId(turnId, itemId || 'pending');
    const previous = realtimeStreamingPart.value;
    const sameItem = previous?.info.id === messageId;
    const provisional = previous?.info.id === codexAssistantMessageId(turnId, 'pending');
    const now = Date.now();
    if (previous && !sameItem && !provisional && previous.part.text) {
      mergeRealtimeHistoryEntry({ info: previous.info, parts: [previous.part] });
    }
    if (provisional && itemId) {
      realtimeMessageAliases.value = { ...realtimeMessageAliases.value, [previous.info.id]: messageId };
      realtimeHistoryQueue.value = realtimeHistoryQueue.value.filter(entry => entry.info.id !== previous.info.id);
    }
    const stored = realtimeHistoryQueue.value.find(entry => entry.info.id === messageId);
    const storedText = stored?.parts.find((part): part is TextPart => part.type === 'text');
    const currentText = sameItem || provisional ? previous?.part.text ?? '' : storedText?.text ?? '';
    const info = previous && (sameItem || provisional) ? { ...previous.info, id: messageId }
      : createCodexAssistantInfo(sessionId, messageId, createdAt ?? now, currentRealtimeParentId(sessionId, turnId));
    const part: TextPart = {
      id: codexAssistantTextPartId(turnId, itemId || 'pending'), sessionID: sessionId, messageID: messageId,
      type: 'text', text: completed ? text : currentText + text,
      time: { start: sameItem || provisional ? previous?.part.time?.start ?? info.time.created : storedText?.time?.start ?? info.time.created, ...(completed ? { end: now } : {}) },
    };
    if (!completed || !stored || sameItem || provisional) realtimeStreamingPart.value = { info, part, updatedAt: now };
    mergeRealtimeHistoryEntry({ info, parts: [part] });
    const transcriptId = assistantTranscriptIds.get(messageId)
      ?? (provisional ? assistantTranscriptIds.get(previous.info.id) : undefined);
    const transcriptIndex = transcript.value.findIndex(entry => entry.id === transcriptId);
    const transcriptEntry = transcript.value[transcriptIndex];
    if (transcriptEntry) {
      transcript.value[transcriptIndex] = { ...transcriptEntry, text: part.text };
    } else {
      const entry = createTranscriptEntry('assistant', part.text, currentSelectedModelName());
      transcript.value.push(entry);
      assistantTranscriptIds.set(messageId, entry.id);
    }
    if (transcriptId !== undefined) assistantTranscriptIds.set(messageId, transcriptId);
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

  function createCodexAssistantInfo(
    sessionId: string,
    messageId: string,
    createdAt: number,
    parentId = '',
  ): MessageInfo {
    parentId = realtimeMessageAliases.value[parentId] || parentId;
    const existing = [
      realtimeStreamingPart.value?.info,
      ...realtimeHistoryQueue.value.map(entry => entry.info),
      ...canonicalHistory.value.map(entry => entry.info),
      realtimeReasoningPart.value?.info,
      ...realtimeToolParts.value.map(entry => entry.info),
    ].find(info => info?.id === messageId && info.sessionID === sessionId && info.role === 'assistant');
    if (existing?.role === 'assistant') {
      return { ...existing, parentID: realtimeMessageAliases.value[existing.parentID] || existing.parentID || parentId };
    }
    const parentKey = `${sessionId}:${messageId}`;
    const context = assistantContexts.get(parentKey);
    parentId = context?.parentId || parentId;
    if (context) createdAt = context.createdAt;
    else {
      createdAt = Math.max(createdAt, latestAssistantCreatedAt + 1);
      latestAssistantCreatedAt = createdAt;
      assistantContexts.set(parentKey, { parentId, createdAt });
    }
    parentId = realtimeMessageAliases.value[parentId] || parentId;
    const model = parseSelectedCodexModel(selectedModel.value);
    const parent = [...realtimeHistoryQueue.value, ...canonicalHistory.value]
      .find(entry => entry.info.id === parentId && entry.info.sessionID === sessionId);
    return {
      id: messageId,
      sessionID: sessionId,
      role: 'assistant',
      time: { created: createdAt },
      parentID: parentId,
      modelID: parent?.info.role === 'user' ? parent.info.model.modelID : model.modelID || 'codex',
      providerID: parent?.info.role === 'user' ? parent.info.model.providerID : model.providerID,
      variant: parent?.info.variant,
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

  function currentRealtimeParentId(sessionId?: string, turnId?: string) {
    const targetSessionId = sessionId?.trim() || activeThreadId.value || '';
    const entries = [...canonicalHistory.value, ...realtimeHistoryQueue.value];
    if (turnId) {
      const user = entries.filter(entry => entry.info.role === 'user'
        && entry.info.id.startsWith(`${turnId}:user:`)
        && entry.info.sessionID === targetSessionId)
        .sort((left, right) => left.info.time.created - right.info.time.created).at(-1);
      if (user) return user.info.id;
    }
    return entries.reverse().find(entry => entry.info.role === 'user' && (
      entry.info.sessionID === targetSessionId || entry.info.sessionID === 'codex-pending'
    ))?.info.id || '';
  }

  function finalizeRealtimeUser(provisionalId: string, messageId: string, sessionId: string, variant?: string) {
    realtimeHistoryQueue.value = dedupeRealtimeHistoryQueue(realtimeHistoryQueue.value.map(entry => {
      if (entry.info.id === messageId) return { ...entry, info: { ...entry.info, variant: variant ?? entry.info.variant } };
      if (entry.info.id !== provisionalId) return entry;
      return {
        info: { ...entry.info, id: messageId, sessionID: sessionId, variant: variant ?? entry.info.variant },
        parts: entry.parts.map(part => ({
          ...part,
          id: part.id.startsWith(`${provisionalId}:`) ? `${messageId}${part.id.slice(provisionalId.length)}` : part.id,
          sessionID: sessionId,
          messageID: messageId,
        })),
      };
    }));
    realtimeMessageAliases.value = { ...realtimeMessageAliases.value, [provisionalId]: messageId };
    const reparent = (info: MessageInfo): MessageInfo => info.role === 'assistant' && info.parentID === provisionalId
      ? { ...info, parentID: messageId } : info;
    realtimeHistoryQueue.value = realtimeHistoryQueue.value.map(entry => ({ ...entry, info: reparent(entry.info) }));
    realtimeToolParts.value = realtimeToolParts.value.map(entry => ({ ...entry, info: reparent(entry.info) }));
    if (realtimeReasoningPart.value) realtimeReasoningPart.value = { ...realtimeReasoningPart.value, info: reparent(realtimeReasoningPart.value.info) };
    if (realtimeStreamingPart.value) realtimeStreamingPart.value = { ...realtimeStreamingPart.value, info: reparent(realtimeStreamingPart.value.info) };
    if (realtimeCompletedPart.value) realtimeCompletedPart.value = { ...realtimeCompletedPart.value, info: reparent(realtimeCompletedPart.value.info) };
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
    let fileIndex = 0;
    inputItems?.forEach((item, index) => {
      if (item.type === 'image') {
        const mimeMatch = item.url.match(/^data:([^;,]+)/u);
        const mime = mimeMatch?.[1] || 'image/*';
        const extension = mime.split('/')[1]?.split('+')[0] || 'img';
        parts.push({
          id: `${messageId}:file:${fileIndex++}`,
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
          id: `${messageId}:file:${fileIndex++}`,
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

  function setRealtimeReasoningCompleted(completedAt = Date.now(), turnId?: string) {
    if (!realtimeReasoningPart.value || realtimeReasoningPart.value.part.time.end != null) return;
    if (turnId && !realtimeReasoningPart.value.part.messageID.startsWith(`${turnId}:assistant:`)) return;
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

  function completeRealtimeToolPart(
    partId: string,
    finalizedPart?: ToolPart | null,
    finalOutput = '',
  ) {
    const index = realtimeToolParts.value.findIndex((entry) => entry.part.id === partId);
    if (index === -1) return null;
    const current = realtimeToolParts.value[index];
    if (!current) return null;
    const completedAt = Date.now();
    const resolvedState = resolveRealtimeToolCompletion({
      state: current.part.state,
      finalizedState: finalizedPart?.state,
      tool: current.part.tool,
      finalOutput,
      createdAt: current.info.time.created,
      completedAt,
    });
    const completedPart: ToolPart = {
      ...current.part,
      ...(finalizedPart
        ? { ...finalizedPart, id: current.part.id, callID: current.part.callID }
        : {}),
      state: resolvedState,
    };
    realtimeToolParts.value = realtimeToolParts.value.filter(
      (_, entryIndex) => entryIndex !== index,
    );
    const info = current.info;
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
    if (entry.info.role === 'assistant') {
      entry = { ...entry, info: createCodexAssistantInfo(entry.info.sessionID, entry.info.id, entry.info.time.created, entry.info.parentID) };
    } else {
      entry = messageModels.restore(entry.info.sessionID, [entry], [...canonicalHistory.value, ...realtimeHistoryQueue.value])[0] ?? entry;
    }
    const existingIndex = realtimeHistoryQueue.value.findIndex(
      (current) => current.info.id === entry.info.id,
    );
    if (existingIndex === -1) {
      const known = canonicalHistory.value.find(current =>
        current.info.id === entry.info.id && current.info.sessionID === entry.info.sessionID,
      );
      realtimeHistoryQueue.value = dedupeRealtimeHistoryQueue([
        ...realtimeHistoryQueue.value,
        known ? { ...entry, info: { ...entry.info, time: known.info.time, variant: entry.info.variant ?? known.info.variant } } : entry,
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
      info: { ...entry.info, time: existing.info.time, variant: entry.info.variant ?? existing.info.variant },
      parts: Array.from(partsById.values()),
    };
    realtimeHistoryQueue.value = dedupeRealtimeHistoryQueue(nextQueue);
  }

  const realtimeImageRequests = new Map<string, symbol>();
  function isLocalImage(part: MessagePart): part is FilePart {
    return part.type === 'file' && part.mime.startsWith('image/') && !/^(data:|https?:|blob:)/u.test(part.url);
  }

  function mergeRealtimeHistoryBundle(bundle: { messages: MessageInfo[]; parts: MessagePart[] }, request: ConnectionRequest, turnId: string) {
    const selectionGeneration = threadSelectionGeneration;
    for (const info of bundle.messages) {
      mergeRealtimeHistoryEntry({
        info,
        parts: bundle.parts.filter((part) => part.messageID === info.id && !isLocalImage(part)),
      });
      for (const part of bundle.parts.filter((part) => part.messageID === info.id)) {
        const token = Symbol(part.id);
        realtimeImageRequests.set(part.id, token);
        if (!isLocalImage(part)) {
          realtimeImageRequests.delete(part.id);
          continue;
        }
        void hydrateThreadImages([{ info, parts: [part] }], request.sourceAdapter).then(([hydrated]) => {
          if (!isCurrentConnection(request) || selectionGeneration !== threadSelectionGeneration ||
              activeThreadId.value !== info.sessionID || isInvalidatedTurnId(info.sessionID, turnId) ||
              realtimeImageRequests.get(part.id) !== token) return;
          if (hydrated) mergeRealtimeHistoryEntry({ ...hydrated, parts: hydrated.parts.filter(part => !isLocalImage(part)) });
        }).finally(() => {
          if (realtimeImageRequests.get(part.id) === token) realtimeImageRequests.delete(part.id);
        });
      }
    }
  }

  function persistRealtimeAuxiliaryHistory(threadId: string) {
    if (!threadId) return;
    const entries = [...realtimeHistoryQueue.value];
    if (realtimeReasoningPart.value) {
      entries.push({
        info: realtimeReasoningPart.value.info,
        parts: [realtimeReasoningPart.value.part],
      });
    }
    for (const tool of realtimeToolParts.value) {
      entries.push({ info: tool.info, parts: [tool.part] });
    }
    saveCodexAuxiliaryHistory(threadId, entries);
  }

  function persistCompletedAuxiliaryNotification(
    threadId: string,
    turnId: string,
    item: Record<string, unknown>,
  ) {
    if (typeof item.type !== 'string') return;
    const bundle = normalizeCodexTurnItems({
      sessionId: threadId,
      turnId: turnId || `${threadId}:realtime`,
      items: [item],
      parentMessageId: turnId ? codexUserMessageId(turnId, 0) : undefined,
    });
    const entries = bundle.messages.map((info) => ({
      info: info.role === 'assistant'
        ? createCodexAssistantInfo(threadId, info.id, info.time.created,
          [...(observedTurnUsers.get(liveTurnKey(threadId, turnId)) ?? [])].at(-1) || info.parentID)
        : info,
      parts: bundle.parts.filter((part) => part.messageID === info.id),
    }));
    saveCodexAuxiliaryHistory(
      threadId,
      mergeCodexAuxiliaryHistory(threadId, loadCodexAuxiliaryHistory(threadId), entries),
    );
  }

  function handleNotification(notification: CodexJsonRpcNotification, request: ConnectionRequest) {
    if (!isCurrentConnection(request)) return;
    events.value.push({
      id: nextEventId,
      method: notification.method,
      params: notification.params,
      time: Date.now(),
    });
    nextEventId += 1;

    const notificationParams = isRecord(notification.params) ? notification.params : null;
    const notificationThreadId =
      typeof notificationParams?.threadId === 'string' ? notificationParams.threadId : '';
    const notificationTurnId =
      typeof notificationParams?.turnId === 'string' ? notificationParams.turnId : '';
    if (
      notificationThreadId &&
      notificationThreadId === activeThreadId.value &&
      (notification.method === 'thread/goal/updated' ||
        notification.method === 'thread/goal/cleared')
    ) {
      const goal = notificationParams?.goal;
      if (
        notification.method === 'thread/goal/updated' &&
        (!isThreadGoal(goal) || goal.threadId !== notificationThreadId)
      ) return;
      threadGoalRefreshGeneration += 1;
      threadGoal.value =
        isThreadGoal(goal) && notification.method === 'thread/goal/updated' ? goal : null;
      threadGoalThreadId.value = notificationThreadId;
      threadGoalLoading.value = false;
    }
    if (notificationThreadId && notificationTurnId) {
      if (isInvalidatedTurnId(notificationThreadId, notificationTurnId)) return;
      recordObservedTurnId(notificationThreadId, notificationTurnId);
    }
    subagentStreams.handle(notification);
    const userItem = isRecord(notificationParams?.item) ? notificationParams.item : null;
    if ((notification.method === 'item/started' || notification.method === 'item/completed')
      && notificationThreadId && notificationTurnId && userItem?.type === 'userMessage') {
      const identity = typeof userItem.clientId === 'string' && userItem.clientId.trim()
        ? userItem.clientId.trim() : typeof userItem.id === 'string' ? userItem.id.trim() : '';
      if (identity) {
        const key = liveTurnKey(notificationThreadId, notificationTurnId);
        const users = observedTurnUsers.get(key) ?? new Set<string>();
        users.add(codexUserMessageId(notificationTurnId, identity));
        observedTurnUsers.set(key, users);
      }
    }
    if ((notification.method === 'item/started' || notification.method === 'item/completed')
      && userItem?.type === 'userMessage' && typeof userItem.clientId === 'string'
      && notificationThreadId === activeThreadId.value) {
      const turnId = notificationTurnId || activeTurn.value?.id;
      if (turnId) {
        finalizeRealtimeUser(codexUserMessageId(`pending-turn:${userItem.clientId}`), codexUserMessageId(turnId, userItem.clientId), notificationThreadId);
      }
    }
    if (notification.method === 'turn/started' || notification.method === 'turn/completed') {
      const turn = extractTurn(notification.params);
      const threadId = notificationThreadId || activeThreadId.value;
      const turnId = turn?.id || notificationTurnId;
      if (threadId && turnId) {
        threadActivity.markParticipated(threadId);
        updateThreadStatus(threadId, notification.method === 'turn/started' ? 'active' : 'idle');
        const key = liveTurnKey(threadId, turnId);
        if (notification.method === 'turn/started') {
          liveTurnGenerations.set(key, request.generation);
        } else {
          const startedGeneration = liveTurnGenerations.get(key);
          liveTurnGenerations.delete(key);
          if (turn?.status === 'completed' && startedGeneration === request.generation) {
            initialOptions.onTaskCompleted?.({ sessionId: threadId, completionId: turnId });
          }
        }
      }
    }
    const isRealtimeThreadNotification =
      notification.method.startsWith('item/') ||
      notification.method.startsWith('turn/') ||
      notification.method.startsWith('command/');
    if (
      isRealtimeThreadNotification &&
      notificationThreadId &&
      notificationThreadId !== activeThreadId.value
    ) {
      if (notification.method === 'item/started' && userItem && userItem.type !== 'userMessage' && typeof userItem.id === 'string') {
        const parentId = [...(observedTurnUsers.get(liveTurnKey(notificationThreadId, notificationTurnId)) ?? [])].at(-1);
        if (parentId) createCodexAssistantInfo(notificationThreadId, codexAssistantMessageId(notificationTurnId, userItem.id), Date.now(), parentId);
      }
      if (notification.method === 'item/completed' && isRecord(notificationParams?.item)) {
        persistCompletedAuxiliaryNotification(
          notificationThreadId,
          notificationTurnId,
          notificationParams.item,
        );
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
      notification.method === 'thread/archived' ||
      notification.method === 'thread/unarchived' ||
      notification.method === 'thread/closed'
    ) {
      void refreshThreads();
      return;
    }

    if (notification.method === 'thread/status/changed') {
      if (notificationThreadId && extractStatusType(notificationParams?.status)) {
        updateThreadStatus(notificationThreadId, notificationParams?.status);
      } else {
        void refreshThreads();
      }
      return;
    }

    if (notification.method === 'serverRequest/resolved') {
      const params = isRecord(notification.params) ? notification.params : null;
      const requestId = params?.requestId;
      serverRequests.value = serverRequests.value.filter((request) => {
        const requestParams = isRecord(request.params) ? request.params : null;
        return (
          request.id !== requestId &&
          requestParams?.requestId !== requestId &&
          requestParams?.itemId !== requestId
        );
      });
      toolUserInputRequests.value = toolUserInputRequests.value.filter(
        (request) => request.requestId !== requestId,
      );
      dynamicToolCalls.value = dynamicToolCalls.value.filter(
        (request) => request.requestId !== requestId,
      );
      permissionRequests.value = permissionRequests.value.filter(
        (request) => request.requestId !== requestId,
      );
      elicitationRequests.value = elicitationRequests.value.filter(
        (request) => request.requestId !== requestId,
      );
      return;
    }

    if (notification.method === 'turn/started' || notification.method === 'turn/completed') {
      const turn = extractTurn(notification.params);
      if (turn) activeTurn.value = turn;
      pruneServerRequestsForActiveContext();
      if (notification.method === 'turn/completed') {
        setRealtimeAssistantCompleted();
        setRealtimeReasoningCompleted(Date.now(), turn?.id);
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
        const sessionId = notificationThreadId || activeThreadId.value || 'codex-thread';
        const turnId = notificationTurnId || activeTurn.value?.id || `${sessionId}:realtime`;
        updateAssistantItem(sessionId, turnId, typeof item.id === 'string' ? item.id : '', item.text, true, typeof item.createdAt === 'number' ? item.createdAt : undefined);
      }
      if (isRecord(item) && item.type === 'reasoning') {
        if (realtimeReasoningPart.value && realtimeReasoningPart.value.part.id === item.id) {
          const completedAt = Date.now();
          const current = realtimeReasoningPart.value;
          const finalPart: ReasoningPart = {
            ...current.part,
            text: codexReasoningText(item) || current.part.text,
            time: { start: current.part.time.start, end: completedAt },
          };
          realtimeReasoningPart.value = { ...current, part: finalPart, updatedAt: completedAt };
          mergeRealtimeHistoryEntry({ info: current.info, parts: [finalPart] });
        }
      }
      const realtimeSessionId = notificationThreadId || activeThreadId.value || 'codex-thread';
      const realtimeTurnId =
        notificationTurnId || activeTurn.value?.id || `${realtimeSessionId}:realtime`;
      const normalizedBundle =
        isRecord(item) && typeof item.type === 'string'
          ? normalizeCodexTurnItems({
              sessionId: realtimeSessionId,
              turnId: realtimeTurnId,
              items: [item],
              parentMessageId: currentRealtimeParentId(realtimeSessionId, realtimeTurnId),
            })
          : null;
      const normalizedToolPart =
        normalizedBundle?.parts.find((part): part is ToolPart => part.type === 'tool') ?? null;
      const completedReasoning = normalizedBundle?.parts.find((part): part is ReasoningPart => part.type === 'reasoning');
      const completedInfo = normalizedBundle?.messages.find((info) => info.role === 'assistant');
      if (completedReasoning && completedInfo && realtimeReasoningPart.value?.part.id !== completedReasoning.id) {
        realtimeReasoningPart.value = {
          info: completedInfo,
          part: { ...completedReasoning, time: { ...completedReasoning.time, end: Date.now() } },
          updatedAt: Date.now(),
        };
      }
      if (normalizedToolPart?.tool === 'task' && completedInfo) {
        realtimeCompletedPart.value = { info: completedInfo, part: normalizedToolPart, updatedAt: Date.now() };
      }
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
          const finalOutput =
            typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
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
          mergeRealtimeHistoryBundle(bundle, request, realtimeTurnId);
        }
      }
      return;
    }

    if (notification.method === 'item/agentMessage/delta') {
      const delta = extractAgentDelta(notification.params);
      const params = isRecord(notification.params) ? notification.params : null;
      const sessionId = notificationThreadId || activeThreadId.value || 'codex-thread';
      const turnId = notificationTurnId || activeTurn.value?.id || `${sessionId}:realtime`;
      if (delta) updateAssistantItem(sessionId, turnId, typeof params?.itemId === 'string' ? params.itemId : '', delta, false);
      return;
    }

    // Review mode notifications and tool item bridging
    if (notification.method === 'item/started') {
      const params = isRecord(notification.params) ? notification.params : null;
      const item = isRecord(params?.item) ? params.item : null;
      const sessionId = notificationThreadId || activeThreadId.value || 'codex-thread';
      const turnId = notificationTurnId || activeTurn.value?.id || `${sessionId}:realtime`;
      if (item?.type === 'userMessage') {
        mergeRealtimeHistoryBundle(normalizeCodexTurnItems({ sessionId, turnId, items: [item] }), request, turnId);
        return;
      }
      if (item?.type === 'agentMessage' && typeof item.id === 'string') {
        createCodexAssistantInfo(sessionId, codexAssistantMessageId(turnId, item.id), Date.now(), currentRealtimeParentId(sessionId, turnId));
        return;
      }
      if (item?.type === 'enteredReviewMode') {
        reviewState.value = 'reviewing';
        reviewResult.value = '';
        const reviewText = typeof item.review === 'string' ? item.review : '';
        pushTranscript(
          'system',
          `Review started: ${reviewText || 'current changes'}`,
          currentSelectedModelName(),
        );
        return;
      }
      if (
        item &&
        typeof item.type === 'string' &&
        item.type !== 'userMessage' &&
        item.type !== 'agentMessage'
      ) {
        const realtimeSessionId = notificationThreadId || activeThreadId.value || 'codex-thread';
        const turnId =
          notificationTurnId || activeTurn.value?.id || `${realtimeSessionId}:realtime`;
        const bundle = normalizeCodexTurnItems({
          sessionId: realtimeSessionId,
          turnId,
          items: [item],
          parentMessageId: currentRealtimeParentId(realtimeSessionId, turnId),
        });
        for (const part of bundle.parts) {
          if (part.type === 'tool') {
            upsertRealtimeToolPart({
              info: createCodexAssistantInfo(
                realtimeSessionId,
                part.messageID,
                Date.now(),
                currentRealtimeParentId(realtimeSessionId, turnId),
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
      notification.method === 'command/exec/outputDelta' ||
      notification.method === 'item/commandExecution/outputDelta'
    ) {
      const params = isRecord(notification.params) ? notification.params : null;
      const callId =
        typeof params?.callId === 'string'
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
          plan: plan
            .filter((p: unknown) => isRecord(p))
            .map((p: Record<string, unknown>) => ({
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
      const delta = extractAgentDelta(notification.params);
      const last = transcript.value.at(-1);
      if (last?.role === 'assistant') {
        transcript.value[transcript.value.length - 1] = { ...last, text: last.text + delta };
      } else if (delta) {
        pushTranscript('assistant', delta, currentSelectedModelName());
      }
      return;
    }

    const reasoningDeltaKind =
      notification.method === 'item/reasoning/summaryTextDelta'
        ? 'summary'
        : notification.method === 'item/reasoning/textDelta'
          ? 'raw'
          : undefined;
    if (reasoningDeltaKind) {
      const { itemId, delta } = extractItemDelta(notification.params);
      if (itemId) {
        const existing = reasoningStreams.value[itemId] ?? { summary: '', raw: '' };
        reasoningStreams.value[itemId] = {
          ...existing,
          [reasoningDeltaKind]: existing[reasoningDeltaKind] + delta,
        };
      }
      if (delta && itemId) {
        const threadId = notificationThreadId || activeThreadId.value || 'codex-thread';
        const messageId = codexAssistantMessageId(
          notificationTurnId || activeTurn.value?.id || `reasoning:${threadId}`,
          itemId,
        );
        const existing = realtimeReasoningPart.value?.part;
        const accumulated = reasoningStreams.value[itemId]?.summary || reasoningStreams.value[itemId]?.raw || delta;
        realtimeReasoningPart.value = {
          info: createCodexAssistantInfo(
            threadId,
            messageId,
            Date.now(),
            currentRealtimeParentId(threadId, notificationTurnId || activeTurn.value?.id),
          ),
          part: {
            id: itemId,
            sessionID: threadId,
            messageID: messageId,
            type: 'reasoning',
            text: accumulated,
            time: { start: existing?.id === itemId ? existing.time.start : Date.now() },
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
        reasoningStreams.value[itemId] = { ...existing, summary: existing.summary ? existing.summary + '\n---\n' : '' };
      }
      if (itemId && realtimeReasoningPart.value?.part.id === itemId) {
        const current = realtimeReasoningPart.value.part;
        realtimeReasoningPart.value = {
          info: realtimeReasoningPart.value.info,
          part: { ...current, text: reasoningStreams.value[itemId]?.summary || reasoningStreams.value[itemId]?.raw || current.text },
          updatedAt: Date.now(),
        };
      }
      return;
    }

    if (notification.method === 'item/fileChange/outputDelta') {
      const { itemId, delta } = extractItemDelta(notification.params);
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
        error:
          typeof params?.error === 'string' || params?.error === null ? params.error : undefined,
      };
      return;
    }

    if (notification.method === 'fuzzyFileSearch/sessionUpdated') {
      const params = isRecord(notification.params)
        ? (notification.params as {
            files?: Array<{ path: string; score: number }>;
            query?: string;
          })
        : null;
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
        ...elicitationRequests.value.filter(
          (item) => item.dialogId !== elicitationRequest.dialogId,
        ),
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

    const scopedRequest = extractScopedApprovalRequest(
      request,
      activeThreadId.value,
      activeTurn.value?.id,
    );
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
    serverRequests.value = serverRequests.value.filter(
      (request) => request.threadId === threadId && request.turnId === turnId,
    );
    permissionRequests.value = permissionRequests.value.filter(
      (request) => request.sessionID === threadId && request.turnId === turnId,
    );
    elicitationRequests.value = elicitationRequests.value.filter(
      (request) =>
        request.sessionID === threadId && (request.turnId === null || request.turnId === turnId),
    );
    toolUserInputRequests.value = toolUserInputRequests.value.filter(
      (request) => request.threadId === threadId && request.turnId === turnId,
    );
    dynamicToolCalls.value = dynamicToolCalls.value.filter(
      (request) => request.threadId === threadId && request.turnId === turnId,
    );
  }

  async function refreshHomeDir(
    force = false,
    request: ConnectionRequest | null = captureConnection(),
  ) {
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
        const data = (await res.json()) as { home?: string };
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
    if (threadActivity.setConnection(url.value)) threads.value = [];
    status.value = 'connecting';
    errorMessage.value = '';
    adapter = makeAdapter();
    const request = captureConnection();
    if (!request) return;
    const sourceAdapter = request.sourceAdapter;

    if (import.meta.env.DEV) console.time('codex-connect');

    try {
      await initializeCodexAuxiliaryStorage();
      if (!isCurrentConnection(request)) return;
      onPhase?.('home');
      await refreshHomeDir(false, request);
      if (!isCurrentConnection(request)) return;
      unsubscribeNotifications = sourceAdapter.onNotification((notification) =>
        handleNotification(notification, request),
      );
      unsubscribeServerRequests = sourceAdapter.onServerRequest(handleServerRequest);
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
    subagentStreamGeneration += 1;
    subagentStreams.reset();
    subscribedSubagents.clear();
    realtimeSubagentPart.value = null;
    connectionGeneration += 1;
    threadSelectionGeneration += 1;
    accountRefreshGeneration += 1;
    threadGoalRefreshGeneration += 1;
    pluginsRefreshGeneration += 1;
    unsubscribeNotifications?.();
    unsubscribeNotifications = null;
    unsubscribeServerRequests?.();
    unsubscribeServerRequests = null;
    if (adapter) historyReaders.delete(adapter);
    adapter?.disconnect();
    adapter = null;
    capabilityRegistry.reset();
    initialized.value = false;
    activeTurn.value = null;
    liveTurnGenerations.clear();
    assistantContexts.clear();
    observedTurnUsers.clear();
    latestAssistantCreatedAt = 0;
    liveThreadStatuses.clear();
    serverRequests.value = [];
    permissionRequests.value = [];
    elicitationRequests.value = [];
    toolUserInputRequests.value = [];
    dynamicToolCalls.value = [];
    threadGoal.value = null;
    threadGoalThreadId.value = null;
    threadGoalLoading.value = false;
    loadingThread.value = false;
    collaborationModes.value = [];
    collaborationModesLoading.value = false;
    collaborationModesError.value = null;
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
    const baseParams = {
      limit: 50,
      sortKey: 'updated_at' as const,
      modelProviders: null,
      ...params,
    };
    const result = await listThreadsAcrossConfiguredProviders(
      baseParams,
      includeConfiguredProviders,
      request,
    );
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
      const activeProvider =
        typeof rawConfig.model_provider === 'string' ? rawConfig.model_provider.trim() : '';
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
    params: CodexThreadListParams & {
      limit: number;
      sortKey: 'updated_at' | 'created_at';
      modelProviders?: string[] | null;
    },
    includeConfiguredProviders = true,
    request: ConnectionRequest | null = captureConnection(),
  ): Promise<CodexThreadListResult> {
    if (!request || !isCurrentConnection(request)) return { data: [], nextCursor: null };
    const currentAdapter = request.sourceAdapter;
    if (
      !includeConfiguredProviders ||
      (params.modelProviders !== undefined && params.modelProviders !== null)
    ) {
      return currentAdapter.listThreads(params);
    }

    const providerIds = await configuredThreadModelProviderIds(request);
    if (!providerIds || !isCurrentConnection(request)) return { data: [], nextCursor: null };
    if (providerIds.length <= 1) return currentAdapter.listThreads(params);

    const requests = [
      currentAdapter.listThreads(params),
      ...providerIds.map((providerId) =>
        currentAdapter.listThreads({ ...params, modelProviders: [providerId] }),
      ),
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
        merged.set(thread.id, {
          ...existing,
          ...thread,
          createdAt: monotonic.createdAt,
          updatedAt: monotonic.updatedAt,
        });
      }
    }
    return {
      data: Array.from(merged.values()).sort(
        (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
      ),
      nextCursor,
    };
  }

  async function refreshConfiguredProviderThreads() {
    const statusRevision = threadStatusRevision;
    const request = captureConnection();
    if (!request) return;
    const { sourceAdapter } = request;
    const providerIds = await configuredThreadModelProviderIds(request);
    if (!providerIds || !isCurrentConnection(request) || providerIds.length <= 1) return;
    const results = await Promise.allSettled(
      providerIds.map((providerId) =>
        sourceAdapter.listThreads({
          limit: 50,
          sortKey: 'updated_at',
          modelProviders: [providerId],
        }),
      ),
    );
    if (!isCurrentConnection(request)) return;
    const merged = new Map(threads.value.map((thread) => [thread.id, thread]));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const thread of result.value.data) {
        const existing = merged.get(thread.id);
        const monotonic = monotonicTimestamps(existing, thread);
        merged.set(
          thread.id,
          normalizeThreadCwd({
            ...existing,
            ...thread,
            cwd: thread.cwd ?? existing?.cwd,
            gitInfo: thread.gitInfo ?? existing?.gitInfo,
            createdAt: monotonic.createdAt,
            updatedAt: monotonic.updatedAt,
          }),
        );
      }
    }
    const enrichedThreads = await Promise.all([...merged.values()].map(enrichThreadWithGitInfo));
    if (isCurrentConnection(request)) {
      threads.value = enrichedThreads.map((thread) => reconcileThreadStatus(thread, statusRevision)).sort(
        (left, right) =>
          (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0),
      );
    }
  }

  async function refreshThreads(
    params: CodexThreadListParams = {},
    includeConfiguredProviders = true,
  ) {
    const statusRevision = threadStatusRevision;
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
    threads.value = enrichedThreads.map((thread) => reconcileThreadStatus(thread, statusRevision));
    if (!loadingThread.value) {
      if (
        activeThreadId.value &&
        !enrichedThreads.some((thread) => thread.id === activeThreadId.value)
      ) {
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
    const commonRoot =
      typeof record.commonRoot === 'string' ? expandPath(record.commonRoot).trim() : '';
    const worktreeRoot =
      typeof record.worktreeRoot === 'string' ? expandPath(record.worktreeRoot).trim() : '';
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
    const { originUrl: _originUrl, ...safeGitInfo } = gitInfo as NonNullable<
      CodexThread['gitInfo']
    > & { originUrl?: unknown };
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
    if (normalizedThread.gitInfo?.root && normalizedThread.gitInfo.commonRoot) {
      return normalizedThread;
    }
    const gitInfo = await resolveThreadGitInfo(cwd);
    return gitInfo?.root
      ? { ...normalizedThread, gitInfo: { ...gitInfo, ...normalizedThread.gitInfo } }
      : normalizedThread;
  }

  async function upsertThreadWithGitInfo(thread: CodexThread) {
    const request = captureConnection();
    const statusRevision = threadStatusRevision;
    const enrichedThread = await enrichThreadWithGitInfo(thread);
    if (!request || !isCurrentConnection(request)) return;
    upsertThread(enrichedThread, false, statusRevision);
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
    let readHistory = historyReaders.get(sourceAdapter);
    if (!readHistory) {
      readHistory = createCodexHistoryReader(sourceAdapter);
      historyReaders.set(sourceAdapter, readHistory);
    }
    return mergeThreadReadResult(await readHistory(threadId), threadId);
  }

  async function hydrateThreadImages(entries: CodexCanonicalHistoryEntry[], sourceAdapter = adapter) {
    const nextEntries = await Promise.all(
      entries.map(async (entry) => {
        const parts = await Promise.all(
          entry.parts.map(async (part) => {
            if (part.type !== 'file') return part;
            if (
              part.url.startsWith('data:') ||
              part.url.startsWith('http://') ||
              part.url.startsWith('https://') || part.url.startsWith('blob:')
            )
              return part;
            if (!part.mime.startsWith('image/')) return part;
            try {
              if (!sourceAdapter) return part;
              const raw = await sourceAdapter.readFile({ path: expandPath(part.url) });
              const dataUrl = fileResultToDataUrl(part.url, raw);
              return dataUrl ? { ...part, url: dataUrl } : part;
            } catch {
              return part;
            }
          }),
        );
        return { ...entry, parts };
      }),
    );
    return nextEntries;
  }

  function restoreAuxiliaryHistory(threadId: string) {
    const serverParts = new Set(
      canonicalHistory.value.flatMap((entry) => entry.parts.map((part) => part.id)),
    );
    const serverInfo = new Map(canonicalHistory.value.map((entry) => [entry.info.id, entry.info]));
    const missingEntries = migrateCodexAuxiliaryHistory(loadCodexAuxiliaryHistory(threadId), canonicalHistory.value)
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
    const isCurrentSelection = () =>
      adapter === sourceAdapter &&
      threadSelectionGeneration === selectionGeneration &&
      activeThreadId.value === threadId;
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
    realtimeCompletedPart.value = null;
    realtimeReasoningPart.value = null;
    realtimeToolParts.value = [];
    loadingThread.value = true;
    errorMessage.value = '';
    const restoreRunningTurn = (turns: CodexTurn[] | undefined, previousTurn: CodexTurn | null) => {
      if (activeTurn.value !== previousTurn || !turns) return;
      activeTurn.value = turns.findLast((turn) => turn.status === 'inProgress' || turn.status === 'in_progress') ?? null;
    };
    try {
      let statusRevision = threadStatusRevision;
      let read = await readThreadForHistory(threadId, sourceAdapter);
      if (!isCurrentSelection()) return;
      restoreRunningTurn(read.thread.turns, null);
      upsertThread(read.thread, true, statusRevision);
      setTranscriptFromTurns(read.thread.turns ?? []);
      const hydratedHistory = await hydrateThreadImages(canonicalHistory.value, sourceAdapter);
      if (!isCurrentSelection()) return;
      canonicalHistory.value = hydratedHistory;
      try {
        const previousTurn = activeTurn.value;
        statusRevision = threadStatusRevision;
        const resumed = await sourceAdapter.resumeThread({ threadId });
        if (!isCurrentSelection()) return;
        restoreRunningTurn(resumed.thread.turns, previousTurn);
        upsertThread(resumed.thread, true, statusRevision);
        if ((read.thread.turns?.length ?? 0) === 0) {
          const previousTurn = activeTurn.value;
          statusRevision = threadStatusRevision;
          read = await readThreadForHistory(threadId, sourceAdapter);
          if (!isCurrentSelection()) return;
          restoreRunningTurn(read.thread.turns, previousTurn);
          upsertThread(read.thread, true, statusRevision);
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

  async function readSubagentHistory(threadId: string): Promise<CodexCanonicalHistoryEntry[]> {
    const sourceAdapter = adapter;
    if (!sourceAdapter) throw new Error('Codex is not connected.');
    const read = await readThreadForHistory(threadId, sourceAdapter);
    const entries = messageModels.restore(threadId, restoreCodexMessageEfforts(threadId, normalizeCodexTurnsToHistory({
      sessionId: threadId,
      turns: read.thread.turns ?? [],
      model: { providerID: read.thread.modelProvider, modelID: read.thread.model ?? undefined },
    })));
    const hydrated = await hydrateThreadImages(entries, sourceAdapter);
    if (adapter !== sourceAdapter) throw new Error('Codex connection changed.');
    return hydrated;
  }

  async function hydrateThread(threadId: string) {
    const sourceAdapter = adapter;
    if (!sourceAdapter) return;
    const selectionGeneration = threadSelectionGeneration;
    const statusRevision = threadStatusRevision;
    const read = await readThreadForHistory(threadId, sourceAdapter);
    if (
      adapter !== sourceAdapter ||
      threadSelectionGeneration !== selectionGeneration ||
      activeThreadId.value !== threadId
    ) {
      return;
    }
    const hydrated = await hydrateThreadImages(normalizeCodexTurnsToHistory({
      sessionId: threadId, turns: read.thread.turns ?? [],
    }), sourceAdapter);
    if (adapter !== sourceAdapter || threadSelectionGeneration !== selectionGeneration || activeThreadId.value !== threadId) return;
    upsertThread(read.thread, true, statusRevision);
    setTranscriptFromTurns(read.thread.turns ?? []);
    const imageUrls = new Map(hydrated.flatMap(entry => entry.parts.filter(part => part.type === 'file').map(part => [part.id, part.url])));
    canonicalHistory.value = canonicalHistory.value.map(entry => ({ ...entry, parts: entry.parts.map(part =>
      part.type === 'file' ? { ...part, url: imageUrls.get(part.id) ?? part.url } : part) }));
  }

  async function startThread(cwd?: string) {
    if (!adapter) throw new Error('Codex is not connected.');
    const params: { cwd?: string; model?: string } = {};
    if (cwd) params.cwd = expandPath(cwd);
    const selectedCodexModel = parseSelectedCodexModel(selectedModel.value).modelID;
    if (selectedCodexModel) params.model = selectedCodexModel;
    const result = await adapter.startThread(params);
    const thread =
      params.cwd && !result.thread.cwd ? { ...result.thread, cwd: params.cwd } : result.thread;
    const gitInfo = thread.cwd ? await resolveThreadGitInfo(thread.cwd) : null;
    const enrichedThread = gitInfo?.root ? { ...thread, gitInfo } : thread;
    upsertThread(enrichedThread, false);
    activeThreadId.value = enrichedThread.id;
    transcript.value = [];
    canonicalHistory.value = [];
    realtimeHistoryQueue.value = [];
    realtimeStreamingPart.value = null;
    realtimeCompletedPart.value = null;
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
    const request = captureConnection();
    if (!request) throw new Error('Codex is not connected.');
    const turn = activeTurn.value;
    const turnId = turn?.id;
    const threadId = activeThreadId.value;
    if (!threadId || !turnId) return;
    await request.sourceAdapter.interruptTurn({ threadId, turnId });
    if (!isCurrentConnection(request)) return;
    liveTurnGenerations.delete(liveTurnKey(threadId, turnId));
    if (activeThreadId.value !== threadId || activeTurn.value !== turn) return;
    activeTurn.value = { ...turn, status: 'interrupted' };
    updateThreadStatus(threadId, 'idle');
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

  async function rollbackThread(threadId: string, target: number | string = 1) {
    if (!adapter) throw new Error('Codex is not connected.');
    const request = captureConnection();
    if (!request) throw new Error('Codex is not connected.');
    const numTurns = typeof target === 'number' ? target : codexRollbackCount(threadId,
      (await readThreadForHistory(threadId, request.sourceAdapter)).thread.turns ?? [], target);
    if (!isCurrentConnection(request)) throw new Error('Codex connection changed.');
    const result = await request.sourceAdapter.rollbackThread({ threadId, numTurns });
    if (!isCurrentConnection(request)) return result.thread;
    if (activeThreadId.value === threadId) resetSubagentStreams();
    invalidateRecentTurnIds(threadId, numTurns);
    clearCodexAuxiliaryHistory(threadId);
    realtimeHistoryQueue.value = realtimeHistoryQueue.value.filter(
      (entry) => entry.info.sessionID !== threadId,
    );
    if (activeThreadId.value === threadId) {
      realtimeCompletedPart.value = null;
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
      return normalizeAbsolutePathNoParent(
        `${home.replace(/\/+$/u, '')}/${trimmed.slice(2).replace(/^\/+/, '')}`,
      );
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

  function codexFileResultToText(result: {
    dataBase64?: string;
    content?: string;
    encoding?: string;
  }) {
    if (typeof result.content === 'string' && result.encoding !== 'base64') return result.content;
    if (typeof result.content === 'string' && result.encoding === 'base64')
      return base64ToUtf8(result.content);
    if (typeof result.dataBase64 === 'string') return base64ToUtf8(result.dataBase64);
    return '';
  }

  function decodeReadFileText(result: {
    dataBase64?: string;
    content?: string;
    encoding?: string;
  }) {
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
        .map((e) =>
          resolved.endsWith('/') ? `${resolved}${e.fileName}` : `${resolved}/${e.fileName}`,
        );
      fsShowSuggestions.value = fsSuggestions.value.length > 0;
    } catch {
      const lastSlash = resolved.lastIndexOf('/');
      if (lastSlash > 0) {
        const parent = resolved.slice(0, lastSlash) || '/';
        const prefix = resolved.slice(lastSlash + 1).toLowerCase();
        try {
          const result = await adapter.readDirectory({ path: parent });
          fsSuggestions.value = result.entries
            .filter((e) => e.isDirectory && e.fileName.toLowerCase().startsWith(prefix))
            .map((e) => (parent === '/' ? `/${e.fileName}` : `${parent}/${e.fileName}`));
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
            .filter((e) => e.isDirectory && e.fileName.toLowerCase().startsWith(prefix))
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
    )
      return;
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
    permissionRequests.value = permissionRequests.value.filter(
      (item) => item.dialogId !== dialogId,
    );
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
    elicitationRequests.value = elicitationRequests.value.filter(
      (item) => item.dialogId !== dialogId,
    );
  }

  function resolvePromptCwd(cwd: string | undefined, threadId: string) {
    const explicitCwd = cwd?.trim();
    if (explicitCwd) return normalizeCwd(explicitCwd);
    const threadCwd = threads.value.find((thread) => thread.id === threadId)?.cwd?.trim();
    return threadCwd ? normalizeCwd(threadCwd) : undefined;
  }

  async function sendPrompt(
    text: string,
    options: {
      model?: string;
      effort?: string;
      cwd?: string;
      threadId?: string;
      input?: CodexPromptInput['input'];
      forceNewThread?: boolean;
      collaborationMode?: CodexCollaborationModePayload;
    } = {},
  ) {
    const prompt = text.trim();
    const inputItems =
      options.input?.filter((item) => item.type !== 'text' || item.text.trim().length > 0) ?? [];
    if (!prompt && inputItems.length === 0) return null;
    if (!adapter) throw new Error('Codex is not connected.');

    pending.value = true;
    errorMessage.value = '';
    pushTranscript('user', prompt);

    const clientUserMessageId = `client-user:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const pendingTurnId = `pending-turn:${clientUserMessageId}`;
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
      variant: options.effort,
      model: {
        providerID: selectedModelInfo.providerID,
        modelID: options.model?.trim() || selectedModelInfo.modelID || 'unknown',
      },
    };
    const userParts = buildRealtimeUserParts(sessionId, userMessageId, prompt, inputItems, now);
    realtimeHistoryQueue.value = dedupeRealtimeHistoryQueue([
      ...realtimeHistoryQueue.value,
      { info: userInfo, parts: userParts },
    ]);

    try {
      const model =
        options.model?.trim() || parseSelectedCodexModel(selectedModel.value).modelID || undefined;
      const cwd = resolvePromptCwd(options.cwd, targetThreadId);
      const input: CodexPromptInput = { text: prompt, summary: 'auto', clientUserMessageId };
      if (inputItems.length > 0) input.input = inputItems;
      if (targetThreadId) input.threadId = targetThreadId;
      if (model) input.model = model;
      if (options.effort) input.effort = options.effort;
      if (options.collaborationMode) input.collaborationMode = options.collaborationMode;
      if (cwd) input.cwd = cwd;
      const statusRevision = threadStatusRevision;
      const request = captureConnection();
      if (!request) throw new Error('Codex is not connected.');
      const result = await request.sourceAdapter.sendPrompt(input);
      if (!isCurrentConnection(request)) return result;
      activeThreadId.value = result.threadId;
      if (result.thread) upsertThread(result.thread, true, statusRevision);
      threadActivity.markParticipated(result.threadId);
      upsertThread({
        id: result.threadId,
        status: ['completed', 'failed', 'interrupted'].includes(result.turn.status ?? '') ? 'idle' : 'active',
      }, false, statusRevision);
      if (activeTurn.value?.id !== result.turn.id || (liveThreadStatuses.get(result.threadId)?.revision ?? 0) <= statusRevision) {
        activeTurn.value = result.turn;
      }

      const finalizedTurnId = result.turn.id || pendingTurnId;
      recordObservedTurnId(result.threadId, finalizedTurnId);
      const finalizedUserMessageId = codexUserMessageId(finalizedTurnId, clientUserMessageId);
      messageModels.save(result.threadId, { ...userInfo, id: finalizedUserMessageId, sessionID: result.threadId });
      saveCodexTurnEffort(result.threadId, finalizedTurnId, options.effort, finalizedUserMessageId);
      finalizeRealtimeUser(userMessageId, finalizedUserMessageId, result.threadId, options.effort);

      return result;
    } catch (error) {
      realtimeHistoryQueue.value = realtimeHistoryQueue.value.filter(
        (entry) => entry.info.id !== userMessageId,
      );
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
  async function reviewThread(
    target: CodexReviewStartParams['target'],
    delivery: 'inline' | 'detached' = 'inline',
  ) {
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
  async function executeCommand(
    argv: string[],
    options: { cwd?: string; sandboxPolicy?: unknown; timeoutMs?: number } = {},
  ) {
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
    if (activeThreadId.value === threadId && threadGoalThreadId.value !== threadId) {
      threadGoal.value = null;
      threadGoalThreadId.value = null;
    }
    threadGoalLoading.value = true;
    try {
      const result = await capabilityRegistry.run('thread/goal/get', () =>
        request.sourceAdapter.getThreadGoal({ threadId }),
      );
      if (
        isCurrentConnection(request) &&
        threadGoalRefreshGeneration === refreshGeneration &&
        activeThreadId.value === threadId
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
    const mutation = beginThreadGoalMutation();
    try {
      const result = await capabilityRegistry.run('thread/goal/set', () =>
        mutation.request.sourceAdapter.setThreadGoal({ threadId: mutation.threadId, ...params }),
      );
      if (mutation.isCurrent()) {
        threadGoal.value = result.goal;
        threadGoalThreadId.value = mutation.threadId;
      }
      return result;
    } finally {
      if (mutation.isCurrent()) threadGoalLoading.value = false;
    }
  }

  async function clearThreadGoal() {
    const mutation = beginThreadGoalMutation();
    try {
      const result = await capabilityRegistry.run('thread/goal/clear', () =>
        mutation.request.sourceAdapter.clearThreadGoal({ threadId: mutation.threadId }),
      );
      if (mutation.isCurrent()) {
        threadGoal.value = null;
        threadGoalThreadId.value = mutation.threadId;
      }
      return result;
    } finally {
      if (mutation.isCurrent()) threadGoalLoading.value = false;
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

  async function callMcpTool(
    threadId: string,
    serverName: string,
    tool: string,
    args?: Record<string, unknown>,
  ) {
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

  async function writeConfigValue(
    keyPath: string,
    value: unknown,
    mergeStrategy?: ConfigMergeStrategy,
  ) {
    if (!adapter) throw new Error('Codex is not connected.');
    const params: CodexConfigValueWriteParams = {
      keyPath,
      value,
      mergeStrategy,
    };
    await adapter.writeConfigValue(params);
    await refreshConfig();
  }

  async function batchWriteConfig(
    edits: Array<{ keyPath: string; value: unknown; mergeStrategy?: ConfigMergeStrategy }>,
  ) {
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
      externalAgentImportStatus.value = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async function refreshExperimentalFeatures() {
    const request = captureConnection();
    if (!request) throw new Error('Codex is not connected.');
    experimentalFeaturesLoading.value = true;
    try {
      const result: CodexExperimentalFeatureListResult =
        await request.sourceAdapter.listExperimentalFeatures();
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
    const refreshGeneration = ++collaborationModesRefreshGeneration;
    const isCurrent = () =>
      isCurrentConnection(request) && collaborationModesRefreshGeneration === refreshGeneration;
    collaborationModesLoading.value = true;
    collaborationModesError.value = null;
    try {
      const result: CodexCollaborationModeListResult =
        await request.sourceAdapter.listCollaborationModes();
      if (isCurrent()) collaborationModes.value = Array.isArray(result.data) ? result.data : [];
      return result;
    } catch (error) {
      if (!isCurrent()) return { data: [] };
      collaborationModes.value = [];
      collaborationModesError.value = error instanceof Error ? error.message : String(error);
      if (typeof console !== 'undefined') {
        console.warn(
          '[Codex] collaborationMode/list failed (the experimental API may not be enabled on this Codex server):',
          error,
        );
      }
      return { data: [] };
    } finally {
      if (isCurrent()) collaborationModesLoading.value = false;
    }
  }

  async function startWindowsSandboxSetup(mode: 'elevated' | 'unelevated') {
    if (!adapter) throw new Error('Codex is not connected.');
    windowsSandboxStatus.value = null;
    const result: CodexWindowsSandboxSetupStartResult = await adapter.startWindowsSandboxSetup({
      mode,
    });
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
    adapter.respondToServerRequest(
      requestId,
      buildToolUserInputResponse(
        responses.map((response) => ({
          questionId: response.questionId,
          answers: [response.response],
        })),
      ),
    );
    toolUserInputRequests.value = toolUserInputRequests.value.filter(
      (request) => request.requestId !== requestId,
    );
  }

  async function respondToDynamicToolCall(
    requestId: CodexJsonRpcId,
    contentItems: CodexDynamicToolOutput[],
    success = true,
  ) {
    if (!adapter) throw new Error('Codex is not connected.');
    adapter.respondToServerRequest(requestId, buildDynamicToolCallResponse(contentItems, success));
    dynamicToolCalls.value = dynamicToolCalls.value.filter(
      (request) => request.requestId !== requestId,
    );
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

  async function updateThreadMetadata(
    threadId: string,
    gitInfo: {
      branch?: string;
      sha?: string;
      root?: string;
      commonRoot?: string;
      worktreeRoot?: string;
    } | null,
  ) {
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

  async function readPlugin(
    pluginName: string,
    marketplacePath?: string,
    remoteMarketplaceName?: string,
  ) {
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
    readSubagentHistory,
    status,
    reconnectOnMount,
    url,
    bridgeToken,
    errorMessage,
    threads,
    participatedThreadIds: threadActivity.participatedThreadIds,
    activeThreadId,
    activeTurn,
    transcript,
    canonicalHistory,
    realtimeHistoryQueue,
    realtimeMessageAliases,
    realtimeCompletedPart,
    realtimeSubagentPart,
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
    collaborationModesError,
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
