import {
  CodexJsonRpcClient,
  type CodexJsonRpcClientOptions,
  type CodexJsonRpcId,
  type CodexJsonRpcNotification,
  type CodexJsonRpcServerRequest,
} from './jsonRpcClient';
import type {
  BackendAdapter,
  ListSessionsOptions,
  SessionUpdatePayload,
} from '../types';

export type CodexClientInfo = {
  name: string;
  title: string;
  version: string;
};

export type CodexInitializeParams = {
  clientInfo?: CodexClientInfo;
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
};

export type CodexInitializeResult = {
  userAgent?: string;
  platformFamily?: string;
  platformOs?: string;
};

export type CodexThread = {
  id: string;
  name?: string | null;
  preview?: string;
  ephemeral?: boolean;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: unknown;
  cwd?: string;
};

export type CodexThreadListParams = {
  cursor?: string | null;
  limit?: number;
  sortKey?: 'created_at' | 'updated_at';
  modelProviders?: string[] | null;
  sourceKinds?: string[];
  archived?: boolean;
  cwd?: string;
  searchTerm?: string;
};

export type CodexThreadListResult = {
  data: CodexThread[];
  nextCursor: string | null;
};

export type CodexThreadStartParams = {
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  personality?: string;
  serviceName?: string;
};

export type CodexThreadStartResult = {
  thread: CodexThread;
};

export type CodexThreadResumeParams = {
  threadId: string;
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  personality?: string;
};

export type CodexThreadResumeResult = {
  thread: CodexThread;
};

export type CodexThreadNameSetParams = {
  threadId: string;
  name: string | null;
};

export type CodexThreadArchiveParams = {
  threadId: string;
};

export type CodexThreadUnarchiveResult = {
  thread: CodexThread;
};

export type CodexThreadForkParams = {
  threadId: string;
};

export type CodexThreadForkResult = {
  thread: CodexThread;
};

export type CodexThreadRollbackParams = {
  threadId: string;
  numTurns: number;
};

export type CodexThreadRollbackResult = {
  thread: CodexThread;
};

export type CodexFsReadDirectoryParams = {
  path: string;
};

export type CodexFsDirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
};

export type CodexFsReadDirectoryResult = {
  entries: CodexFsDirectoryEntry[];
};

export type CodexFsReadFileParams = {
  path: string;
};

export type CodexFsReadFileResult = {
  dataBase64: string;
};

export type CodexFsWriteFileParams = {
  path: string;
  content: string;
};

export type CodexFsWriteFileResult = {};

export type CodexFsCreateDirectoryParams = {
  path: string;
};

export type CodexFsCreateDirectoryResult = {};

export type CodexFsChangedNotificationParams = {
  watchId: string;
  changedPaths: string[];
};

export type CodexThreadUnsubscribeParams = {
  threadId: string;
};

export type CodexThreadReadParams = {
  threadId: string;
  includeTurns?: boolean;
};

export type CodexThreadReadResult = {
  thread: CodexThread & {
    turns?: CodexTurn[];
  };
};

export type CodexTurnInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string };

export type CodexTurnStartParams = {
  threadId: string;
  input: CodexTurnInputItem[];
  cwd?: string;
  approvalPolicy?: string;
  sandboxPolicy?: unknown;
  model?: string;
  effort?: string;
  summary?: string;
  personality?: string;
  outputSchema?: unknown;
};

export type CodexTurn = {
  id: string;
  status?: string;
  items?: unknown[];
  error?: unknown;
};

export type CodexThreadTurnsListParams = {
  threadId: string;
  cursor?: string | null;
  limit?: number;
  sortDirection?: 'asc' | 'desc';
};

export type CodexThreadTurnsListResult = {
  data: CodexTurn[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};

export type CodexTurnStartResult = {
  turn: CodexTurn;
};

export type CodexTurnInterruptParams = {
  threadId: string;
  turnId: string;
};

export type CodexPromptInput = Omit<CodexTurnStartParams, 'threadId' | 'input'> & {
  threadId?: string;
  text: string;
  thread?: CodexThreadStartParams;
};

export type CodexPromptResult = {
  threadId: string;
  thread?: CodexThread;
  turn: CodexTurn;
};

export type CodexReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'custom'; instructions: string };

export type CodexReviewStartParams = {
  threadId: string;
  delivery?: 'inline' | 'detached';
  target: CodexReviewTarget;
};

export type CodexReviewStartResult = {
  turn: CodexTurn;
  reviewThreadId: string;
};

export type CodexCommandExecParams = {
  command: string[];
  cwd?: string;
  sandboxPolicy?: unknown;
  timeoutMs?: number;
  tty?: boolean;
  streamStdoutStderr?: boolean;
};

export type CodexCommandExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  processId?: string;
};

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email?: string; planType?: string }
  | { type: 'chatgptAuthTokens' }
  | null;

export type CodexAccountReadParams = {
  refreshToken?: boolean;
};

export type CodexAccountReadResult = {
  account: CodexAccount;
  requiresOpenaiAuth: boolean;
};

export type CodexAccountLoginType =
  | { type: 'apiKey'; apiKey: string }
  | { type: 'chatgpt' }
  | { type: 'chatgptDeviceCode' }
  | { type: 'chatgptAuthTokens'; accessToken: string; chatgptAccountId: string; chatgptPlanType?: string };

export type CodexAccountLoginStartParams = CodexAccountLoginType & {
  loginId?: string;
};

export type CodexAccountLoginStartResult = {
  type: string;
  loginId?: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
};

export type CodexAccountCancelLoginParams = {
  loginId: string;
};

export type CodexAccountRateLimitBucket = {
  limitId: string;
  limitName?: string | null;
  primary: {
    usedPercent: number;
    windowDurationMins: number;
    resetsAt: number;
    planType?: string;
    credits?: unknown;
  };
  secondary?: unknown;
  rateLimitReachedType?: string | null;
};

export type CodexAccountRateLimitsReadResult = {
  rateLimits: CodexAccountRateLimitBucket;
  rateLimitsByLimitId?: Record<string, CodexAccountRateLimitBucket>;
};

export type CodexAccountSendNudgeParams = {
  creditType: 'credits' | 'usage_limit';
};

export type CodexAccountSendNudgeResult = {
  status: string;
};

// model/* types
export type CodexModelReasoningEffort = {
  reasoningEffort: 'low' | 'medium' | 'high';
  description: string;
};

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: CodexModelReasoningEffort[];
  inputModalities?: Array<'text' | 'image'>;
  supportsPersonality?: boolean;
  isDefault?: boolean;
  upgrade?: string;
  upgradeInfo?: unknown;
};

export type CodexModelListParams = {
  limit?: number;
  includeHidden?: boolean;
};

export type CodexModelListResult = {
  data: CodexModel[];
  nextCursor: string | null;
};

// skills/* types
export type CodexSkillToolDependency = {
  type: 'env_var' | 'mcp';
  value: string;
  description?: string;
  transport?: 'streamable_http';
  url?: string;
};

export type CodexSkillDependencies = {
  tools: CodexSkillToolDependency[];
};

export type CodexSkillInterface = {
  displayName: string;
  shortDescription: string;
};

export type CodexSkill = {
  name: string;
  description: string;
  enabled: boolean;
  interface?: CodexSkillInterface;
  dependencies?: CodexSkillDependencies;
};

export type CodexSkillsListCwdEntry = {
  cwd: string;
  skills: CodexSkill[];
  errors?: unknown[];
};

export type CodexSkillsListParams = {
  cwds: string[];
  forceReload?: boolean;
  perCwdExtraUserRoots?: Array<{ cwd: string; extraUserRoots: string[] }>;
};

export type CodexSkillsListResult = {
  data: CodexSkillsListCwdEntry[];
};

export type CodexSkillsConfigWriteParams = {
  path: string;
  enabled: boolean;
};

export type CodexSkillsConfigWriteResult = {};

export type CodexSkillsChangedNotificationParams = unknown;

// marketplace/* types
export type PluginMarketplaceEntry = {
  path?: string | null;
  [key: string]: unknown;
};

export type CodexMarketplaceAddParams = {
  marketplace: PluginMarketplaceEntry;
};

export type CodexMarketplaceAddResult = unknown;

// plugin/* types
export type CodexPluginSourceLocal = { type: 'local'; path: string };
export type CodexPluginSourceGit = { type: 'git'; url: string; path: string; refName: string; sha: string };
export type CodexPluginSourceRemote = { type: 'remote' };
export type CodexPluginSource = CodexPluginSourceLocal | CodexPluginSourceGit | CodexPluginSourceRemote;

export type CodexPlugin = {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string | null;
  logoUrlDark?: string | null;
  distributionChannel?: string | null;
  branding?: unknown;
  appMetadata?: unknown;
  labels?: unknown;
  installUrl?: string;
  isAccessible: boolean;
  isEnabled: boolean;
  source: CodexPluginSource | null;
  state?: string;
};

export type CodexPluginMarketplaceEntry = {
  name: string;
  plugins: CodexPlugin[];
};

export type CodexPluginListResult = {
  marketplaces: CodexPluginMarketplaceEntry[];
  errors?: unknown[];
  featured?: string[];
};

export type CodexPluginReadParams = {
  marketplacePath?: string;
  remoteMarketplaceName?: string;
  pluginName: string;
};

export type CodexPluginReadResult = {
  plugin: CodexPlugin;
  bundledSkills?: Array<{ name: string; path: string }>;
  bundledApps?: Array<{ name: string; path: string }>;
  bundledMcpServerNames?: string[];
};

export type CodexPluginInstallParams = {
  marketplacePath?: string;
  remoteMarketplaceName?: string;
  pluginName: string;
};

export type CodexPluginInstallResult = unknown;

export type CodexPluginUninstallParams = {
  marketplacePath?: string;
  remoteMarketplaceName?: string;
  pluginName: string;
};

export type CodexPluginUninstallResult = unknown;

// mcpServer/* types
export type CodexMcpServerOauthLoginParams = {
  serverName: string;
};

export type CodexMcpServerOauthLoginResult = {
  authUrl: string;
  verificationUrl?: string;
  userCode?: string;
  loginId?: string;
};

export type CodexMcpServerStartupStatusUpdatedNotificationParams = {
  name: string;
  status: string;
  error?: string;
};

export type CodexMcpServerAuth = {
  type: 'none' | 'oauth' | 'apiKey';
  status: 'required' | 'pending' | 'completed';
};

export type CodexMcpServerTool = {
  name: string;
  description: string;
};

export type CodexMcpServerResource = {
  name: string;
  description: string;
  mimeType?: string;
};

export type CodexMcpServerInfo = {
  name: string;
  status: string;
  error?: string;
  tools?: CodexMcpServerTool[];
  resources?: CodexMcpServerResource[];
  auth?: CodexMcpServerAuth;
};

export type CodexMcpServerStatusListParams = {
  cursor?: string;
  limit?: number;
  detail?: 'full' | 'toolsAndAuthOnly';
};

export type CodexMcpServerStatusListResult = {
  data: CodexMcpServerInfo[];
  nextCursor: string | null;
};

export type CodexMcpServerResourceReadParams = {
  serverName: string;
  uri: string;
};

export type CodexMcpServerResourceReadResult = {
  contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
};

export type CodexMcpServerToolCallParams = {
  threadId: string;
  serverName: string;
  tool: string;
  arguments?: Record<string, unknown>;
};

export type CodexMcpServerToolCallResult = {
  content: Array<{ type: 'text' | 'image'; text?: string; image?: unknown }>;
  isError?: boolean;
};

export type CodexConfigMcpServerReloadParams = {};
export type CodexConfigMcpServerReloadResult = {};

// turn/* types
export type CodexTurnSteerParams = {
  threadId: string;
  input: CodexTurnInputItem[];
  expectedTurnId: string;
};

export type CodexTurnSteerResult = {
  turnId: string;
};

// thread/* types
export type CodexThreadMetadataUpdateParams = {
  threadId: string;
  gitInfo?: { branch?: string; sha?: string; originUrl?: string } | null;
};

export type CodexThreadMetadataUpdateResult = {
  thread: CodexThread;
};

export type CodexThreadCompactStartParams = {
  threadId: string;
};

export type CodexThreadCompactStartResult = {};

export type CodexThreadShellCommandParams = {
  threadId: string;
  command: string;
};

export type CodexThreadShellCommandResult = {};

export type CodexThreadInjectItemsParams = {
  threadId: string;
  items: unknown[];
};

export type CodexThreadInjectItemsResult = {};

export type CodexThreadLoadedListResult = {
  data: string[];
};

// fs/* types
export type CodexFsRemoveParams = {
  path: string;
};

export type CodexFsRemoveResult = {};

export type CodexFsWatchParams = {
  watchId: string;
  path: string;
};

export type CodexFsWatchResult = {
  path: string;
};

export type CodexFsUnwatchParams = {
  watchId: string;
};

export type CodexFsUnwatchResult = {};

export type CodexFsGetMetadataParams = {
  path: string;
};

export type CodexFsGetMetadataResult = {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink?: boolean;
  createdAtMs?: number;
  modifiedAtMs?: number;
};

export type CodexFsCopyParams = {
  sourcePath: string;
  destinationPath: string;
  recursive?: boolean;
};

export type CodexFsCopyResult = {};

// command/* types
export type CodexCommandExecWriteParams = {
  processId: string;
  deltaBase64?: string;
  closeStdin?: boolean;
};

export type CodexCommandExecWriteResult = {};

export type CodexCommandExecTerminateParams = {
  processId: string;
};

export type CodexCommandExecTerminateResult = {};

// config/* types
export type CodexConfigLayer = {
  source: string;
  config: Record<string, unknown>;
};

export type CodexConfigReadParams = {
  includeLayers?: boolean;
};

export type CodexConfigReadResult = {
  config: Record<string, unknown>;
  layers?: CodexConfigLayer[];
};

export type CodexApp = {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string | null;
  logoUrlDark?: string | null;
  distributionChannel?: string | null;
  branding?: unknown;
  appMetadata?: unknown;
  labels?: unknown;
  installUrl?: string;
  isAccessible: boolean;
  isEnabled: boolean;
};

export type CodexAppListParams = {
  cursor?: string | null;
  limit?: number;
  threadId?: string;
  forceRefetch?: boolean;
};

export type CodexAppListResult = {
  data: CodexApp[];
  nextCursor: string | null;
};

export type CodexConfigValueWriteParams = {
  keyPath: string;
  value: unknown;
  mergeStrategy?: 'replace' | 'upsert' | 'remove';
};

export type CodexConfigValueWriteResult = {};

export type CodexConfigBatchWriteParams = {
  edits: Array<{ keyPath: string; value: unknown; mergeStrategy?: 'replace' | 'upsert' | 'remove' }>;
};

export type CodexConfigBatchWriteResult = {};

export type CodexConfigRequirementsReadParams = {};

export type CodexConfigRequirementsReadResult = {
  requirements: {
    allowedApprovalPolicies?: string[];
    allowedSandboxModes?: string[];
    featureRequirements?: Record<string, boolean>;
    network?: {
      enabled?: boolean;
      allowedDomains?: string[];
      allowUnixSockets?: string[];
      dangerouslyAllowAllUnixSockets?: boolean;
    };
  } | null;
};

export type CodexExternalAgentConfigItem = {
  itemType: 'AGENTS_MD' | 'CONFIG' | 'SKILLS' | 'PLUGINS' | 'MCP_SERVER_CONFIG';
  description: string;
  cwd: string | null;
  details?: {
    plugins?: Array<{ marketplaceName: string; pluginNames: string[] }>;
  };
};

export type CodexExternalAgentConfigDetectParams = {
  includeHome?: boolean;
  cwds?: string[];
};

export type CodexExternalAgentConfigDetectResult = {
  items: CodexExternalAgentConfigItem[];
};

export type CodexExternalAgentConfigImportParams = {
  migrationItems: Array<{ itemType: string; description: string; cwd: string | null }>;
};

export type CodexExternalAgentConfigImportResult = {};

export type CodexCommandExecResizeParams = {
  processId: string;
  size: { rows: number; cols: number };
};

export type CodexCommandExecResizeResult = {};

export type CodexThreadBackgroundTerminalsCleanParams = {
  threadId: string;
};

export type CodexThreadBackgroundTerminalsCleanResult = {};

export type CodexExperimentalFeature = {
  name: string;
  stage: 'beta' | 'underDevelopment' | 'stable' | 'deprecated' | 'removed';
  displayName?: string | null;
  description?: string | null;
  announcement?: string | null;
  enabled: boolean;
  defaultEnabled: boolean;
};

export type CodexExperimentalFeatureListParams = {
  cursor?: string | null;
  limit?: number;
};

export type CodexExperimentalFeatureListResult = {
  data: CodexExperimentalFeature[];
  nextCursor: string | null;
};

export type CodexExperimentalFeatureEnablementSetParams = {
  name: string;
  enabled: boolean;
};

export type CodexExperimentalFeatureEnablementSetResult = {};

export type CodexCollaborationMode = {
  id: string;
  name: string;
  description?: string;
};

export type CodexCollaborationModeListResult = {
  data: CodexCollaborationMode[];
};

export type CodexWindowsSandboxSetupStartParams = {
  mode: 'elevated' | 'unelevated';
};

export type CodexWindowsSandboxSetupStartResult = {
  started: boolean;
};

export type CodexFeedbackUploadParams = {
  classification: string;
  reason?: string;
  logs?: string;
  conversationId?: string;
  extraLogFiles?: Array<{ name: string; contentBase64: string }>;
};

export type CodexFeedbackUploadResult = {};

export type CodexToolRequestUserInputParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: Array<{ id: string; text: string; isOther?: boolean }>;
};

export type CodexToolRequestUserInputResult = {
  responses: Array<{ questionId: string; response: string }>;
};

export type CodexAdapterOptions = CodexJsonRpcClientOptions & {
  clientInfo?: CodexClientInfo;
  experimentalApi?: boolean;
};

type NormalizedCodexSession = {
  id: string;
  projectID: string;
  title?: string;
  status?: 'busy' | 'idle' | 'retry';
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
    pinned?: number;
  };
};

function syntheticProjectId(directory?: string) {
  const normalized = directory?.trim() || 'default';
  return `codex:${normalized}`;
}

function normalizeCodexStatus(status: unknown): NormalizedCodexSession['status'] {
  if (status === 'running' || status === 'busy' || status === 'inProgress') return 'busy';
  if (status === 'retry') return 'retry';
  return 'idle';
}

function normalizeCodexThread(thread: CodexThread): NormalizedCodexSession {
  const directory = thread.cwd?.trim() || undefined;
  return {
    id: thread.id,
    projectID: syntheticProjectId(directory),
    title: thread.name || thread.preview || undefined,
    status: normalizeCodexStatus(thread.status),
    directory,
    time: {
      created: thread.createdAt,
      updated: thread.updatedAt ?? thread.createdAt,
      archived: undefined,
      pinned: undefined,
    },
  };
}

function isAbsolutePath(path: string) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path);
}

function normalizeRelativePath(path?: string) {
  const trimmed = path?.trim() || '.';
  if (trimmed === '.') return '';
  return trimmed.replace(/^\/+|\/+$/gu, '');
}

function resolveCodexFsPath(directory: string, path?: string) {
  const trimmedPath = path?.trim();
  if (trimmedPath && isAbsolutePath(trimmedPath)) return trimmedPath;
  const root = directory.trim();
  const relative = normalizeRelativePath(trimmedPath);
  return relative ? `${root.replace(/\/+$/u, '')}/${relative}` : root;
}

function decodeBase64Bytes(dataBase64: string) {
  const globalWithBuffer = globalThis as typeof globalThis & {
    Buffer?: { from(data: string, encoding: 'base64'): Uint8Array };
  };
  if (typeof globalWithBuffer.Buffer?.from === 'function') {
    return new Uint8Array(globalWithBuffer.Buffer.from(dataBase64, 'base64'));
  }
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function defaultClientInfo(): CodexClientInfo {
  return {
    name: 'vis',
    title: 'Vis',
    version: '0.3.0',
  };
}

export class CodexAdapter implements BackendAdapter {
  readonly kind = 'codex' as const;
  readonly label = 'Codex';
  readonly capabilities = {
    projects: false,
    worktrees: false,
    sessions: true,
    sessionFork: true,
    sessionRevert: true,
    files: true,
    terminal: true,
    permissions: false,
    questions: false,
    todos: false,
    status: true,
  };

  private readonly client: CodexJsonRpcClient;
  private readonly clientInfo: CodexClientInfo;
  private readonly experimentalApi: boolean;
  private initialized = false;

  constructor(options: CodexAdapterOptions) {
    this.client = new CodexJsonRpcClient(options);
    this.clientInfo = options.clientInfo ?? defaultClientInfo();
    this.experimentalApi = options.experimentalApi ?? false;
  }

  isConnected() {
    return this.client.isConnected();
  }

  connect() {
    return this.client.connect();
  }

  disconnect() {
    this.initialized = false;
    this.client.disconnect();
  }

  onNotification(handler: (notification: CodexJsonRpcNotification) => void) {
    return this.client.onNotification(handler);
  }

  onServerRequest(handler: (request: CodexJsonRpcServerRequest) => void) {
    return this.client.onServerRequest(handler);
  }

  respondToServerRequest(id: CodexJsonRpcId, result: unknown) {
    this.client.respond(id, result);
  }

  async initialize(params: CodexInitializeParams = {}) {
    await this.connect();
    const capabilities = params.capabilities ?? {
      experimentalApi: this.experimentalApi,
    };
    const result = await this.client.request<CodexInitializeResult>('initialize', {
      clientInfo: params.clientInfo ?? this.clientInfo,
      capabilities,
    });
    this.client.notify('initialized', {});
    this.initialized = true;
    return result;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    await this.initialize();
  }

  async listThreads(params: CodexThreadListParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadListResult>('thread/list', params);
  }

  async startThread(params: CodexThreadStartParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadStartResult>('thread/start', params);
  }

  async resumeThread(params: CodexThreadResumeParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadResumeResult>('thread/resume', params);
  }

  async setThreadName(params: CodexThreadNameSetParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('thread/name/set', params);
  }

  async archiveThread(params: CodexThreadArchiveParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('thread/archive', params);
  }

  async unarchiveThread(params: CodexThreadArchiveParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadUnarchiveResult>('thread/unarchive', params);
  }

  async unsubscribeThread(params: CodexThreadUnsubscribeParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('thread/unsubscribe', params);
  }

  async forkThread(params: CodexThreadForkParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadForkResult>('thread/fork', params);
  }

  async rollbackThread(params: CodexThreadRollbackParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadRollbackResult>('thread/rollback', params);
  }

  async readDirectory(params: CodexFsReadDirectoryParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsReadDirectoryResult>('fs/readDirectory', params);
  }

  async readFile(params: CodexFsReadFileParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsReadFileResult>('fs/readFile', params);
  }

  async readThread(params: CodexThreadReadParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadReadResult>('thread/read', params);
  }

  async listThreadTurns(params: CodexThreadTurnsListParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadTurnsListResult>('thread/turns/list', params);
  }

  async startTurn(params: CodexTurnStartParams) {
    await this.ensureInitialized();
    return this.client.request<CodexTurnStartResult>('turn/start', params);
  }

  async interruptTurn(params: CodexTurnInterruptParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('turn/interrupt', params);
  }

   async sendPrompt(input: CodexPromptInput): Promise<CodexPromptResult> {
    await this.ensureInitialized();
    const startedThread = input.threadId
      ? undefined
      : await this.startThread({
          ...input.thread,
          model: input.thread?.model ?? input.model,
          cwd: input.thread?.cwd ?? input.cwd,
          approvalPolicy: input.thread?.approvalPolicy ?? input.approvalPolicy,
        });
    const threadId = input.threadId ?? startedThread?.thread.id;
    if (!threadId) {
      throw new Error('Codex prompt requires a threadId or a started thread.');
    }
    if (input.threadId) {
      await this.resumeThread({ threadId: input.threadId });
    }

    const turn = await this.startTurn({
      threadId,
      input: [{ type: 'text', text: input.text }],
      cwd: input.cwd,
      approvalPolicy: input.approvalPolicy,
      sandboxPolicy: input.sandboxPolicy,
      model: input.model,
      effort: input.effort,
      summary: input.summary,
      personality: input.personality,
      outputSchema: input.outputSchema,
    });

    return {
      threadId,
      thread: startedThread?.thread,
      turn: turn.turn,
    };
  }

  async reviewStart(params: CodexReviewStartParams) {
    await this.ensureInitialized();
    return this.client.request<CodexReviewStartResult>('review/start', params);
  }

  async commandExec(params: CodexCommandExecParams) {
    await this.ensureInitialized();
    return this.client.request<CodexCommandExecResult>('command/exec', params);
  }

  async readAccount(params: CodexAccountReadParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexAccountReadResult>('account/read', params);
  }

  async startAccountLogin(params: CodexAccountLoginStartParams) {
    await this.ensureInitialized();
    return this.client.request<CodexAccountLoginStartResult>('account/login/start', params);
  }

  async cancelAccountLogin(params: CodexAccountCancelLoginParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('account/login/cancel', params);
  }

  async logoutAccount() {
    await this.ensureInitialized();
    return this.client.request<{}>('account/logout', {});
  }

  async readAccountRateLimits() {
    await this.ensureInitialized();
    return this.client.request<CodexAccountRateLimitsReadResult>('account/rateLimits/read', {});
  }

  async sendAddCreditsNudge(params: CodexAccountSendNudgeParams) {
    await this.ensureInitialized();
    return this.client.request<CodexAccountSendNudgeResult>('account/sendAddCreditsNudgeEmail', params);
  }

  // fs/* methods
  async writeFile(params: CodexFsWriteFileParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsWriteFileResult>('fs/writeFile', params);
  }

  async createDirectory(params: CodexFsCreateDirectoryParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsCreateDirectoryResult>('fs/createDirectory', params);
  }

  // model/* methods
  async listModels(params: CodexModelListParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexModelListResult>('model/list', params);
  }

  // skills/* methods
  async listSkills(params: CodexSkillsListParams) {
    await this.ensureInitialized();
    return this.client.request<CodexSkillsListResult>('skills/list', params);
  }

  async writeSkillConfig(params: CodexSkillsConfigWriteParams) {
    await this.ensureInitialized();
    return this.client.request<CodexSkillsConfigWriteResult>('skills/config/write', params);
  }

  // marketplace/* methods
  async addMarketplace(params: CodexMarketplaceAddParams) {
    await this.ensureInitialized();
    return this.client.request<CodexMarketplaceAddResult>('marketplace/add', params);
  }

  // plugin/* methods
  async listPlugins(): Promise<CodexPluginListResult> {
    await this.ensureInitialized();
    return this.client.request<CodexPluginListResult>('plugin/list', {});
  }

  async readPlugin(params: CodexPluginReadParams) {
    await this.ensureInitialized();
    return this.client.request<CodexPluginReadResult>('plugin/read', params);
  }

  async installPlugin(params: CodexPluginInstallParams) {
    await this.ensureInitialized();
    return this.client.request<CodexPluginInstallResult>('plugin/install', params);
  }

  async uninstallPlugin(params: CodexPluginUninstallParams) {
    await this.ensureInitialized();
    return this.client.request<CodexPluginUninstallResult>('plugin/uninstall', params);
  }

  // mcpServer/* methods
  async mcpServerOauthLogin(params: CodexMcpServerOauthLoginParams) {
    await this.ensureInitialized();
    return this.client.request<CodexMcpServerOauthLoginResult>('mcpServer/oauth/login', params);
  }

  async reloadMcpServerConfig(_params: CodexConfigMcpServerReloadParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexConfigMcpServerReloadResult>('config/mcpServer/reload', {});
  }

  async listMcpServerStatus(params: CodexMcpServerStatusListParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexMcpServerStatusListResult>('mcpServerStatus/list', params);
  }

  async readMcpResource(params: CodexMcpServerResourceReadParams) {
    await this.ensureInitialized();
    return this.client.request<CodexMcpServerResourceReadResult>('mcpServer/resource/read', params);
  }

  async callMcpTool(params: CodexMcpServerToolCallParams) {
    await this.ensureInitialized();
    return this.client.request<CodexMcpServerToolCallResult>('mcpServer/tool/call', params);
  }

  // config/* methods
  async readConfig(params: CodexConfigReadParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexConfigReadResult>('config/read', params);
  }

  // turn/* methods
  async steerTurn(params: CodexTurnSteerParams) {
    await this.ensureInitialized();
    return this.client.request<CodexTurnSteerResult>('turn/steer', params);
  }

  // thread/* methods
  async updateThreadMetadata(params: CodexThreadMetadataUpdateParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadMetadataUpdateResult>('thread/metadata/update', params);
  }

  async startThreadCompaction(params: CodexThreadCompactStartParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadCompactStartResult>('thread/compact/start', params);
  }

  async runThreadShellCommand(params: CodexThreadShellCommandParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadShellCommandResult>('thread/shellCommand', params);
  }

  async injectThreadItems(params: CodexThreadInjectItemsParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadInjectItemsResult>('thread/inject_items', params);
  }

  async listLoadedThreads() {
    await this.ensureInitialized();
    return this.client.request<CodexThreadLoadedListResult>('thread/loaded/list', {});
  }

  // fs/* methods
  async removeFile(params: CodexFsRemoveParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsRemoveResult>('fs/remove', params);
  }

  async watchFile(params: CodexFsWatchParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsWatchResult>('fs/watch', params);
  }

  async unwatchFile(params: CodexFsUnwatchParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsUnwatchResult>('fs/unwatch', params);
  }

  async getFileMetadata(params: CodexFsGetMetadataParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsGetMetadataResult>('fs/getMetadata', params);
  }

  async copyFile(params: CodexFsCopyParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFsCopyResult>('fs/copy', params);
  }

  // command/* methods
  async writeCommandExec(params: CodexCommandExecWriteParams) {
    await this.ensureInitialized();
    return this.client.request<CodexCommandExecWriteResult>('command/exec/write', params);
  }

  async terminateCommandExec(params: CodexCommandExecTerminateParams) {
    await this.ensureInitialized();
    return this.client.request<CodexCommandExecTerminateResult>('command/exec/terminate', params);
  }

  async resizeCommandExec(params: CodexCommandExecResizeParams) {
    await this.ensureInitialized();
    return this.client.request<CodexCommandExecResizeResult>('command/exec/resize', params);
  }

  async cleanThreadBackgroundTerminals(params: CodexThreadBackgroundTerminalsCleanParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadBackgroundTerminalsCleanResult>('thread/backgroundTerminals/clean', params);
  }

  async listApps(params: CodexAppListParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexAppListResult>('app/list', params);
  }

  async writeConfigValue(params: CodexConfigValueWriteParams) {
    await this.ensureInitialized();
    return this.client.request<CodexConfigValueWriteResult>('config/value/write', params);
  }

  async batchWriteConfig(params: CodexConfigBatchWriteParams) {
    await this.ensureInitialized();
    return this.client.request<CodexConfigBatchWriteResult>('config/batchWrite', params);
  }

  async readConfigRequirements(params: CodexConfigRequirementsReadParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexConfigRequirementsReadResult>('configRequirements/read', params);
  }

  async detectExternalAgentConfig(params: CodexExternalAgentConfigDetectParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexExternalAgentConfigDetectResult>('externalAgentConfig/detect', params);
  }

  async importExternalAgentConfig(params: CodexExternalAgentConfigImportParams) {
    await this.ensureInitialized();
    return this.client.request<CodexExternalAgentConfigImportResult>('externalAgentConfig/import', params);
  }

  async listExperimentalFeatures(params: CodexExperimentalFeatureListParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexExperimentalFeatureListResult>('experimentalFeature/list', params);
  }

  async setExperimentalFeatureEnablement(params: CodexExperimentalFeatureEnablementSetParams) {
    await this.ensureInitialized();
    return this.client.request<CodexExperimentalFeatureEnablementSetResult>('experimentalFeature/enablement/set', params);
  }

  async listCollaborationModes() {
    await this.ensureInitialized();
    return this.client.request<CodexCollaborationModeListResult>('collaborationMode/list', {});
  }

  async startWindowsSandboxSetup(params: CodexWindowsSandboxSetupStartParams) {
    await this.ensureInitialized();
    return this.client.request<CodexWindowsSandboxSetupStartResult>('windowsSandbox/setupStart', params);
  }

  async uploadFeedback(params: CodexFeedbackUploadParams) {
    await this.ensureInitialized();
    return this.client.request<CodexFeedbackUploadResult>('feedback/upload', params);
  }

  async requestUserInput(params: CodexToolRequestUserInputParams) {
    await this.ensureInitialized();
    return this.client.request<CodexToolRequestUserInputResult>('tool/requestUserInput', params);
  }

  async createSession(directory?: string) {
    const result = await this.startThread({ cwd: directory });
    return normalizeCodexThread(result.thread);
  }

  async forkSession(sessionId: string, _messageId: string, _directory?: string) {
    const result = await this.forkThread({ threadId: sessionId });
    return normalizeCodexThread(result.thread);
  }

  async updateSession(sessionId: string, payload: SessionUpdatePayload, _directory?: string) {
    if (payload.time?.archived && payload.time.archived > 0) {
      await this.archiveThread({ threadId: sessionId });
    }
    if (payload.time?.archived === 0) {
      const result = await this.unarchiveThread({ threadId: sessionId });
      return normalizeCodexThread(result.thread);
    }
    if (payload.title !== undefined) await this.setThreadName({
      threadId: sessionId,
      name: payload.title || null,
    });
    const result = await this.readThread({ threadId: sessionId });
    return normalizeCodexThread(result.thread);
  }

  deleteSession(sessionId: string, _directory?: string) {
    void sessionId;
    return Promise.reject(new Error('Codex does not support deleteSession; hide the thread locally or archive it instead.'));
  }

  async revertSession(sessionId: string, _messageId: string, _directory?: string) {
    const result = await this.rollbackThread({ threadId: sessionId, numTurns: 1 });
    return normalizeCodexThread(result.thread);
  }

  unrevertSession() {
    return Promise.reject(new Error('Codex does not support unrevertSession.'));
  }

  async listSessions(options?: ListSessionsOptions) {
    const result = await this.listThreads({
      limit: options?.limit,
      cwd: options?.directory,
      searchTerm: options?.search,
    });
    return result.data.map((thread) => normalizeCodexThread(thread));
  }

  async listFiles(payload: { directory: string; path?: string }) {
    const absolutePath = resolveCodexFsPath(payload.directory, payload.path);
    const relativePrefix = normalizeRelativePath(payload.path);
    const result = await this.readDirectory({ path: absolutePath });
    return result.entries.map((entry) => ({
      name: entry.fileName,
      path: relativePrefix ? `${relativePrefix}/${entry.fileName}` : entry.fileName,
      type: entry.isDirectory ? 'directory' : 'file',
    }));
  }

  async readFileContent(payload: { directory: string; path: string }) {
    const result = await this.readFile({ path: resolveCodexFsPath(payload.directory, payload.path) });
    return new TextDecoder().decode(decodeBase64Bytes(result.dataBase64));
  }

  async readFileContentBytes(payload: { directory: string; path: string }) {
    const result = await this.readFile({ path: resolveCodexFsPath(payload.directory, payload.path) });
    return decodeBase64Bytes(result.dataBase64);
  }

  async getVcsInfo(directory: string) {
    const result = await this.commandExec({
      command: ['git', 'branch', '--show-current'],
      cwd: directory,
      timeoutMs: 10_000,
    });
    return { branch: result.stdout.trim() };
  }

  async runOneShotCommand(payload: { directory?: string; command: string; args: string[] }) {
    const result = await this.commandExec({
      command: [payload.command, ...payload.args],
      cwd: payload.directory,
      timeoutMs: 30_000,
      streamStdoutStderr: false,
    });
    if (result.exitCode !== 0) {
      const error = new Error(`Codex command failed (${result.exitCode})`);
      (error as Error & { output?: string }).output = result.stdout || result.stderr;
      throw error;
    }
    return result.stdout;
  }

  async listPendingPermissions() {
    return [];
  }

  async listPendingQuestions() {
    return [];
  }

  async getSessionTodos() {
    return [];
  }

  async getGlobalHealth() {
    await this.ensureInitialized();
    return { healthy: true, version: 'codex-app-server' };
  }

  async getMcpStatus() {
    const result = await this.listMcpServerStatus();
    return result.data;
  }

  async getGlobalConfig() {
    return this.readConfig();
  }

  async getSkillStatus() {
    const result = await this.listSkills({ cwds: [] });
    return result.data.flatMap((entry) => entry.skills);
  }

  updateProject() {
    return Promise.reject(new Error('Codex does not support updateProject.'));
  }

  createWorktree() {
    return Promise.reject(new Error('Codex does not support createWorktree.'));
  }

  deleteWorktree() {
    return Promise.reject(new Error('Codex does not support deleteWorktree.'));
  }
}

export function createCodexAdapter(options: CodexAdapterOptions) {
  return new CodexAdapter(options);
}
