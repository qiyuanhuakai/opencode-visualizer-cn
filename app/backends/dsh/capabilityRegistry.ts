/**
 * dsh runtime capability gating registry (Todo 31).
 *
 * Mirrors the Codex precedent (`app/backends/codex/capabilityRegistry.ts`:
 * `classifyCapabilityError` + a generation-guarded `run`) and the kimi-web
 * runtime gate (`app/backends/kimiWeb/capabilityRegistry.ts`), with the dsh
 * lesson applied: **capability is decided by a live runtime probe, never by a
 * version number or the docs.**
 *
 * ## States (per probe, independent slots)
 * - `unknown`   — the probe has not run, was skipped for lack of context, or
 *                 was inconclusive (network / wire / malformed / HTTP 404).
 *                 Fail-closed: a surface whose driver is `unknown` stays hidden.
 * - `supported` — the probe call resolved with the expected response shape.
 * - `unsupported` — the probe returned a DEFINITIVE structured negative (e.g.
 *                 a business error code/message saying the feature is
 *                 unavailable / not implemented). Never derived from a version.
 * - `gated`     — the probe was blocked by an auth/permission/feature gate
 *                 (`MISSING_CREDENTIAL`, HTTP 401/403, "capability required").
 *
 * ## 404-class endpoints
 * `session/skills/list` and `session/fileReferences/list` are agent-scoped and
 * legitimately return HTTP 404 when no agent/session is active (docs/dsh.md
 * §7.1, Task 6 probe). A 404 is therefore `unknown` — never `unsupported`
 * (it does not prove the feature absent) and never `supported`. This is the
 * explicit Todo 31 acceptance ("404 类端点判 unknown 不误报").
 *
 * ## Static seed (Scope OUT)
 * `DSH_CAPABILITY_REGISTRY` in `./capabilities.ts` is the static Scope-OUT
 * matrix, consumed here as {@link DSH_STATIC_CAPABILITY_SEED}: every key is
 * seeded `unknown` and only a runtime probe can move one. This module never
 * forks the matrix; the false bits and their enforcement anchors stay in
 * `./capabilities.ts`.
 *
 * ## Consumer seam (Todo 33 App.vue wiring / Todo 34 StatusMonitor)
 * - `createDshCapabilityRegistry({ call, resolveContext })` returns a registry.
 * - A live connection installs it with `setActiveDshCapabilityRegistry(reg)`;
 *   module consumers then read `getDshCapabilityStates()` (per-probe states),
 *   `getDshSurfaceState(surface)` / `isDshSurfaceAvailable(surface)` (the
 *   derived UI-gating view: which capability drives which UI surface), and
 *   `getDshCapabilitySnapshot()` (states + surfaces + generation).
 * - `invalidate(reason)` bumps the generation and re-seeds every slot to
 *   `unknown`, so a stale in-flight observation from a previous connection can
 *   never re-unlock a surface (reconnect / activation refresh).
 * - `refresh(context)` = `invalidate()` + `probeAll(context)`: the activation
 *   entry point. `probeAll` never throws; each probe owns its result slot.
 *
 * The `call` seam is the Todo 5/8 RPC client shape
 * (`call(namespace, method, args)`); tests inject the transport directly.
 */
import { shallowRef } from 'vue';
import { DSH_CAPABILITY_REGISTRY, type DshCapabilityKey } from './capabilities';
import type { DshJsonValue } from './types';
import {
  DshMissingCredentialError,
  DshRpcError,
  DshRpcForbiddenError,
  DshRpcNotFoundError,
  DshRpcUnauthorizedError,
  DshRemoteRpcError,
} from '../../utils/dshRpc';

export type DshCapabilityState = 'unknown' | 'supported' | 'unsupported' | 'gated';

// ---------------------------------------------------------------------------
// Probe descriptors
// ---------------------------------------------------------------------------

/**
 * The runtime probe set. Each key is one independent result slot. `skills` /
 * `fileReferences` are the agent-scoped 404-class probes (docs/dsh.md §7.1).
 */
export const DSH_PROBE_KEYS = [
  'account',
  'models',
  'terminal',
  'workspaceFiles',
  'skills',
  'profile',
  'fileReferences',
] as const;

export type DshProbeKey = (typeof DSH_PROBE_KEYS)[number];

/** Probes whose endpoint may 404 while no agent/session is active. */
export const DSH_AGENT_SCOPED_PROBES = ['skills', 'fileReferences'] as const satisfies readonly DshProbeKey[];

/** The UI surfaces gated by a runtime probe (显隐 / unsupported 文案). */
export type DshUiSurface = 'account' | 'models' | 'fileTree' | 'shell' | 'skills' | 'profile';

/**
 * The derived UI-gating view: which probe drives which surface. A surface is
 * available only when its driver is `supported` this generation.
 */
export const DSH_SURFACE_DRIVER: Readonly<Record<DshUiSurface, DshProbeKey>> = {
  account: 'account',
  models: 'models',
  fileTree: 'workspaceFiles',
  shell: 'terminal',
  skills: 'skills',
  profile: 'profile',
};

/**
 * Context the probe set needs to address agent/scope-scoped endpoints. When a
 * field is absent the corresponding probe is SKIPPED and stays `unknown` — it
 * is never sent with a fabricated id and never reported as supported.
 */
export type DshProbeContext = {
  /** Session/agent id for `terminal/*` and the agent-scoped probes. */
  agentId?: string | null;
  /** `workspaceFileScopeId` (= SessionId) for `workspaceFiles/*`. */
  workspaceFileScopeId?: string | null;
  /** Path for the `workspaceFiles/list` probe; defaults to the session cwd. */
  workspaceFilePath?: string;
  /** Request client descriptor for the optional `account/getProfile` probe. */
  client?: Record<string, DshJsonValue> | null;
};

export type DshCapabilityProbe = {
  readonly key: DshProbeKey;
  readonly namespace: string;
  readonly method: string;
  /** Probe failure must not poison other slots. */
  readonly optional: boolean;
  /** Endpoint may legitimately 404 while no agent is active. */
  readonly agentScoped: boolean;
  /** Null → skip (leave `unknown`); never fabricate an entity id. */
  readonly buildArgs: (context: DshProbeContext) => Record<string, DshJsonValue> | null;
  /** Expected response shape; a mismatch is `unknown`, never `supported`. */
  readonly validate: (value: DshJsonValue) => boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The probe set (docs/dsh.md §7): account state, model catalog, PTY
 * environment, file tree, optional profile, and the two agent-scoped
 * 404-class endpoints. Response validators are pinned to the real captured
 * shapes (Task 6 `probe-results.json`, Task 36 live frames).
 */
export const DSH_CAPABILITY_PROBES: readonly DshCapabilityProbe[] = [
  {
    key: 'account',
    namespace: 'account',
    method: 'getState',
    optional: false,
    agentScoped: false,
    buildArgs: () => ({}),
    // {status:string, attempt:null, links:{usageUrl,topUpUrl}}
    validate: (value) => isRecord(value) && typeof value.status === 'string',
  },
  {
    key: 'models',
    namespace: 'session',
    method: 'modelCatalog',
    optional: false,
    agentScoped: false,
    buildArgs: () => ({}),
    // {default:{provider,model,reasoningEffort}, routableProviders, groups, failures}
    validate: (value) => {
      if (!isRecord(value) || !isRecord(value.default)) return false;
      const def = value.default;
      return nonEmptyString(def.provider) && nonEmptyString(def.model) && Array.isArray(value.groups);
    },
  },
  {
    key: 'terminal',
    namespace: 'terminal',
    method: 'environment',
    optional: false,
    agentScoped: false,
    buildArgs: (context) => {
      const agentId = context.agentId;
      return nonEmptyString(agentId) ? { agentId } : null;
    },
    // {cwd, maxInputBytes, maxCols, maxRows, scrollback}
    validate: (value) =>
      isRecord(value) &&
      typeof value.cwd === 'string' &&
      typeof value.maxInputBytes === 'number' &&
      typeof value.maxCols === 'number',
  },
  {
    key: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'list',
    optional: false,
    agentScoped: false,
    buildArgs: (context) => {
      const scopeId = context.workspaceFileScopeId;
      if (!nonEmptyString(scopeId)) return null;
      return { workspaceFileScopeId: scopeId, path: context.workspaceFilePath?.trim() || '.' };
    },
    // {path, entries:[{name,type,size}], truncated}
    validate: (value) => isRecord(value) && typeof value.path === 'string' && Array.isArray(value.entries),
  },
  {
    key: 'skills',
    namespace: 'session',
    method: 'skills/list',
    optional: false,
    agentScoped: true,
    buildArgs: (context) => {
      const agentId = context.agentId;
      const request: Record<string, DshJsonValue> = nonEmptyString(agentId) ? { agentId } : {};
      return { _request: request };
    },
    validate: (value) => isRecord(value) || Array.isArray(value),
  },
  {
    key: 'profile',
    namespace: 'account',
    method: 'getProfile',
    optional: true,
    agentScoped: false,
    buildArgs: (context) => (context.client ? { client: context.client } : null),
    // Live degraded-path read is `ok:true` with a null value (no client).
    validate: (value) => value === null || isRecord(value),
  },
  {
    key: 'fileReferences',
    namespace: 'session',
    method: 'fileReferences/list',
    optional: false,
    agentScoped: true,
    buildArgs: (context) => {
      const agentId = context.agentId;
      return nonEmptyString(agentId) ? { agentId, query: '' } : null;
    },
    validate: (value) => isRecord(value) || Array.isArray(value),
  },
];

// ---------------------------------------------------------------------------
// Static Scope-OUT seed (consumes ./capabilities.ts, no fork)
// ---------------------------------------------------------------------------

/** Every static matrix key, seeded `unknown` until a runtime probe lands. */
export type DshStaticCapabilitySeed = Record<DshCapabilityKey, DshCapabilityState>;

/**
 * The static `DSH_CAPABILITY_REGISTRY` re-projected as all-`unknown`. A
 * statically-true bit is NOT a runtime capability verdict; it must be probed.
 */
export const DSH_STATIC_CAPABILITY_SEED: Readonly<DshStaticCapabilitySeed> = Object.freeze(
  Object.fromEntries(
    (Object.keys(DSH_CAPABILITY_REGISTRY) as DshCapabilityKey[]).map((key) => [
      key,
      'unknown' as DshCapabilityState,
    ]),
  ) as DshStaticCapabilitySeed,
);

/**
 * The static bits that a runtime probe covers today (Scope OUT for the rest,
 * which stay seeded `unknown`). Never used to ASSERT support — only to name
 * which probe supersedes which seed bit.
 */
export const DSH_STATIC_CAPABILITY_PROBES: Partial<Record<DshCapabilityKey, DshProbeKey>> = {
  files: 'workspaceFiles',
  terminal: 'terminal',
  status: 'account',
};

// ---------------------------------------------------------------------------
// Failure classification (Codex `classifyCapabilityError` analog)
// ---------------------------------------------------------------------------

const GATED_RE =
  /(credential|unauthori[sz]ed|forbidden|permission|sign[-\s]?in|log[-\s]?in|not[-\s]?enabled|experimental|capabilit(?:y|ies)|feature[-\s]?disabled)/iu;
const UNSUPPORTED_CODE_RE =
  /(unsupported|not[-\s]?supported|not[-\s]?implemented|unavailable|no[-\s]?surface|method[-\s]?not[-\s]?found)/iu;
const UNSUPPORTED_MESSAGE_RE =
  /(not\s+(?:supported|implemented|available)|unsupported|does\s+not\s+support|no\s+such\s+(?:method|endpoint|command|capabilit)|method\s+not\s+found|is\s+not\s+enabled)/iu;

/**
 * Map a thrown probe failure to a capability state.
 *
 * Fail-closed precedence:
 * 1. HTTP 404 → `unknown` (agent-scoped endpoint state, not a capability fact).
 * 2. HTTP 401/403 → `gated`.
 * 3. `MISSING_CREDENTIAL` → `gated`.
 * 4. Business envelope → `gated` when it names an auth/permission/feature gate,
 *    else `unsupported` when it is a definitive structured negative, else
 *    `unknown`.
 * 5. Anything else (network / wire / malformed / non-dsh) → `unknown`.
 *
 * A rejected probe NEVER yields `supported`.
 */
export function classifyDshCapabilityError(error: unknown): DshCapabilityState {
  if (error instanceof DshRpcNotFoundError) return 'unknown';
  if (error instanceof DshRpcUnauthorizedError || error instanceof DshRpcForbiddenError) return 'gated';
  if (error instanceof DshMissingCredentialError) return 'gated';
  if (error instanceof DshRemoteRpcError) {
    if (GATED_RE.test(error.code) || GATED_RE.test(error.message)) return 'gated';
    if (UNSUPPORTED_CODE_RE.test(error.code) || UNSUPPORTED_MESSAGE_RE.test(error.message)) {
      return 'unsupported';
    }
    return 'unknown';
  }
  if (error instanceof DshRpcError) {
    if (error.status === 404) return 'unknown';
    if (error.status === 401 || error.status === 403) return 'gated';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Transport seam: the Todo 5/8 RPC client `call(namespace, method, args)`. */
export type DshCapabilityCall = (
  namespace: string,
  method: string,
  args: Record<string, DshJsonValue>,
) => Promise<DshJsonValue>;

export type DshCapabilityRegistryOptions = {
  call: DshCapabilityCall;
  /** Supplies agent/scope/client context for the activation probe set. */
  resolveContext?: () => DshProbeContext | Promise<DshProbeContext>;
  /** Override the probe set (tests); defaults to {@link DSH_CAPABILITY_PROBES}. */
  probes?: readonly DshCapabilityProbe[];
};

export type DshCapabilitySnapshot = {
  readonly generation: number;
  readonly states: Readonly<Record<DshProbeKey, DshCapabilityState>>;
  readonly surfaces: Readonly<Record<DshUiSurface, boolean>>;
};

function seedProbeStates(): Record<DshProbeKey, DshCapabilityState> {
  return Object.fromEntries(DSH_PROBE_KEYS.map((key) => [key, 'unknown' as DshCapabilityState])) as Record<
    DshProbeKey,
    DshCapabilityState
  >;
}

function computeSurfaces(states: Readonly<Record<DshProbeKey, DshCapabilityState>>): Record<DshUiSurface, boolean> {
  return Object.fromEntries(
    (Object.keys(DSH_SURFACE_DRIVER) as DshUiSurface[]).map((surface) => [
      surface,
      states[DSH_SURFACE_DRIVER[surface]] === 'supported',
    ]),
  ) as Record<DshUiSurface, boolean>;
}

export function createDshCapabilityRegistry(options: DshCapabilityRegistryOptions) {
  const probes = options.probes ?? DSH_CAPABILITY_PROBES;
  const states = shallowRef<Record<DshProbeKey, DshCapabilityState>>(seedProbeStates());
  let generation = 0;

  function setState(key: DshProbeKey, state: DshCapabilityState, requestGeneration = generation) {
    if (requestGeneration !== generation) return;
    states.value = { ...states.value, [key]: state };
  }

  /**
   * Drop every observation for the current connection (reconnect, token
   * rotation, activation refresh). In-flight probes from the previous
   * generation are discarded, and every surface becomes hidden until re-probed.
   */
  function invalidate(_reason?: string) {
    generation += 1;
    states.value = seedProbeStates();
  }

  /**
   * Run one operation under a probe key (Codex `run` precedent). Resolves with
   * the result on success; a thrown error classifies the key and re-throws.
   */
  async function probe<T>(key: DshProbeKey, operation: () => Promise<T>): Promise<T> {
    const requestGeneration = generation;
    try {
      const result = await operation();
      setState(key, 'supported', requestGeneration);
      return result;
    } catch (error) {
      setState(key, classifyDshCapabilityError(error), requestGeneration);
      throw error;
    }
  }

  function markSupported(key: DshProbeKey) {
    setState(key, 'supported');
  }

  function markGated(key: DshProbeKey) {
    setState(key, 'gated');
  }

  function markUnsupported(key: DshProbeKey) {
    setState(key, 'unsupported');
  }

  /** One independent probe; never throws, never reports supported on failure. */
  async function runProbe(probeSpec: DshCapabilityProbe, context: DshProbeContext, requestGeneration: number) {
    const args = probeSpec.buildArgs(context);
    if (args === null) return; // no context → stay unknown, never fabricate
    let value: DshJsonValue;
    try {
      value = await options.call(probeSpec.namespace, probeSpec.method, args);
    } catch (error) {
      setState(probeSpec.key, classifyDshCapabilityError(error), requestGeneration);
      return;
    }
    if (requestGeneration !== generation) return;
    if (!probeSpec.validate(value)) {
      // A malformed success is inconclusive: unknown, never supported.
      setState(probeSpec.key, 'unknown', requestGeneration);
      return;
    }
    setState(probeSpec.key, 'supported', requestGeneration);
  }

  async function resolveContext(): Promise<DshProbeContext> {
    if (!options.resolveContext) return {};
    try {
      return await options.resolveContext();
    } catch {
      return {};
    }
  }

  /**
   * Probe the whole set for the CURRENT generation. Never throws: each probe
   * owns its slot, so one failure cannot fail the registry.
   */
  async function probeAll(context?: DshProbeContext): Promise<DshCapabilitySnapshot> {
    const requestGeneration = generation;
    const resolved = context ?? (await resolveContext());
    await Promise.all(
      probes.map((probeSpec) => runProbe(probeSpec, resolved, requestGeneration)),
    );
    return snapshot();
  }

  /** Activation entry: invalidate the old connection, then probe afresh. */
  async function refresh(context?: DshProbeContext): Promise<DshCapabilitySnapshot> {
    invalidate('refresh');
    return probeAll(context);
  }

  function getState(key: DshProbeKey): DshCapabilityState {
    return states.value[key] ?? 'unknown';
  }

  function getStates(): Readonly<Record<DshProbeKey, DshCapabilityState>> {
    return { ...states.value };
  }

  function getSurfaceState(surface: DshUiSurface): DshCapabilityState {
    return getState(DSH_SURFACE_DRIVER[surface]);
  }

  /** Surface entry-point gate: true ONLY for a probe proven supported this generation. */
  function isSurfaceAvailable(surface: DshUiSurface): boolean {
    return getSurfaceState(surface) === 'supported';
  }

  function snapshot(): DshCapabilitySnapshot {
    const current = { ...states.value };
    return {
      generation,
      states: current,
      surfaces: computeSurfaces(current),
    };
  }

  return {
    states,
    invalidate,
    probe,
    probeAll,
    refresh,
    markSupported,
    markGated,
    markUnsupported,
    getState,
    getStates,
    getSurfaceState,
    isSurfaceAvailable,
    snapshot,
  };
}

export type DshCapabilityRegistry = ReturnType<typeof createDshCapabilityRegistry>;

// ---------------------------------------------------------------------------
// Module-level consumer seam (Todo 33 installs, Todo 34 reads)
// ---------------------------------------------------------------------------

let activeRegistry: DshCapabilityRegistry | null = null;

/** Install (or clear with null) the registry for the active dsh connection. */
export function setActiveDshCapabilityRegistry(registry: DshCapabilityRegistry | null): void {
  activeRegistry = registry;
}

export function getActiveDshCapabilityRegistry(): DshCapabilityRegistry | null {
  return activeRegistry;
}

/** Per-probe states for the active connection; all-`unknown` when none. */
export function getDshCapabilityStates(): Readonly<Record<DshProbeKey, DshCapabilityState>> {
  return activeRegistry ? activeRegistry.getStates() : seedProbeStates();
}

/** Derived UI-gating view for a surface on the active connection. */
export function getDshSurfaceState(surface: DshUiSurface): DshCapabilityState {
  return activeRegistry ? activeRegistry.getSurfaceState(surface) : 'unknown';
}

/** True only when the active connection has proven the surface's driver supported. */
export function isDshSurfaceAvailable(surface: DshUiSurface): boolean {
  return activeRegistry ? activeRegistry.isSurfaceAvailable(surface) : false;
}

/** Full snapshot (states + surfaces + generation) for the active connection. */
export function getDshCapabilitySnapshot(): DshCapabilitySnapshot {
  return activeRegistry
    ? activeRegistry.snapshot()
    : { generation: 0, states: seedProbeStates(), surfaces: computeSurfaces(seedProbeStates()) };
}
