import type {
  BackendAdapter,
  BackendCapabilities,
  BackendQueryValue,
  BackendRequestOptions,
  ListSessionsOptions,
  ProjectUpdatePayload,
  SessionUpdatePayload,
} from '../types';
import { AcpClient, type AcpClientOptions, type AcpPromptPayload } from './acpClient';
import { createAcpAttributionStore } from './attributionStore';
import { createAcpAgentList, createAcpProviderResponse } from './configOptions';
import { normalizeAcpBridgeUrl } from './bridgeUrl';
import { AcpWorkspaceClient } from './workspaceClient';
import { createAcpSessionArchive } from './sessionArchive';
import {
  parseOmpExtensions,
  toOmpMcpStatus,
  toOmpPluginStatus,
  toOmpSkillStatus,
  type OmpExtension,
} from './ompExtensions';

const baseCapabilities: BackendCapabilities = {
  projects: false,
  worktrees: false,
  sessions: true,
  sessionFork: false,
  sessionRevert: false,
  sessionRename: false,
  sessionArchive: true,
  sessionUnarchive: true,
  sessionDelete: false,
  sessionPin: true,
  sessionUnpin: true,
  sessionCompact: false,
  files: true,
  terminal: true,
  permissions: true,
  questions: false,
  todos: false,
  status: true,
  providerConfig: false,
  imageAttachmentsOnly: true,
  projectPickerCreatesSession: true,
  ptyExitRequiresSyntheticEvent: true,
  ptyRefreshArtifactsOnSuccess: false,
  strictSandboxPaths: true,
  sessionManagementMode: 'standard',
};

function unsupported(operation: string): Promise<never> {
  return Promise.reject(new Error(`ACP agent does not support ${operation}.`));
}

const OMP_FALLBACK_COMMANDS = [
  'branch',
  'clear',
  'compact',
  'copy',
  'export',
  'fork',
  'hotkeys',
  'mcp',
  'model',
  'new',
  'plan',
  'reload-plugins',
  'resume',
  'settings',
  'share',
  'status',
  'usage',
].map((name) => ({ name }));

export class AcpAdapter implements BackendAdapter {
  readonly kind = 'acp' as const;
  readonly capabilities = { ...baseCapabilities };
  private readonly acp: AcpClient;
  private readonly workspace: AcpWorkspaceClient;
  private readonly archive: ReturnType<typeof createAcpSessionArchive>;
  private readonly agentId: string;
  private isOhMyPi: boolean;
  private extensionSnapshotPromise: Promise<OmpExtension[]> | null = null;

  constructor(options: AcpClientOptions) {
    this.acp = new AcpClient({
      ...options,
      attributionStore: options.attributionStore ?? createAcpAttributionStore(),
      sessionMetaFetcher:
        options.sessionMetaFetcher ??
        ((sessionId) => this.workspace.getAcpSessionMeta(options.agentId, sessionId)),
    });
    this.agentId = options.agentId;
    this.isOhMyPi = options.agentId === 'oh-my-pi';
    this.capabilities.sessionDelete = false;
    this.archive = createAcpSessionArchive(options.agentId);
    const agentUrl = new URL(options.url);
    const inferredBridgeUrl = `${agentUrl.protocol}//${agentUrl.host}${agentUrl.pathname.replace(/\/acp\/[^/]+$/u, '')}`;
    this.workspace = new AcpWorkspaceClient({
      bridgeUrl: options.bridgeUrl ?? normalizeAcpBridgeUrl(inferredBridgeUrl),
      bridgeToken: options.bridgeToken ?? agentUrl.searchParams.get('token') ?? '',
    });
    this.createSession = this.createSession.bind(this);
    this.forkSession = this.forkSession.bind(this);
    this.updateSession = this.updateSession.bind(this);
    this.deleteSession = this.deleteSession.bind(this);
    this.revertSession = this.revertSession.bind(this);
    this.unrevertSession = this.unrevertSession.bind(this);
    this.listSessions = this.listSessions.bind(this);
    this.listSessionMessages = this.listSessionMessages.bind(this);
    this.sendPromptAsync = this.sendPromptAsync.bind(this);
    this.abortSession = this.abortSession.bind(this);
    this.getSessionStatusMap = this.getSessionStatusMap.bind(this);
    this.listPendingPermissions = this.listPendingPermissions.bind(this);
    this.replyPermission = this.replyPermission.bind(this);
    this.getGlobalHealth = this.getGlobalHealth.bind(this);
    this.getGlobalConfig = this.getGlobalConfig.bind(this);
    this.getMcpStatus = this.getMcpStatus.bind(this);
    this.getPluginStatus = this.getPluginStatus.bind(this);
    this.getSkillStatus = this.getSkillStatus.bind(this);
    this.listProviders = this.listProviders.bind(this);
    this.listAgents = this.listAgents.bind(this);
    this.listCommands = this.listCommands.bind(this);
    this.sendCommand = this.sendCommand.bind(this);
    this.listAgentAuthMethods = this.listAgentAuthMethods.bind(this);
    this.createAgentAuthPty = this.createAgentAuthPty.bind(this);
    this.authenticateAgent = this.authenticateAgent.bind(this);
    this.listFiles = this.listFiles.bind(this);
    this.readFileContent = this.readFileContent.bind(this);
    this.readFileContentBytes = this.readFileContentBytes.bind(this);
    this.writeFileContent = this.writeFileContent.bind(this);
    this.listPtys = this.listPtys.bind(this);
    this.createPty = this.createPty.bind(this);
    this.updatePtySize = this.updatePtySize.bind(this);
    this.deletePty = this.deletePty.bind(this);
    this.createPtyWebSocketUrl = this.createPtyWebSocketUrl.bind(this);
    this.runOneShotCommand = this.runOneShotCommand.bind(this);
    this.getVcsInfo = this.getVcsInfo.bind(this);
    this.updateProject = this.updateProject.bind(this);
    this.createWorktree = this.createWorktree.bind(this);
    this.deleteWorktree = this.deleteWorktree.bind(this);
  }

  get label() {
    return this.acp.agentInfo?.title ?? this.acp.agentInfo?.name ?? 'ACP';
  }

  get agentInfo() {
    return this.acp.agentInfo;
  }

  async initialize() {
    const result = await this.acp.initialize();
    this.isOhMyPi = this.isOhMyPi || result.agentInfo?.name === 'oh-my-pi';
    this.capabilities.sessionDelete =
      this.acp.supports('session/delete') ||
      (this.isOhMyPi && this.acp.supports('session/resume') && this.acp.supports('session/list'));
    return result;
  }

  disconnect() {
    this.acp.disconnect();
  }

  supports(method: string) {
    return this.acp.supports(method);
  }

  onEvent(handler: Parameters<AcpClient['onEvent']>[0]) {
    return this.acp.onEvent(handler);
  }

  createSession(directory?: string) {
    return this.acp.createSession(directory);
  }

  async listSessions(options?: ListSessionsOptions) {
    this.archive.reload();
    const sessions = await this.acp.listSessions({ directory: options?.directory });
    return sessions.map((session) =>
      this.archive.has(session.id)
        ? { ...session, time: { ...session.time, archived: session.time?.archived ?? 1 } }
        : session,
    );
  }

  listSessionMessages(sessionId: string, options?: { directory?: string; limit?: number }) {
    return this.acp.listSessionMessages(sessionId, options?.directory);
  }

  sendPromptAsync(sessionId: string, payload: AcpPromptPayload) {
    return this.acp.sendPromptAsync(sessionId, payload);
  }

  abortSession(sessionId: string) {
    return this.acp.abortSession(sessionId);
  }

  getSessionStatusMap(_directory?: string, _options?: BackendRequestOptions) {
    return Promise.resolve(this.acp.getSessionStatusMap());
  }

  listPendingPermissions() {
    return this.acp.listPendingPermissions();
  }

  replyPermission(requestId: string, payload: { reply: string }) {
    if (payload.reply !== 'once' && payload.reply !== 'always' && payload.reply !== 'reject') {
      return Promise.reject(new Error(`Unsupported ACP permission reply: ${payload.reply}`));
    }
    return this.acp.replyPermission(requestId, payload.reply);
  }

  async getGlobalHealth() {
    const result = await this.acp.initialize();
    return { healthy: true, version: result.agentInfo?.version ?? String(result.protocolVersion) };
  }

  async getGlobalConfig() {
    return {};
  }

  private getOmpExtensions() {
    if (!this.isOhMyPi) return unsupported('extension status');
    if (!this.extensionSnapshotPromise) {
      this.extensionSnapshotPromise = this.acp
        .listOmpExtensions()
        .then(parseOmpExtensions)
        .finally(() => {
          queueMicrotask(() => {
            this.extensionSnapshotPromise = null;
          });
        });
    }
    return this.extensionSnapshotPromise;
  }

  async getMcpStatus() {
    return toOmpMcpStatus(await this.getOmpExtensions());
  }

  async getPluginStatus() {
    return toOmpPluginStatus(await this.getOmpExtensions());
  }

  async getSkillStatus() {
    return toOmpSkillStatus(await this.getOmpExtensions());
  }

  async listProviders() {
    return createAcpProviderResponse(this.acp.getConfigOptions(), this.label);
  }

  async listAgents() {
    return createAcpAgentList(this.acp.getConfigOptions(), this.label);
  }

  getSessionConfigOptions() {
    return this.acp.getConfigOptions();
  }

  syncSessionConfig(sessionId: string, selection: { model: string; mode: string; thoughtLevel?: string }) {
    return this.acp.syncSessionConfig(sessionId, selection);
  }

  async listCommands() {
    const commands = this.acp.getAvailableCommands();
    return commands.length > 0 || !this.isOhMyPi ? commands : OMP_FALLBACK_COMMANDS;
  }

  async listAgentAuthMethods() {
    await this.acp.initialize();
    const methods = this.acp.getAuthMethods();
    if (this.agentId === 'kimi-code') {
      // kimi --login does not exist ("unknown option --login"); providers are
      // configured in the interactive TUI via the /provider page. Replace the
      // broken advertised method with a plain TUI terminal plus the /provider
      // keystrokes as initial input.
      return [
        {
          type: 'terminal',
          id: 'terminal',
          name: 'Set up Kimi Code in terminal',
          args: [],
          initialInput: '/provider\r',
        },
      ];
    }
    if (this.isOhMyPi) {
      // Provider setup lives in the TUI's /providers page; auto-type it after boot.
      // Keep the agent-advertised terminal args (--acp-terminal-auth) when present.
      const withInput = methods.map((method) =>
        method.type === 'terminal' ? { ...method, initialInput: '/providers\r' } : method,
      );
      if (withInput.some((method) => method.type === 'terminal')) return withInput;
      return [
        ...withInput,
        {
          type: 'terminal',
          id: 'terminal',
          name: 'Set up Oh My Pi in terminal',
          args: [],
          initialInput: '/providers\r',
        },
      ];
    }
    return methods;
  }

  async createAgentAuthPty(methodId: string) {
    const method = (await this.listAgentAuthMethods()).find(
      (candidate) => candidate.id === methodId,
    );
    if (!method || method.type !== 'terminal' || (!method.args?.length && !method.initialInput)) {
      throw new Error(`ACP terminal authentication method is unavailable: ${methodId}.`);
    }
    return this.workspace.createManagedAgentTerminal(this.agentId, method.args ?? [], method.name);
  }

  authenticateAgent(methodId: string) {
    return this.acp.authenticate(methodId);
  }

  sendCommand(
    sessionId: string,
    payload: {
      directory?: string;
      command: string;
      arguments: string;
      agent?: string;
      model?: string;
      variant?: string;
    },
  ) {
    const argumentsText = payload.arguments.trim();
    return this.acp.sendPromptAsync(sessionId, {
      directory: payload.directory ?? '',
      agent: payload.agent ?? 'default',
      model: { providerID: 'acp', modelID: payload.model ?? 'default' },
      variant: payload.variant,
      parts: [
        { type: 'text', text: `/${payload.command}${argumentsText ? ` ${argumentsText}` : ''}` },
      ],
    });
  }

  listFiles(payload: { directory: string; path?: string }) {
    return this.workspace.listFiles(payload);
  }

  readFileContent(payload: { directory: string; path: string }, options?: BackendRequestOptions) {
    return this.workspace.readFile(payload, options);
  }

  readFileContentBytes(
    payload: { directory: string; path: string },
    options?: BackendRequestOptions,
  ) {
    return this.workspace.readFileBytes(payload, options);
  }

  writeFileContent(
    payload: { directory: string; path: string; content: string },
    options?: BackendRequestOptions,
  ) {
    return this.workspace.writeFile(payload, options);
  }

  listPtys() {
    return this.workspace.listPtys();
  }

  createPty(
    payload: {
      directory?: string;
      cwd?: string;
      command?: string;
      args?: string[];
      title?: string;
    },
    options?: BackendRequestOptions,
  ) {
    return this.workspace.createPty(payload, options);
  }

  updatePtySize(ptyId: string, payload: { rows: number; cols: number }) {
    return this.workspace.resizePty(ptyId, payload.rows, payload.cols);
  }

  deletePty(ptyId: string) {
    return this.workspace.deletePty(ptyId);
  }

  createPtyWebSocketUrl(path: string, params?: Record<string, BackendQueryValue>) {
    return this.workspace.createPtyWebSocketUrl(path, params);
  }

  runOneShotCommand(payload: { directory?: string; command: string; args: string[] }) {
    return this.workspace.runOneShotCommand(payload);
  }

  getVcsInfo(directory: string) {
    return this.workspace.getVcsInfo(directory);
  }

  forkSession(_sessionId: string, _messageId: string, _directory?: string) {
    return unsupported('session/fork');
  }

  updateSession(sessionId: string, payload: SessionUpdatePayload, _directory?: string) {
    if (payload.time?.archived === undefined) return unsupported('session rename');
    const archived = payload.time.archived > 0;
    this.archive.set(sessionId, archived);
    this.acp.setSessionArchived(sessionId, archived ? payload.time.archived : undefined);
    return Promise.resolve({});
  }

  async deleteSession(sessionId: string, directory?: string) {
    if (this.acp.supports('session/delete')) {
      await this.acp.deleteSession(sessionId);
      return;
    }
    if (!this.isOhMyPi) return unsupported('session/delete');
    await this.acp.deleteSessionWithCommand(sessionId, directory);
    this.archive.set(sessionId, false);
  }

  revertSession(_sessionId: string, _messageId: string, _directory?: string) {
    return unsupported('session revert');
  }

  unrevertSession(_sessionId: string, _directory?: string) {
    return unsupported('session unrevert');
  }

  updateProject(_projectId: string, _payload: ProjectUpdatePayload) {
    return unsupported('project updates');
  }

  createWorktree(_directory: string) {
    return unsupported('worktrees');
  }

  deleteWorktree(_directory: string, _targetDirectory: string) {
    return unsupported('worktrees');
  }
}

export function createAcpAdapter(options: AcpClientOptions) {
  return new AcpAdapter(options);
}
