import type {
  BackendAdapter,
  BackendCapabilities,
  BackendRequestOptions,
  ListSessionsOptions,
  ProjectUpdatePayload,
  SessionUpdatePayload,
} from '../types';
import type { GitStatus } from '../../types/git';
import type { BackendProviderResponse, BackendSessionInfo } from '../../types/backend-domain';
import type { ProjectState } from '../../types/worker-state';
import {
  createKimiWebClient,
  KimiWebTransportError,
  type KimiWebClient,
  type KimiWebModel,
  type KimiWebSession,
} from '../../utils/kimiWeb';
import { kimiWebProxyHttpUrl, kimiWebWsUrl } from '../../utils/kimiWebWs';
import type { ProviderConfigState } from '../../utils/providerConfig';
import { normalizeDirectory } from '../../utils/path';
import {
  isKimiWebPermissionMode,
  isTowerExperimentEnabled,
  serializeKimiWebSessionModeChange,
  type KimiWebSessionModeChange,
} from './sessionModes';

export const KIMI_WEB_CAPABILITIES: BackendCapabilities = {
  projects: true,
  worktrees: false,
  sessions: true,
  sessionFork: false,
  sessionRevert: false,
  sessionRename: true,
  sessionArchive: true,
  sessionUnarchive: true,
  sessionDelete: true,
  sessionPin: true,
  sessionUnpin: true,
  sessionCompact: true,
  files: true,
  terminal: true,
  permissions: true,
  questions: true,
  todos: false,
  status: true,
  providerConfig: true,
  imageAttachmentsOnly: false,
  projectPickerCreatesSession: false,
  ptyExitRequiresSyntheticEvent: false,
  ptyRefreshArtifactsOnSuccess: false,
  strictSandboxPaths: false,
  sessionManagementMode: 'standard',
};

export type KimiWebMappedSession = BackendSessionInfo & {
  workspaceId: string;
  model?: string;
  lastSeq?: number;
};

export type KimiWebAdapterOptions = {
  bridgeUrl: string;
  bridgeToken?: string;
  client?: KimiWebClient;
};

export class KimiWebTowerExperimentUnavailableError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super('Kimi Web tower mode requires the tower experiment to be enabled.');
    this.name = 'KimiWebTowerExperimentUnavailableError';
    this.sessionId = sessionId;
  }
}

function unsupported(operation: string): Promise<never> {
  return Promise.reject(new Error(`Kimi Web does not support ${operation}.`));
}

function timestamp(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function mapKimiWebSession(session: KimiWebSession): KimiWebMappedSession {
  const directory = normalizeDirectory(session.metadata?.cwd?.trim() || '/');
  return {
    id: session.id,
    projectID: session.workspace_id,
    projectId: session.workspace_id,
    workspaceId: session.workspace_id,
    parentID: session.metadata?.parent_session_id,
    title: session.title || session.id,
    status: session.busy ? 'busy' : session.last_turn_reason ? 'idle' : 'unknown',
    directory,
    time: {
      created: timestamp(session.created_at),
      updated: timestamp(session.updated_at),
      archived: session.archived ? timestamp(session.archived_at) ?? 1 : undefined,
    },
    model: session.agent_config?.model,
    lastSeq: session.last_seq,
  };
}

export function mapKimiWebSessionsToProjects(
  sessions: readonly KimiWebMappedSession[],
): Record<string, ProjectState> {
  const projects: Record<string, ProjectState> = {};
  for (const session of [...sessions].sort((left, right) =>
    (left.directory || '/').localeCompare(right.directory || '/') || left.id.localeCompare(right.id))) {
    const projectId = session.workspaceId.trim();
    if (!projectId) throw new Error(`Kimi Web session ${session.id} has no workspace id.`);
    const directory = normalizeDirectory(session.directory?.trim() || '/');
    const project = projects[projectId] ?? {
      id: projectId,
      name: directory.split('/').filter(Boolean).at(-1) || projectId,
      worktree: directory,
      sandboxes: {},
    };
    projects[projectId] = project;
    const sandbox = project.sandboxes[directory] ?? {
      directory,
      name: directory.split('/').filter(Boolean).at(-1) || projectId,
      rootSessions: [],
      sessions: {},
    };
    project.sandboxes[directory] = sandbox;
    if (!session.parentID) sandbox.rootSessions.push(session.id);
    sandbox.sessions[session.id] = {
      id: session.id,
      parentID: session.parentID,
      title: session.title,
      status: session.status,
      directory,
      timeCreated: session.time?.created,
      timeUpdated: session.time?.updated,
      timeArchived: session.time?.archived,
    };
  }
  for (const session of sessions) {
    if (session.parentID) upsertKimiWebSessionIntoProjects(projects, session);
  }
  return projects;
}

function kimiWebParentLocation(projects: Record<string, ProjectState>, parentId?: string) {
  let nextId = parentId;
  let location: { projectId: string; directory: string } | undefined;
  const visited = new Set<string>();
  while (nextId && !visited.has(nextId)) {
    visited.add(nextId);
    const owner = Object.values(projects).flatMap((project) =>
      Object.values(project.sandboxes).map((sandbox) => ({ project, sandbox })))
      .find(({ sandbox }) => Boolean(nextId && sandbox.sessions[nextId]));
    if (!owner) break;
    location = { projectId: owner.project.id, directory: owner.sandbox.directory };
    nextId = owner.sandbox.sessions[nextId].parentID;
  }
  return location;
}

/**
 * Insert (or refresh) ONE mapped session inside an existing projects record.
 * Live-created kimi sessions never pass through `listSessions`; without this
 * upsert `validateSelectedSession` (App.vue) bounces the selection back to a
 * listed session and the composer sends prompts to the stale session.
 */
export function upsertKimiWebSessionIntoProjects(
  projects: Record<string, ProjectState>,
  session: KimiWebMappedSession,
): void {
  const parent = kimiWebParentLocation(projects, session.parentID);
  const projectId = parent?.projectId || session.workspaceId.trim();
  if (!projectId) throw new Error(`Kimi Web session ${session.id} has no workspace id.`);
  const directory = parent?.directory || normalizeDirectory(session.directory?.trim() || '/');
  for (const existingProject of Object.values(projects)) {
    for (const [key, existingSandbox] of Object.entries(existingProject.sandboxes)) {
      if (existingProject.id === projectId && key === directory) continue;
      if (!existingSandbox.sessions[session.id]) continue;
      delete existingSandbox.sessions[session.id];
      existingSandbox.rootSessions = existingSandbox.rootSessions.filter((id) => id !== session.id);
      if (Object.keys(existingSandbox.sessions).length === 0) delete existingProject.sandboxes[key];
    }
    if (existingProject.id !== projectId && Object.keys(existingProject.sandboxes).length === 0) {
      delete projects[existingProject.id];
    }
  }
  const name = directory.split('/').filter(Boolean).at(-1) || projectId;
  const project = projects[projectId] ?? {
    id: projectId,
    name,
    worktree: directory,
    sandboxes: {},
  };
  projects[projectId] = project;
  if (!project.sandboxes[project.worktree]) {
    project.worktree = directory;
    project.name = name;
  }
  const sandbox = project.sandboxes[directory] ?? {
    directory,
    name,
    rootSessions: [],
    sessions: {},
  };
  project.sandboxes[directory] = sandbox;
  if (!sandbox.sessions[session.id] && !session.parentID) {
    sandbox.rootSessions.push(session.id);
  }
  if (session.parentID) sandbox.rootSessions = sandbox.rootSessions.filter((id) => id !== session.id);
  sandbox.sessions[session.id] = {
    ...sandbox.sessions[session.id],
    id: session.id,
    parentID: session.parentID,
    title: session.title,
    status: session.status,
    directory,
    timeCreated: session.time?.created,
    timeUpdated: session.time?.updated,
    timeArchived: session.time?.archived,
  };
}

function modelResponse(models: KimiWebModel[]): BackendProviderResponse {
  const providers = new Map<string, NonNullable<BackendProviderResponse['all']>[number]>();
  for (const model of models) {
    const provider = providers.get(model.provider) ?? {
      id: model.provider,
      name: model.provider === 'managed:kimi-code' ? 'Kimi Code' : model.provider,
      models: {},
    };
    provider.models ??= {};
    provider.models[model.model] = {
      id: model.model,
      name: model.display_name,
      ...(model.support_efforts?.length ? { variants: Object.fromEntries(model.support_efforts.map((effort) => [effort, { default: effort === model.default_effort }])) } : {}),
      providerID: model.provider,
      limit: model.max_context_size ? { context: model.max_context_size } : undefined,
      capabilities: {
        attachment: model.capabilities?.some((capability) => ['vision', 'image_in', 'video_in'].includes(capability)) ?? false,
        reasoning: model.capabilities?.includes('thinking') ?? false,
        toolcall: model.capabilities?.some((capability) => ['tools', 'tool_use'].includes(capability)) ?? true,
      },
    };
    providers.set(model.provider, provider);
  }
  return { all: [...providers.values()], connected: [...providers.keys()] };
}

export class KimiWebAdapter implements BackendAdapter {
  readonly kind = 'kimi-web' as const;
  readonly label = 'Kimi Web';
  readonly capabilities = { ...KIMI_WEB_CAPABILITIES };
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly restClient: KimiWebClient;

  constructor(options: KimiWebAdapterOptions) {
    this.bridgeUrl = options.bridgeUrl;
    this.bridgeToken = options.bridgeToken?.trim() ?? '';
    this.restClient =
      options.client ??
      createKimiWebClient({
        baseUrl: kimiWebProxyHttpUrl(kimiWebWsUrl(this.bridgeUrl, this.bridgeToken)),
        getToken: () => this.bridgeToken,
      });
    this.listFiles = this.listFiles.bind(this);
    this.readFileContent = this.readFileContent.bind(this);
    this.readFileContentBytes = this.readFileContentBytes.bind(this);
    this.getVcsInfo = this.getVcsInfo.bind(this);
    this.getGlobalConfig = this.getGlobalConfig.bind(this);
    this.listProviders = this.listProviders.bind(this);
    this.updateSessionMode = this.updateSessionMode.bind(this);
    this.listPtys = this.listPtys.bind(this);
    this.createPty = this.createPty.bind(this);
    this.updatePtySize = this.updatePtySize.bind(this);
    this.deletePty = this.deletePty.bind(this);
    this.createPtyWebSocketUrl = this.createPtyWebSocketUrl.bind(this);
  }

  private async ptyRequest(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(kimiWebWsUrl(this.bridgeUrl, this.bridgeToken));
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = path;
    url.search = '';
    const response = await fetch(url.toString(), {
      method,
      headers: {
        ...(this.bridgeToken ? { Authorization: `Bearer ${this.bridgeToken}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error : `PTY request failed (${response.status}).`;
      throw new Error(message);
    }
    return result;
  }

  listPtys(_directory?: string) {
    return this.ptyRequest('/pty', 'GET');
  }

  createPty(
    payload: { directory?: string; cwd?: string; command?: string; args?: string[]; title?: string },
    options?: BackendRequestOptions,
  ) {
    return this.ptyRequest('/pty', 'POST', payload, options?.signal);
  }

  updatePtySize(ptyId: string, payload: { directory?: string; rows: number; cols: number }) {
    return this.ptyRequest(`/pty/${encodeURIComponent(ptyId)}`, 'PUT', { size: { rows: payload.rows, cols: payload.cols } });
  }

  deletePty(ptyId: string, _directory?: string) {
    return this.ptyRequest(`/pty/${encodeURIComponent(ptyId)}`, 'DELETE');
  }

  createPtyWebSocketUrl(path: string) {
    const url = new URL(kimiWebWsUrl(this.bridgeUrl, this.bridgeToken));
    url.pathname = path;
    return url.toString();
  }

  initialize() {
    return Promise.all([
      this.restClient.getMeta(),
      this.restClient.getAuth(),
      this.restClient.listModels(),
    ]);
  }

  createSession(directory = '/') {
    return this.restClient.createSession({ metadata: { cwd: directory } });
  }

  forkSession() {
    return unsupported('session fork');
  }

  async updateSession(sessionId: string, payload: SessionUpdatePayload) {
    if (payload.title !== undefined) {
      return this.restClient.updateProfile(sessionId, { title: payload.title });
    }
    if (payload.time?.archived !== undefined) {
      return payload.time.archived > 0
        ? this.restClient.archiveSession(sessionId)
        : this.restClient.restoreSession(sessionId);
    }
    return unsupported('this session update');
  }

  async updateSessionMode(sessionId: string, change: KimiWebSessionModeChange): Promise<void> {
    if (change.field === 'permissionMode' && !isKimiWebPermissionMode(change.value)) {
      throw new TypeError(`Invalid Kimi Web permission mode: ${String(change.value)}`);
    }
    if (change.field === 'towerMode' && change.value === true) {
      const meta = await this.restClient.getMeta();
      if (!isTowerExperimentEnabled(meta)) {
        throw new KimiWebTowerExperimentUnavailableError(sessionId);
      }
    }
    await this.restClient.updateProfile(sessionId, serializeKimiWebSessionModeChange(change));
  }

  deleteSession(sessionId: string) {
    return this.restClient.deleteSession(sessionId);
  }

  revertSession() {
    return unsupported('session revert');
  }

  unrevertSession() {
    return unsupported('session unrevert');
  }

  async listSessions(options?: ListSessionsOptions) {
    const limit = options?.limit;
    if (limit !== undefined && limit <= 0) return [];
    const directory = options?.directory?.trim();
    const normalizedDirectory = directory ? normalizeDirectory(directory) : undefined;
    const sessions = new Map<string, KimiWebMappedSession>();
    const cursors = new Set<string>();
    let beforeId: string | undefined;
    do {
      const page = await this.restClient.listSessions({
        include_archive: true,
        page_size: limit === undefined ? undefined : Math.min(limit, 100),
        before_id: beforeId,
        signal: options?.signal,
      });
      for (const session of page.items) {
        const mapped = mapKimiWebSession(session);
        if (!normalizedDirectory || mapped.directory === normalizedDirectory) {
          sessions.set(session.id, mapped);
        }
      }
      if (limit !== undefined && sessions.size >= limit) break;
      if (!page.has_more) break;
      const nextCursor = page.items.at(-1)?.id;
      if (!nextCursor || cursors.has(nextCursor)) {
        throw new Error('Kimi Web session pagination did not advance.');
      }
      cursors.add(nextCursor);
      beforeId = nextCursor;
    } while (beforeId !== undefined);
    return [...sessions.values()].slice(0, limit);
  }

  async listProviders() {
    const page = await this.restClient.listModels();
    return modelResponse(page.items);
  }

  async getGlobalConfig(): Promise<ProviderConfigState> {
    try {
      const page = await this.restClient.listModels();
      return {
        enabled_providers: [...new Set(page.items.map((model) => model.provider))],
        disabled_providers: [],
      };
    } catch (error) {
      if (error instanceof KimiWebTransportError && error.kind === 'network') {
        return { enabled_providers: [], disabled_providers: [] };
      }
      throw error;
    }
  }

  private async sessionIdForDirectory(directory: string, options?: BackendRequestOptions) {
    const normalizedDirectory = normalizeDirectory(directory.trim() || '/');
    const sessions = await this.listSessions({
      directory: normalizedDirectory,
      signal: options?.signal,
    });
    const session = sessions[0];
    if (!session) {
      throw new Error(`No Kimi Web session found for directory ${normalizedDirectory}.`);
    }
    return session.id;
  }

  async listFiles(
    payload: { directory: string; path?: string },
    options?: BackendRequestOptions,
  ) {
    const sessionId = await this.sessionIdForDirectory(payload.directory, options);
    const [page, visiblePage] = await Promise.all([
      this.restClient.listFiles(sessionId, payload.path ?? '.', {
      ...options,
      show_hidden: true,
      follow_gitignore: false,
      }),
      this.restClient.listFiles(sessionId, payload.path ?? '.', {
        ...options,
        show_hidden: true,
        follow_gitignore: true,
      }),
    ]);
    const visiblePaths = new Set(visiblePage.items.map((item) => item.path));
    return page.items.map((item) => ({
      path: item.path,
      name: item.name,
      type: item.kind,
      ignored: !visiblePaths.has(item.path),
    }));
  }

  async readFileContentBytes(
    payload: { directory: string; path: string },
    options?: BackendRequestOptions,
  ): Promise<Uint8Array> {
    const sessionId = await this.sessionIdForDirectory(payload.directory, options);
    return this.restClient.downloadFile(sessionId, payload.path, { signal: options?.signal });
  }

  async readFileContent(
    payload: { directory: string; path: string },
    options?: BackendRequestOptions,
  ): Promise<{ type: 'text' | 'binary'; encoding: 'utf-8' | 'base64'; content: string }> {
    const bytes = await this.readFileContentBytes(payload, options);
    let textContent: string | undefined;
    try {
      textContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      textContent = undefined;
    }
    if (textContent !== undefined && !textContent.includes('\0')) {
      return { type: 'text', encoding: 'utf-8', content: textContent };
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return { type: 'binary', encoding: 'base64', content: btoa(binary) };
  }

  async getVcsInfo(directory: string, options?: BackendRequestOptions) {
    const sessionId = await this.sessionIdForDirectory(directory, options);
    const status = await this.restClient.getGitStatus(sessionId, options);
    const snapshot: GitStatus = {
      branch: {
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
      },
      files: [],
      diffStats: {
        staged: { additions: 0, deletions: 0 },
        unstaged: { additions: status.additions, deletions: status.deletions },
      },
      untracked: {
        eligibleFileCount: 0,
        pending: false,
      },
    };
    return { root: directory, branch: status.branch, entries: status.entries, snapshot };
  }

  async abortSession(sessionId: string) {
    await this.restClient.abortSession(sessionId);
  }

  async getGlobalHealth() {
    const meta = await this.restClient.getMeta();
    return { healthy: true, version: meta.server_version };
  }

  updateProject(_projectId: string, _payload: ProjectUpdatePayload) {
    return unsupported('project updates');
  }

  createWorktree() {
    return unsupported('worktrees');
  }

  deleteWorktree() {
    return unsupported('worktrees');
  }
}

export function createKimiWebAdapter(options: KimiWebAdapterOptions) {
  return new KimiWebAdapter(options);
}
