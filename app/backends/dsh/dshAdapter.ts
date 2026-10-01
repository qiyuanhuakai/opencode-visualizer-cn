/**
 * dsh web backend adapter (`BackendAdapter` implementation).
 *
 * Transport boundary (IS-12 load-bearing decision, docs/dsh.md §4.2/§5/§6):
 * the browser only ever talks to **vis_bridge**:
 *   - unary RPC goes through the Todo 4 HTTP client (`createDshRpcClient`)
 *     against the bridge `/dsh` HTTP prefix, so this file never builds a dsh
 *     URL and never holds a dsh cookie or launch token;
 *   - streaming endpoints (`workspace/follow`, `session/follow`) go through the
 *     Todo 5 mux client against the bridge `/dsh/ws` route;
 *   - the Shell is NOT dsh's `terminal/*` surface (excluded by the Metis #15
 *     decision): `terminal/create`/`terminal/follow` stay unimplemented and the
 *     PTY series routes through the shared bridge `/pty` control surface that
 *     kimi web and codex already use.
 *
 * Structure mirrors `kimiWeb/kimiWebAdapter.ts` (the newest sibling): a
 * module-level capability matrix, pure mapping helpers, per-method `bind(this)`
 * in the constructor, and a `createDshAdapter` factory.
 *
 * Binding is NOT cosmetic (memory #1770): App.vue extracts adapter methods via
 * `requireBackendMethod`, which returns them unchanged, so every public method
 * is assigned to a bound function in the constructor. The unbound-call
 * regression test in `./dshAdapter.test.ts` enumerates the surface and invokes
 * each method detached from the instance.
 *
 * Unverified-endpoint discipline: only endpoints marked ✅ in docs/dsh.md §7 are
 * called with a shaped request. Endpoints probed as ➖/❌ either throw a typed
 * {@link DshUnsupportedError} (naming the reason) or are documented below as
 * owed to a later todo. Nothing is fabricated.
 */

import type {
  BackendAdapter,
  BackendCapabilities,
  BackendQueryValue,
  BackendRequestOptions,
  ListSessionsOptions,
  ProjectUpdatePayload,
  SessionUpdatePayload,
} from '../types';
import type {
  BackendProviderInfo,
  BackendProviderModel,
  BackendProviderResponse,
  BackendSessionInfo,
} from '../../types/backend-domain';
import type { ProjectState } from '../../types/worker-state';
import { normalizeDirectory } from '../../utils/path';
import { createDshRpcClient, deriveDshBridgeHttpUrl, type DshRpcClient } from '../../utils/dshRpc';
import { createDshMuxClient, dshMuxBridgeUrl, type DshMuxClient } from '../../utils/dshMux';
import { DSH_WIRE_VERSION, type DshJsonValue, type DshSessionSnapshot } from './types';

/**
 * Capability matrix for the dsh backend.
 *
 * `terminal: true` means the Shell works — through the bridge PTY surface, not
 * through dsh's own (excluded) terminal endpoints. `sessionDelete: false`
 * because dsh exposes no session delete endpoint at all (docs/dsh.md §7 has no
 * `session/delete`); VIS-local hide semantics are owned by a later todo and
 * must not be confused with a native delete.
 */
export const DSH_CAPABILITIES: BackendCapabilities = {
  projects: true,
  worktrees: false,
  sessions: true,
  sessionFork: true,
  sessionRevert: false,
  sessionRename: true,
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
  providerConfig: true,
  imageAttachmentsOnly: false,
  projectPickerCreatesSession: false,
  ptyExitRequiresSyntheticEvent: false,
  ptyRefreshArtifactsOnSuccess: false,
  strictSandboxPaths: false,
  sessionManagementMode: 'standard',
};

/** The single provider dsh serves (docs/dsh.md §10, live-verified). */
export const DSH_MODEL_PROVIDER = 'deepseek-official';

/** Fallback reasoning effort when the catalog does not declare a default. */
const DSH_DEFAULT_REASONING_EFFORT = 'high';

/** Byte window requested from `workspaceFiles/read` (docs/dsh.md §7.7). */
const DSH_FILE_READ_LIMIT = 2 * 1024 * 1024;

/**
 * Every public method of {@link DshAdapter}, in bind order.
 *
 * This list is the contract the unbound-call regression test pins: the test
 * asserts it is exactly the adapter's public surface (public prototype methods
 * minus the internal helpers) and that every entry is a bound own property.
 * Adding a method without extending this list fails that test.
 */
export const DSH_ADAPTER_METHODS = [
  'createSession',
  'forkSession',
  'updateSession',
  'deleteSession',
  'revertSession',
  'unrevertSession',
  'listSessions',
  'updateProject',
  'createWorktree',
  'deleteWorktree',
  'configure',
  'disconnect',
  'listPtys',
  'createPty',
  'updatePtySize',
  'deletePty',
  'createPtyWebSocketUrl',
  'listFiles',
  'readFileContent',
  'readFileContentBytes',
  'getVcsInfo',
  'listProviders',
  'getGlobalConfig',
  'updateSessionMode',
  'syncSessionConfig',
  'getSessionConfigOptions',
  'listCommands',
  'getSessionStatusMap',
  'getGlobalHealth',
  'abortSession',
] as const;

/**
 * Raised for a capability the dsh wire contract does not expose. Always names
 * the operation and the reason, so a caller never has to guess whether a
 * rejected call was a silent no-op.
 */
export class DshUnsupportedError extends Error {
  readonly operation: string;
  readonly reason: string;

  constructor(operation: string, reason: string) {
    super(`dsh does not support ${operation}: ${reason}`);
    this.name = 'DshUnsupportedError';
    this.operation = operation;
    this.reason = reason;
  }
}

function unsupported(operation: string, reason: string): Promise<never> {
  return Promise.reject(new DshUnsupportedError(operation, reason));
}

/** Bridge control-route fetch surface (`/pty`, `/command/exec`). */
export type DshBridgeFetcher = (
  url: string,
  init: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type DshAdapterOptions = {
  /** vis_bridge dsh WebSocket URL, e.g. `ws://localhost:23004/dsh/ws`. */
  bridgeUrl: string;
  /** vis_bridge token (sent as `Authorization: Bearer` / `?token=`). */
  bridgeToken?: string;
  /** Injectable unary RPC client (tests). Defaults to the real Todo 4 client. */
  rpcClient?: DshRpcClient;
  /** Injectable mux client (tests). Defaults to the real Todo 5 client. */
  muxClient?: DshMuxClient;
  /** Injectable fetch for bridge control routes (tests). Defaults to the global fetch. */
  fetcher?: DshBridgeFetcher;
};

// ---------------------------------------------------------------------------
// Pure wire readers (defensive: docs pin only part of each response shape)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readArray(source: unknown): unknown[] {
  return Array.isArray(source) ? source : [];
}

function readStringArray(value: unknown): string[] {
  return readArray(value).filter((entry): entry is string => typeof entry === 'string');
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Model catalog normalization
// ---------------------------------------------------------------------------

export type DshModelInfo = {
  id: string;
  name: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
  contextLimit?: number;
};

export type DshCatalogProvider = {
  id: string;
  name: string;
  models: DshModelInfo[];
};

/**
 * Normalize `session/modelCatalog` (docs/dsh.md §7.1/§10: provider
 * `deepseek-official` with `deepseek-flash` / `deepseek-v4-pro` plus the
 * `off|low|high|max` reasoning ladder, default `high`).
 *
 * The exact response envelope is not pinned by the docs, so the reader accepts
 * the documented shapes (`{providers}` / `{items}` / a bare array, `id` or
 * `provider`, `id` or `model` for a model) and drops entries it cannot name.
 * A catalog that yields no provider is an error, not an empty selector.
 */
export function normalizeDshModelCatalog(value: unknown): DshCatalogProvider[] {
  const raw = isRecord(value) ? (value.groups ?? value.providers ?? value.items ?? value) : value;
  const providers: DshCatalogProvider[] = [];
  for (const entry of readArray(raw)) {
    if (!isRecord(entry)) continue;
    const id = readString(entry, ['id', 'provider', 'providerId']);
    if (!id) continue;
    const models: DshModelInfo[] = [];
    for (const modelEntry of readArray(entry.models)) {
      if (!isRecord(modelEntry)) continue;
      const modelId = readString(modelEntry, ['id', 'model', 'modelId']);
      if (!modelId) continue;
      const reasoning = isRecord(modelEntry.reasoning) ? modelEntry.reasoning : undefined;
      const efforts = reasoning
        ? readArray(reasoning.efforts).flatMap((effort) => {
            const id = typeof effort === 'string' ? effort : isRecord(effort) ? readString(effort, ['id']) : '';
            return id ? [id] : [];
          })
        : readStringArray(modelEntry.reasoningEfforts ?? modelEntry.reasoning_efforts);
      const contextLimit =
        typeof modelEntry.maxContextTokens === 'number'
          ? modelEntry.maxContextTokens
          : typeof modelEntry.contextWindow === 'number'
            ? modelEntry.contextWindow
            : undefined;
      models.push({
        id: modelId,
        name: readString(modelEntry, ['display_name', 'displayName', 'name', 'label']) || modelId,
        reasoningEfforts: efforts,
        defaultReasoningEffort:
          (reasoning ? readString(reasoning, ['defaultEffort']) : '') || readString(modelEntry, [
            'defaultReasoningEffort',
            'default_reasoning_effort',
            'defaultEffort',
          ]) ||
          efforts[0] ||
          DSH_DEFAULT_REASONING_EFFORT,
        ...(contextLimit === undefined ? {} : { contextLimit }),
      });
    }
    providers.push({
      id,
      name: readString(entry, ['display_name', 'displayName', 'name', 'label']) || id,
      models,
    });
  }
  if (providers.length === 0) {
    throw new Error('dsh session/modelCatalog returned no usable provider.');
  }
  return providers;
}

function dshModelResponse(providers: DshCatalogProvider[]): BackendProviderResponse {
  const all: BackendProviderInfo[] = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: Object.fromEntries(
      provider.models.map((model): [string, BackendProviderModel] => [
        model.id,
        {
          id: model.id,
          name: model.name,
          providerID: provider.id,
          ...(model.contextLimit === undefined ? {} : { limit: { context: model.contextLimit } }),
          ...(model.reasoningEfforts.length
            ? {
                variants: Object.fromEntries(
                  model.reasoningEfforts.map((effort) => [
                    effort,
                    { default: effort === model.defaultReasoningEffort },
                  ]),
                ),
              }
            : {}),
          capabilities: { reasoning: true, toolcall: true, attachment: false },
        },
      ]),
    ),
  }));
  const defaults: Record<string, string> = {};
  for (const provider of providers) {
    const first = provider.models[0];
    if (first) defaults[provider.id] = first.id;
  }
  return { all, connected: providers.map((provider) => provider.id), default: defaults };
}

// ---------------------------------------------------------------------------
// Session / project mapping (attribution rules mirror kimiWebAdapter)
// ---------------------------------------------------------------------------

export type DshMappedSession = BackendSessionInfo & {
  workspaceId: string;
  model?: string;
};

export type DshSessionItem = {
  sessionId: string;
  workspaceId?: string;
  cwd?: string;
  title?: string;
  /** The live wire field (`session/list`), NOT the follow header's `parentSession`. */
  parentSessionId?: string;
  busy?: boolean;
  createdAt?: string | number;
  updatedAt?: string | number;
};

export type DshWorkspaceItem = {
  workspaceId: string;
  path: string;
  title?: string;
  sessionIds?: readonly string[];
  createdAt?: string;
  updatedAt?: string;
};

/** Project id used for a session no workspace claims (child/subagent sessions). */
function orphanProjectId(directory: string): string {
  return `dsh:${directory}`;
}

function directoryName(directory: string): string {
  return directory.split('/').filter(Boolean).at(-1) || directory || '/';
}

/**
 * Map ONE `session/list` item onto a vis session. The workspace path wins over
 * the item's own `cwd` when a workspace claims the session: that is the stable
 * attribution rule (a branch rename or a session-level cwd change must never
 * move a session to another sandbox — same rule as kimi).
 */
export function mapDshSessionItem(
  item: DshSessionItem,
  context: {
    workspace?: DshWorkspaceItem;
    archived?: boolean;
    pinned?: boolean;
    model?: string;
  } = {},
): DshMappedSession {
  const sessionId = item.sessionId.trim();
  if (!sessionId) throw new Error('dsh session list item has no sessionId.');
  const workspaceId = item.workspaceId?.trim() || context.workspace?.workspaceId?.trim() || '';
  const directory = normalizeDirectory(
    (context.workspace?.path?.trim() || item.cwd?.trim() || '/') as string,
  );
  const projectId = workspaceId || orphanProjectId(directory);
  if (!projectId) throw new Error(`dsh session ${sessionId} has no workspace id.`);
  const parentID = item.parentSessionId?.trim() || undefined;
  return {
    id: sessionId,
    projectID: projectId,
    projectId,
    workspaceId: projectId,
    parentID,
    title: item.title?.trim() || sessionId,
    status: item.busy ? 'busy' : 'unknown',
    directory,
    time: {
      created: timestamp(item.createdAt),
      updated: timestamp(item.updatedAt),
      ...(context.archived ? { archived: 1 } : {}),
      ...(context.pinned ? { pinned: 1 } : {}),
    },
    ...(context.model ? { model: context.model } : {}),
  };
}

/** Group sessions by workspace (project) and by directory (sandbox), like kimi. */
export function mapDshSessionsToProjects(
  sessions: readonly DshMappedSession[],
): Record<string, ProjectState> {
  const projects: Record<string, ProjectState> = {};
  for (const session of [...sessions].sort(
    (left, right) =>
      (left.directory || '/').localeCompare(right.directory || '/') ||
      left.id.localeCompare(right.id),
  )) {
    const projectId = session.workspaceId.trim();
    if (!projectId) throw new Error(`dsh session ${session.id} has no workspace id.`);
    const directory = normalizeDirectory(session.directory?.trim() || '/');
    const project = projects[projectId] ?? {
      id: projectId,
      name: directoryName(directory),
      worktree: directory,
      sandboxes: {},
    };
    projects[projectId] = project;
    const sandbox = project.sandboxes[directory] ?? {
      directory,
      name: directoryName(directory),
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
    if (session.parentID) upsertDshSessionIntoProjects(projects, session);
  }
  return projects;
}

function dshParentLocation(
  projects: Record<string, ProjectState>,
  parentId?: string,
): { projectId: string; directory: string } | undefined {
  let nextId = parentId;
  let location: { projectId: string; directory: string } | undefined;
  const visited = new Set<string>();
  while (nextId && !visited.has(nextId)) {
    visited.add(nextId);
    const owner = Object.values(projects)
      .flatMap((project) =>
        Object.values(project.sandboxes).map((sandbox) => ({ project, sandbox })),
      )
      .find(({ sandbox }) => Boolean(nextId && sandbox.sessions[nextId]));
    if (!owner) break;
    location = { projectId: owner.project.id, directory: owner.sandbox.directory };
    nextId = owner.sandbox.sessions[nextId].parentID;
  }
  return location;
}

/**
 * Insert (or refresh) ONE mapped session inside an existing projects record.
 * Live-created dsh sessions never pass through `listSessions`; without this
 * upsert the freshly created session is missing from the tree until a refresh.
 */
export function upsertDshSessionIntoProjects(
  projects: Record<string, ProjectState>,
  session: DshMappedSession,
): void {
  const parent = dshParentLocation(projects, session.parentID);
  const projectId = parent?.projectId || session.workspaceId.trim();
  if (!projectId) throw new Error(`dsh session ${session.id} has no workspace id.`);
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
  const name = directoryName(directory);
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
  if (!sandbox.sessions[session.id] && !session.parentID) sandbox.rootSessions.push(session.id);
  if (session.parentID)
    sandbox.rootSessions = sandbox.rootSessions.filter((id) => id !== session.id);
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

// ---------------------------------------------------------------------------
// Wire readers for the shapes this adapter consumes
// ---------------------------------------------------------------------------

export type DshWorkspaceBaseline = {
  items: DshWorkspaceItem[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
};

/** Read a `workspace/follow` baseline frame (layout captured live, docs §6/§7.2). */
export function readDshWorkspaceBaseline(value: unknown): DshWorkspaceBaseline {
  if (!isRecord(value) || value.type !== 'baseline' || !isRecord(value.value)) {
    throw new Error('dsh workspace/follow: first frame is not a baseline frame.');
  }
  const inner = value.value;
  const items: DshWorkspaceItem[] = [];
  for (const entry of readArray(inner.items)) {
    if (!isRecord(entry)) continue;
    const workspaceId = readString(entry, ['workspaceId']);
    if (!workspaceId) continue;
    items.push({
      workspaceId,
      path: readString(entry, ['path']),
      title: readString(entry, ['title']),
      sessionIds: readStringArray(entry.sessionIds),
      createdAt: readString(entry, ['createdAt']),
      updatedAt: readString(entry, ['updatedAt']),
    });
  }
  return {
    items,
    archivedSessionIds: readStringArray(inner.archivedSessionIds),
    pinnedSessionIds: readStringArray(inner.pinnedSessionIds),
  };
}

export type DshModelSelection = { provider: string; model: string; reasoningEffort?: string };

/** Read `projections.values.modelSelection` from a follow snapshot (docs §8.2). */
export function readDshModelSelection(snapshot: unknown): DshModelSelection | undefined {
  if (!isRecord(snapshot)) return undefined;
  const projections = isRecord(snapshot.projections) ? snapshot.projections : undefined;
  const values = projections && isRecord(projections.values) ? projections.values : undefined;
  const selection = values?.modelSelection;
  const lastUsed = isRecord(selection) ? selection.lastUsed : undefined;
  if (!isRecord(lastUsed)) return undefined;
  const provider = readString(lastUsed, ['provider']);
  const model = readString(lastUsed, ['model']);
  if (!provider || !model) return undefined;
  const reasoningEffort = readString(lastUsed, ['reasoningEffort']);
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** Read the informative fields of a `session/follow` snapshot. */
export function readDshSessionSnapshot(value: unknown): {
  sessionId: string;
  cwd: string;
  createdAt?: number;
  title?: string;
  modelSelection?: DshModelSelection;
} {
  const snapshot = value as DshSessionSnapshot | undefined;
  if (!snapshot || snapshot.type !== 'snapshot' || !isRecord(snapshot.header)) {
    throw new Error('dsh session/follow: first frame is not a snapshot frame.');
  }
  const header = snapshot.header as unknown as Record<string, unknown>;
  const projections = isRecord(snapshot.projections) ? snapshot.projections : undefined;
  const values = projections && isRecord(projections.values) ? projections.values : undefined;
  const title =
    typeof values?.title === 'string' && values.title.trim() ? values.title.trim() : undefined;
  return {
    sessionId: readString(header, ['id']),
    cwd: readString(header, ['cwd']),
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
    ...(title ? { title } : {}),
    ...(readDshModelSelection(snapshot) ? { modelSelection: readDshModelSelection(snapshot) } : {}),
  };
}

/** Resolve the shared repository root from `git rev-parse --git-common-dir`. */
function commonRootFromGitCommonDir(commonGitDir: string, worktreeRoot: string): string {
  const gitDir = commonGitDir.trim();
  if (!gitDir) return '';
  if (gitDir === '.git') return normalizeDirectory(worktreeRoot);
  if (gitDir.endsWith('/.git')) return normalizeDirectory(gitDir.slice(0, -5));
  const marker = '/.git/worktrees/';
  const worktreeIndex = gitDir.indexOf(marker);
  if (worktreeIndex > 0) return normalizeDirectory(gitDir.slice(0, worktreeIndex));
  // A relative git dir (`.git`) already resolved against the worktree root.
  return gitDir.startsWith('/')
    ? normalizeDirectory(gitDir.replace(/\/\.git$/u, ''))
    : normalizeDirectory(worktreeRoot);
}

function modelKey(selection: DshModelSelection): string {
  return `${selection.provider}/${selection.model}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DshAdapter implements BackendAdapter {
  readonly kind = 'dsh' as const;
  readonly label = 'dsh';
  readonly capabilities = { ...DSH_CAPABILITIES };

  private readonly rpcClient: DshRpcClient;
  private readonly muxClient: DshMuxClient;
  private readonly fetcher: DshBridgeFetcher;
  private readonly bridgeUrl: string;
  private bridgeToken: string;
  private modelCatalog: DshCatalogProvider[] | null = null;

  constructor(options: DshAdapterOptions) {
    const bridgeUrl = options.bridgeUrl.trim();
    if (!bridgeUrl) throw new Error('dsh bridge URL is required.');
    // Throws a typed DshRpcError for a non-derivable URL, mirroring the
    // registry's own validation (never silently falls back to a default).
    deriveDshBridgeHttpUrl(bridgeUrl);
    this.bridgeUrl = bridgeUrl;
    this.bridgeToken = options.bridgeToken?.trim() ?? '';
    this.rpcClient =
      options.rpcClient ??
      createDshRpcClient({
        baseUrl: deriveDshBridgeHttpUrl(bridgeUrl),
        getBridgeToken: () => this.bridgeToken,
        // One injectable fetcher serves both surfaces; the RPC client's contract
        // is POST-only, so the wider method union is narrowed here.
        fetcher: options.fetcher
          ? (url, init) => options.fetcher!(url, { ...init, method: 'POST' })
          : undefined,
      });
    this.muxClient =
      options.muxClient ??
      createDshMuxClient({ url: bridgeUrl, getBridgeToken: async () => this.bridgeToken || null });
    this.fetcher =
      options.fetcher ??
      ((url, init) => {
        const fetchImpl = globalThis.fetch;
        if (!fetchImpl) throw new Error('no fetch implementation available');
        return fetchImpl(url, init as RequestInit);
      });

    // memory #1770: App.vue hands these methods out unbound, so every public
    // method must be a bound own property of the instance.
    this.createSession = this.createSession.bind(this);
    this.forkSession = this.forkSession.bind(this);
    this.updateSession = this.updateSession.bind(this);
    this.deleteSession = this.deleteSession.bind(this);
    this.revertSession = this.revertSession.bind(this);
    this.unrevertSession = this.unrevertSession.bind(this);
    this.listSessions = this.listSessions.bind(this);
    this.updateProject = this.updateProject.bind(this);
    this.createWorktree = this.createWorktree.bind(this);
    this.deleteWorktree = this.deleteWorktree.bind(this);
    this.configure = this.configure.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.listPtys = this.listPtys.bind(this);
    this.createPty = this.createPty.bind(this);
    this.updatePtySize = this.updatePtySize.bind(this);
    this.deletePty = this.deletePty.bind(this);
    this.createPtyWebSocketUrl = this.createPtyWebSocketUrl.bind(this);
    this.listFiles = this.listFiles.bind(this);
    this.readFileContent = this.readFileContent.bind(this);
    this.readFileContentBytes = this.readFileContentBytes.bind(this);
    this.getVcsInfo = this.getVcsInfo.bind(this);
    this.listProviders = this.listProviders.bind(this);
    this.getGlobalConfig = this.getGlobalConfig.bind(this);
    this.updateSessionMode = this.updateSessionMode.bind(this);
    this.syncSessionConfig = this.syncSessionConfig.bind(this);
    this.getSessionConfigOptions = this.getSessionConfigOptions.bind(this);
    this.listCommands = this.listCommands.bind(this);
    this.getSessionStatusMap = this.getSessionStatusMap.bind(this);
    this.getGlobalHealth = this.getGlobalHealth.bind(this);
    this.abortSession = this.abortSession.bind(this);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Absolute bridge control-route URL (PTY / command runner), NOT a dsh URL. */
  private bridgeControlUrl(path: string): string {
    return `${new URL(deriveDshBridgeHttpUrl(this.bridgeUrl)).origin}${path}`;
  }

  private async bridgeRequest(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.bridgeToken) headers.Authorization = `Bearer ${this.bridgeToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetcher(this.bridgeControlUrl(path), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `dsh bridge ${method} ${path} failed (${response.status})${text ? `: ${text}` : ''}`,
      );
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `dsh bridge ${method} ${path} returned a non-JSON body: ${text.slice(0, 120)}`,
      );
    }
  }

  /** First frame of a mux stream, then the stream is cancelled (never `end`). */
  private async firstMuxItem(
    endpoint: string,
    args: Record<string, DshJsonValue>,
  ): Promise<DshJsonValue | undefined> {
    await this.muxClient.connect();
    const handle = this.muxClient.open(endpoint, { args });
    try {
      return await new Promise<DshJsonValue | undefined>((resolve, reject) => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          unsubscribe?.();
          fn();
        };
        unsubscribe = handle.onItem((value) => settle(() => resolve(value)));
        handle.promise.then(
          (values) => settle(() => resolve(values[0])),
          (error: unknown) => settle(() => reject(error)),
        );
      });
    } finally {
      // R13 (replay boundary contract): follow streams are downlink-only, so
      // the half-close is expressed with `cancel`, NEVER with an uplink `end`.
      handle.cancel();
    }
  }

  private async workspaceBaseline(): Promise<DshWorkspaceBaseline> {
    const frame = await this.firstMuxItem('workspace/follow', {});
    return readDshWorkspaceBaseline(frame);
  }

  /** Workspaces as dsh reports them (used by listSessions/createSession). */
  private async workspaceItems(): Promise<DshWorkspaceItem[]> {
    return (await this.workspaceBaseline()).items;
  }

  private async findWorkspaceForDirectory(
    directory: string,
  ): Promise<DshWorkspaceItem | undefined> {
    const normalized = normalizeDirectory(directory.trim() || '/');
    const items = await this.workspaceItems();
    return items.find((item) => normalizeDirectory(item.path?.trim() || '/') === normalized);
  }

  /** `session/list` items (docs/dsh.md §7.1: `{_request:{}}` → `{items:[…]}`). */
  private async sessionListItems(): Promise<DshSessionItem[]> {
    const value = await this.rpcClient.call('session', 'list', { _request: {} });
    if (!isRecord(value)) throw new Error('dsh session/list did not return an object.');
    return readArray(value.items).flatMap((entry) =>
      isRecord(entry) ? [entry as unknown as DshSessionItem] : [],
    );
  }

  /**
   * Full session list: `workspace/follow` baseline (which session belongs to
   * which workspace, plus archived/pinned sets) joined onto `session/list`
   * items. Item-declared workspace ids win over the baseline; a session claimed
   * by no workspace keeps its own cwd so it still lands in the tree.
   */
  private async listMappedSessions(options?: ListSessionsOptions): Promise<DshMappedSession[]> {
    const limit = options?.limit;
    if (limit !== undefined && limit <= 0) return [];
    const directory = options?.directory?.trim();
    const normalizedDirectory = directory ? normalizeDirectory(directory) : undefined;
    const baseline = await this.workspaceBaseline();
    const ownerBySessionId = new Map<string, DshWorkspaceItem>();
    for (const item of baseline.items) {
      for (const sessionId of item.sessionIds ?? []) {
        if (!ownerBySessionId.has(sessionId)) ownerBySessionId.set(sessionId, item);
      }
    }
    const archived = new Set(baseline.archivedSessionIds);
    const pinned = new Set(baseline.pinnedSessionIds);
    const items = await this.sessionListItems();
    const sessions: DshMappedSession[] = [];
    for (const item of items) {
      const sessionId = item.sessionId?.trim();
      if (!sessionId) continue;
      const workspace = item.workspaceId?.trim()
        ? (baseline.items.find((entry) => entry.workspaceId === item.workspaceId!.trim()) ??
          ownerBySessionId.get(sessionId))
        : ownerBySessionId.get(sessionId);
      const mapped = mapDshSessionItem(item, {
        ...(workspace ? { workspace } : {}),
        archived: archived.has(sessionId),
        pinned: pinned.has(sessionId),
      });
      if (normalizedDirectory && mapped.directory !== normalizedDirectory) continue;
      sessions.push(mapped);
    }
    return typeof limit === 'number' ? sessions.slice(0, limit) : sessions;
  }

  private async loadModelCatalog(): Promise<DshCatalogProvider[]> {
    if (this.modelCatalog) return this.modelCatalog;
    const providers = normalizeDshModelCatalog(
      await this.rpcClient.call('session', 'modelCatalog', {}),
    );
    this.modelCatalog = providers;
    return providers;
  }

  /** Resolve the provider that owns a model id (dsh serves exactly one). */
  private async resolveModelProvider(modelId: string): Promise<string> {
    const providers = await this.loadModelCatalog();
    const owner = providers.find((provider) =>
      provider.models.some((model) => model.id === modelId),
    );
    return owner?.id ?? providers[0]?.id ?? DSH_MODEL_PROVIDER;
  }

  /** The catalog's first model — dsh has no "default model" read endpoint. */
  private async defaultModelSelection(): Promise<DshModelSelection> {
    const providers = await this.loadModelCatalog();
    const provider = providers[0];
    const model = provider?.models[0];
    if (!provider || !model)
      throw new Error('dsh session/modelCatalog carried no model to select.');
    return {
      provider: provider.id,
      model: model.id,
      reasoningEffort: model.defaultReasoningEffort,
    };
  }

  /** Session whose cwd resolves to `directory` (the workspaceFiles scope id). */
  private async sessionIdForDirectory(directory: string): Promise<string> {
    const normalized = normalizeDirectory(directory.trim() || '/');
    const sessions = await this.sessionListItems();
    const session = sessions.find((entry) => entry.cwd && normalizeDirectory(entry.cwd) === normalized);
    if (!session) throw new Error(`No dsh session found for directory ${normalized}.`);
    return session.sessionId;
  }

  /** Run one bridge command (`/command/exec`) and return its result. */
  private async bridgeCommand(
    command: string,
    args: string[],
    directory: string,
    options?: BackendRequestOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.bridgeRequest(
      '/command/exec',
      'POST',
      {
        command,
        args,
        directory,
      },
      options?.signal,
    );
    if (!isRecord(result)) throw new Error('dsh bridge command/exec did not return an object.');
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  configure(options: { baseUrl?: string; authorization?: string; codexBridgeUrl?: string }) {
    // The registry builds a new adapter when the bridge URL changes; a token
    // rotation lands here so in-flight requests keep authenticating.
    if (typeof options.authorization === 'string') this.bridgeToken = options.authorization.trim();
  }

  disconnect() {
    this.muxClient.disconnect();
    this.modelCatalog = null;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async listSessions(options?: ListSessionsOptions): Promise<DshMappedSession[]> {
    return this.listMappedSessions(options);
  }

  async createSession(directory = '/'): Promise<DshMappedSession> {
    const normalized = normalizeDirectory(directory.trim() || '/');
    const workspace = await this.findWorkspaceForDirectory(normalized);
    const created = await this.rpcClient.call('session', 'create', {
      request: {
        ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
        cwd: normalized,
      },
    });
    if (!isRecord(created)) throw new Error('dsh session/create did not return an object.');
    const sessionId = readString(created, ['sessionId', 'session_id', 'id']);
    if (!sessionId) throw new Error('dsh session/create returned no session id.');

    // dsh does not silently apply a default model: write it explicitly, then
    // read the projection back so the reported model is the stored one.
    const selection = await this.defaultModelSelection();
    await this.rpcClient.call('session', 'selectModel', {
      request: {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      },
    });
    const snapshot = await this.firstMuxItem('session/follow', {
      request: { address: { kind: 'session', sessionId } },
    });
    const info = readDshSessionSnapshot(snapshot);
    const storedSelection = info.modelSelection ?? selection;
    return mapDshSessionItem(
      {
        sessionId,
        workspaceId: workspace?.workspaceId,
        cwd: info.cwd || normalized,
        ...(info.title ? { title: info.title } : {}),
        createdAt: info.createdAt,
      },
      { ...(workspace ? { workspace } : {}), model: modelKey(storedSelection) },
    );
  }

  async forkSession(sessionId: string, messageId?: string): Promise<unknown> {
    // The atSeq key is OMITTED (never null/NaN — the gateway rejects those) when the caller has no checkpoint to fork at.
    const atSeq = messageId === undefined || messageId === '' ? undefined : Number(messageId);
    return this.rpcClient.call('session', 'fork', {
      request: { sessionId, ...(atSeq !== undefined && Number.isFinite(atSeq) ? { atSeq } : {}) },
    });
  }

  async updateSession(
    sessionId: string,
    payload: SessionUpdatePayload,
    _directory?: string,
  ): Promise<unknown> {
    if (payload.title !== undefined) {
      return this.rpcClient.call('session', 'rename', {
        request: { sessionId, title: payload.title },
      });
    }
    if (payload.time?.archived !== undefined) {
      return payload.time.archived > 0
        ? this.rpcClient.call('workspace', 'archiveSession', { request: { sessionId } })
        : this.rpcClient.call('workspace', 'unarchiveSession', { request: { sessionId } });
    }
    if (payload.time?.pinned !== undefined) {
      return payload.time.pinned > 0
        ? this.rpcClient.call('workspace', 'pinSession', { request: { sessionId } })
        : this.rpcClient.call('workspace', 'unpinSession', { request: { sessionId } });
    }
    return unsupported(
      'session update',
      'only rename/archive/pin payloads are wired (docs/dsh.md §7.2).',
    );
  }

  deleteSession(_sessionId: string, _directory?: string): Promise<never> {
    // dsh has no session delete endpoint; a VIS-local hide is NOT a remote
    // delete, so the capability stays false and this must fail loudly.
    return unsupported(
      'session delete',
      'dsh exposes no session delete endpoint; VIS-local hide semantics are a later todo',
    );
  }

  revertSession(_sessionId: string, _messageId: string, _directory?: string): Promise<never> {
    return unsupported('session revert', 'dsh exposes no revert endpoint.');
  }

  unrevertSession(_sessionId: string, _directory?: string): Promise<never> {
    return unsupported('session unrevert', 'dsh exposes no unrevert endpoint.');
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.rpcClient.call('session', 'cancel', { request: { sessionId } });
  }

  updateProject(_projectId: string, _payload: ProjectUpdatePayload): Promise<never> {
    return unsupported(
      'project updates',
      'dsh workspaces are not renameable through the wired surface.',
    );
  }

  createWorktree(_directory: string): Promise<never> {
    return unsupported(
      'worktrees',
      'dsh has no worktree surface; each workspace is its own directory.',
    );
  }

  deleteWorktree(_directory: string, _targetDirectory: string): Promise<never> {
    return unsupported(
      'worktrees',
      'dsh has no worktree surface; each workspace is its own directory.',
    );
  }

  // -------------------------------------------------------------------------
  // Model / provider surface
  // -------------------------------------------------------------------------

  async listProviders(): Promise<BackendProviderResponse> {
    return dshModelResponse(await this.loadModelCatalog());
  }

  async getGlobalConfig(): Promise<{ enabled_providers: string[]; disabled_providers: string[] }> {
    const providers = await this.loadModelCatalog();
    return { enabled_providers: providers.map((provider) => provider.id), disabled_providers: [] };
  }

  getSessionConfigOptions() {
    // Docs-anchored static ladder (docs/dsh.md §10: off/low/high/max, default
    // high). Not probed live; the model ladder itself lives in modelCatalog.
    return [
      {
        type: 'select' as const,
        id: 'reasoningEffort',
        name: 'reasoningEffort',
        category: 'thought_level',
        currentValue: DSH_DEFAULT_REASONING_EFFORT,
        options: [
          { value: 'off', name: 'off' },
          { value: 'low', name: 'low' },
          { value: 'high', name: 'high' },
          { value: 'max', name: 'max' },
        ],
      },
    ];
  }

  async syncSessionConfig(
    sessionId: string,
    selection: { model: string; mode: string; thoughtLevel?: string },
  ): Promise<unknown> {
    const model = selection.model.trim();
    if (!model) throw new Error('dsh session/selectModel requires a model id.');
    const provider = await this.resolveModelProvider(model);
    return this.rpcClient.call('session', 'selectModel', {
      request: {
        sessionId,
        provider,
        model,
        ...(selection.thoughtLevel ? { reasoningEffort: selection.thoughtLevel } : {}),
      },
    });
  }

  updateSessionMode(_sessionId: string, _change: unknown): Promise<never> {
    // No probed unary endpoint writes a dsh session mode: `settings/update` is
    // unverified (docs/dsh.md §7.4, ➖) and `session/updateQueue` is
    // input-invalid. Failing loudly beats guessing at the request shape.
    return unsupported(
      'session mode',
      'no probed unary endpoint writes a dsh session mode (settings/update is unverified, docs §7.4)',
    );
  }

  listCommands(_directory?: string): Promise<never> {
    return unsupported(
      'commands',
      'dsh exposes no slash-command catalog endpoint (docs/dsh.md §7).',
    );
  }

  async getSessionStatusMap(_directory?: string): Promise<Record<string, { type: string }>> {
    // dsh has no `session/status` endpoint; only an explicit per-session
    // activity signal is reported. Live status is owned by a later todo.
    const sessions = await this.listMappedSessions();
    return Object.fromEntries(
      sessions.flatMap((session) =>
        session.status === 'busy' ? [[session.id, { type: 'busy' }]] : [],
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  async listFiles(payload: { directory: string; path?: string }, options?: BackendRequestOptions) {
    const directory = normalizeDirectory(payload.directory.trim() || '/');
    const scopeId = await this.sessionIdForDirectory(directory);
    const relative = payload.path?.trim() || '.';
    const value = await this.rpcClient.call(
      'workspaceFiles',
      'list',
      { workspaceFileScopeId: scopeId, path: relative },
      { signal: options?.signal },
    );
    if (!isRecord(value)) throw new Error('dsh workspaceFiles/list did not return an object.');
    const prefix = relative === '.' ? '' : relative.replace(/^\/+/u, '').replace(/\/+$/u, '');
    const entries = readArray(value.entries).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const name = readString(entry, ['name']);
      if (!name) return [];
      return [
        {
          name,
          path: prefix ? `${prefix}/${name}` : name,
          type:
            readString(entry, ['type']) === 'directory'
              ? ('directory' as const)
              : ('file' as const),
          ignored: false,
        },
      ];
    });
    if (entries.length === 0) return entries;
    const ignored = await this.bridgeCommand('git', [
      '-c', 'core.quotePath=false', 'check-ignore', '--',
      ...entries.map((entry) => entry.path),
    ], directory, options);
    const ignoredPaths = new Set(ignored.exitCode === 0
      ? ignored.stdout.split('\n')
      : []);
    return entries.map((entry) => ({ ...entry, ignored: entry.path === '.git' || entry.path.startsWith('.git/') || ignoredPaths.has(entry.path) || ignoredPaths.has(JSON.stringify(entry.path)) }));
  }

  async readFileContent(
    payload: { directory: string; path: string },
    options?: BackendRequestOptions,
  ) {
    const directory = normalizeDirectory(payload.directory.trim() || '/');
    const scopeId = await this.sessionIdForDirectory(directory);
    const relative = payload.path?.trim() || '.';
    const value = await this.rpcClient.call(
      'workspaceFiles',
      'read',
      {
        workspaceFileScopeId: scopeId,
        path: relative,
        range: { offset: 0, limit: DSH_FILE_READ_LIMIT },
      },
      { signal: options?.signal },
    );
    if (!isRecord(value)) throw new Error('dsh workspaceFiles/read did not return an object.');
    const text = typeof value.text === 'string' ? value.text : '';
    const binary = text.includes('\0');
    return {
      type: binary ? ('binary' as const) : ('text' as const),
      encoding: 'utf-8' as const,
      content: text,
    };
  }

  async readFileContentBytes(
    payload: { directory: string; path: string },
    options?: BackendRequestOptions,
  ) {
    // `workspaceFiles/readBytes` is unverified (docs/dsh.md §7.7, ➖) and may
    // answer multipart; the verified `read` endpoint carries the same bytes as
    // UTF-8 text, which is what the editor/file tree consumes.
    const directory = normalizeDirectory(payload.directory.trim() || '/');
    const scopeId = await this.sessionIdForDirectory(directory);
    const value = await this.rpcClient.callMultipart(
      'workspaceFiles',
      'readBytes',
      { workspaceFileScopeId: scopeId, path: payload.path?.trim() || '.' },
      { signal: options?.signal },
    );
    return value.bytes[0] ?? new TextEncoder().encode('');
  }

  async getVcsInfo(directory: string, options?: BackendRequestOptions) {
    const cwd = normalizeDirectory(directory.trim() || '/');
    // Same data source as the codex adapter: the bridge command runner. It is
    // the only mechanism that works for every backend, and dsh's own git
    // surface does not exist.
    let root = '';
    try {
      const result = await this.bridgeCommand(
        'git',
        ['rev-parse', '--show-toplevel'],
        cwd,
        options,
      );
      if (result.exitCode !== 0) return { root: '', branch: '' };
      root = result.stdout.trim();
    } catch {
      return { root: '', branch: '' };
    }
    let commonRoot = '';
    try {
      const result = await this.bridgeCommand(
        'git',
        ['rev-parse', '--git-common-dir'],
        cwd,
        options,
      );
      commonRoot = commonRootFromGitCommonDir(result.stdout, root);
    } catch {
      commonRoot = '';
    }
    let branch = '';
    try {
      const result = await this.bridgeCommand('git', ['branch', '--show-current'], cwd, options);
      branch = result.stdout.trim();
    } catch {
      branch = '';
    }
    let sha = '';
    try {
      const result = await this.bridgeCommand(
        'git',
        ['rev-parse', '--short', 'HEAD'],
        cwd,
        options,
      );
      sha = result.stdout.trim();
    } catch {
      sha = '';
    }
    return {
      root,
      branch,
      ...(commonRoot ? { commonRoot } : {}),
      ...(commonRoot && commonRoot !== root ? { worktreeRoot: root } : {}),
      ...(sha ? { sha } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Shell: bridge PTY, never dsh terminal endpoints
  // -------------------------------------------------------------------------

  listPtys(_directory?: string) {
    return this.bridgeRequest('/pty', 'GET');
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
    return this.bridgeRequest('/pty', 'POST', payload, options?.signal);
  }

  updatePtySize(ptyId: string, payload: { directory?: string; rows: number; cols: number }) {
    return this.bridgeRequest(`/pty/${encodeURIComponent(ptyId)}`, 'PUT', {
      size: { rows: payload.rows, cols: payload.cols },
    });
  }

  deletePty(ptyId: string, _directory?: string) {
    return this.bridgeRequest(`/pty/${encodeURIComponent(ptyId)}`, 'DELETE');
  }

  createPtyWebSocketUrl(
    path: string,
    params?: Record<string, BackendQueryValue>,
    _credentials?: { username: string; password: string },
  ): string {
    // The PTY route lives on the bridge root, so the derived /dsh prefix is
    // dropped: only the origin is reused. The token query set by
    // dshMuxBridgeUrl is preserved; caller params are layered on top.
    const url = new URL(dshMuxBridgeUrl(this.bridgeUrl, this.bridgeToken || null));
    url.pathname = path;
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async getGlobalHealth(): Promise<{ healthy: boolean; version: string }> {
    // dsh has no health route: the ready-signal is a successful
    // `account/getState` envelope (Todo 14 uses the same probe). A signed-out
    // account is still healthy — the sign-in flow is a separate surface. The
    // version is the protocol generation this adapter speaks, because dsh
    // exposes no server-version endpoint.
    const value = await this.rpcClient.call('account', 'getState', {});
    if (!isRecord(value)) throw new Error('dsh account/getState did not return an object.');
    return { healthy: true, version: DSH_WIRE_VERSION };
  }
}

export function createDshAdapter(options: DshAdapterOptions) {
  return new DshAdapter(options);
}
