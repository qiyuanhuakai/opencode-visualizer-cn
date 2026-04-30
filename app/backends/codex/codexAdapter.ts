import {
  CodexJsonRpcClient,
  type CodexJsonRpcClientOptions,
  type CodexJsonRpcId,
  type CodexJsonRpcNotification,
  type CodexJsonRpcServerRequest,
} from './jsonRpcClient';
import type {
  BackendAdapter,
  BackendQueryValue,
  BackendRequestOptions,
  ListSessionsOptions,
  SessionUpdatePayload,
} from '../types';
import { CODEX_PROJECT_ID, codexBridgeHttpUrl } from './bridgeUrl';
import { normalizeCodexTurnsToHistory } from './normalize';

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
  gitInfo?: { branch?: string; sha?: string; originUrl?: string; root?: string } | null;
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
  dataBase64?: string;
  content?: string;
  encoding?: string;
  type?: 'text' | 'binary';
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

type CodexProviderModel = {
  id: string;
  name: string;
  providerID: string;
  status?: string;
  variants?: Record<string, { description?: string }>;
  capabilities?: {
    attachment?: boolean;
    reasoning?: boolean;
    toolcall?: boolean;
  };
};

type CodexProviderInfo = {
  id: string;
  name: string;
  source: string;
  models: Record<string, CodexProviderModel>;
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
  gitInfo?: { branch?: string; sha?: string; originUrl?: string; root?: string } | null;
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

function normalizeCodexStatus(status: unknown): NormalizedCodexSession['status'] {
  if (status === 'running' || status === 'busy' || status === 'inProgress') return 'busy';
  if (status === 'retry') return 'retry';
  return 'idle';
}

function normalizeCodexMcpStatus(status: string) {
  if (status === 'connected' || status === 'disabled' || status === 'failed') return status;
  if (status === 'needs_auth' || status === 'needs_client_registration') return status;
  if (status === 'running' || status === 'ready') return 'connected';
  if (status === 'auth_required') return 'needs_auth';
  return status ? 'failed' : 'disabled';
}

function codexModelVariants(model: CodexModel) {
  const efforts = model.supportedReasoningEfforts ?? [];
  return Object.fromEntries(
    efforts.map((effort) => [
      effort.reasoningEffort,
      { description: effort.description },
    ]),
  );
}

function expandCodexHomePath(path: string | undefined, homeDirectory?: string) {
  const raw = path?.trim();
  if (!raw) return undefined;
  const home = homeDirectory?.trim();
  if (raw === '~') return home || '/';
  if (raw.startsWith('~/')) return home ? `${home.replace(/\/+$/u, '')}/${raw.slice(2).replace(/^\/+/, '')}` : raw;
  return raw;
}

function normalizeCodexThread(thread: CodexThread, homeDirectory?: string): NormalizedCodexSession {
  const directory = expandCodexHomePath(thread.cwd, homeDirectory);
    return {
    id: thread.id,
    projectID: CODEX_PROJECT_ID,
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

function normalizePathSeparators(path: string) {
  return path.replace(/\\/gu, '/');
}

function hasParentSegment(path: string) {
  return normalizePathSeparators(path).split('/').some((segment) => segment === '..');
}

function normalizeAbsoluteCodexPath(path: string) {
  const normalized = normalizePathSeparators(path.trim()).replace(/\/+/gu, '/');
  if (/^[A-Za-z]:\//u.test(normalized)) {
    const [drive = '', ...rest] = normalized.split('/');
    return `${drive}/${rest.filter((segment) => segment && segment !== '.').join('/')}`.replace(/\/+$/u, '') || `${drive}/`;
  }
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new Error('Codex file paths cannot escape the active directory.');
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`.replace(/\/+$/u, '') || '/';
}

function isWithinCodexRoot(root: string, target: string) {
  const normalizedRoot = normalizeAbsoluteCodexPath(root);
  const normalizedTarget = normalizeAbsoluteCodexPath(target);
  if (normalizedRoot === '/') return normalizedTarget === '/';
  const comparableRoot = /^[A-Za-z]:\//u.test(normalizedRoot) ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableTarget = /^[A-Za-z]:\//u.test(normalizedTarget) ? normalizedTarget.toLowerCase() : normalizedTarget;
  return comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}/`);
}

function normalizeRelativePath(path?: string) {
  const trimmed = path?.trim() || '.';
  if (trimmed === '.') return '';
  return trimmed.replace(/^\/+|\/+$/gu, '');
}

function resolveCodexFsPath(directory: string, path?: string) {
  const trimmedPath = path?.trim();
  const root = normalizeAbsoluteCodexPath(directory.trim());
  if (!isAbsolutePath(root)) throw new Error('Codex file root must be absolute.');
  if (trimmedPath && isAbsolutePath(trimmedPath)) {
    const target = normalizeAbsoluteCodexPath(trimmedPath);
    if (!isWithinCodexRoot(root, target)) {
      throw new Error('Codex file path is outside the active directory.');
    }
    return target;
  }
  if (trimmedPath && hasParentSegment(trimmedPath)) {
    throw new Error('Codex file paths cannot contain parent-directory segments.');
  }
  const relative = normalizeRelativePath(trimmedPath);
  const target = relative ? `${root.replace(/\/+$/u, '')}/${relative}` : root;
  if (!isWithinCodexRoot(root, target)) {
    throw new Error('Codex file path is outside the active directory.');
  }
  return target;
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

function isUnmaterializedThreadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /not materialized/i.test(message) ||
    /includeTurns is unavailable/i.test(message) ||
    /no rollout found/i.test(message);
}

function codexReadFileBytes(result: CodexFsReadFileResult) {
  if (typeof result.dataBase64 === 'string') return decodeBase64Bytes(result.dataBase64);
  if (typeof result.content === 'string') {
    if (result.encoding === 'base64') return decodeBase64Bytes(result.content);
    return new TextEncoder().encode(result.content);
  }
  return new Uint8Array();
}

function codexReadFileText(result: CodexFsReadFileResult) {
  if (typeof result.content === 'string' && result.encoding !== 'base64') return result.content;
  return new TextDecoder().decode(codexReadFileBytes(result));
}

function codexBridgeWebSocketUrl(bridgeUrl: string, endpoint: `/${string}`, params: Record<string, BackendQueryValue> = {}) {
  const parsed = new URL(bridgeUrl);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Unsupported Codex bridge URL protocol: ${parsed.protocol}`);
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  if (pathSegments.length > 0) pathSegments.pop();
  const prefix = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
  parsed.pathname = `${prefix}${endpoint}`;
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) parsed.searchParams.set(key, String(value));
  });
  return parsed.toString();
}

function defaultClientInfo(): CodexClientInfo {
  return {
    name: 'vis',
    title: 'Vis',
    version: '0.3.0',
  };
}

function parseCodexDialogRequestId(requestId: string): CodexJsonRpcId {
  const prefix = 'codex:';
  if (!requestId.startsWith(prefix)) return requestId;
  try {
    const parsed: unknown = JSON.parse(requestId.slice(prefix.length));
    if (typeof parsed === 'string' || typeof parsed === 'number') return parsed;
  } catch {
    return requestId;
  }
  return requestId;
}

function parseCodexToolQuestionRequest(requestId: string): {
  id: CodexJsonRpcId;
  questionIds: string[];
  dynamic: boolean;
} {
  const dynamicPrefix = 'codex-dynamic:';
  if (requestId.startsWith(dynamicPrefix)) {
    try {
      const parsed: unknown = JSON.parse(requestId.slice(dynamicPrefix.length));
      if (typeof parsed === 'string' || typeof parsed === 'number') {
        return { id: parsed, questionIds: [], dynamic: true };
      }
    } catch {
      return { id: requestId, questionIds: [], dynamic: true };
    }
    return { id: requestId, questionIds: [], dynamic: true };
  }
  const prefix = 'codex-tool:';
  if (!requestId.startsWith(prefix)) {
    return { id: parseCodexDialogRequestId(requestId), questionIds: [], dynamic: false };
  }
  try {
    const parsed: unknown = JSON.parse(requestId.slice(prefix.length));
    if (!parsed || typeof parsed !== 'object') return { id: requestId, questionIds: [], dynamic: false };
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === 'string' || typeof record.id === 'number'
      ? record.id
      : requestId;
    const questionIds = Array.isArray(record.questionIds)
      ? record.questionIds.filter((value): value is string => typeof value === 'string')
      : [];
    return { id, questionIds, dynamic: false };
  } catch {
    return { id: requestId, questionIds: [], dynamic: false };
  }
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
    permissions: true,
    questions: true,
    todos: false,
    status: true,
  };

  private readonly client: CodexJsonRpcClient;
  private readonly clientInfo: CodexClientInfo;
  private readonly experimentalApi: boolean;
  private readonly bridgeUrl: string;
  private readonly activeTurnByThreadId = new Map<string, string>();
  private initialized = false;

  constructor(options: CodexAdapterOptions) {
    this.client = new CodexJsonRpcClient(options);
    this.clientInfo = options.clientInfo ?? defaultClientInfo();
    this.experimentalApi = options.experimentalApi ?? false;
    this.bridgeUrl = options.url;
    this.bindBackendMethods();
  }

  private bindBackendMethods() {
    this.createSession = this.createSession.bind(this);
    this.forkSession = this.forkSession.bind(this);
    this.updateSession = this.updateSession.bind(this);
    this.deleteSession = this.deleteSession.bind(this);
    this.revertSession = this.revertSession.bind(this);
    this.unrevertSession = this.unrevertSession.bind(this);
    this.listSessions = this.listSessions.bind(this);
    this.getPathInfo = this.getPathInfo.bind(this);
    this.getGlobalConfig = this.getGlobalConfig.bind(this);
    this.listFiles = this.listFiles.bind(this);
    this.readFileContent = this.readFileContent.bind(this);
    this.readFileContentBytes = this.readFileContentBytes.bind(this);
    this.listPtys = this.listPtys.bind(this);
    this.createPty = this.createPty.bind(this);
    this.updatePtySize = this.updatePtySize.bind(this);
    this.deletePty = this.deletePty.bind(this);
    this.createPtyWebSocketUrl = this.createPtyWebSocketUrl.bind(this);
    this.getVcsInfo = this.getVcsInfo.bind(this);
    this.listProviders = this.listProviders.bind(this);
    this.listProviderAuthMethods = this.listProviderAuthMethods.bind(this);
    this.listAgents = this.listAgents.bind(this);
    this.listCommands = this.listCommands.bind(this);
    this.getSessionStatusMap = this.getSessionStatusMap.bind(this);
    this.listSessionMessages = this.listSessionMessages.bind(this);
    this.getSessionTodos = this.getSessionTodos.bind(this);
    this.sendPromptAsync = this.sendPromptAsync.bind(this);
    this.abortSession = this.abortSession.bind(this);
    this.listPendingPermissions = this.listPendingPermissions.bind(this);
    this.listPendingQuestions = this.listPendingQuestions.bind(this);
    this.replyPermission = this.replyPermission.bind(this);
    this.replyQuestion = this.replyQuestion.bind(this);
    this.rejectQuestion = this.rejectQuestion.bind(this);
    this.getGlobalHealth = this.getGlobalHealth.bind(this);
    this.getMcpStatus = this.getMcpStatus.bind(this);
    this.getLspStatus = this.getLspStatus.bind(this);
    this.updateMcp = this.updateMcp.bind(this);
    this.getSkillStatus = this.getSkillStatus.bind(this);
    this.updateProject = this.updateProject.bind(this);
    this.createWorktree = this.createWorktree.bind(this);
    this.deleteWorktree = this.deleteWorktree.bind(this);
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
    let result: CodexInitializeResult;
    try {
      result = await this.client.request<CodexInitializeResult>('initialize', {
        clientInfo: params.clientInfo ?? this.clientInfo,
        capabilities,
      });
      this.client.notify('initialized', {});
    } catch (error) {
      if (!(error instanceof Error) || !/already initialized/i.test(error.message)) {
        throw error;
      }
      result = {};
    }
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
    let startedThread = input.threadId
      ? undefined
      : await this.startThread({
          ...input.thread,
          model: input.thread?.model ?? input.model,
          cwd: input.thread?.cwd ?? input.cwd,
          approvalPolicy: input.thread?.approvalPolicy ?? input.approvalPolicy,
        });
    let threadId = input.threadId ?? startedThread?.thread.id;
    if (!threadId) {
      throw new Error('Codex prompt requires a threadId or a started thread.');
    }
    if (input.threadId) {
      try {
        await this.resumeThread({ threadId: input.threadId });
      } catch (error) {
        if (!isUnmaterializedThreadError(error)) throw error;
        startedThread = await this.startThread({
          ...input.thread,
          model: input.thread?.model ?? input.model,
          cwd: input.thread?.cwd ?? input.cwd,
          approvalPolicy: input.thread?.approvalPolicy ?? input.approvalPolicy,
        });
        threadId = startedThread.thread.id;
      }
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

  private async fetchBridgeHomeDir() {
    try {
      const httpUrl = codexBridgeHttpUrl(this.bridgeUrl, '/homedir');
      const response = await fetch(httpUrl, { method: 'GET' });
      if (!response.ok) return '';
      const data = await response.json() as { home?: unknown };
      return typeof data.home === 'string' ? data.home : '';
    } catch {
      return '';
    }
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
    return normalizeCodexThread(result.thread, await this.fetchBridgeHomeDir());
  }

  async forkSession(sessionId: string, _messageId: string, _directory?: string) {
    const result = await this.forkThread({ threadId: sessionId });
    return normalizeCodexThread(result.thread, await this.fetchBridgeHomeDir());
  }

  async updateSession(sessionId: string, payload: SessionUpdatePayload, _directory?: string) {
    if (payload.time?.archived && payload.time.archived > 0) {
      await this.archiveThread({ threadId: sessionId });
    }
    if (payload.time?.archived === 0) {
      const result = await this.unarchiveThread({ threadId: sessionId });
      return normalizeCodexThread(result.thread, await this.fetchBridgeHomeDir());
    }
    if (payload.title !== undefined) await this.setThreadName({
      threadId: sessionId,
      name: payload.title || null,
    });
    const result = await this.readThread({ threadId: sessionId });
    return normalizeCodexThread(result.thread, await this.fetchBridgeHomeDir());
  }

  deleteSession(sessionId: string, _directory?: string) {
    void sessionId;
    return Promise.reject(new Error('Codex does not support deleteSession; hide the thread locally or archive it instead.'));
  }

  async revertSession(sessionId: string, _messageId: string, _directory?: string) {
    const result = await this.rollbackThread({ threadId: sessionId, numTurns: 1 });
    return normalizeCodexThread(result.thread, await this.fetchBridgeHomeDir());
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
    const home = await this.fetchBridgeHomeDir();
    return result.data.map((thread) => normalizeCodexThread(thread, home));
  }

  async listProviders() {
    const result = await this.listModels({ includeHidden: true });
    const allModels = result.data;
    const models = Object.fromEntries(
      allModels.map((model) => {
        const variants = codexModelVariants(model);
        const providerModel: CodexProviderModel = {
          id: model.id,
          name: model.displayName || model.model || model.id,
          providerID: CODEX_PROJECT_ID,
          status: model.upgrade ? 'available' : 'connected',
          variants,
          capabilities: {
            attachment: model.inputModalities?.includes('image') ?? false,
            reasoning: Object.keys(variants).length > 0,
            toolcall: true,
          },
        };
        return [model.id, providerModel];
      }),
    );
    const provider: CodexProviderInfo = {
      id: CODEX_PROJECT_ID,
      name: 'Codex',
      source: 'codex-app-server',
      models,
    };
    const defaultModel = allModels.find((model) => model.isDefault) ?? allModels.find((model) => !model.hidden) ?? allModels[0];
    return {
      all: [provider],
      connected: [CODEX_PROJECT_ID],
      default: defaultModel ? { [CODEX_PROJECT_ID]: defaultModel.id } : {},
    };
  }

  async listProviderAuthMethods() {
    return { [CODEX_PROJECT_ID]: [] };
  }

  async listAgents() {
    return [
      {
        name: 'codex',
        description: 'Codex app-server',
        mode: 'primary',
        color: 'cyan',
      },
    ];
  }

  async listCommands() {
    return [];
  }

  async getPathInfo() {
    const home = await this.fetchBridgeHomeDir();
    return {
      home: home || '/',
      worktree: home || '/',
    };
  }

  async getSessionStatusMap(directory?: string) {
    const result = await this.listThreads({ cwd: directory, limit: 100, sortKey: 'updated_at' });
    return Object.fromEntries(
      result.data.map((thread) => [thread.id, normalizeCodexStatus(thread.status)]),
    );
  }

  async listSessionMessages(sessionId: string) {
    let read: CodexThreadReadResult;
    try {
      read = await this.readThread({ threadId: sessionId, includeTurns: true });
    } catch (error) {
      if (!isUnmaterializedThreadError(error)) throw error;
      read = await this.readThread({ threadId: sessionId, includeTurns: false });
    }
    return normalizeCodexTurnsToHistory({
      sessionId: read.thread.id,
      turns: read.thread.turns ?? [],
    });
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
    return {
      content: codexReadFileText(result),
      encoding: 'utf-8',
      type: result.type === 'binary' ? 'binary' : 'text',
    };
  }

  async readFileContentBytes(payload: { directory: string; path: string }) {
    const result = await this.readFile({ path: resolveCodexFsPath(payload.directory, payload.path) });
    return codexReadFileBytes(result);
  }

  async getVcsInfo(directory: string) {
    let root = '';
    let branch = '';
    try {
      const rootResult = await this.commandExec({
        command: ['git', 'rev-parse', '--show-toplevel'],
        cwd: directory,
        timeoutMs: 10_000,
      });
      root = rootResult.stdout.trim();
    } catch {
      return { root: '', branch: '' };
    }
    try {
      const branchResult = await this.commandExec({
        command: ['git', 'branch', '--show-current'],
        cwd: directory,
        timeoutMs: 10_000,
      });
      branch = branchResult.stdout.trim();
    } catch {
      branch = '';
    }
    return { root, branch };
  }
  private async bridgeJson(endpoint: `/${string}`, init: RequestInit = {}) {
    const response = await fetch(codexBridgeHttpUrl(this.bridgeUrl, endpoint), init);
    if (!response.ok) {
      let message = `Codex bridge request failed (${response.status})`;
      try {
        const data = await response.json() as { error?: unknown };
        if (typeof data.error === 'string') message = data.error;
      } catch {}
      throw new Error(message);
    }
    return response.json();
  }

  async listPtys(_directory?: string) {
    return this.bridgeJson('/pty');
  }

  async createPty(
    payload: { directory?: string; cwd?: string; command?: string; args?: string[]; title?: string },
    options?: BackendRequestOptions,
  ) {
    return this.bridgeJson('/pty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options?.signal,
    });
  }

  async updatePtySize(ptyId: string, payload: { directory?: string; rows: number; cols: number }) {
    return this.bridgeJson(`/pty/${encodeURIComponent(ptyId)}` as `/${string}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: { rows: payload.rows, cols: payload.cols } }),
    });
  }

  async deletePty(ptyId: string) {
    return this.bridgeJson(`/pty/${encodeURIComponent(ptyId)}` as `/${string}`, { method: 'DELETE' });
  }

  createPtyWebSocketUrl(path: string, params?: Record<string, BackendQueryValue>) {
    return codexBridgeWebSocketUrl(this.bridgeUrl, path as `/${string}`, params ?? {});
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

  async sendPromptAsync(
    sessionId: string,
    payload: { directory: string; model: { providerID?: string; modelID: string }; parts: Array<Record<string, unknown>> },
  ) {
    const text = payload.parts
      .map((part) => {
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (part.type === 'file' && typeof part.filename === 'string') return `[file: ${part.filename}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
    if (!text.trim()) return;
    const result = await this.sendPrompt({
      threadId: sessionId,
      text,
      cwd: payload.directory,
      model: payload.model.modelID,
    });
    this.activeTurnByThreadId.set(result.threadId, result.turn.id);
  }

  async abortSession(sessionId: string) {
    const turnId = this.activeTurnByThreadId.get(sessionId);
    if (!turnId) return;
    await this.interruptTurn({ threadId: sessionId, turnId });
    this.activeTurnByThreadId.delete(sessionId);
  }

  async listPendingPermissions() {
    return [];
  }

  async listPendingQuestions() {
    return [];
  }

  async replyPermission(requestId: string, payload: { reply: string }) {
    const decision = payload.reply === 'always'
      ? 'acceptForSession'
      : payload.reply === 'reject'
        ? 'decline'
        : 'accept';
    this.respondToServerRequest(parseCodexDialogRequestId(requestId), decision);
  }

  async replyQuestion(requestId: string, payload: { answers: string[][] }) {
    const request = parseCodexToolQuestionRequest(requestId);
    if (request.dynamic) {
      const contentItems = payload.answers
        .flat()
        .map((text) => ({ type: 'text', text }));
      this.respondToServerRequest(request.id, { contentItems });
      return;
    }
    const responses = payload.answers.flatMap((answers, index) => (
      answers.map((answer) => ({ questionId: request.questionIds[index] ?? String(index), response: answer }))
    ));
    this.respondToServerRequest(request.id, { responses });
  }

  async rejectQuestion(requestId: string) {
    const request = parseCodexToolQuestionRequest(requestId);
    this.respondToServerRequest(request.id, request.dynamic ? { contentItems: [] } : { responses: [] });
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
    return Object.fromEntries(
      result.data.map((server) => [
        server.name,
        {
          status: normalizeCodexMcpStatus(server.status),
          error: server.error,
        },
      ]),
    );
  }

  async getLspStatus() {
    return [];
  }

  async getGlobalConfig() {
    return this.readConfig();
  }

  async updateMcp(payload: { name: string; config: Record<string, unknown> }) {
    await this.writeConfigValue({
      keyPath: `mcp.${payload.name}`,
      value: payload.config,
      mergeStrategy: 'replace',
    });
    return this.reloadMcpServerConfig({});
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
