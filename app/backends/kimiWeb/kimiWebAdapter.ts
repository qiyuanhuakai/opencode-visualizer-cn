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
  sessionPin: false,
  sessionUnpin: false,
  sessionCompact: false,
  files: true,
  terminal: false,
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

function unsupported(operation: string): Promise<never> {
  return Promise.reject(new Error(`Kimi Web does not support ${operation}.`));
}

function timestamp(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function mapKimiWebSession(session: KimiWebSession): KimiWebMappedSession {
  const directory = session.metadata?.cwd?.trim() || '/';
  return {
    id: session.id,
    projectID: session.workspace_id,
    projectId: session.workspace_id,
    workspaceId: session.workspace_id,
    title: session.title || session.id,
    status: session.busy ? 'busy' : 'idle',
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
  for (const session of sessions) {
    const projectId = session.workspaceId.trim();
    if (!projectId) throw new Error(`Kimi Web session ${session.id} has no workspace id.`);
    const directory = session.directory?.trim() || '/';
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
    sandbox.rootSessions.push(session.id);
    sandbox.sessions[session.id] = {
      id: session.id,
      title: session.title,
      status: session.status,
      directory,
      timeCreated: session.time?.created,
      timeUpdated: session.time?.updated,
      timeArchived: session.time?.archived,
    };
  }
  return projects;
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
  const projectId = session.workspaceId.trim();
  if (!projectId) throw new Error(`Kimi Web session ${session.id} has no workspace id.`);
  const directory = session.directory?.trim() || '/';
  const name = directory.split('/').filter(Boolean).at(-1) || projectId;
  const project = projects[projectId] ?? {
    id: projectId,
    name,
    worktree: directory,
    sandboxes: {},
  };
  projects[projectId] = project;
  const sandbox = project.sandboxes[directory] ?? {
    directory,
    name,
    rootSessions: [],
    sessions: {},
  };
  project.sandboxes[directory] = sandbox;
  if (!sandbox.sessions[session.id]) {
    sandbox.rootSessions.push(session.id);
  }
  sandbox.sessions[session.id] = {
    id: session.id,
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
      name: model.provider,
      models: {},
    };
    provider.models ??= {};
    provider.models[model.model] = {
      id: model.model,
      name: model.display_name,
      providerID: model.provider,
      limit: model.max_context_size ? { context: model.max_context_size } : undefined,
      capabilities: {
        attachment: model.capabilities?.includes('vision') ?? false,
        reasoning: model.capabilities?.includes('thinking') ?? false,
        toolcall: model.capabilities?.includes('tools') ?? true,
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
    this.getVcsInfo = this.getVcsInfo.bind(this);
    this.getGlobalConfig = this.getGlobalConfig.bind(this);
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
    const page = await this.restClient.listSessions({
      include_archive: true,
      page_size: options?.limit,
      signal: options?.signal,
    });
    const directory = options?.directory?.trim();
    return page.items
      .map(mapKimiWebSession)
      .filter((session) => !directory || session.directory === directory);
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
    const normalizedDirectory = directory.trim() || '/';
    const page = await this.restClient.listSessions({
      include_archive: true,
      signal: options?.signal,
    });
    const session = page.items.find(
      (item) => (item.metadata?.cwd?.trim() || '/') === normalizedDirectory,
    );
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
    const page = await this.restClient.listFiles(sessionId, payload.path ?? '.', options);
    return page.items.map((item) => ({
      path: item.path,
      name: item.name,
      type: item.kind,
    }));
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
