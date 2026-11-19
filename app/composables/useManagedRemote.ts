import { computed, ref, shallowRef } from 'vue';
import { parseConnectionProfile, parseNewConnectionProfile, resolveProfileEnvironment } from '../../shared/runtime/connectionProfile.js';
import type { ConnectionProfile } from '../../shared/runtime/connectionProfile.js';
import type { HostMutationCall } from '../../shared/runtime/hostWire.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';
import type { HostClient } from '../runtime/hostClient';
import { hostArray, hostObject, hostString } from '../runtime/hostCollaborationViews';
import { remoteAvailability, remoteChallenge, remoteIdentity, remotePreview, remoteSlurm, remoteStatus } from '../runtime/hostRemoteViews';
import { detectRuntimeClient, resolveRuntimeCapabilityEntry, resolveRuntimeTargetIdentity } from './useRuntimeProfiles';
import type { RuntimeChallenge, RuntimeConnectionStatus, SlurmLifecycleStatus, SlurmResourceInput, SlurmResourcePreview, RuntimeTransportAvailability } from './useRuntimeProfiles';

export interface ManagedSlurmRequest {
  readonly resources: SlurmResourceInput;
  readonly ownership: 'owned' | 'borrowed';
  readonly mode: 'tcp' | 'relay';
  readonly computeWorkingRoot: string;
  readonly computeStateRoot: string;
  readonly jobId?: string;
}

export function createManagedRemoteState(options: { getHost: () => HostClient | null; onConnected: (environmentId: EnvironmentId) => Promise<void> }) {
  const profiles = shallowRef<readonly ConnectionProfile[]>([]);
  const selectedProfileId = ref('');
  const status = ref<RuntimeConnectionStatus | null>(null);
  const slurm = ref<SlurmLifecycleStatus | null>(null);
  const jobs = shallowRef<readonly SlurmLifecycleStatus[]>([]);
  const selectedIntentId = ref('');
  const challenge = ref<RuntimeChallenge | null>(null);
  const transports = ref<RuntimeTransportAvailability>({ direct: false, ssh: false, slurm: false });
  const managedTransport = ref(false);
  const preview = ref<SlurmResourcePreview | null>(null);
  const executionIdentity = ref<ReturnType<typeof remoteIdentity>>(null);
  const busy = ref(false);
  const error = ref('');
  const client = detectRuntimeClient();
  const selectedProfile = computed(() => profiles.value.find((profile) => profile.profileId === selectedProfileId.value) ?? null);
  const identity = computed(() => selectedProfile.value ? resolveRuntimeTargetIdentity(selectedProfile.value) : null);
  const capabilityEntry = computed(() => resolveRuntimeCapabilityEntry({ client, transports: transports.value, managedTransport: managedTransport.value, environmentId: identity.value?.environmentId }));
  let activeHost: HostClient | null = null;
  let generation = 0;
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let previewSequence = 0;
  let refreshSequence = 0;
  function current(host: HostClient, token: number): boolean { return activeHost === host && token === generation && host.isCurrent(); }

  async function refresh(host = activeHost, token = generation): Promise<void> {
    if (!host || !current(host, token)) return;
    const sequence = ++refreshSequence;
    const [available, saved] = await Promise.all([
      host.read({ domain: 'remote', operation: 'capabilities', args: {} }, remoteAvailability),
      host.read({ domain: 'remote', operation: 'profiles', args: {} }, (value) => hostArray(value).map(parseConnectionProfile)),
    ]);
    if (!current(host, token) || sequence !== refreshSequence) return;
    profiles.value = saved; transports.value = available;
    managedTransport.value = true;
    if (!saved.some((profile) => profile.profileId === selectedProfileId.value)) selectedProfileId.value = saved[0]?.profileId ?? '';
    const profile = selectedProfile.value;
    if (!profile) { status.value = null; challenge.value = null; jobs.value = []; slurm.value = null; executionIdentity.value = null; return; }
    const profileId = profile.profileId;
    const [nextStatus, challenges, records, connectedIdentity] = await Promise.all([
      host.read({ domain: 'remote', operation: 'status', args: { profileId } }, remoteStatus),
      host.read({ domain: 'remote', operation: 'challenges', args: { profileId } }, (value) => hostArray(value).map(remoteChallenge)),
      profile.transport.kind === 'slurm' ? host.read({ domain: 'remote', operation: 'jobs', args: { profileId } }, (value) => hostArray(value).map(remoteSlurm)) : Promise.resolve([]),
      host.read({ domain: 'remote', operation: 'identity', args: { profileId } }, remoteIdentity),
    ]);
    if (!current(host, token) || sequence !== refreshSequence || selectedProfileId.value !== profileId) return;
    status.value = nextStatus; challenge.value = challenges[0] ?? null; jobs.value = records;
    executionIdentity.value = connectedIdentity;
    const focused = records.find((record) => record.intentId === selectedIntentId.value) ?? records.at(-1) ?? null;
    selectedIntentId.value = focused?.intentId ?? ''; slurm.value = focused ? { ...focused, bridgeInstanceId: connectedIdentity?.instanceId ?? null } : null;
  }

  async function run(action: (host: HostClient, token: number) => Promise<void>): Promise<void> {
    const host = activeHost, token = generation;
    if (!host || !current(host, token)) { error.value = 'Connect to the management Bridge before continuing.'; return; }
    pending += 1; busy.value = true; error.value = '';
    try { await action(host, token); }
    catch (failure) { if (token === generation && host === activeHost) error.value = failure instanceof Error ? failure.message : 'The remote operation failed.'; }
    finally { if (token === generation) { pending -= 1; busy.value = pending > 0; } }
  }

  function schedule(host: HostClient, token: number): void {
    timer = setTimeout(async () => {
      timer = undefined;
      if (!current(host, token)) return;
      if (!refreshing) {
        refreshing = true;
        try {
          const profile = selectedProfile.value, intent = slurm.value;
          if (profile?.transport.kind === 'slurm' && intent?.attached && !intent.terminal) {
            await host.mutate({ domain: 'remote', operation: 'reconcile', args: { profileId: profile.profileId, intentId: intent.intentId } }, (value) => value, crypto.randomUUID()).executed;
          }
          await refresh(host, token);
        } catch (failure) { if (current(host, token) && !error.value) error.value = failure instanceof Error ? failure.message : 'The remote status could not be read.'; }
        finally { refreshing = false; }
      }
      if (current(host, token)) schedule(host, token);
    }, 1000);
  }

  async function mutate(call: HostMutationCall): Promise<void> {
    await run(async (host, token) => { await host.mutate(call, (value) => value, crypto.randomUUID()).executed; await refresh(host, token); });
  }

  async function open(): Promise<void> {
    close(); activeHost = options.getHost();
    await run((host, token) => refresh(host, token));
    if (activeHost) schedule(activeHost, generation);
  }
  function close(): void {
    generation += 1; activeHost = null; pending = 0; busy.value = false;
    previewSequence += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined; challenge.value = null; error.value = ''; preview.value = null;
    profiles.value = []; selectedProfileId.value = ''; status.value = null; jobs.value = []; slurm.value = null; selectedIntentId.value = '';
    transports.value = { direct: false, ssh: false, slurm: false };
    managedTransport.value = false;
    executionIdentity.value = null;
  }
  function select(profileId: string): void {
    if (!profiles.value.some((profile) => profile.profileId === profileId)) return;
    selectedProfileId.value = profileId; status.value = null; slurm.value = null; challenge.value = null; preview.value = null; executionIdentity.value = null;
    previewSequence += 1;
    void run((host, token) => refresh(host, token));
  }

  async function connect(reconnect = false): Promise<void> {
    const profile = selectedProfile.value;
    if (!profile) return;
    await run(async (host, token) => {
      if (!profile.enabled) throw new Error('Enable this connection profile before connecting.');
      await host.mutate({ domain: 'remote', operation: reconnect ? 'reconnect' : 'connect', args: { profileId: profile.profileId } }, remoteStatus, crypto.randomUUID()).executed;
      if (!current(host, token)) return;
      await options.onConnected(resolveProfileEnvironment(profile)); await refresh(host, token);
    });
  }

  return {
    client, profiles, selectedProfileId, selectedProfile, selectedIntentId, status, identity, executionIdentity, slurm, jobs, challenge, transports, preview, busy, error, capabilityEntry,
    managedTransport,
    open, close, select, refresh: () => run((host, token) => refresh(host, token)), connect: () => connect(), reconnect: () => connect(true),
    setEnabled: (input: { profileId: string; enabled: boolean }) => mutate({ domain: 'remote', operation: 'enable', args: input }),
    saveProfile: (draft: unknown) => run(async (host, token) => {
      const parsed = parseNewConnectionProfile(draft);
      const created = await host.mutate({ domain: 'remote', operation: 'create', args: { ...parsed } }, parseConnectionProfile, crypto.randomUUID()).executed;
      if (current(host, token)) selectedProfileId.value = created.profileId;
      await refresh(host, token);
    }),
    disconnect: () => selectedProfile.value ? mutate({ domain: 'remote', operation: 'disconnect', args: { profileId: selectedProfile.value.profileId } }) : Promise.resolve(),
    respond: (answer: { challengeId: string; accept: boolean; secret?: string }) => {
      const profile = selectedProfile.value, currentChallenge = challenge.value;
      if (!profile || currentChallenge?.challengeId !== answer.challengeId) return Promise.resolve();
      challenge.value = null;
      return mutate({ domain: 'remote', operation: 'respond', args: { profileId: profile.profileId, challengeId: answer.challengeId, answer: { accept: answer.accept, ...(answer.secret === undefined ? {} : { secret: answer.secret }) } } });
    },
    submitSlurm: (request: ManagedSlurmRequest) => run(async (host, token) => {
      const profile = selectedProfile.value;
      if (!profile || profile.transport.kind !== 'slurm') throw new Error('Select a Slurm cluster profile before submitting.');
      const deployment = { resources: { ...request.resources }, mode: request.mode, computeWorkingRoot: request.computeWorkingRoot, computeStateRoot: request.computeStateRoot };
      const submitted = await host.mutate(request.ownership === 'borrowed'
        ? { domain: 'remote', operation: 'borrow', args: { profileId: profile.profileId, jobId: request.jobId ?? '', deployment } }
        : { domain: 'remote', operation: 'submit', args: { profileId: profile.profileId, deployment } }, hostObject, crypto.randomUUID()).executed;
      if (current(host, token)) selectedIntentId.value = hostString(submitted.intentId);
      await refresh(host, token);
    }),
    intentAction: (operation: 'reconcile' | 'detach' | 'stop') => selectedProfile.value && selectedIntentId.value
      ? mutate({ domain: 'remote', operation, args: { profileId: selectedProfile.value.profileId, intentId: selectedIntentId.value } }) : Promise.resolve(),
    previewSlurm: (resources: SlurmResourceInput) => {
      const sequence = ++previewSequence;
      return run(async (host, token) => {
        const result = await host.read({ domain: 'remote', operation: 'preview', args: { resources: { ...resources } } }, remotePreview);
        if (current(host, token) && sequence === previewSequence) preview.value = result;
      });
    },
  };
}
