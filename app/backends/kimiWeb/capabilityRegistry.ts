/**
 * Kimi Web runtime capability gating.
 *
 * Two gates, in order (project rule: runtime probing first, never version/docs):
 *
 * 1. **First-level connection gate** — a live `GET /api/v1/meta` (`.capabilities`)
 *    plus `GET /api/v1/auth` (`.models_ready`) probe through the Todo 8 REST client.
 *    Until it succeeds the whole connection is treated as unknown and every action
 *    entry point is hidden. `meta.experimental_flags` is captured for DISPLAY only
 *    and is never consulted by {@link createKimiWebCapabilityRegistry | isAvailable}.
 * 2. **Per-action runtime probe** — actions with no meta flag (`fork`/`compact`/
 *    `undo`/`btw`) stay `unknown` (hidden) until this connection probes them.
 *
 * Fail-closed rules encoded here:
 * - a probe failure of any kind yields `unknown` (or `unsupported`/`gated` when the
 *   server explicitly says so) — never `supported`;
 * - a `200` response whose envelope carries `code !== 0` is a failure, not a success;
 * - a meta document without a `capabilities` object, or an auth body without a boolean
 *   `models_ready`, fails the first-level gate instead of being partially trusted;
 * - {@link createKimiWebCapabilityRegistry | invalidate} bumps a generation so a
 *   stale in-flight observation (token rotation, `event.model_catalog.changed`, new
 *   epoch) can never re-unlock an action.
 *
 * Consumers: Todo 20's StatusMonitorModal reads `firstLevel` / `states` for display,
 * and App.vue action entry points read `isAvailable(action)` to decide visibility.
 */
import { shallowRef } from 'vue';
import { KimiWebError, type KimiWebAuth, type KimiWebClient, type KimiWebMeta } from '../../utils/kimiWeb';

export type KimiWebCapabilityState = 'unknown' | 'supported' | 'unsupported' | 'gated';

/** Actions whose first-level gate is a live `meta.capabilities.<id>` boolean. */
export const KIMI_WEB_META_GATED_ACTIONS = [
  'websocket',
  'file_upload',
  'fs_query',
  'mcp',
  'tasks',
  'terminal',
] as const;

/** Actions with no meta flag: only this connection's runtime probe may unlock them. */
export const KIMI_WEB_PROBE_ONLY_ACTIONS = ['fork', 'compact', 'undo', 'btw'] as const;

export type KimiWebCapabilityAction =
  | (typeof KIMI_WEB_META_GATED_ACTIONS)[number]
  | (typeof KIMI_WEB_PROBE_ONLY_ACTIONS)[number];

export const KIMI_WEB_CAPABILITY_ACTIONS: readonly KimiWebCapabilityAction[] = [
  ...KIMI_WEB_META_GATED_ACTIONS,
  ...KIMI_WEB_PROBE_ONLY_ACTIONS,
];

/** First-level gate snapshot; `probed:false` means unknown → everything hidden. */
export type KimiWebFirstLevelGate = {
  probed: boolean;
  modelsReady: boolean | null;
  capabilities: Record<string, boolean> | null;
  /** DISPLAY ONLY — never a gate. */
  experimentalFlags: Record<string, boolean>;
  features: Array<{ name: string; state: string }>;
  serverVersion: string | null;
};

const UNSUPPORTED_RE =
  /(not\s+(?:implemented|supported|available)|unsupported|unknown\s+(?:action|method|command|endpoint)|does\s+not\s+support|method\s+not\s+found|no\s+such)/iu;
const GATED_RE =
  /(experimental|feature|flag|capabilit(?:y|ies)|permission|forbidden|unauthori[sz]ed|disabled|not\s+enabled|not\s+allowed)/iu;

/**
 * Map a thrown probe failure to a capability state. Only an explicit Kimi Web
 * envelope error can produce `unsupported`/`gated`; every transport/unknown error
 * is `unknown` so callers keep the action hidden.
 */
export function classifyKimiWebCapabilityError(error: unknown): KimiWebCapabilityState {
  if (!(error instanceof KimiWebError)) return 'unknown';
  const text = error.msg;
  if (UNSUPPORTED_RE.test(text)) return 'unsupported';
  if (GATED_RE.test(text)) return 'gated';
  return 'unknown';
}

function emptyGate(): KimiWebFirstLevelGate {
  return {
    probed: false,
    modelsReady: null,
    capabilities: null,
    experimentalFlags: {},
    features: [],
    serverVersion: null,
  };
}

function usableMeta(meta: KimiWebMeta | null | undefined): meta is KimiWebMeta {
  return (
    !!meta &&
    typeof meta === 'object' &&
    !!meta.capabilities &&
    typeof meta.capabilities === 'object' &&
    !Array.isArray(meta.capabilities)
  );
}

function usableAuth(auth: KimiWebAuth | null | undefined): auth is KimiWebAuth {
  return !!auth && typeof auth === 'object' && typeof auth.models_ready === 'boolean';
}

/** A kimi envelope that arrived with HTTP 200 but a non-zero business `code`. */
function failedEnvelope(value: unknown): { code: number; msg: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { code?: unknown; msg?: unknown };
  if (typeof candidate.code !== 'number' || candidate.code === 0) return null;
  return { code: candidate.code, msg: typeof candidate.msg === 'string' ? candidate.msg : '' };
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (typeof flag === 'boolean') out[key] = flag;
  }
  return out;
}

function featureList(value: unknown): Array<{ name: string; state: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is { name: string; state: string } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { state?: unknown }).state === 'string',
    )
    .map((item) => ({ name: item.name, state: item.state }));
}

export type KimiWebCapabilityRegistryOptions = {
  /** Todo 8 client `.getMeta()` (live `/api/v1/meta` through the bridge proxy). */
  getMeta: () => Promise<KimiWebMeta>;
  /** Todo 8 client `.getAuth()` (live `/api/v1/auth` through the bridge proxy). */
  getAuth: () => Promise<KimiWebAuth>;
};

export function createKimiWebCapabilityRegistry(options: KimiWebCapabilityRegistryOptions) {
  const states = shallowRef<Record<string, KimiWebCapabilityState>>(seedUnknown());
  const firstLevel = shallowRef<KimiWebFirstLevelGate>(emptyGate());
  const reProbeRequired = shallowRef(true);
  let generation = 0;

  function seedUnknown() {
    return Object.fromEntries(
      KIMI_WEB_CAPABILITY_ACTIONS.map((action) => [action, 'unknown' as KimiWebCapabilityState]),
    );
  }

  function set(action: string, state: KimiWebCapabilityState, requestGeneration = generation) {
    if (requestGeneration !== generation) return;
    states.value = { ...states.value, [action]: state };
  }

  function failClosed(requestGeneration: number) {
    if (requestGeneration !== generation) return;
    firstLevel.value = emptyGate();
    states.value = seedUnknown();
    reProbeRequired.value = true;
  }

  /**
   * Drop every observation for the current connection (token rotation, a new
   * session epoch, `event.model_catalog.changed`, …). In-flight observations from
   * the previous generation are discarded, and all actions become unknown/hidden
   * until re-probed.
   */
  function invalidate(_reason?: string) {
    generation += 1;
    firstLevel.value = emptyGate();
    states.value = seedUnknown();
    reProbeRequired.value = true;
  }

  /**
   * Run the first-level meta+auth probe. Never throws: a failure (including a
   * `code != 0` envelope from the Todo 8 client) leaves the gate `probed:false`
   * and every action unknown. On success, meta-gated action states are derived
   * from the live flags; probe-only actions are left for {@link probe}.
   */
  async function refreshFirstLevel(): Promise<KimiWebFirstLevelGate> {
    const requestGeneration = generation;
    let meta: KimiWebMeta;
    let auth: KimiWebAuth;
    try {
      [meta, auth] = await Promise.all([options.getMeta(), options.getAuth()]);
    } catch {
      failClosed(requestGeneration);
      return firstLevel.value;
    }
    if (requestGeneration !== generation) return firstLevel.value;
    if (!usableMeta(meta) || !usableAuth(auth)) {
      failClosed(requestGeneration);
      return firstLevel.value;
    }

    const capabilities = booleanRecord(meta.capabilities);
    const gate: KimiWebFirstLevelGate = {
      probed: true,
      modelsReady: auth.models_ready,
      capabilities,
      experimentalFlags: booleanRecord(meta.experimental_flags),
      features: featureList(meta.features),
      serverVersion: typeof meta.server_version === 'string' ? meta.server_version : null,
    };
    firstLevel.value = gate;
    reProbeRequired.value = false;

    const next = { ...states.value };
    for (const action of KIMI_WEB_META_GATED_ACTIONS) {
      next[action] = capabilities[action] === true ? 'supported' : 'unsupported';
    }
    states.value = next;
    return gate;
  }

  /**
   * Runtime-probe one action (Codex `capabilityRegistry.run` precedent). Resolves
   * with the operation result on success; a thrown error OR a `200` envelope with
   * `code != 0` classifies the action and re-throws.
   */
  async function probe<T>(
    action: KimiWebCapabilityAction | string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const requestGeneration = generation;
    try {
      const result = await operation();
      const failure = failedEnvelope(result);
      if (failure) {
        const error = new KimiWebError(failure.code, failure.msg);
        set(action, classifyKimiWebCapabilityError(error), requestGeneration);
        throw error;
      }
      set(action, 'supported', requestGeneration);
      return result;
    } catch (error) {
      set(action, classifyKimiWebCapabilityError(error), requestGeneration);
      throw error;
    }
  }

  function markSupported(action: KimiWebCapabilityAction | string) {
    set(action, 'supported');
  }

  function actionState(action: KimiWebCapabilityAction | string): KimiWebCapabilityState {
    return states.value[action] ?? 'unknown';
  }

  /** True once the live meta+auth probe succeeded AND `models_ready === true`. */
  function isConnectionReady(): boolean {
    return firstLevel.value.probed && firstLevel.value.modelsReady === true;
  }

  /** Action entry-point gate: false for anything not proven supported this generation. */
  function isAvailable(action: KimiWebCapabilityAction | string): boolean {
    return isConnectionReady() && actionState(action) === 'supported';
  }

  return {
    states,
    firstLevel,
    reProbeRequired,
    refreshFirstLevel,
    invalidate,
    probe,
    markSupported,
    actionState,
    isConnectionReady,
    isAvailable,
  };
}

export type KimiWebCapabilityRegistry = ReturnType<typeof createKimiWebCapabilityRegistry>;

export async function probeKimiWebSessionActions(
  registry: KimiWebCapabilityRegistry,
  client: Pick<KimiWebClient, 'forkSession' | 'compactSession' | 'undoSession'>,
): Promise<void> {
  if (!registry.isConnectionReady()) return;
  const missingSessionId = `session_${crypto.randomUUID()}`;
  const check = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      if (error instanceof KimiWebError && error.code === 40401 && /\bsession\b.*\b(?:not found|does not exist)\b/iu.test(error.msg)) return;
      throw error;
    }
  };
  await Promise.allSettled([
    registry.probe('fork', () => check(() => client.forkSession(missingSessionId))),
    registry.probe('compact', () => check(() => client.compactSession(missingSessionId))),
    registry.probe('undo', () => check(() => client.undoSession(missingSessionId, 1))),
  ]);
}
