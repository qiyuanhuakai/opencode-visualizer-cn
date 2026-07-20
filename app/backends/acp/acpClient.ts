import type { BackendSessionInfo } from '../../types/backend-domain';
import { CodexJsonRpcClient } from '../codex/jsonRpcClient';
import {
  applyAcpUpdate,
  beginAcpPrompt,
  completeAcpPrompt,
  createAcpSessionState,
  type AcpHistoryEntry,
  type AcpSessionState,
} from './history';
import {
  parseInitializeResult,
  parseNewSessionResult,
  parsePromptResult,
  parseSessionUpdateParams,
  toRecord,
  type AcpAgentInfo,
  type AcpInitializeResult,
} from './wire';
import { AcpPermissionStore } from './permissionStore';
import { parseAcpSessionList } from './sessionList';
import { toAcpPromptBlocks } from './promptBlocks';
import { syncAcpPromptConfig } from './configOptions';
import { loadAcpSessionHistory } from './sessionHistory';
import { ACP_PROJECT_ID } from './bridgeUrl';
import type { AcpClientEvent, AcpClientOptions, AcpPromptPayload } from './acpClientTypes';

export type { AcpPermissionRequest } from './permissionStore';
export type { AcpClientEvent, AcpClientOptions, AcpPromptPayload } from './acpClientTypes';

function parseAcpCommand(value: unknown): Array<Record<string, unknown>> {
  const record = toRecord(value);
  if (!record || typeof record.name !== 'string') return [];
  return [
    {
      name: record.name,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(toRecord(record.input) ? { input: record.input } : {}),
    },
  ];
}

export class AcpClient {
  private readonly client: CodexJsonRpcClient;
  private readonly agentId: string;
  private readonly now: () => number;
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly activatedSessions = new Set<string>();
  private readonly loadedSessions = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly eventHandlers = new Set<(event: AcpClientEvent) => void>();
  private readonly permissions: AcpPermissionStore;
  private readonly promptingSessions = new Set<string>();
  private readonly historyLoads = new Map<string, Promise<AcpHistoryEntry[]>>();
  private initializeResult: AcpInitializeResult | null = null;
  private activeSessionId: string | null = null;
  private lifecycleGeneration = 0;

  constructor(options: AcpClientOptions) {
    this.agentId = options.agentId;
    this.now = options.now ?? Date.now;
    this.client = new CodexJsonRpcClient({
      url: options.url,
      connectionLabel: 'ACP',
      jsonRpcVersion: '2.0',
      webSocketCtor: options.webSocketCtor,
    });
    this.client.onNotification((notification) => {
      if (notification.method === 'session/update') this.handleSessionUpdate(notification.params);
    });
    this.permissions = new AcpPermissionStore(
      this.client,
      (sessionId) =>
        this.sessions.get(sessionId)?.activeAssistantId ?? `acp:${sessionId}:assistant`,
      (request) => this.emit({ type: 'permission.asked', request }),
    );
    this.client.onServerRequest((request) => this.permissions.handleServerRequest(request));
  }

  get agentInfo(): AcpAgentInfo | undefined {
    return this.initializeResult?.agentInfo;
  }

  onEvent(handler: (event: AcpClientEvent) => void) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: AcpClientEvent) {
    for (const handler of this.eventHandlers) handler(event);
  }

  private emitEntry(entry: AcpHistoryEntry) {
    this.emit({ type: 'message.updated', info: entry.info });
    for (const part of entry.parts) this.emit({ type: 'message.part.updated', part });
  }

  async initialize() {
    if (this.initializeResult && this.client.isConnected()) return this.initializeResult;
    if (this.initializeResult) {
      this.lifecycleGeneration += 1;
      this.initializeResult = null;
      this.loadedSessions.clear();
      this.historyLoads.clear();
      this.permissions.clear();
    }
    await this.client.connect();
    const result = parseInitializeResult(
      await this.client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          auth: { terminal: true },
        },
        clientInfo: { name: 'vis', title: 'VIS', version: '0.7.0' },
      }),
    );
    if (result.protocolVersion !== 1) {
      throw new Error(`Unsupported ACP protocol version: ${result.protocolVersion}`);
    }
    this.initializeResult = result;
    return result;
  }

  supports(method: string) {
    const capabilities = this.initializeResult?.agentCapabilities;
    if (!capabilities) return false;
    if (method === 'session/load') return capabilities.loadSession === true;
    const name = method.startsWith('session/') ? method.slice('session/'.length) : method;
    return Boolean(capabilities.sessionCapabilities?.[name]);
  }

  async createSession(directory = '') {
    await this.initialize();
    const result = parseNewSessionResult(
      await this.client.request('session/new', {
        cwd: directory,
        mcpServers: [],
      }),
    );
    const now = this.now();
    const info: BackendSessionInfo = {
      id: result.sessionId,
      projectID: ACP_PROJECT_ID,
      directory,
      title: result.sessionId,
      status: 'idle',
      time: { created: now, updated: now },
    };
    this.sessions.set(info.id, createAcpSessionState(info, result.configOptions));
    this.deletedSessions.delete(info.id);
    this.activatedSessions.add(info.id);
    this.loadedSessions.add(info.id);
    this.activeSessionId = info.id;
    this.emit({ type: 'session.updated', info });
    this.emit({ type: 'config.updated', options: result.configOptions });
    return info;
  }

  async deleteSession(sessionId: string) {
    await this.initialize();
    if (!this.supports('session/delete')) {
      throw new Error('ACP agent does not support session/delete.');
    }
    await this.client.request('session/delete', { sessionId });
    this.removeSession(sessionId);
  }

  async deleteSessionWithCommand(sessionId: string, directory = '') {
    await this.initialize();
    if (!this.supports('session/resume') || !this.supports('session/list')) {
      throw new Error('Oh My Pi session deletion requires session/resume and session/list.');
    }
    if (!this.loadedSessions.has(sessionId)) {
      await this.client.request('session/resume', {
        sessionId,
        cwd: directory,
        mcpServers: [],
      });
      this.loadedSessions.add(sessionId);
    }
    this.activeSessionId = sessionId;
    parsePromptResult(
      await this.client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: '/session delete' }],
      }),
    );
    const remaining = parseAcpSessionList(
      await this.client.request('session/list', directory ? { cwd: directory } : {}),
    );
    if (remaining.some((session) => session.id === sessionId)) {
      throw new Error(`Oh My Pi did not remove session: ${sessionId}`);
    }
    this.removeSession(sessionId);
  }

  async listOmpExtensions() {
    await this.initialize();
    const directory = this.activeSessionId
      ? this.sessions.get(this.activeSessionId)?.info.directory
      : undefined;
    return this.client.request('_omp/extensions', directory ? { cwd: directory } : {});
  }

  removeSession(sessionId: string) {
    this.deletedSessions.add(sessionId);
    this.sessions.delete(sessionId);
    this.loadedSessions.delete(sessionId);
    this.activatedSessions.delete(sessionId);
    this.emit({ type: 'session.deleted', sessionId });
  }

  async listSessions(options?: { directory?: string }) {
    await this.initialize();
    if (this.supports('session/list')) {
      const result = await this.client.request(
        'session/list',
        options?.directory ? { cwd: options.directory } : {},
      );
      for (const info of parseAcpSessionList(result)) {
        if (this.deletedSessions.has(info.id)) continue;
        const existing = this.sessions.get(info.id);
        if (existing) {
          existing.info = {
            ...info,
            status: this.activatedSessions.has(info.id) ? existing.status : undefined,
          };
        } else this.sessions.set(info.id, createAcpSessionState(info));
      }
    }
    return [...this.sessions.values()].map((session) => session.info);
  }

  async sendPromptAsync(sessionId: string, payload: AcpPromptPayload) {
    await this.initialize();
    if (this.promptingSessions.has(sessionId)) {
      throw new Error(`ACP session already has a prompt in progress: ${sessionId}`);
    }
    this.promptingSessions.add(sessionId);
    this.activatedSessions.add(sessionId);
    this.activeSessionId = sessionId;
    const state =
      this.sessions.get(sessionId) ??
      createAcpSessionState({ id: sessionId, directory: payload.directory, title: sessionId });
    this.sessions.set(sessionId, state);
    try {
      await syncAcpPromptConfig(
        sessionId,
        state.configOptions,
        { model: payload.model.modelID, mode: payload.agent, thoughtLevel: payload.variant },
        (params) => this.client.request('session/set_config_option', params),
      );
      const entries = beginAcpPrompt(state, payload.parts, this.now(), this.agentId);
      state.info.status = 'busy';
      this.emit({ type: 'session.updated', info: state.info });
      entries.forEach((entry) => this.emitEntry(entry));
      const prompt = toAcpPromptBlocks(
        payload.parts,
        this.initializeResult?.agentCapabilities.promptCapabilities?.image === true,
      );
      try {
        const result = parsePromptResult(
          await this.client.request('session/prompt', { sessionId, prompt }),
        );
        const completed = completeAcpPrompt(state, result.stopReason, this.now(), result.usage);
        if (completed) this.emitEntry(completed);
        state.info.status = 'idle';
        this.emit({ type: 'session.updated', info: state.info });
      } catch (error) {
        const completed = completeAcpPrompt(state, 'error', this.now());
        if (completed?.info.role === 'assistant') {
          completed.info.error = {
            name: 'ACPError',
            data: { message: error instanceof Error ? error.message : String(error) },
          };
          this.emitEntry(completed);
        }
        state.info.status = 'idle';
        this.emit({ type: 'session.updated', info: state.info });
        throw error;
      }
    } finally {
      this.promptingSessions.delete(sessionId);
    }
  }

  async listSessionMessages(sessionId: string, directory?: string) {
    await this.initialize();
    this.activatedSessions.add(sessionId);
    this.activeSessionId = sessionId;
    const existing = this.historyLoads.get(sessionId);
    if (existing) return existing;
    const generation = this.lifecycleGeneration;
    const loading = loadAcpSessionHistory({
      sessionId,
      directory,
      sessions: this.sessions,
      loadedSessions: this.loadedSessions,
      supports: (method) => this.supports(method),
      request: (method, params) => this.client.request(method, params),
      isCurrent: () => this.lifecycleGeneration === generation,
    });
    this.historyLoads.set(sessionId, loading);
    try {
      const entries = await loading;
      const state = this.sessions.get(sessionId);
      if (state) {
        state.info.status = state.status;
        this.emit({ type: 'session.updated', info: state.info });
        this.emit({ type: 'config.updated', options: state.configOptions });
      }
      return entries;
    } finally {
      if (this.historyLoads.get(sessionId) === loading) this.historyLoads.delete(sessionId);
    }
  }

  getSessionStatusMap() {
    return Object.fromEntries(
      [...this.sessions]
        .filter(([id]) => this.activatedSessions.has(id))
        .map(([id, state]) => [id, { type: state.status }]),
    );
  }

  setSessionArchived(sessionId: string, archived: number | undefined) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.info.time = { ...state.info.time, archived };
    this.emit({ type: 'session.updated', info: state.info });
  }

  async abortSession(sessionId: string) {
    await this.initialize();
    this.client.notify('session/cancel', { sessionId });
  }

  async listPendingPermissions() {
    return this.permissions.list();
  }

  getConfigOptions() {
    return this.activeSessionId
      ? (this.sessions.get(this.activeSessionId)?.configOptions ?? [])
      : [];
  }

  getAvailableCommands() {
    if (!this.activeSessionId) return [];
    return (
      this.sessions.get(this.activeSessionId)?.availableCommands.flatMap(parseAcpCommand) ?? []
    );
  }

  getAuthMethods() {
    return this.initializeResult?.authMethods ?? [];
  }

  async authenticate(methodId: string) {
    await this.initialize();
    await this.client.request('authenticate', { methodId });
  }

  async replyPermission(requestId: string, reply: 'once' | 'always' | 'reject') {
    this.permissions.reply(requestId, reply);
  }

  disconnect() {
    this.lifecycleGeneration += 1;
    this.initializeResult = null;
    this.sessions.clear();
    this.activatedSessions.clear();
    this.loadedSessions.clear();
    this.deletedSessions.clear();
    this.promptingSessions.clear();
    this.historyLoads.clear();
    this.activeSessionId = null;
    this.permissions.clear();
    this.client.disconnect();
  }

  private handleSessionUpdate(value: unknown) {
    const params = parseSessionUpdateParams(value);
    if (!params) return;
    if (this.deletedSessions.has(params.sessionId)) return;
    this.activatedSessions.add(params.sessionId);
    const state =
      this.sessions.get(params.sessionId) ??
      createAcpSessionState({ id: params.sessionId, title: params.sessionId });
    this.sessions.set(params.sessionId, state);
    const entry = applyAcpUpdate(state, params.update, this.now(), this.agentId);
    state.info.status = state.status;
    if (entry) this.emitEntry(entry);
    const update = toRecord(params.update);
    if (update?.sessionUpdate === 'available_commands_update') {
      this.emit({ type: 'commands.updated', commands: this.getAvailableCommands() });
    } else if (update?.sessionUpdate === 'config_option_update') {
      this.emit({ type: 'config.updated', options: state.configOptions });
    }
    this.emit({ type: 'session.updated', info: state.info });
  }
}
