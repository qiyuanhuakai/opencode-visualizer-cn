// Capability-gated native control resolution for the runtime harness kinds.
//
// Task 23 requires every backend-specific setting/control to be entered into
// the task-4 mapping (BACKEND_OPERATION_OWNERS / NATIVE_EXTENSIONS /
// WORKSPACE_OPERATIONS) and scoped to either the CURRENT SESSION or an explicit
// Harness instance. Workspace controls never consult `activeBackendKind`.
//
// Two resolution channels with different sources of truth:
//   * harness controls (model / provider / auth / skills / MCP / usage) read the
//     Harness manifest for the target instance. A capability that is absent,
//     explicitly unsupported, or unknown resolves UNSUPPORTED and carries the
//     SOURCE INFORMATION (which environment/instance/kind, what is missing) so
//     it can never masquerade as an available control.
//   * workspace controls (git / files / terminal) resolve against the workspace
//     scope alone. They never read a manifest and never report a harness source,
//     so switching the active backend kind cannot change their outcome.
import { shallowRef } from 'vue';
import { CORE_OPERATIONS, HARNESS_KINDS } from '../../shared/runtime/harnessContract.js';
import type { HarnessKind, HarnessManifest, Support } from '../../shared/runtime/harnessContract.js';
import { BACKEND_OPERATION_OWNERS, NATIVE_EXTENSIONS, WORKSPACE_OPERATIONS } from '../../shared/runtime/nativeExtensions.js';
import type { LegacyCapability, NativeOperation, WorkspaceOperation } from '../../shared/runtime/nativeExtensions.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';

/** Which scope a control applies to. The shared Scope contract is fixed. */
export type ControlScope =
  | Readonly<{ kind: 'session'; session: SessionRef }>
  | Readonly<{ kind: 'instance'; environmentId: EnvironmentId; harnessInstanceId: HarnessInstanceId }>
  | Readonly<{ kind: 'workspace'; environmentId: EnvironmentId; canonicalPath: string }>;

/** The operation scope a harness control requires, from the task-4 mapping. */
export type ControlOperationScope = 'instance' | 'session' | 'optional-session';

/** The UI surface a backend-specific control drives. */
export type ControlGroup =
  | 'model'
  | 'provider'
  | 'auth'
  | 'skills'
  | 'mcp'
  | 'usage'
  | 'settings'
  | 'commands'
  | 'plugins'
  | 'lsp'
  | 'status';

/**
 * The legacy capability a control is gated on, or `null` when the task-4
 * mapping declares no legacy capability for that surface (MCP, skills).
 */
export type ControlCapability = LegacyCapability | null;

/** One entry of the task-4 control mapping. */
export type HarnessControlEntry = Readonly<{
  operation: string;
  capability: ControlCapability;
  group: ControlGroup;
}>;
export type WorkspaceControlEntry = Readonly<{
  operation: WorkspaceOperation;
  service: 'git' | 'files' | 'terminal';
  capability: ControlCapability;
  group: ControlGroup;
}>;

/** Every backend-specific control entered into the task-4 mapping. */
export const HARNESS_CONTROLS: Readonly<Record<string, HarnessControlEntry>> = Object.freeze({
  // ── model ──────────────────────────────────────────────────────────────
  'codex.models': { operation: 'codex.models', capability: 'providerConfig', group: 'model' },
  // ── provider / model provider configuration ────────────────────────────
  listProviders: { operation: 'listProviders', capability: 'providerConfig', group: 'provider' },
  listProviderAuthMethods: { operation: 'listProviderAuthMethods', capability: 'providerConfig', group: 'provider' },
  setProviderAuth: { operation: 'setProviderAuth', capability: 'providerConfig', group: 'provider' },
  authorizeProviderOAuth: { operation: 'authorizeProviderOAuth', capability: 'providerConfig', group: 'provider' },
  completeProviderOAuth: { operation: 'completeProviderOAuth', capability: 'providerConfig', group: 'provider' },
  deleteProviderAuth: { operation: 'deleteProviderAuth', capability: 'providerConfig', group: 'provider' },
  'codex.providerCapabilities': { operation: 'codex.providerCapabilities', capability: 'providerConfig', group: 'provider' },
  // ── auth (harness / agent authentication) ──────────────────────────────
  listAgents: { operation: 'listAgents', capability: 'providerConfig', group: 'auth' },
  listAgentAuthMethods: { operation: 'listAgentAuthMethods', capability: 'providerConfig', group: 'auth' },
  createAgentAuthPty: { operation: 'createAgentAuthPty', capability: 'terminal', group: 'auth' },
  authenticateAgent: { operation: 'authenticateAgent', capability: 'providerConfig', group: 'auth' },
  // ── skills ─────────────────────────────────────────────────────────────
  getSkillStatus: { operation: 'getSkillStatus', capability: null, group: 'skills' },
  updateSkill: { operation: 'updateSkill', capability: null, group: 'skills' },
  // ── MCP ────────────────────────────────────────────────────────────────
  getMcpStatus: { operation: 'getMcpStatus', capability: null, group: 'mcp' },
  updateMcp: { operation: 'updateMcp', capability: null, group: 'mcp' },
  'codex.mcp.reload': { operation: 'codex.mcp.reload', capability: null, group: 'mcp' },
  'codex.mcp.oauth': { operation: 'codex.mcp.oauth', capability: null, group: 'mcp' },
  // ── usage / monitoring ─────────────────────────────────────────────────
  getGlobalHealth: { operation: 'inspect', capability: 'status', group: 'usage' },
  'codex.usage': { operation: 'codex.usage', capability: 'status', group: 'usage' },
  'codex.rateLimits': { operation: 'codex.rateLimits', capability: 'status', group: 'usage' },
  'codex.account': { operation: 'codex.account', capability: 'status', group: 'usage' },
  // ── settings / global config ───────────────────────────────────────────
  getGlobalConfig: { operation: 'getGlobalConfig', capability: 'providerConfig', group: 'settings' },
  updateGlobalConfig: { operation: 'updateGlobalConfig', capability: 'providerConfig', group: 'settings' },
  writeConfigValue: { operation: 'writeConfigValue', capability: 'providerConfig', group: 'settings' },
  batchWriteConfig: { operation: 'batchWriteConfig', capability: 'providerConfig', group: 'settings' },
  getSessionConfigOptions: { operation: 'getSessionConfigOptions', capability: 'providerConfig', group: 'settings' },
  'codex.requirements': { operation: 'codex.requirements', capability: 'providerConfig', group: 'settings' },
  // ── commands / slash commands ──────────────────────────────────────────
  listCommands: { operation: 'listCommands', capability: 'sessions', group: 'commands' },
  sendCommand: { operation: 'sendCommand', capability: 'sessions', group: 'commands' },
  // ── plugins ────────────────────────────────────────────────────────────
  getPluginStatus: { operation: 'getPluginStatus', capability: 'status', group: 'plugins' },
  getPluginManagementEntries: { operation: 'getPluginManagementEntries', capability: 'status', group: 'plugins' },
  setPluginEnabled: { operation: 'setPluginEnabled', capability: 'status', group: 'plugins' },
  'codex.plugin.install': { operation: 'codex.plugin.install', capability: 'status', group: 'plugins' },
  'codex.plugin.uninstall': { operation: 'codex.plugin.uninstall', capability: 'status', group: 'plugins' },
  // ── lsp ────────────────────────────────────────────────────────────────
  getLspStatus: { operation: 'getLspStatus', capability: 'status', group: 'lsp' },
  // ── status ─────────────────────────────────────────────────────────────
  getSessionStatusMap: { operation: 'getSessionStatusMap', capability: 'status', group: 'status' },
  listPendingPermissions: { operation: 'listPendingPermissions', capability: 'permissions', group: 'status' },
  listPendingQuestions: { operation: 'listPendingQuestions', capability: 'questions', group: 'status' },
});

/** Every workspace control entered into the task-4 mapping (never backend-kind dependent). */
export const WORKSPACE_CONTROLS: Readonly<Record<string, WorkspaceControlEntry>> = Object.freeze({
  listProjects: { operation: 'listProjects', service: 'git', capability: 'projects', group: 'settings' },
  getCurrentProject: { operation: 'getCurrentProject', service: 'git', capability: 'projects', group: 'settings' },
  listWorktrees: { operation: 'listWorktrees', service: 'git', capability: 'worktrees', group: 'settings' },
  createWorktree: { operation: 'createWorktree', service: 'git', capability: 'worktrees', group: 'settings' },
  deleteWorktree: { operation: 'deleteWorktree', service: 'git', capability: 'worktrees', group: 'settings' },
  getVcsInfo: { operation: 'getVcsInfo', service: 'git', capability: 'worktrees', group: 'status' },
  updateProject: { operation: 'updateProject', service: 'git', capability: 'projects', group: 'settings' },
  getPathInfo: { operation: 'getPathInfo', service: 'git', capability: 'projects', group: 'settings' },
  listFiles: { operation: 'listFiles', service: 'files', capability: 'files', group: 'settings' },
  readFileContent: { operation: 'readFileContent', service: 'files', capability: 'files', group: 'settings' },
  readFileContentBytes: { operation: 'readFileContentBytes', service: 'files', capability: 'files', group: 'settings' },
  writeFileContent: { operation: 'writeFileContent', service: 'files', capability: 'files', group: 'settings' },
  listPtys: { operation: 'listPtys', service: 'terminal', capability: 'terminal', group: 'settings' },
  createPty: { operation: 'createPty', service: 'terminal', capability: 'terminal', group: 'settings' },
  updatePtySize: { operation: 'updatePtySize', service: 'terminal', capability: 'terminal', group: 'settings' },
  deletePty: { operation: 'deletePty', service: 'terminal', capability: 'terminal', group: 'settings' },
  createPtyWebSocketUrl: { operation: 'createPtyWebSocketUrl', service: 'terminal', capability: 'terminal', group: 'settings' },
  runOneShotCommand: { operation: 'runOneShotCommand', service: 'terminal', capability: 'terminal', group: 'settings' },
});

/** Source information for an unsupported control: which source, what is missing. */
export type HarnessSource = Readonly<{
  environmentId: EnvironmentId;
  harnessInstanceId: HarnessInstanceId;
  kind: HarnessKind;
}>;
export type WorkspaceSource = Readonly<{ kind: 'workspace'; environmentId: EnvironmentId; canonicalPath: string }>;

export type HarnessControlSupport =
  | Readonly<{
      state: 'supported';
      channel: 'harness';
      control: string;
      operation: string;
      capability: ControlCapability;
      group: ControlGroup;
      scope: ControlOperationScope;
      source: HarnessSource;
    }>
  | Readonly<{
      state: 'unsupported';
      channel: 'harness';
      control: string;
      operation: string | null;
      capability: ControlCapability;
      reason: string;
      source: HarnessSource | null;
    }>;

export type WorkspaceControlSupport =
  | Readonly<{
      state: 'supported';
      channel: 'workspace';
      control: string;
      operation: WorkspaceOperation;
      capability: ControlCapability;
      group: ControlGroup;
      service: 'git' | 'files' | 'terminal';
      source: WorkspaceSource;
    }>
  | Readonly<{
      state: 'unsupported';
      channel: 'workspace';
      control: string;
      operation: WorkspaceOperation | null;
      capability: ControlCapability;
      reason: string;
      source: WorkspaceSource | null;
    }>;

export type ControlSupport = HarnessControlSupport | WorkspaceControlSupport;

/** A saved control mutation. The scope is captured so it cannot be mis-attributed. */
export type ControlSave = Readonly<{
  control: string;
  channel: 'harness' | 'workspace';
  capability: ControlCapability;
  operation: string;
  scope: ControlScope;
  payload: Readonly<Record<string, unknown>>;
}>;

function isHarnessKind(value: unknown): value is HarnessKind {
  return typeof value === 'string' && (HARNESS_KINDS as readonly string[]).includes(value);
}

/** The harness scope a control scope addresses. `null` when the scope is a workspace. */
export function controlHarnessScope(scope: ControlScope): Readonly<{ environmentId: EnvironmentId; harnessInstanceId: HarnessInstanceId }> | null {
  switch (scope.kind) {
    case 'session':
      return { environmentId: scope.session.environmentId, harnessInstanceId: scope.session.harnessInstanceId };
    case 'instance':
      return { environmentId: scope.environmentId, harnessInstanceId: scope.harnessInstanceId };
    default:
      return null;
  }
}

function supportOf(manifest: HarnessManifest, operation: string): Support | null {
  const core = manifest.core as Readonly<Record<string, Support | undefined>>;
  if (Object.hasOwn(core, operation)) return core[operation] ?? null;
  const extension = manifest.extensions.find((entry) => entry.name === operation);
  return extension ? extension.support : null;
}

function operationScopeOf(manifest: HarnessManifest, operation: string): ControlOperationScope {
  const core = manifest.core as Readonly<Record<string, Support | undefined>>;
  if (Object.hasOwn(core, operation)) {
    const coreScope = CORE_OPERATIONS[operation as keyof typeof CORE_OPERATIONS];
    return (coreScope as ControlOperationScope | undefined) ?? 'instance';
  }
  const extension = manifest.extensions.find((entry) => entry.name === operation);
  return (extension?.scope as ControlOperationScope | undefined) ?? NATIVE_EXTENSIONS[operation as NativeOperation]?.scope ?? 'instance';
}

/**
 * Resolve one backend-specific control against the manifests in scope.
 *
 * The manifest list is passed explicitly (never read from a global) so the
 * resolution is deterministic and the caller decides which sources are visible.
 * The result always names the source when unsupported, and `null` when no
 * source could be identified at all.
 */
export function resolveControlSupport(input: Readonly<{
  control: string;
  scope: ControlScope;
  manifests: readonly HarnessManifest[];
  activeBackendKind?: unknown;
}>): ControlSupport {
  const { control, scope, manifests, activeBackendKind } = input;
  if (scope.kind === 'workspace') return resolveWorkspaceSupport(control, scope);

  const entry = HARNESS_CONTROLS[control];
  if (!entry) {
    return Object.freeze({
      state: 'unsupported', channel: 'harness', control, operation: null, capability: null,
      reason: `Unknown harness control "${control}" is not in the task-4 control mapping`,
      source: null,
    });
  }
  // An unidentifiable active backend kind can never make a harness control
  // available: the caller would have no source to attribute the call to.
  if (activeBackendKind !== undefined && activeBackendKind !== null && !isHarnessKind(activeBackendKind)) {
    return Object.freeze({
      state: 'unsupported', channel: 'harness', control, operation: entry.operation, capability: entry.capability,
      reason: `Active backend kind "${String(activeBackendKind)}" is not one of the five harness kinds`,
      source: null,
    });
  }
  const target = controlHarnessScope(scope);
  if (!target) {
    return Object.freeze({
      state: 'unsupported', channel: 'harness', control, operation: entry.operation, capability: entry.capability,
      reason: 'Control requires a session or harness instance scope', source: null,
    });
  }
  const manifest = manifests.find((candidate) => candidate.environmentId === target.environmentId && candidate.harnessInstanceId === target.harnessInstanceId);
  if (!manifest) {
    return Object.freeze({
      state: 'unsupported', channel: 'harness', control, operation: entry.operation, capability: entry.capability,
      reason: `Harness instance ${target.harnessInstanceId} is not registered on environment ${target.environmentId}`,
      source: null,
    });
  }
  const source: HarnessSource = Object.freeze({ environmentId: manifest.environmentId, harnessInstanceId: manifest.harnessInstanceId, kind: manifest.kind });
  // A legacy capability explicitly declared unsupported gates the control first.
  if (entry.capability) {
    const capabilitySupport = manifest.capabilities[entry.capability];
    if (capabilitySupport && capabilitySupport.state === 'unsupported') {
      return Object.freeze({
        state: 'unsupported', channel: 'harness', control, operation: entry.operation, capability: entry.capability,
        reason: capabilitySupport.reason, source,
      });
    }
  }
  const support = supportOf(manifest, entry.operation);
  if (!support) {
    return Object.freeze({
      state: 'unsupported', channel: 'harness', control, operation: entry.operation, capability: entry.capability,
      reason: `${manifest.kind} does not declare the "${entry.operation}" operation`,
      source,
    });
  }
  if (support.state === 'unsupported') {
    return Object.freeze({
      state: 'unsupported', channel: 'harness', control, operation: entry.operation, capability: entry.capability,
      reason: support.reason, source,
    });
  }
  const required = operationScopeOf(manifest, entry.operation);
  if (required === 'session' && scope.kind !== 'session') {
    return Object.freeze({
      state: 'unsupported', channel: 'harness', control, operation: entry.operation, capability: entry.capability,
      reason: `"${entry.operation}" requires a session scope`, source,
    });
  }
  return Object.freeze({
    state: 'supported', channel: 'harness', control, operation: entry.operation, capability: entry.capability,
    group: entry.group, scope: required, source,
  });
}

/** Workspace resolution: the workspace scope alone decides. No manifest, no backend kind. */
function resolveWorkspaceSupport(control: string, scope: Readonly<{ kind: 'workspace'; environmentId: EnvironmentId; canonicalPath: string }>): WorkspaceControlSupport {
  const entry = WORKSPACE_CONTROLS[control];
  if (!entry) {
    return Object.freeze({
      state: 'unsupported', channel: 'workspace', control, operation: null, capability: null,
      reason: `Unknown workspace control "${control}" is not in the task-4 control mapping`, source: null,
    });
  }
  const owner = BACKEND_OPERATION_OWNERS[entry.operation];
  if (owner.owner !== 'workspace') {
    return Object.freeze({
      state: 'unsupported', channel: 'workspace', control, operation: entry.operation, capability: entry.capability,
      reason: `"${entry.operation}" is not a workspace operation`, source: null,
    });
  }
  if (entry.service !== WORKSPACE_OPERATIONS[entry.operation]) {
    return Object.freeze({
      state: 'unsupported', channel: 'workspace', control, operation: entry.operation, capability: entry.capability,
      reason: `"${entry.operation}" service disagrees with the task-4 mapping`, source: null,
    });
  }
  let environmentId: EnvironmentId;
  try {
    environmentId = parseEnvironmentId(scope.environmentId);
  } catch {
    return Object.freeze({
      state: 'unsupported', channel: 'workspace', control, operation: entry.operation, capability: entry.capability,
      reason: 'Workspace scope carries an invalid environment id', source: null,
    });
  }
  if (typeof scope.canonicalPath !== 'string' || scope.canonicalPath.length === 0) {
    return Object.freeze({
      state: 'unsupported', channel: 'workspace', control, operation: entry.operation, capability: entry.capability,
      reason: 'Workspace scope carries no canonical path',
      source: Object.freeze({ kind: 'workspace' as const, environmentId, canonicalPath: String(scope.canonicalPath ?? '') }),
    });
  }
  return Object.freeze({
    state: 'supported', channel: 'workspace', control, operation: entry.operation, capability: entry.capability,
    group: entry.group, service: entry.service,
    source: Object.freeze({ kind: 'workspace' as const, environmentId, canonicalPath: scope.canonicalPath }),
  });
}

/** Human-readable source line for an unsupported control (which source, what is missing). */
export function describeControlSupport(support: ControlSupport): string {
  if (support.state === 'supported') return `${support.control} is available`;
  if (support.channel === 'workspace') {
    const source = support.source;
    return source && source.kind === 'workspace'
      ? `Workspace ${source.canonicalPath} on ${source.environmentId}: ${support.reason}`
      : `Workspace: ${support.reason}`;
  }
  const source = support.source;
  if (!source) return `${support.control}: ${support.reason}`;
  return `${source.kind} (${source.environmentId} / ${source.harnessInstanceId}): ${support.reason}`;
}
/**
 * Capture a control mutation together with the scope it belongs to.
 *
 * Throws when the control is not currently supported or when the requested
 * scope does not address the source the capability was resolved against, so an
 * unsupported or unknown capability can never be saved and a save can never be
 * attributed to the wrong source.
 */
export function captureControlSave(input: Readonly<{
  control: string;
  support: ControlSupport;
  scope: ControlScope;
  payload: Readonly<Record<string, unknown>>;
}>): ControlSave {
  const { control, support, scope, payload } = input;
  if (support.state !== 'supported') throw new TypeError(`capture.unsupported: ${describeControlSupport(support)}`);
  if (support.control !== control) throw new TypeError(`capture.control: ${control} does not match ${support.control}`);
  const scopeTarget = controlHarnessScope(scope);
  if (support.channel === 'harness') {
    if (!scopeTarget) throw new TypeError('capture.scope: a harness control requires a session or instance scope');
    if (scopeTarget.environmentId !== support.source.environmentId || scopeTarget.harnessInstanceId !== support.source.harnessInstanceId) {
      throw new TypeError('capture.scope: the requested scope addresses a different harness instance');
    }
  } else if (scope.kind !== 'workspace' || scope.environmentId !== support.source.environmentId || scope.canonicalPath !== support.source.canonicalPath) {
    throw new TypeError('capture.scope: the requested scope addresses a different workspace');
  }
  return Object.freeze({
    control, channel: support.channel, capability: support.capability, operation: support.operation,
    scope, payload: Object.freeze({ ...payload }),
  });
}

function sameScope(left: ControlScope, right: ControlScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'workspace' && right.kind === 'workspace') {
    return left.environmentId === right.environmentId && left.canonicalPath === right.canonicalPath;
  }
  if (left.kind === 'instance' && right.kind === 'instance') {
    return left.environmentId === right.environmentId && left.harnessInstanceId === right.harnessInstanceId;
  }
  if (left.kind === 'session' && right.kind === 'session') {
    return left.session.environmentId === right.session.environmentId
      && left.session.harnessInstanceId === right.session.harnessInstanceId
      && left.session.nativeSessionId === right.session.nativeSessionId;
  }
  return false;
}

/** The scope a save targets, as a comparable ControlScope. */
export function saveScope(save: ControlSave): ControlScope {
  return save.scope;
}

export type RuntimeCapabilities = Readonly<{
  /** Resolve a control. Workspace controls never consult the active backend kind. */
  support(input: Readonly<{ control: string; scope: ControlScope }>): ControlSupport;
  /** Capture a save for a control resolved against the given scope. */
  capture(input: Readonly<{ control: string; scope: ControlScope; payload: Readonly<Record<string, unknown>> }>): ControlSave;
  /** Whether a save may be applied to a scope: the scope must match exactly. */
  apply(save: ControlSave, scope: ControlScope): boolean;
  setActiveBackendKind(kind: HarnessKind | null): void;
  readonly activeBackendKind: HarnessKind | null;
  setManifests(manifests: readonly HarnessManifest[]): void;
}>;

/**
 * Reactive capability resolver over one set of manifests.
 *
 * `activeBackendKind` is carried so a caller can observe which source is active,
 * but it is deliberately NOT an input to workspace resolution: `support()` routes
 * workspace controls down the workspace channel before any backend-kind value is
 * consulted, and for harness controls it is only used to reject an unidentifiable
 * kind — never to override the manifest.
 */
export function useRuntimeCapabilities(options: Readonly<{
  activeBackendKind?: HarnessKind | null;
  manifests?: readonly HarnessManifest[];
}> = {}): RuntimeCapabilities {
  const activeBackendKind = shallowRef<HarnessKind | null>(isHarnessKind(options.activeBackendKind) ? options.activeBackendKind : null);
  const manifests = shallowRef<readonly HarnessManifest[]>(Object.freeze([...(options.manifests ?? [])]));
  function support(input: Readonly<{ control: string; scope: ControlScope }>): ControlSupport {
    return resolveControlSupport({ control: input.control, scope: input.scope, manifests: manifests.value, activeBackendKind: activeBackendKind.value });
  }
  function capture(input: Readonly<{ control: string; scope: ControlScope; payload: Readonly<Record<string, unknown>> }>): ControlSave {
    const resolved = support({ control: input.control, scope: input.scope });
    return captureControlSave({ control: input.control, support: resolved, scope: input.scope, payload: input.payload });
  }
  return Object.freeze({
    support,
    capture,
    apply: (save, scope) => sameScope(save.scope, scope),
    setActiveBackendKind(kind) { activeBackendKind.value = isHarnessKind(kind) ? kind : null; },
    get activeBackendKind() { return activeBackendKind.value; },
    setManifests(next) { manifests.value = Object.freeze([...next]); },
  });
}

/** The harness instance a session belongs to, validated. */
export function harnessInstanceOf(session: SessionRef): Readonly<{ environmentId: EnvironmentId; harnessInstanceId: HarnessInstanceId }> {
  const ref = parseSessionRef(session);
  return Object.freeze({ environmentId: ref.environmentId, harnessInstanceId: parseHarnessInstanceId(ref.harnessInstanceId) });
}

/** The ordered list of control groups a source declares for one scope. */
export function controlGroupsFor(manifests: readonly HarnessManifest[], scope: ControlScope): readonly ControlGroup[] {
  const groups = new Set<ControlGroup>();
  for (const control of Object.keys(HARNESS_CONTROLS)) {
    const support = resolveControlSupport({ control, scope, manifests });
    if (support.state === 'supported' && support.channel === 'harness') groups.add(support.group);
  }
  return Object.freeze([...groups]);
}
