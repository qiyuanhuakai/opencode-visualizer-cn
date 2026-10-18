// Task 30 registered QA browser entry — the real SSH / HPC connection surface, mounted for real.
//
// Loaded by scripts/qa/runtime-v090-cases/task-30.mjs from a runner-served page and driven by a
// real headless Chromium. The REAL landed code executes here:
//   * app/components/runtime/ConnectionManager.vue — the ONE capability entry, the visible
//     direct-only marker, the profile picker, the challenge/trust panel and the lifecycle actions;
//   * app/components/runtime/{ConnectionStatus,RemoteBridgeActions,SshHostForm,SlurmExecutionForm}.vue;
//   * app/composables/useRuntimeProfiles.ts — the capability resolver, the strict-profile guard,
//     the cancel plan, the challenge answer builder and the Slurm submit/detach/stop lifecycle;
//   * shared/runtime/connectionProfile.js — the REAL strict parser / target mapping;
//   * app/utils/{regionTheme,themeTokens}.ts — the REAL imported-theme token pipeline, so the
//     light and dark presets resolve through the same code the product uses.
//
// The only controlled boundaries are:
//   * the management profile port, the Slurm lifecycle port and the remote-bridge port are
//     INJECTED case-owned fakes (task 30's implementation acknowledges the Slurm lifecycle port has
//     no HTTP/WS route yet — only the CLI control-store/relay roles reach the real controller, so
//     this case must inject it too and does NOT claim a wired route);
//   * @iconify/vue is aliased to a case-owned stub so the surface stays hermetic (icons are
//     decorative; every assertion reads data-testid / data-* attributes, never an icon).
//
// This entry never contacts a live SSH host and never contacts a scheduler, and it authors no PASS
// verdict — task 46 owns the live end-to-end verification.
import { Buffer as NodeBuffer } from 'buffer';
import { createApp, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

import ConnectionManager from '../../components/runtime/ConnectionManager.vue';
import type { ConnectionProfile, ConnectionProfileDraft } from '../../../shared/runtime/connectionProfile.js';
import { parseConnectionProfile, resolveProfileEnvironment } from '../../../shared/runtime/connectionProfile.js';
import { ANIME_NIGHT_PRESET, SOFT_WHITE_PRESET } from '../../utils/regionTheme';
import {
  SEMANTIC_THEME_TOKENS,
  THEME_ROOT_ATTRIBUTE,
  createSemanticTokenSnapshot,
  extractSemanticTokenOverrides,
  regionThemeToStorage,
  semanticTokenCssVariable,
} from '../../utils/themeTokens';
import type {
  RemoteBridgeUpdatePlan,
  RuntimeCapabilityRow,
  RuntimeClientKind,
  RuntimeConnectionStatus,
  RuntimeTransportAvailability,
  SlurmLifecycleStatus,
  SlurmOwnership,
  SlurmResourceInput,
  SlurmResourcePreview,
} from '../../composables/useRuntimeProfiles';
import {
  buildChallengeAnswer,
  useRuntimeProfiles,
} from '../../composables/useRuntimeProfiles';

type AnyRecord = Record<string, any>;

(globalThis as AnyRecord).Buffer = (globalThis as AnyRecord).Buffer ?? NodeBuffer;

const CLUSTER_ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const COMPUTE_NODE = 'compute-01.cluster';
const SECRET = '(this-is-the-challenge-secret-NEVER-PERSISTED)';

// ── observation channels ────────────────────────────────────────────────────────────────────
const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => {
  errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`);
});

const consoleEntries: Array<{ level: string; text: string }> = [];
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { consoleEntries.push({ level, text: args.map(safeString).join(' ') }); } catch { /* capture never throws */ }
    original(...args);
  };
}

const domHost = document.createElement('pre');
domHost.id = 'qa30-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

const occurrences = (haystack: string, needle: string): number => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);

// ── injected ports (case-owned fakes; every real product call is still made through them) ──────
const portCalls = {
  profileList: 0, profileCreate: 0, profileSetEnabled: 0, profileConnect: 0,
  profileDisconnect: 0, profileReconnect: 0, profileInspect: 0,
  slurmPreview: 0, slurmSubmit: 0, slurmDetach: 0, slurmStop: 0, slurmState: 0,
  remotePlan: 0, remoteUpdate: 0,
};
const callLog: Array<{ at: number; op: string; detail?: string }> = [];
const note = (op: string, detail?: string) => { callLog.push({ at: Date.now(), op, detail }); };

const seededProfiles: ConnectionProfile[] = [];
let profileSequence = 0;
const PROFILE_PREFIX = '30000000-0000-4000-8000-';

const profilePort = {
  async list() { portCalls.profileList += 1; note('profile.list'); return Object.freeze([...seededProfiles]); },
  async create(input: ConnectionProfileDraft) {
    portCalls.profileCreate += 1;
    profileSequence += 1;
    const created = parseConnectionProfile({ profileId: `${PROFILE_PREFIX}${String(profileSequence).padStart(12, '0')}`, ...input });
    seededProfiles.push(created);
    note('profile.create', created.profileId);
    return created;
  },
  async update() { note('profile.update'); return undefined; },
  async setEnabled(profileId: string, enabled: boolean) {
    portCalls.profileSetEnabled += 1;
    const index = seededProfiles.findIndex((entry) => entry.profileId === profileId);
    if (index < 0) return undefined;
    const updated = parseConnectionProfile({ ...seededProfiles[index], enabled });
    seededProfiles[index] = updated;
    note('profile.setEnabled', `${profileId}:${enabled}`);
    return updated;
  },
  async remove(profileId: string) {
    note('profile.remove', profileId);
    return Object.freeze({ removed: profileId, environmentId: CLUSTER_ENVIRONMENT, nativeHistoryPreserved: true as const, ownedJobsPreserved: true as const, cancelledJobs: 0 as const, preservedHandles: Object.freeze([]) });
  },
  async connect(profileId: string) {
    portCalls.profileConnect += 1;
    profileGenerations.set(profileId, (profileGenerations.get(profileId) ?? 0) + 1);
    note('profile.connect', profileId);
    return Object.freeze({ profileId, state: 'connected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: profileGenerations.get(profileId) ?? 1 });
  },
  async disconnect(profileId: string) {
    portCalls.profileDisconnect += 1;
    note('profile.disconnect', profileId);
    return Object.freeze({ profileId, state: 'disconnected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: profileGenerations.get(profileId) ?? 1 });
  },
  async reconnect(profileId: string) {
    portCalls.profileReconnect += 1;
    profileGenerations.set(profileId, (profileGenerations.get(profileId) ?? 0) + 1);
    note('profile.reconnect', profileId);
    return Object.freeze({ profileId, state: 'connected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: profileGenerations.get(profileId) ?? 1 });
  },
  async inspect() { portCalls.profileInspect += 1; note('profile.inspect'); return Object.freeze({ profiles: Object.freeze([]) }); },
};
const profileGenerations = new Map<string, number>();

const slurmIntents = new Map<string, SlurmLifecycleStatus>();

function buildPreview(resources: Partial<SlurmResourceInput>): SlurmResourcePreview {
  const memory = typeof resources.memory === 'number' ? resources.memory : Number.parseInt(String(resources.memory ?? '4096'), 10);
  const gres = typeof resources.gres === 'string' && resources.gres.length > 0 ? resources.gres : 'none';
  const time = typeof resources.time === 'string' && resources.time.length > 0 ? resources.time : '00:00:00';
  const [hours = '0', minutes = '0', seconds = '0'] = time.split(':');
  return Object.freeze({
    nodes: 1,
    ntasks: 1,
    cpus: Number(resources.cpus ?? 1),
    memory: `${memory}M`,
    memoryMiB: memory,
    time,
    timeSeconds: Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds),
    gres,
    requestsGpu: gres !== 'none',
    partition: String(resources.partition ?? 'cpu'),
    account: resources.account == null ? null : String(resources.account),
  });
}

const slurmPort = {
  preview(resources: SlurmResourceInput) { portCalls.slurmPreview += 1; note('slurm.preview'); return buildPreview(resources); },
  async submit(request: Readonly<{ resources: SlurmResourceInput; ownership?: SlurmOwnership }>) {
    portCalls.slurmSubmit += 1;
    const intentId = `${PROFILE_PREFIX}${String(900 + (slurmIntents.size + 1)).padStart(12, '0')}`;
    const status: SlurmLifecycleStatus = Object.freeze({
      environmentId: CLUSTER_ENVIRONMENT,
      intentId,
      jobId: String(24680 + slurmIntents.size),
      state: 'PENDING',
      queue: 'PENDING',
      terminal: null,
      reconcile: null,
      attached: true,
      ownership: request.ownership ?? 'owned',
      computeNode: null,
      stepId: null,
      epoch: null,
      bridgeInstanceId: null,
    });
    slurmIntents.set(intentId, status);
    note('slurm.submit', intentId);
    return status;
  },
  async detach(intentId: string) {
    portCalls.slurmDetach += 1;
    note('slurm.detach', intentId);
    return Object.freeze({ intentId, cancelled: false, signalled: false });
  },
  async stop(intentId: string) {
    portCalls.slurmStop += 1;
    note('slurm.stop', intentId);
    return Object.freeze({ intentId, cancelled: true, signalled: true });
  },
  async state(intentId: string) { portCalls.slurmState += 1; note('slurm.state', intentId); return slurmIntents.get(intentId); },
};

let remotePlanValue: RemoteBridgeUpdatePlan | null = Object.freeze({
  action: 'connect', location: 'remote', channel: 'transport',
  compatible: true, connectable: true, upgradePath: null,
  automatic: false, requiresExplicitAction: true,
});
const remoteBridgePort = {
  async plan() { portCalls.remotePlan += 1; note('remote.plan'); return remotePlanValue; },
  async update() { portCalls.remoteUpdate += 1; note('remote.update'); remotePlanValue = Object.freeze({ ...(remotePlanValue as RemoteBridgeUpdatePlan), action: 'upgrade', upgradePath: Object.freeze({ fromVersion: '0.8.0', requiredProtocol: 'v090-runtime' }) }); return remotePlanValue; },
};

// ── reactive host state fed to the surfaces ────────────────────────────────────────────────────
const probeEnvironmentId = ref('');
const preview = ref<SlurmResourcePreview | null>(null);
let autoPreview = true;
let runtime: ReturnType<typeof useRuntimeProfiles> | null = null;
let lastChallengeAnswer: AnyRecord | null = null;
let consumedSecret: string | null = null;

const app = createApp({
  setup() {
    runtime = useRuntimeProfiles({
      client: 'browser' as RuntimeClientKind,
      transports: Object.freeze({ direct: true, ssh: true, slurm: true }) as RuntimeTransportAvailability,
      managedTransport: true,
      profilePort,
      slurmPort,
      remoteBridgePort,
    });
    const rt = runtime;

    const selectedIntentId = (): string => rt.selectedIntentId.value;

    function onChallengeAnswer(answer: Readonly<{ challengeId: string; accept: boolean; secret?: string }>) {
      const current = rt.challenge.value;
      if (current === null) return;
      // The REAL answer builder: a secret becomes a redacting box, never the value.
      lastChallengeAnswer = buildChallengeAnswer(current, { accept: answer.accept, secret: answer.secret }) as unknown as AnyRecord;
      consumedSecret = typeof answer.secret === 'string' ? answer.secret : null;
      note('challenge.answer', `${current.kind}:${answer.accept ? 'accept' : 'decline'}`);
      rt.dismissChallenge();
    }

    return () => h(ConnectionManager as never, {
      open: true,
      client: rt.client.value,
      profiles: rt.profiles.value,
      capabilityEntry: rt.capabilityEntry.value,
      managedTransport: rt.managedTransport.value,
      selectedProfileId: rt.selectedProfileId.value,
      identity: rt.selectedIdentity.value,
      status: rt.statusOf.value,
      slurm: rt.selectedSlurm.value,
      challenge: rt.challenge.value,
      plan: rt.remotePlan.value,
      preview: preview.value,
      probedEnvironmentId: probeEnvironmentId.value,
      busy: rt.busy.value,
      error: rt.error.value,
      onClose: () => {},
      onSelect: (profileId: string) => rt.selectProfile(profileId),
      onConnect: () => { void rt.connect(rt.selectedProfileId.value); },
      onCancel: () => { void rt.cancelConnection(rt.selectedProfileId.value); },
      onDetach: () => { void rt.detachSlurm(selectedIntentId()); },
      onStop: () => { void rt.stopSlurm(selectedIntentId()); },
      onReconnect: () => { void rt.reconnect(rt.selectedProfileId.value); },
      onUpdate: () => { void rt.updateRemoteBridge(); },
      onSaveSsh: (draft: unknown) => { void rt.createProfile(draft as ConnectionProfileDraft); },
      onSubmitSlurm: (request: unknown) => { void rt.submitSlurm(request as Readonly<{ resources: SlurmResourceInput; ownership?: SlurmOwnership }>); },
      // Every resource edit is answered with a preview produced by the injected port for THAT
      // draft, so the displayed preview is the request the form will submit.
      onPreviewRequest: (draft: Readonly<{ resources: SlurmResourceInput }>) => {
        if (!autoPreview) return;
        void rt.previewSlurm(draft.resources).then((produced) => {
          if (produced !== null) preview.value = produced;
        });
      },
      onChallengeAnswer,
    });
  },
}); 
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });
app.use(i18n);
app.mount('#app');

// ── UI-driver helpers (all reads happen against the REAL rendered DOM) ────────────────────────
function element(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}
async function click(testId: string): Promise<boolean> {
  const target = element(testId) as HTMLButtonElement | null;
  if (target === null) return false;
  target.click();
  await nextTick(); await nextTick();
  return true;
}
async function setInput(testId: string, value: string): Promise<boolean> {
  const input = element(testId) as HTMLInputElement | null;
  if (input === null) return false;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await nextTick();
  return true;
}
function rgbOf(hex: string | undefined): string | null {
  if (typeof hex !== 'string') return null;
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (match === null) return null;
  const value = Number.parseInt(match[1], 16);
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`;
}

const api: AnyRecord = {
  ready: true,
  constants: { CLUSTER_ENVIRONMENT, COMPUTE_NODE, SECRET },
  errors: () => errors,
  consoleEntries: () => consoleEntries.map((entry) => ({ ...entry })),
  callLog: () => callLog.map((entry) => ({ ...entry })),
  portCalls: () => ({ ...portCalls }),
  domText: () => `${document.body.innerText}\n${domHost.textContent ?? ''}`,
  domSnapshot: () => ({
    text: document.body.innerText,
    inputValues: [...document.querySelectorAll('input')].map((input) => input.value),
    taskIds: [...document.querySelectorAll('[data-testid]')].map((node) => node.getAttribute('data-testid')),
  }),
  storageSnapshot: () => {
    const serialize = (storage: Storage): string => {
      const parts: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? '';
        parts.push(`${key}=${storage.getItem(key) ?? ''}`);
      }
      return parts.join('\n');
    };
    return { local: serialize(window.localStorage), session: serialize(window.sessionStorage) };
  },

  configure(input: AnyRecord) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    if (input.client !== undefined) rt.client.value = input.client;
    if (input.transports !== undefined) rt.transports.value = Object.freeze({ direct: input.transports.direct === true, ssh: input.transports.ssh === true, slurm: input.transports.slurm === true });
    if (input.managedTransport !== undefined) rt.managedTransport.value = input.managedTransport === true;
    return { capabilityEntry: rt.capabilityEntry.value.map((row) => `${row.capability}:${row.state}`), directOnly: rt.directOnly.value };
  },

  resolveEntry(input: { client: RuntimeClientKind; transports: AnyRecord; managedTransport: boolean }) {
    // Uses the composable's own resolution path so browser and electron are compared on the real code.
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    const previous = { client: rt.client.value, transports: rt.transports.value, managed: rt.managedTransport.value };
    rt.client.value = input.client;
    rt.transports.value = Object.freeze({ direct: input.transports.direct === true, ssh: input.transports.ssh === true, slurm: input.transports.slurm === true });
    rt.managedTransport.value = input.managedTransport;
    const rows: readonly RuntimeCapabilityRow[] = [...rt.capabilityEntry.value];
    rt.client.value = previous.client; rt.transports.value = previous.transports; rt.managedTransport.value = previous.managed;
    return rows.map((row) => ({ capability: row.capability, state: row.state, reason: row.reason }));
  },

  seedProfiles(profiles: AnyRecord[]) {
    const parsed = profiles.map((entry) => parseConnectionProfile(entry));
    seededProfiles.splice(0, seededProfiles.length, ...parsed);
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    rt.profiles.value = Object.freeze([...parsed]);
    rt.selectProfile(parsed[0]?.profileId ?? '');
    return { count: parsed.length, selected: rt.selectedProfileId.value };
  },

  // ── profile selection through the REAL picker ──
  // Drives the real profile-picker button (a genuine UI click → the manager's `select` event →
  // `useRuntimeProfiles.selectProfile`), so a selection change is proven through the product
  // surface rather than by poking the composable ref directly. Falls back to the composable's own
  // `selectProfile` only if the row is not rendered, and reports which path ran.
  selectProfile(profileId: string) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    const rows = [...document.querySelectorAll('[data-testid="connection-profile-row"]')] as HTMLElement[];
    const row = rows.find((node) => node.getAttribute('data-profile-id') === profileId) ?? null;
    if (row !== null) row.click();
    else rt.selectProfile(profileId);
    return {
      clicked: row !== null,
      requested: profileId,
      selectedProfileId: rt.selectedProfileId.value,
      environmentId: rt.selectedIdentity.value?.environmentId ?? null,
      targetKind: rt.selectedIdentity.value?.targetKind ?? null,
    };
  },

  setProbeEnvironment(value: string) { probeEnvironmentId.value = value; return probeEnvironmentId.value; },

  setPreview(value: SlurmResourcePreview | null) { preview.value = value; return preview.value; },

  /**
   * When disabled, a `preview-request` from the form is NOT answered, so the displayed preview is
   * left describing an older request. The form must refuse to submit in that state.
   */
  setAutoPreview(enabled: boolean) { autoPreview = enabled; return autoPreview; },

  previewViaPort(resources: AnyRecord) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    return rt.previewSlurm(resources as SlurmResourceInput);
  },

  setSlurm(status: AnyRecord | null) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    if (status === null) { rt.slurmStatuses.value = Object.freeze([]); rt.selectIntent(''); return null; }
    const frozen = Object.freeze({ ...status }) as SlurmLifecycleStatus;
    rt.slurmStatuses.value = Object.freeze([frozen]);
    slurmIntents.set(frozen.intentId, frozen);
    // The injected status stands in for a real submission, so it is bound to the intent the same
    // way `submitSlurm` binds one. The intent id is NOT the profile id.
    rt.selectIntent(frozen.intentId);
    return frozen;
  },

  setSlurmStatuses(statuses: AnyRecord[]) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    const frozen = Object.freeze(statuses.map((entry) => Object.freeze({ ...entry }))) as readonly SlurmLifecycleStatus[];
    rt.slurmStatuses.value = frozen;
    for (const entry of frozen) slurmIntents.set(entry.intentId, entry);
    rt.selectIntent(frozen[frozen.length - 1]?.intentId ?? '');
    return frozen.length;
  },

  selectIntent(intentId: string) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    rt.selectIntent(intentId);
    return rt.selectedIntentId.value;
  },

  selectedIntentState() {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    return {
      selectedProfileId: rt.selectedProfileId.value,
      selectedIntentId: rt.selectedIntentId.value,
      selectedSlurmIntent: rt.selectedSlurm.value?.intentId ?? null,
      selectedSlurmJob: rt.selectedSlurm.value?.jobId ?? null,
      intentDiffersFromProfile: rt.selectedIntentId.value !== '' && rt.selectedIntentId.value !== rt.selectedProfileId.value,
    };
  },

  setStatus(status: AnyRecord | null) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    if (status === null) { rt.statuses.value = Object.freeze([]); return null; }
    rt.statuses.value = Object.freeze([Object.freeze({ ...status })]) as readonly RuntimeConnectionStatus[];
    return rt.statusOf.value;
  },

  setPlan(plan: AnyRecord | null) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    rt.remotePlan.value = plan === null ? null : (Object.freeze({ ...plan }) as RemoteBridgeUpdatePlan);
    return rt.remotePlan.value;
  },

  presentChallenge(challenge: AnyRecord) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    rt.presentChallenge(Object.freeze({ ...challenge }) as never);
    return rt.challenge.value;
  },

  async presentChallengeAndMount(kind: string, fields: AnyRecord = {}) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    rt.presentChallenge(Object.freeze({ challengeId: `challenge-${kind}`, kind, prompt: `${kind} prompt`, echo: false, redacted: true, createdAt: 1, ...fields }) as never);
    await nextTick(); await nextTick();
    return rt.challenge.value;
  },

  // ── SSH profile creation through the real form ──
  async createSshProfileViaUi(input: { name: string; endpoint: string; credentialRef: string; enabled: boolean }) {
    // Open the composer only when the SSH form is not already mounted, so a second profile can be
    // created without the toggle hiding the form again.
    if (element('ssh-host-form') === null) { await click('new-ssh-profile'); await nextTick(); }
    await setInput('ssh-name', input.name);
    await setInput('ssh-endpoint', input.endpoint);
    await setInput('ssh-credential-ref', input.credentialRef);
    const enabledBox = element('ssh-enabled') as HTMLInputElement | null;
    if (enabledBox !== null && enabledBox.checked !== input.enabled) { enabledBox.click(); await nextTick(); }
    await click('ssh-host-save');
    await nextTick(); await nextTick();
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    return {
      profileCount: rt.profiles.value.length,
      selectedProfileId: rt.selectedProfileId.value,
      created: rt.profiles.value[rt.profiles.value.length - 1] ?? null,
      savedProblems: element('ssh-host-problems')?.textContent ?? null,
      unresolved: element('ssh-environment-unresolved') !== null,
    };
  },

  // ── challenge answer through the real challenge panel ──
  async answerChallengeViaUi(input: { accept: boolean; secret?: string }) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    const kind = rt.challenge.value?.kind ?? null;
    if (typeof input.secret === 'string') await setInput('challenge-secret', input.secret);
    const beforeValue = (element('challenge-secret') as HTMLInputElement | null)?.value ?? null;
    await click(input.accept ? 'challenge-accept' : 'challenge-cancel');
    await nextTick(); await nextTick();
    const payload = lastChallengeAnswer;
    let serialized = '';
    try { serialized = payload === null ? '' : JSON.stringify(payload); } catch { serialized = '<unserializable>'; }
    return {
      kind,
      acceptDisabled: (element('challenge-accept') as HTMLButtonElement | null)?.disabled ?? null,
      refusal: element('challenge-refusal')?.textContent ?? null,
      beforeValue,
      afterValue: (element('challenge-secret') as HTMLInputElement | null)?.value ?? null,
      afterInputAbsent: element('challenge-secret') === null,
      challengeCleared: rt.challenge.value === null,
      payload,
      serialized,
      secretInPayload: typeof input.secret === 'string' && serialized.length > 0 ? occurrences(serialized, input.secret) : 0,
      consumed: consumedSecret,
      secretBoxType: payload?.secret === undefined ? null : typeof payload.secret,
      secretBoxString: payload?.secret === undefined ? null : String(payload.secret),
      secretBoxJson: payload?.secret === undefined ? null : payload.secret?.toJSON?.() ?? null,
    };
  },

  async connectViaUi() { const clicked = await click('connection-connect'); await nextTick(); const rt = runtime as ReturnType<typeof useRuntimeProfiles>; return { clicked, status: rt.statusOf.value }; },
  async cancelViaUi() { const clicked = await click('connection-cancel'); await nextTick(); await nextTick(); const rt = runtime as ReturnType<typeof useRuntimeProfiles>; return { clicked, status: rt.statusOf.value, slurmStatuses: rt.slurmStatuses.value }; },
  async detachViaUi() {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    const target = rt.selectedIntentId.value;
    const clicked = await click('remote-detach');
    await nextTick(); await nextTick();
    return { clicked, target, profileId: rt.selectedProfileId.value, targetIsNotProfile: target !== '' && target !== rt.selectedProfileId.value, slurm: rt.selectedSlurm.value };
  },
  async stopViaUi() {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    const target = rt.selectedIntentId.value;
    const clicked = await click('remote-stop');
    await nextTick(); await nextTick();
    return { clicked, target, profileId: rt.selectedProfileId.value, targetIsNotProfile: target !== '' && target !== rt.selectedProfileId.value, slurm: rt.selectedSlurm.value };
  },
  async reconnectViaUi() { const clicked = await click('remote-reconnect'); await nextTick(); await nextTick(); const rt = runtime as ReturnType<typeof useRuntimeProfiles>; return { clicked, status: rt.statusOf.value }; },
  async updateViaUi() { const clicked = await click('remote-update'); await nextTick(); await nextTick(); const rt = runtime as ReturnType<typeof useRuntimeProfiles>; return { clicked, plan: rt.remotePlan.value }; },

  async submitSlurmViaUi(resources: AnyRecord) {
    // Open the composer only when the Slurm form is not already mounted (idempotent across calls).
    if (element('slurm-execution-form') === null) { await click('new-slurm-profile'); await nextTick(); }
    if (resources.partition !== undefined) await setInput('slurm-partition', String(resources.partition));
    if (resources.account !== undefined) await setInput('slurm-account', String(resources.account));
    if (resources.cpus !== undefined) await setInput('slurm-cpus', String(resources.cpus));
    if (resources.memory !== undefined) await setInput('slurm-memory', String(resources.memory));
    if (resources.time !== undefined) await setInput('slurm-time', String(resources.time));
    if (resources.gres !== undefined) await setInput('slurm-gres', String(resources.gres));
    // The edit-driven preview refresh is measured separately from the submit itself: filling the
    // form asks the port for a preview of each draft, and the submit must add none of its own.
    const beforeSubmitClick = portCalls.slurmPreview;
    await click('slurm-form-submit');
    await nextTick(); await nextTick();
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    return {
      preview: preview.value,
      slurmStatuses: rt.slurmStatuses.value,
      error: rt.error.value,
      selectedProfileId: rt.selectedProfileId.value,
      selectedIntentId: rt.selectedIntentId.value,
      selectedSlurm: rt.selectedSlurm.value,
      intentDiffersFromProfile: rt.selectedIntentId.value !== '' && rt.selectedIntentId.value !== rt.selectedProfileId.value,
      previewCallsBeforeSubmitClick: beforeSubmitClick,
      previewCallsAfterSubmitClick: portCalls.slurmPreview,
      previewBoundToDraft: (element('slurm-resource-preview') as HTMLElement | null)?.getAttribute('data-bound') ?? null,
      previewStale: (element('slurm-preview-stale') as HTMLElement | null)?.textContent ?? null,
    };
  },

  errorState() { const rt = runtime as ReturnType<typeof useRuntimeProfiles>; return { error: rt.error.value, busy: rt.busy.value }; },
  challengeState() { const rt = runtime as ReturnType<typeof useRuntimeProfiles>; return rt.challenge.value; },

  renderedTargets() {
    const surface = element('connection-lifecycle');
    // `data-pending-reason` is always bound (`pendingReason ?? ''`), so an EMPTY attribute value is the
    // receiver's "no reason" state; normalize it to null so a ready/terminal target reads as null.
    const pendingReasonAttribute = surface?.getAttribute('data-pending-reason') ?? null;
    return {
      present: surface !== null,
      environmentId: surface?.getAttribute('data-environment-id') ?? null,
      targetKind: surface?.getAttribute('data-target-kind') ?? null,
      computeNode: surface?.getAttribute('data-compute-node') ?? null,
      jobId: surface?.getAttribute('data-job-id') ?? null,
      ownership: surface?.getAttribute('data-ownership') ?? null,
      pendingReason: pendingReasonAttribute === '' ? null : pendingReasonAttribute,
      terminal: surface?.getAttribute('data-terminal') ?? null,
      state: surface?.getAttribute('data-state') ?? null,
      generation: surface?.getAttribute('data-generation') ?? null,
      environmentCell: element('connection-environment-id')?.textContent ?? null,
      computeNodeCell: element('connection-compute-node-id')?.textContent ?? null,
      jobCell: element('connection-job-id')?.textContent ?? null,
      queueStateCell: element('connection-queue-state')?.textContent ?? null,
      stepEpochCell: element('connection-step-epoch')?.textContent ?? null,
      bridgeInstanceCell: element('connection-bridge-instance-id')?.textContent ?? null,
      pendingCell: element('connection-pending-reason')?.textContent ?? null,
      terminalCell: element('connection-terminal')?.textContent ?? null,
      statusErrorCell: element('connection-status-error')?.textContent ?? null,
    };
  },

  resolvedEnvironmentOf(profileId: string) {
    const rt = runtime as ReturnType<typeof useRuntimeProfiles>;
    const profile = rt.profiles.value.find((entry) => entry.profileId === profileId);
    return profile === undefined ? null : resolveProfileEnvironment(profile);
  },

  applyTheme(kind: 'light' | 'dark') {
    const theme = kind === 'light' ? SOFT_WHITE_PRESET : ANIME_NIGHT_PRESET;
    const storage = regionThemeToStorage(theme);
    const snapshot = createSemanticTokenSnapshot(extractSemanticTokenOverrides(storage));
    const root = document.documentElement;
    for (const token of SEMANTIC_THEME_TOKENS) {
      const value = snapshot[token];
      if (value) root.style.setProperty(semanticTokenCssVariable(token), value);
    }
    root.setAttribute(THEME_ROOT_ATTRIBUTE, kind);
    return { kind, preset: storage?.preset ?? null, tokenCount: SEMANTIC_THEME_TOKENS.filter((token) => Boolean(snapshot[token])).length };
  },

  renderedCapabilityRows() {
    return [...document.querySelectorAll('[data-testid="capability-entry"] [data-capability]')]
      .map((row) => `${row.getAttribute('data-capability')}:${row.getAttribute('data-state')}`);
  },

  renderedButtonCount() { return document.querySelectorAll('button').length; },

  probe() {
    const disabled = (testId: string): boolean | null => {
      const node = element(testId) as HTMLButtonElement | null;
      return node === null ? null : node.disabled;
    };
    const text = (testId: string): string | null => element(testId)?.textContent ?? null;
    return {
      directOnlyMarker: text('direct-only-marker'),
      newSshDisabled: disabled('new-ssh-profile'),
      newSlurmDisabled: disabled('new-slurm-profile'),
      newProfileHint: text('new-profile-hint'),
      connectDisabled: disabled('connection-connect'),
      cancelDisabled: disabled('connection-cancel'),
      detachDisabled: disabled('remote-detach'),
      stopDisabled: disabled('remote-stop'),
      reconnectDisabled: disabled('remote-reconnect'),
      updateDisabled: disabled('remote-update'),
      stopRefusal: text('remote-stop-refusal'),
      updateRefusal: text('remote-update-refusal'),
      slurmFormProblems: text('slurm-form-problems'),
      slurmPreviewNodes: text('slurm-preview-nodes'),
      slurmPreviewCpus: text('slurm-preview-cpus'),
      slurmPreviewMemory: text('slurm-preview-memory'),
      slurmPreviewTime: text('slurm-preview-time'),
      slurmPreviewGres: text('slurm-preview-gres'),
      slurmPreviewNote: text('slurm-preview-note'),
      challengeKind: element('connection-challenge')?.getAttribute('data-kind') ?? null,
      challengePrompt: text('challenge-prompt'),
      challengeFingerprint: text('challenge-fingerprint'),
      challengeRefusal: text('challenge-refusal'),
      challengeAcceptDisabled: disabled('challenge-accept'),
      challengeHasSecretInput: element('challenge-secret') !== null,
      managerClient: element('connection-manager')?.getAttribute('data-client') ?? null,
      managedTransportAttr: element('connection-manager')?.getAttribute('data-managed-transport') ?? null,
      statusChip: element('connection-manager-status')?.textContent ?? null,
    };
  },

  styleProbe() {
    const modal = document.querySelector('[data-testid="connection-manager"] .modal') as HTMLElement | null;
    const marker = element('direct-only-marker');
    const lifecycle = element('connection-lifecycle');
    const style = modal === null ? null : getComputedStyle(modal);
    return {
      themeAttribute: document.documentElement.getAttribute(THEME_ROOT_ATTRIBUTE),
      modalColor: style?.color ?? null,
      modalBackgroundImage: style?.backgroundImage ?? null,
      modalBorderColor: style?.borderTopColor ?? null,
      markerColor: marker === null ? null : getComputedStyle(marker).color,
      lifecycleColor: lifecycle === null ? null : getComputedStyle(lifecycle).color,
      expectedModalText: rgbOf(SOFT_WHITE_PRESET.regions.modalPanel?.text),
      expectedDarkModalText: rgbOf(ANIME_NIGHT_PRESET.regions.modalPanel?.text),
      modalFont: style?.fontFamily ?? null,
    };
  },
};

(window as unknown as AnyRecord).task30 = api;
