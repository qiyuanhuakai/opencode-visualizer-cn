// Runtime connection profiles, capability entry and lifecycle feedback (plan task 30 / GAP-5).
//
// This composable is the single frontend owner of the SSH/HPC connection surface. It exists so
// that every control below is entered through ONE capability entry that Browser and Electron
// resolve identically, and so that no control can imply a relay the target does not have.
//
// Boundaries that are load-bearing:
//   * The strict profile parser, the stable target mapping and the secret-payload guard are the
//     REAL ones from `shared/runtime/connectionProfile.js` (task 25). Nothing here re-derives
//     them: a draft is validated by `parseNewConnectionProfile`, which rejects a hidden or
//     secret-bearing field and assigns `enabled: false` (opt-in).
//   * Capability resolution never consults the client kind to CHANGE the outcome. `browser` and
//     `electron` both hold exactly one management entry, so a managed transport is either
//     available to both or to neither; the client kind is recorded for attribution only.
//   * Cancelling a connection is a *tracking* action. It detaches the intents this client was
//     attached to and closes the transport; it never signals the scheduler. A borrowed
//     allocation is never signalled either — `stop` is the only signal path and it is owned-only.
//   * A password / OTP is never cached. The UI holds it only inside a secret box whose every
//     projection redacts, the profile carries a `credentialRef` (a 0600 file path on the bridge,
//     never the value), and the input is cleared the moment the answer is handed over.
import { computed, ref, shallowRef } from 'vue';
import {
  TRANSPORT_KINDS,
  assertNoSecretPayload,
  parseNewConnectionProfile,
  parseConnectionProfile,
  publicConnectionProfile,
  resolveProfileEnvironment,
} from '../../shared/runtime/connectionProfile.js';
import type {
  ConnectionProfile,
  ConnectionProfileDraft,
  ConnectionTarget,
  TransportKind,
} from '../../shared/runtime/connectionProfile.js';

// ---------------------------------------------------------------------------
// Client identity and the ONE capability entry
// ---------------------------------------------------------------------------

/** The two runtimes that render this surface. Both hold one management entry. */
export type RuntimeClientKind = 'browser' | 'electron';
export const RUNTIME_CLIENTS: readonly RuntimeClientKind[] = Object.freeze(['browser', 'electron']);

/**
 * Transport availability as reported by the management target's inspection
 * (`RuntimeInspection.transports`). This is the ONLY input to capability resolution besides
 * whether a managed bridge exists.
 */
export type RuntimeTransportAvailability = Readonly<{
  readonly direct: boolean;
  readonly ssh: boolean;
  readonly slurm: boolean;
}>;

export type RuntimeCapability = 'direct' | 'managed-bridge' | 'ssh' | 'slurm';
export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = Object.freeze([
  'direct',
  'managed-bridge',
  'ssh',
  'slurm',
]);

export type RuntimeCapabilityState = 'supported' | 'unsupported';

export type RuntimeCapabilityRow = Readonly<{
  readonly capability: RuntimeCapability;
  readonly state: RuntimeCapabilityState;
  /** Why the capability is unavailable, or `null` when it is available. */
  readonly reason: string | null;
  /** The environment the capability resolves against, when the target reports one. */
  readonly environmentId: string | null;
}>;

/**
 * Resolve the capability entry.
 *
 * The result is a pure function of `transports` and `managedTransport`. `client` and
 * `environmentId` are carried for attribution only — they can never add or remove a row, which
 * is what makes the Browser and Electron entry the SAME entry rather than two divergent ones.
 *
 * Scope 11: a plain browser with no managed bridge has its managed transport capability
 * unavailable, while `direct` and a pre-built tunnel stay usable. That is expressed as an
 * `unsupported` row with a reason, never as a missing row.
 */
export function resolveRuntimeCapabilityEntry(input: Readonly<{
  client: RuntimeClientKind;
  transports: RuntimeTransportAvailability;
  managedTransport: boolean;
  environmentId?: string | null;
}>): readonly RuntimeCapabilityRow[] {
  const managed = input.managedTransport === true;
  const environmentId = input.environmentId ?? null;
  const row = (capability: RuntimeCapability, state: RuntimeCapabilityState, reason: string | null): RuntimeCapabilityRow =>
    Object.freeze({ capability, state, reason, environmentId });
  return Object.freeze([
    row('direct', input.transports.direct ? 'supported' : 'unsupported',
      input.transports.direct ? null : 'Target does not report a direct transport'),
    row('managed-bridge', managed ? 'supported' : 'unsupported',
      managed ? null : 'No managed bridge: direct and pre-built tunnels only'),
    row('ssh', managed && input.transports.ssh ? 'supported' : 'unsupported',
      managed ? (input.transports.ssh ? null : 'Target does not report an SSH transport') : 'No managed bridge: SSH is unavailable'),
    row('slurm', managed && input.transports.slurm ? 'supported' : 'unsupported',
      managed ? (input.transports.slurm ? null : 'Target does not report a Slurm transport') : 'No managed bridge: Slurm is unavailable'),
  ]);
}

/**
 * Whether this runtime can only reach targets directly.
 *
 * True whenever there is no managed bridge, on EITHER client. The UI renders this as an explicit
 * marker: an absent relay must never be communicated by an absent control.
 */
export function isDirectOnlyRuntime(input: Readonly<{ managedTransport: boolean }>): boolean {
  return input.managedTransport !== true;
}

/** Which runtime is rendering. Electron is detected by the preload bridge, never by a build flag. */
export function detectRuntimeClient(): RuntimeClientKind {
  if (typeof window === 'undefined') return 'browser';
  return window.electronAPI === undefined ? 'browser' : 'electron';
}

/** Human-readable source line for a capability row (which capability, why not). */
export function describeRuntimeCapability(row: RuntimeCapabilityRow): string {
  if (row.state === 'supported') return `${row.capability} is available`;
  return row.reason === null ? `${row.capability} is unavailable` : `${row.capability}: ${row.reason}`;
}

/** The capability rows a target can actually use, in entry order. */
export function supportedRuntimeCapabilities(rows: readonly RuntimeCapabilityRow[]): readonly RuntimeCapabilityRow[] {
  return Object.freeze(rows.filter((row) => row.state === 'supported'));
}

// ---------------------------------------------------------------------------
// Target identity — the stable environment, never a compute node or a job id
// ---------------------------------------------------------------------------

export type RuntimeTargetIdentity = Readonly<{
  readonly environmentId: string;
  readonly targetKind: TransportKind;
}>;

/**
 * The stable environment identity a profile maps to.
 *
 * Scope 3: `environmentId` is the target's persistent UUID; a Slurm profile resolves to the
 * CLUSTER profile's environment UUID and never to a compute hostname or a job id. That is why
 * the compute node is rendered next to the environment rather than instead of it.
 */
export function resolveRuntimeTargetIdentity(profile: Readonly<{ target: ConnectionTarget }>): RuntimeTargetIdentity {
  const environmentId = resolveProfileEnvironment(profile);
  return Object.freeze({ environmentId, targetKind: profile.target.kind });
}

/**
 * Whether two targets are the same stable environment.
 *
 * A compute node is deliberately NOT part of this comparison: two profiles that share a compute
 * node but resolve to different environment UUIDs are different environments, and two profiles
 * on the same environment that move between compute nodes are the same environment.
 */
export function sameRuntimeEnvironment(left: RuntimeTargetIdentity, right: RuntimeTargetIdentity): boolean {
  return left.environmentId === right.environmentId && left.targetKind === right.targetKind;
}

// ---------------------------------------------------------------------------
// Connection status and lifecycle
// ---------------------------------------------------------------------------

export type RuntimeConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed';

export type RuntimeConnectionStatus = Readonly<{
  readonly profileId: string;
  readonly state: RuntimeConnectionState;
  readonly environmentId: string;
  readonly generation: number;
}>;

/** The managed lifecycle fields, kept independent so they never merge into one label. */
export const SLURM_LIFECYCLE_FIELDS: readonly string[] = Object.freeze([
  'state',
  'queue',
  'resource',
  'bridge',
  'transport',
  'terminal',
  'reconcile',
]);

export type SlurmOwnership = 'owned' | 'borrowed';

/**
 * The rendered Slurm lifecycle. Mirrors `SlurmIntentRecord` plus the relay binding's node
 * identity, so the UI renders the same fields the control store owns.
 */
export type SlurmLifecycleStatus = Readonly<{
  readonly environmentId: string;
  readonly intentId: string;
  readonly jobId: string | null;
  readonly state: string;
  readonly queue: string | null;
  readonly terminal: string | null;
  readonly reconcile: string | null;
  readonly attached: boolean;
  readonly ownership: SlurmOwnership;
  readonly computeNode: string | null;
  readonly stepId: string | null;
  readonly epoch: number | null;
  readonly bridgeInstanceId: string | null;
}>;

/**
 * Why a job is not ready yet, or `null` when it is.
 *
 * Every branch is an observable state from the control store or the scheduler query, so a
 * pending row never invents a reason and a terminal row never reads as pending.
 */
export function slurmPendingReason(status: SlurmLifecycleStatus): string | null {
  if (status.terminal !== null) return null;
  if (status.reconcile === 'ambiguous') return 'Ambiguous submit: querying the scheduler by intent UUID, never resubmitting';
  if (status.reconcile === 'unconfirmed') return 'Submit acknowledgement lost: reconciling by scheduler query';
  if (status.state === 'reconciling') return 'Reconciling: matching the live job by intent UUID';
  if (status.queue === 'PENDING' || status.state === 'PENDING') return 'Queued: waiting for the scheduler to allocate resources';
  if (status.queue === 'RUNNING' || status.state === 'RUNNING') return 'Resources running: waiting for the compute bridge hello';
  if (status.bridgeInstanceId === null) return 'Waiting for the compute bridge instance';
  return null;
}

/** Whether a job has reached a terminal state and therefore can no longer be stopped. */
export function isSlurmTerminal(status: SlurmLifecycleStatus): boolean {
  return status.terminal !== null;
}

// ---------------------------------------------------------------------------
// Cancel semantics — detach never cancels, stop is owned-only
// ---------------------------------------------------------------------------

export type ConnectionCancelReceipt = Readonly<{
  readonly profileId: string;
  readonly detached: readonly string[];
  readonly detachedCount: number;
  /** Always 0: cancelling a connection is a tracking action, never a scheduler signal. */
  readonly cancelledJobs: 0;
  readonly nativeHistoryPreserved: true;
  readonly ownedJobsPreserved: true;
}>;

/**
 * Plan a connection cancel.
 *
 * The plan is a pure function so the caller can see, before anything runs, that the only action
 * taken against the scheduler is nothing at all. `cancelledJobs` is the literal `0` — the plan
 * has no branch that can produce a signal, which is what makes the borrowed-job case safe rather
 * than merely tested.
 */
export function planConnectionCancel(input: Readonly<{
  profileId: string;
  intents: readonly SlurmLifecycleStatus[];
}>): ConnectionCancelReceipt {
  const detached = input.intents.filter((intent) => intent.attached).map((intent) => intent.intentId);
  return Object.freeze({
    profileId: input.profileId,
    detached: Object.freeze(detached),
    detachedCount: detached.length,
    cancelledJobs: 0,
    nativeHistoryPreserved: true,
    ownedJobsPreserved: true,
  });
}

/** Why `stop` is refused for an intent, or `null` when it may be signalled. */
export function stopRefusalReason(status: SlurmLifecycleStatus): 'borrowed' | 'terminal' | 'no-job' | null {
  if (status.ownership !== 'owned') return 'borrowed';
  if (isSlurmTerminal(status)) return 'terminal';
  if (status.jobId === null) return 'no-job';
  return null;
}

// ---------------------------------------------------------------------------
// Challenge / trust — a secret is held only inside a redacting box
// ---------------------------------------------------------------------------

export type RuntimeChallengeKind =
  | 'host-key'
  | 'host-key-changed'
  | 'password'
  | 'passphrase'
  | 'otp'
  | 'keyboard-interactive';

export const RUNTIME_CHALLENGE_KINDS: readonly RuntimeChallengeKind[] = Object.freeze([
  'host-key',
  'host-key-changed',
  'password',
  'passphrase',
  'otp',
  'keyboard-interactive',
]);

/** The challenge kinds whose answer carries a secret. */
export const SECRET_CHALLENGE_KINDS: readonly RuntimeChallengeKind[] = Object.freeze([
  'password',
  'passphrase',
  'otp',
  'keyboard-interactive',
]);

export function isSecretChallengeKind(kind: string): kind is RuntimeChallengeKind {
  return (SECRET_CHALLENGE_KINDS as readonly string[]).includes(kind);
}

/** Mirrors the bridge `AuthChallenge` wire shape exactly. */
export type RuntimeChallenge = Readonly<{
  readonly challengeId: string;
  readonly kind: RuntimeChallengeKind;
  readonly prompt: string;
  readonly echo: false;
  readonly redacted: true;
  readonly createdAt: number;
  readonly fingerprint?: string;
  readonly options?: readonly string[];
}>;

/** Mirrors the bridge `SecretBox` contract: consumable once, redacted in every projection. */
export type RuntimeSecretBox = Readonly<{
  readonly label: string;
  readonly size: number;
  consume(): string;
  toString(): string;
  toJSON(): string;
}>;

/**
 * The redaction marker. It MUST byte-match the bridge's `REDACTED`, or a payload redacted on the
 * client and again by the bridge cannot be told apart from a leak; the test asserts equality by
 * importing the bridge constant.
 */
export const REDACTED = '[redacted]';

/**
 * A browser-safe secret box with the bridge's exact redaction contract.
 *
 * The bridge implementation lives in a Node-only module, so the renderer carries its own box and
 * the task-30 test proves both against the same payload. `toString`, `toJSON` and template
 * interpolation all redact; the value is reachable only through `consume()` and only once.
 */
export function createRuntimeSecretBox(secret: string, label = 'secret'): RuntimeSecretBox {
  if (typeof secret !== 'string' || secret.length === 0) throw new TypeError('secret.required');
  let consumed = false;
  return Object.freeze({
    label,
    get size() {
      return secret.length;
    },
    consume() {
      if (consumed) throw new TypeError('secret.consumed');
      consumed = true;
      return secret;
    },
    toString() {
      return REDACTED;
    },
    toJSON() {
      return REDACTED;
    },
  });
}

/**
 * The answer payload the UI hands to the bridge for a challenge.
 *
 * For a secret challenge the answer carries a secret BOX, never the value, so
 * `JSON.stringify(answer)` is safe to log, to put in an error surface and to replay. A trust
 * challenge carries no secret at all. `credentialRef` is always a reference — the bridge
 * resolves it to a 0600 file on its own side.
 */
export type ChallengeAnswer = Readonly<{
  readonly challengeId: string;
  readonly kind: RuntimeChallengeKind;
  readonly accept: boolean;
  readonly persist: boolean;
  readonly secret?: RuntimeSecretBox;
}>;

export function buildChallengeAnswer(
  challenge: RuntimeChallenge,
  answer: Readonly<{ accept: boolean; persist?: boolean; secret?: string }>,
): ChallengeAnswer {
  const base = Object.freeze({
    challengeId: challenge.challengeId,
    kind: challenge.kind,
    accept: answer.accept === true,
    persist: answer.persist === true,
  });
  if (isSecretChallengeKind(challenge.kind) && typeof answer.secret === 'string') {
    return Object.freeze({ ...base, secret: createRuntimeSecretBox(answer.secret, challenge.kind) });
  }
  return base;
}

/** Whether a challenge may be accepted. A changed host key can never be accepted. */
export function isChallengeAcceptable(challenge: RuntimeChallenge): boolean {
  return challenge.kind !== 'host-key-changed';
}

// ---------------------------------------------------------------------------
// Remote bridge update — explicit, never automatic
// ---------------------------------------------------------------------------

export type RemoteBridgeUpdatePlan = Readonly<{
  readonly action: 'connect' | 'install' | 'upgrade';
  readonly location: 'local' | 'wsl' | 'remote' | 'slurm-compute';
  readonly channel: string;
  readonly compatible: boolean;
  readonly connectable: boolean;
  readonly upgradePath: Readonly<{ fromVersion: string | null; requiredProtocol: string }> | null;
  readonly automatic: false;
  readonly requiresExplicitAction: true;
}>;

/** Why `update` is refused, or `null` when the explicit action may run. */
export function updateRefusalReason(plan: RemoteBridgeUpdatePlan | null): 'unsupported' | 'not-explicit' | null {
  if (plan === null) return 'not-explicit';
  if (!plan.compatible) return 'unsupported';
  return null;
}

// ---------------------------------------------------------------------------
// Slurm resource request and preview — real `SlurmResourcePreview` shape
// ---------------------------------------------------------------------------

export type SlurmResourceInput = Readonly<{
  readonly partition: string;
  readonly account?: string | null;
  readonly cpus: number;
  readonly memory: string | number;
  readonly time: string;
  readonly gres: string;
}>;

export type SlurmResourcePreview = Readonly<{
  readonly nodes: number;
  readonly ntasks: number;
  readonly cpus: number;
  readonly memory: string;
  readonly memoryMiB: number;
  readonly time: string;
  readonly timeSeconds: number;
  readonly gres: string;
  readonly requestsGpu: boolean;
  readonly partition: string;
  readonly account: string | null;
}>;

/**
 * Local validation of a resource request.
 *
 * The numbers and the explicit `time`/`gres` fields are checked here so the form can refuse a
 * request before it reaches the bridge; the authoritative preview is produced by the bridge's
 * `buildResourcePreview` through the injected port, because a client-side re-implementation of
 * the resource contract would be a second source of truth.
 */
export function validateSlurmResourceInput(input: SlurmResourceInput): readonly string[] {
  const problems: string[] = [];
  if (typeof input.partition !== 'string' || input.partition.trim().length === 0) problems.push('partition');
  if (!Number.isSafeInteger(input.cpus) || input.cpus < 1) problems.push('cpus');
  const memory = typeof input.memory === 'number' ? input.memory : Number.parseInt(String(input.memory), 10);
  if (!Number.isFinite(memory) || memory < 1) problems.push('memory');
  if (typeof input.time !== 'string' || input.time.trim().length === 0) problems.push('time');
  if (typeof input.gres !== 'string' || input.gres.trim().length === 0) problems.push('gres');
  return Object.freeze(problems);
}

/** The maximum wall-clock the submission preview shows, always explicit (Scope 12). */
export function slurmTimePreview(preview: SlurmResourcePreview): string {
  return preview.timeSeconds > 0 ? preview.time : '';
}

// ---------------------------------------------------------------------------
// Ports — the injected bridge surfaces
// ---------------------------------------------------------------------------

export type DeleteReceipt = Readonly<{
  readonly removed: string | undefined;
  readonly environmentId: string | undefined;
  readonly nativeHistoryPreserved: true;
  readonly ownedJobsPreserved: true;
  readonly cancelledJobs: 0;
  readonly preservedHandles: readonly string[];
}>;

/** The management-side profile surface, i.e. `bridge/bridgeHttpRoutes.js` profile routes. */
export interface RuntimeProfilePort {
  list(): Promise<readonly ConnectionProfile[]>;
  create(input: ConnectionProfileDraft): Promise<ConnectionProfile>;
  update(profileId: string, patch: unknown): Promise<ConnectionProfile | undefined>;
  setEnabled(profileId: string, enabled: boolean): Promise<ConnectionProfile | undefined>;
  remove(profileId: string): Promise<DeleteReceipt>;
  connect(profileId: string): Promise<RuntimeConnectionStatus>;
  disconnect(profileId: string): Promise<RuntimeConnectionStatus>;
  reconnect(profileId: string): Promise<RuntimeConnectionStatus>;
  inspect(): Promise<{ readonly profiles: readonly RuntimeConnectionStatus[] }>;
}

/** The Slurm control surface (the task-28 `SlurmJobController`, reachable only through a bridge role). */
export interface SlurmLifecyclePort {
  preview(resources: unknown): SlurmResourcePreview;
  submit(request: Readonly<{ resources: SlurmResourceInput; ownership?: SlurmOwnership }>): Promise<SlurmLifecycleStatus>;
  detach(intentId: string): Promise<Readonly<{ intentId: string; cancelled: boolean; signalled: boolean }>>;
  stop(intentId: string): Promise<Readonly<{ intentId: string; cancelled: boolean; signalled: boolean; reason?: string }>>;
  state(intentId: string): Promise<SlurmLifecycleStatus | undefined>;
}

/** The remote bridge bootstrap surface (the task-27 plan). Explicit action only. */
export interface RemoteBridgePort {
  plan(): Promise<RemoteBridgeUpdatePlan | null>;
  update(): Promise<RemoteBridgeUpdatePlan | null>;
}

export interface RuntimeProfileClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly token?: string;
}

/**
 * The real HTTP client for the profile routes task 25 landed.
 *
 * Paths, methods and bodies are the ones `bridge/bridgeHttpRoutes.js` serves; the base URL is the
 * management endpoint the UI already holds, so no new origin or credential is introduced.
 */
export function createBridgeProfileClient(options: RuntimeProfileClientOptions): RuntimeProfilePort {
  const fetchImpl: typeof fetch | undefined = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (fetchImpl === undefined) throw new TypeError('runtime.profile.fetch');
  const request: typeof fetch = fetchImpl;
  const base = options.baseUrl.replace(/\/+$/u, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token !== undefined && options.token.length > 0) headers.Authorization = `Bearer ${options.token}`;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await request(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const payload: unknown = text.length === 0 ? null : JSON.parse(text);
    if (!response.ok) {
      const code = (payload as { code?: unknown } | null)?.code;
      throw new TypeError(typeof code === 'string' ? code : `runtime.profile.${response.status}`);
    }
    return payload;
  }

  function profileList(payload: unknown): readonly ConnectionProfile[] {
    const profiles = (payload as { profiles?: unknown } | null)?.profiles;
    return Object.freeze((Array.isArray(profiles) ? profiles : []).map((entry) => parseConnectionProfile(entry)));
  }

  const port: RuntimeProfilePort = {
    async list() {
      return profileList(await call('GET', '/api/v1/profiles'));
    },
    async create(input) {
      return parseConnectionProfile(await call('POST', '/api/v1/profiles', parseNewConnectionProfile(input)));
    },
    async update(profileId, patch) {
      const updated = await call('PATCH', `/api/v1/profiles/${encodeURIComponent(profileId)}`, patch);
      return updated === null || updated === undefined ? undefined : parseConnectionProfile(updated);
    },
    async setEnabled(profileId, enabled) {
      return parseConnectionProfile(
        await call('PUT', `/api/v1/profiles/${encodeURIComponent(profileId)}/enabled`, { enabled }),
      );
    },
    async remove(profileId) {
      return (await call('DELETE', `/api/v1/profiles/${encodeURIComponent(profileId)}`)) as DeleteReceipt;
    },
    async connect(profileId) {
      return (await call('POST', `/api/v1/profiles/${encodeURIComponent(profileId)}/connect`)) as RuntimeConnectionStatus;
    },
    async disconnect(profileId) {
      return (await call('POST', `/api/v1/profiles/${encodeURIComponent(profileId)}/disconnect`)) as RuntimeConnectionStatus;
    },
    async reconnect(profileId) {
      return (await call('POST', `/api/v1/profiles/${encodeURIComponent(profileId)}/reconnect`)) as RuntimeConnectionStatus;
    },
    async inspect() {
      // The bridge serves NO lifecycle-inspection route: `PROFILE_ACTION` matches only
      // connect|disconnect|reconnect|enabled, and `GET /api/v1/profiles` answers with a profile
      // LIST whose entries carry neither `state` nor `generation`. So this reports NO statuses
      // instead of asserting that list into a status array — a fabricated status would drive a
      // status chip for a connection nobody observed. A real status route is read HERE, nowhere else.
      return Object.freeze({ profiles: Object.freeze([] as readonly RuntimeConnectionStatus[]) });
    },
  };
  return Object.freeze(port);
}

// ---------------------------------------------------------------------------
// The composable
// ---------------------------------------------------------------------------

export type UseRuntimeProfilesOptions = Readonly<{
  profiles?: readonly ConnectionProfile[];
  client?: RuntimeClientKind;
  transports?: RuntimeTransportAvailability;
  managedTransport?: boolean;
  profilePort?: RuntimeProfilePort;
  slurmPort?: SlurmLifecyclePort | null;
  remoteBridgePort?: RemoteBridgePort | null;
}>;

const DEFAULT_TRANSPORTS: RuntimeTransportAvailability = Object.freeze({ direct: true, ssh: false, slurm: false });

export function useRuntimeProfiles(options: UseRuntimeProfilesOptions = {}) {
  const client = ref<RuntimeClientKind>(options.client ?? detectRuntimeClient());
  const transports = ref<RuntimeTransportAvailability>(options.transports ?? DEFAULT_TRANSPORTS);
  const managedTransport = ref<boolean>(options.managedTransport === true);
  const profiles = shallowRef<readonly ConnectionProfile[]>(Object.freeze([...(options.profiles ?? [])]));
  const selectedProfileId = ref('');
  /**
   * The Slurm intent currently in focus.
   *
   * A profile UUID and the intent UUID a submission produces are DIFFERENT identities — one names
   * a configured target, the other one run against it — so they are tracked separately and a
   * lookup never matches one against the other.
   */
  const selectedIntentId = ref('');
  /** profileId → the intent that profile submitted, recorded when the submission lands. */
  const submittedIntents = new Map<string, string>();
  const statuses = shallowRef<readonly RuntimeConnectionStatus[]>(Object.freeze([]));
  const slurmStatuses = shallowRef<readonly SlurmLifecycleStatus[]>(Object.freeze([]));
  const challenge = ref<RuntimeChallenge | null>(null);
  const remotePlan = ref<RemoteBridgeUpdatePlan | null>(null);
  const error = ref('');
  const busy = ref(false);

  const profilePort = options.profilePort;
  const slurmPort = options.slurmPort ?? null;
  const remoteBridgePort = options.remoteBridgePort ?? null;

  const selectedProfile = computed<ConnectionProfile | null>(
    () => profiles.value.find((profile) => profile.profileId === selectedProfileId.value) ?? null,
  );
  const selectedIdentity = computed<RuntimeTargetIdentity | null>(() =>
    selectedProfile.value === null ? null : resolveRuntimeTargetIdentity(selectedProfile.value));

  const capabilityEntry = computed<readonly RuntimeCapabilityRow[]>(() =>
    resolveRuntimeCapabilityEntry({
      client: client.value,
      transports: transports.value,
      managedTransport: managedTransport.value,
      environmentId: selectedIdentity.value?.environmentId ?? null,
    }));

  const directOnly = computed<boolean>(() => isDirectOnlyRuntime({ managedTransport: managedTransport.value }));

  const statusOf = computed<RuntimeConnectionStatus | null>(() =>
    statuses.value.find((entry) => entry.profileId === selectedProfileId.value) ?? null);

  /**
   * The newest lifecycle request issued per profile.
   *
   * Ordering is tracked by REQUEST, never by the `generation` the port reports: the real
   * `connectionManager.disconnect` deletes the record and answers with generation 0 while a connect
   * answers with a monotonically increasing one, so comparing the two would discard a legitimate
   * disconnect as "older" than the connect it superseded.
   */
  const newestStatusRequest = new Map<string, number>();
  let statusRequestSequence = 0;

  function beginStatusRequest(profileId: string): number {
    statusRequestSequence += 1;
    newestStatusRequest.set(profileId, statusRequestSequence);
    return statusRequestSequence;
  }

  function recordStatus(profileId: string, request: number, next: RuntimeConnectionStatus) {
    if (newestStatusRequest.get(profileId) !== request) return;
    statuses.value = Object.freeze([...statuses.value.filter((entry) => entry.profileId !== profileId), next]);
  }

  const attachedSlurm = computed<readonly SlurmLifecycleStatus[]>(() =>
    Object.freeze(slurmStatuses.value.filter((entry) => entry.attached)));

  const cancelPlan = computed<ConnectionCancelReceipt>(() =>
    planConnectionCancel({ profileId: selectedProfileId.value, intents: attachedSlurm.value }));

  const selectedSlurm = computed<SlurmLifecycleStatus | null>(() => {
    const intentId = selectedIntentId.value;
    return intentId === '' ? null : slurmStatuses.value.find((entry) => entry.intentId === intentId) ?? null;
  });

  function selectProfile(profileId: string) {
    selectedProfileId.value = profileId;
    // Selecting a profile brings back the intent it submitted, and only that one. Two profiles in
    // the same environment must not share a job, so the intent is never resolved by environment.
    selectedIntentId.value = profileId === '' ? '' : (submittedIntents.get(profileId) ?? '');
  }

  /** Focus one intent explicitly. The caller passes an INTENT id, never a profile id. */
  function selectIntent(intentId: string) {
    selectedIntentId.value = intentId;
  }

  function fail(message: string) {
    error.value = message;
    return null;
  }

  async function refresh() {
    if (profilePort === undefined) return;
    busy.value = true;
    error.value = '';
    try {
      profiles.value = Object.freeze([...(await profilePort.list())]);
      statuses.value = Object.freeze([...(await profilePort.inspect()).profiles]);
      if (remoteBridgePort !== null) remotePlan.value = await remoteBridgePort.plan();
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : 'runtime.profile.refresh');
    } finally {
      busy.value = false;
    }
  }

  async function createProfile(draft: ConnectionProfileDraft) {
    if (profilePort === undefined) return fail('runtime.profile.unavailable');
    busy.value = true;
    error.value = '';
    try {
      // The REAL parser runs first: it rejects a secret-bearing or hidden field, requires the
      // target kind to match the transport kind, and defaults `enabled` to false.
      const validated = parseNewConnectionProfile(draft);
      const created = await profilePort.create(validated);
      profiles.value = Object.freeze([...profiles.value, created]);
      selectedProfileId.value = created.profileId;
      return created;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'runtime.profile.create');
    } finally {
      busy.value = false;
    }
  }

  async function setEnabled(profileId: string, enabled: boolean) {
    if (profilePort === undefined) return fail('runtime.profile.unavailable');
    busy.value = true;
    error.value = '';
    try {
      const updated = await profilePort.setEnabled(profileId, enabled);
      if (updated === undefined) return fail('runtime.profile.missing');
      profiles.value = Object.freeze(profiles.value.map((entry) => (entry.profileId === profileId ? updated : entry)));
      return updated;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'runtime.profile.enable');
    } finally {
      busy.value = false;
    }
  }

  async function connect(profileId: string) {
    if (profilePort === undefined) return fail('runtime.profile.unavailable');
    const request = beginStatusRequest(profileId);
    busy.value = true;
    error.value = '';
    try {
      const status = await profilePort.connect(profileId);
      recordStatus(profileId, request, status);
      return status;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'runtime.profile.connect');
    } finally {
      busy.value = false;
    }
  }

  /**
   * Cancel a connection.
   *
   * Detaches every intent this client was attached to and closes the transport. The scheduler is
   * never signalled — including for an owned job, because a disconnect is not a stop request —
   * and a borrowed allocation is never touched. The receipt reports the observed `cancelledJobs`
   * count, which is `0` by construction of `planConnectionCancel`.
   */
  async function cancelConnection(profileId: string): Promise<ConnectionCancelReceipt | null> {
    const plan = planConnectionCancel({
      profileId,
      intents: slurmStatuses.value.filter((entry) => entry.environmentId === (selectedIdentity.value?.environmentId ?? '')),
    });
    const request = beginStatusRequest(profileId);
    busy.value = true;
    error.value = '';
    try {
      const detached: string[] = [];
      for (const intentId of plan.detached) {
        if (slurmPort !== null) await slurmPort.detach(intentId);
        detached.push(intentId);
      }
      slurmStatuses.value = Object.freeze(slurmStatuses.value.map((entry) => (
        detached.includes(entry.intentId) ? Object.freeze({ ...entry, attached: false }) : entry
      )));
      if (profilePort !== undefined) {
        const status = await profilePort.disconnect(profileId);
        recordStatus(profileId, request, status);
      }
      return Object.freeze({ ...plan, detached: Object.freeze(detached) });
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : 'runtime.profile.disconnect');
      return null;
    } finally {
      busy.value = false;
    }
  }

  async function reconnect(profileId: string) {
    if (profilePort === undefined) return fail('runtime.profile.unavailable');
    const request = beginStatusRequest(profileId);
    busy.value = true;
    error.value = '';
    try {
      const status = await profilePort.reconnect(profileId);
      recordStatus(profileId, request, status);
      return status;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'runtime.profile.reconnect');
    } finally {
      busy.value = false;
    }
  }

  async function submitSlurm(request: Readonly<{ resources: SlurmResourceInput; ownership?: SlurmOwnership }>) {
    if (slurmPort === null) return fail('runtime.slurm.unavailable');
    const problems = validateSlurmResourceInput(request.resources);
    if (problems.length > 0) return fail(`runtime.slurm.resource:${problems.join(',')}`);
    busy.value = true;
    error.value = '';
    try {
      const status = await slurmPort.submit(request);
      // The submission is recorded against the profile it was made for. Without this association
      // the resulting intent — whose UUID differs from the profile's — could not be resolved back.
      if (selectedProfileId.value !== '') submittedIntents.set(selectedProfileId.value, status.intentId);
      selectedIntentId.value = status.intentId;
      slurmStatuses.value = Object.freeze([...slurmStatuses.value.filter((entry) => entry.intentId !== status.intentId), status]);
      return status;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'runtime.slurm.submit');
    } finally {
      busy.value = false;
    }
  }

  async function detachSlurm(intentId: string) {
    if (slurmPort === null) return fail('runtime.slurm.unavailable');
    busy.value = true;
    error.value = '';
    try {
      const receipt = await slurmPort.detach(intentId);
      slurmStatuses.value = Object.freeze(slurmStatuses.value.map((entry) => (
        entry.intentId === intentId ? Object.freeze({ ...entry, attached: false }) : entry
      )));
      return receipt;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'runtime.slurm.detach');
    } finally {
      busy.value = false;
    }
  }

  async function stopSlurm(intentId: string) {
    if (slurmPort === null) return fail('runtime.slurm.unavailable');
    const target = slurmStatuses.value.find((entry) => entry.intentId === intentId);
    if (target === undefined) return fail('runtime.slurm.missing');
    const refusal = stopRefusalReason(target);
    if (refusal !== null) return fail(`runtime.slurm.stop.${refusal}`);
    busy.value = true;
    error.value = '';
    try {
      const receipt = await slurmPort.stop(intentId);
      slurmStatuses.value = Object.freeze(slurmStatuses.value.map((entry) => (
        entry.intentId === intentId ? Object.freeze({ ...entry, attached: false, terminal: 'CANCELLED', queue: 'CANCELLED' }) : entry
      )));
      return receipt;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'runtime.slurm.stop');
    } finally {
      busy.value = false;
    }
  }

  async function previewSlurm(resources: SlurmResourceInput): Promise<SlurmResourcePreview | null> {
    if (slurmPort === null) return null;
    return slurmPort.preview(resources);
  }

  async function updateRemoteBridge() {
    if (remoteBridgePort === null) return fail('runtime.bridge.update.unavailable');
    const refusal = updateRefusalReason(remotePlan.value);
    if (refusal !== null) return fail(`runtime.bridge.update.${refusal}`);
    busy.value = true;
    error.value = '';
    try {
      remotePlan.value = await remoteBridgePort.update();
      return remotePlan.value;
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'runtime.bridge.update');
    } finally {
      busy.value = false;
    }
  }

  /** Present a challenge. The UI keeps only the challenge metadata — never an answer. */
  function presentChallenge(next: RuntimeChallenge | null) {
    challenge.value = next;
  }

  function dismissChallenge() {
    challenge.value = null;
  }

  return Object.freeze({
    client,
    transports,
    managedTransport,
    profiles,
    statuses,
    slurmStatuses,
    challenge,
    remotePlan,
    error,
    busy,
    selectedProfile,
    selectedProfileId,
    selectedIntentId,
    selectedIdentity,
    selectedSlurm,
    capabilityEntry,
    directOnly,
    statusOf,
    attachedSlurm,
    cancelPlan,
    selectProfile,
    selectIntent,
    refresh,
    createProfile,
    setEnabled,
    connect,
    cancelConnection,
    reconnect,
    submitSlurm,
    detachSlurm,
    stopSlurm,
    previewSlurm,
    updateRemoteBridge,
    presentChallenge,
    dismissChallenge,
  });
}

export type RuntimeProfiles = ReturnType<typeof useRuntimeProfiles>;

/** Re-exported so a caller can build a draft through the real strict parser. */
export { TRANSPORT_KINDS, assertNoSecretPayload, parseNewConnectionProfile, publicConnectionProfile };
