<template>
  <dialog
    ref="dialogRef"
    class="modal-backdrop"
    :open="open"
    data-testid="connection-manager"
    :data-client="client"
    :data-managed-transport="String(managedTransport)"
    @close="$emit('close')"
    @cancel.prevent
    @click.self="handleClose"
  >
    <div class="modal">
      <header class="modal-header">
        <div class="modal-title">SSH / HPC connection</div>
        <button type="button" class="modal-close-button" data-testid="connection-manager-close" @click="handleClose">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>

      <!--
        The direct-only marker is a VISIBLE state, not a missing control.
        When there is no managed bridge, the SSH and Slurm rows are present and explicitly
        unavailable, so a reader can never mistake an absent relay for an available one.
      -->
      <p v-if="directOnly" class="direct-only" role="status" data-testid="direct-only-marker">
        <Icon icon="lucide:unplug" :width="14" :height="14" />
        <span>
          Direct only — no managed bridge on this target. Direct targets and pre-built tunnels
          still work; managed SSH and Slurm transports are unavailable.
        </span>
      </p>

      <!--
        ONE capability entry, resolved identically for Browser and Electron.
        `data-client` is attribution only: the rows come from the transports the target reports
        plus whether a managed bridge exists, so the two runtimes never diverge.
      -->
      <section class="capability-entry" data-testid="capability-entry" :aria-label="`Capabilities on ${client}`">
        <div
          v-for="row in capabilityEntry"
          :key="row.capability"
          class="capability-row"
          :class="row.state === 'supported' ? 'is-supported' : 'is-unsupported'"
          :data-capability="row.capability"
          :data-state="row.state"
          :data-testid="row.state === 'supported' ? 'capability-supported' : 'capability-unsupported'"
        >
          <Icon :icon="row.state === 'supported' ? 'lucide:check' : 'lucide:x'" :width="14" :height="14" />
          <span class="capability-name">{{ row.capability }}</span>
          <span v-if="row.reason" class="capability-reason">{{ row.reason }}</span>
        </div>
      </section>

      <p v-if="error" class="modal-error" role="alert" data-testid="connection-manager-error">
        <Icon icon="lucide:alert-triangle" :width="14" :height="14" />
        <span>{{ error }}</span>
      </p>

      <!-- Profile picker -->
      <section class="profile-picker" :aria-label="'Connection profiles'">
        <div class="section-title">Profile</div>
        <div v-if="profiles.length === 0" class="empty" data-testid="profile-empty">
          No profiles yet. Add an SSH host or a Slurm cluster below.
        </div>
        <div v-else class="profile-list" role="group" aria-label="Connection profiles">
          <button
            v-for="profile in profiles"
            :key="profile.profileId"
            type="button"
            class="profile-row"
            :class="{ selected: profile.profileId === selectedProfileId }"
            :data-testid="'connection-profile-row'"
            :data-profile-id="profile.profileId"
            :data-transport="profile.transport.kind"
            :data-enabled="String(profile.enabled)"
            :aria-pressed="profile.profileId === selectedProfileId"
            @click="selectProfile(profile.profileId)"
          >
            <span class="profile-label">{{ profile.name }}</span>
            <span class="profile-transport">{{ profile.transport.kind }} · {{ profile.role }}</span>
            <span class="profile-target mono">{{ profile.target.kind }} · {{ shortId(environmentOf(profile)) }}</span>
            <span v-if="!profile.enabled" class="profile-disabled">disabled</span>
          </button>
        </div>
      </section>

      <!-- Lifecycle feedback -->
      <ConnectionStatus
        :identity="identity"
        :status="status"
        :slurm="slurm"
        :error="error"
      />

      <!-- Remote bridge actions -->
      <RemoteBridgeActions
        :slurm="slurm"
        :status="status"
        :plan="plan"
        :busy="busy"
        @detach="$emit('detach')"
        @stop="$emit('stop')"
        @reconnect="$emit('reconnect')"
        @update="$emit('update')"
      />

      <!-- Challenge / trust -->
      <section v-if="challenge" class="challenge" data-testid="connection-challenge" :data-kind="challenge.kind">
        <div class="section-title">
          {{ challenge.kind === 'host-key' ? 'Trust this host key' : 'Authentication required' }}
        </div>
        <p class="challenge-prompt" data-testid="challenge-prompt">{{ challenge.prompt }}</p>
        <p v-if="challenge.fingerprint" class="challenge-fingerprint mono" data-testid="challenge-fingerprint">
          {{ challenge.fingerprint }}
        </p>
        <p v-if="challenge.kind === 'host-key-changed'" class="challenge-refusal" data-testid="challenge-refusal">
          The host key changed. A changed key is never accepted — verify the host out of band and
          update the known-hosts entry.
        </p>
        <div v-if="isSecretChallenge" class="challenge-secret">
          <label class="field">
            <span class="field-label">{{ challenge.kind === 'otp' ? 'One-time code' : 'Secret' }}</span>
            <input
              ref="secretInput"
              v-model="secret"
              class="field-input"
              :type="challenge.kind === 'otp' ? 'text' : 'password'"
              autocomplete="off"
              spellcheck="false"
              data-testid="challenge-secret"
              @keydown.enter.prevent="answer(true)"
            />
            <span class="field-hint">
              Held only for this answer. It is never cached, never written to the profile, and the
              profile keeps a credential reference instead.
            </span>
          </label>
        </div>
        <div class="challenge-actions">
          <button
            type="button"
            class="action-button"
            data-testid="challenge-cancel"
            @click="answer(false)"
          >
            {{ isSecretChallenge ? 'Cancel' : 'Decline' }}
          </button>
          <button
            type="button"
            class="action-button save"
            data-testid="challenge-accept"
            :disabled="!challengeAcceptable || (isSecretChallenge && secret.length === 0)"
            @click="answer(true)"
          >
            {{ isSecretChallenge ? 'Send' : 'Trust and continue' }}
          </button>
        </div>
      </section>

      <!-- New profile forms -->
      <div class="new-profile">
        <div class="section-title">Add a profile</div>
        <div class="new-profile-actions">
          <button
            type="button"
            class="action-button"
            :class="{ active: composer === 'ssh' }"
            :disabled="!sshAvailable"
            data-testid="new-ssh-profile"
            @click="composer = composer === 'ssh' ? '' : 'ssh'"
          >
            SSH host
          </button>
          <button
            type="button"
            class="action-button"
            :class="{ active: composer === 'slurm' }"
            :disabled="!slurmAvailable"
            data-testid="new-slurm-profile"
            @click="composer = composer === 'slurm' ? '' : 'slurm'"
          >
            Slurm cluster
          </button>
        </div>
        <p v-if="!sshAvailable || !slurmAvailable" class="new-profile-hint" data-testid="new-profile-hint">
          A transport marked unavailable above cannot be configured here.
        </p>
      </div>

      <SshHostForm
        v-if="composer === 'ssh'"
        :available="sshAvailable"
        :unavailable-reason="sshReason"
        :environment-id="probedEnvironmentId"
        @save="$emit('save-ssh', $event)"
        @cancel="composer = ''"
      />

      <SlurmExecutionForm
        v-if="composer === 'slurm'"
        :available="slurmAvailable"
        :unavailable-reason="slurmReason"
        :preview="preview"
        @submit="$emit('submit-slurm', $event)"
        @cancel="composer = ''"
      />

      <footer class="modal-actions">
        <span class="status-chip" :data-state="status?.state ?? 'disconnected'" data-testid="connection-manager-status">
          {{ status?.state ?? 'disconnected' }}
        </span>
        <button
          type="button"
          class="action-button"
          data-testid="connection-cancel"
          :disabled="busy || status?.state !== 'connected'"
          @click="$emit('cancel')"
        >
          Cancel connection
        </button>
        <button
          type="button"
          class="action-button save"
          data-testid="connection-connect"
          :disabled="!canConnect"
          @click="$emit('connect')"
        >
          Connect
        </button>
      </footer>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import type { ConnectionProfile } from '../../../shared/runtime/connectionProfile.js';
import type {
  RemoteBridgeUpdatePlan,
  RuntimeCapability,
  RuntimeCapabilityRow,
  RuntimeChallenge,
  RuntimeClientKind,
  RuntimeConnectionStatus,
  RuntimeTargetIdentity,
  SlurmLifecycleStatus,
  SlurmResourcePreview,
} from '../../composables/useRuntimeProfiles';
import { isSecretChallengeKind } from '../../composables/useRuntimeProfiles';
import ConnectionStatus from './ConnectionStatus.vue';
import RemoteBridgeActions from './RemoteBridgeActions.vue';
import SshHostForm from './SshHostForm.vue';
import SlurmExecutionForm from './SlurmExecutionForm.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** Which runtime renders this surface. Attribution only — never a capability input. */
    client: RuntimeClientKind;
    profiles: readonly ConnectionProfile[];
    capabilityEntry: readonly RuntimeCapabilityRow[];
    /** False renders the explicit direct-only marker. */
    managedTransport: boolean;
    selectedProfileId?: string;
    identity?: RuntimeTargetIdentity | null;
    status?: RuntimeConnectionStatus | null;
    slurm?: SlurmLifecycleStatus | null;
    challenge?: RuntimeChallenge | null;
    plan?: RemoteBridgeUpdatePlan | null;
    preview?: SlurmResourcePreview | null;
    probedEnvironmentId?: string;
    busy?: boolean;
    error?: string;
  }>(),
  {
    selectedProfileId: '',
    identity: null,
    status: null,
    slurm: null,
    challenge: null,
    plan: null,
    preview: null,
    probedEnvironmentId: '',
    busy: false,
    error: '',
  },
);

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'select', profileId: string): void;
  (event: 'connect'): void;
  (event: 'cancel'): void;
  (event: 'detach'): void;
  (event: 'stop'): void;
  (event: 'reconnect'): void;
  (event: 'update'): void;
  (event: 'save-ssh', draft: unknown): void;
  (event: 'submit-slurm', request: unknown): void;
  (event: 'challenge-answer', answer: Readonly<{ challengeId: string; accept: boolean; secret?: string }>): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const composer = ref('');
const secret = ref('');

watch(
  () => props.open,
  (open) => {
    const element = dialogRef.value;
    if (element === null) return;
    if (open) {
      if (!element.open) element.showModal();
    } else if (element.open) {
      element.close();
    }
  },
);

const directOnly = computed(() => props.managedTransport !== true);

function capability(capability: RuntimeCapability): RuntimeCapabilityRow | null {
  return props.capabilityEntry.find((row) => row.capability === capability) ?? null;
}

const sshRow = computed(() => capability('ssh'));
const slurmRow = computed(() => capability('slurm'));
const sshAvailable = computed(() => sshRow.value?.state === 'supported');
const slurmAvailable = computed(() => slurmRow.value?.state === 'supported');
const sshReason = computed(() => sshRow.value?.reason ?? '');
const slurmReason = computed(() => slurmRow.value?.reason ?? '');

const selectedProfile = computed<ConnectionProfile | null>(() =>
  props.profiles.find((profile) => profile.profileId === props.selectedProfileId) ?? null);

const canConnect = computed(() => {
  const profile = selectedProfile.value;
  if (profile === null) return false;
  if (props.status?.state === 'connecting') return false;
  return profile.enabled;
});

const isSecretChallenge = computed(() => props.challenge !== null && isSecretChallengeKind(props.challenge.kind));

/** A changed host key has no accept path at all — the button is disabled, not merely discouraged. */
const challengeAcceptable = computed(() => props.challenge !== null && props.challenge.kind !== 'host-key-changed');

function selectProfile(profileId: string) {
  emit('select', profileId);
}

function handleClose() {
  emit('close');
}

function environmentOf(profile: ConnectionProfile): string {
  const target = profile.target as { environmentId?: string; clusterEnvironmentId?: string };
  return target.environmentId ?? target.clusterEnvironmentId ?? '';
}

/**
 * Answer a challenge.
 *
 * The secret is read out of the input, handed to the parent in the answer event, and then
 * DROPPED: the ref is cleared immediately so nothing in this component retains it. The parent
 * wraps it in a secret box before it can reach any log or error surface.
 */
function answer(accept: boolean) {
  const challenge = props.challenge;
  if (challenge === null) return;
  const value = accept && isSecretChallenge.value ? secret.value : undefined;
  secret.value = '';
  emit('challenge-answer', { challengeId: challenge.challengeId, accept, ...(value === undefined ? {} : { secret: value }) });
}

function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}
</script>

<style scoped>
.modal-backdrop {
  border: none;
  padding: 0;
  margin: 0;
  background: transparent;
  color: inherit;
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-backdrop:not([open]) {
  display: none;
}

.modal-backdrop::backdrop {
  background: var(--theme-surface-overlay, rgba(2, 6, 23, 0.65));
}

.modal {
  width: min(640px, 95vw);
  max-height: 92vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--theme-modal-bg, var(--theme-surface-panel-elevated, rgba(15, 23, 42, 0.98)));
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 12px;
  box-shadow: var(--theme-shadow-panel, 0 12px 32px rgba(2, 6, 23, 0.45));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: var(--app-monospace-font-family);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modal-title {
  font-size: var(--type-heading, 14px);
  font-weight: 600;
}

.modal-close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 6px;
  background: transparent;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  cursor: pointer;
}

.modal-close-button:hover {
  background: var(--theme-modal-active-bg, #1e293b);
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.direct-only {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border: 1px dashed color-mix(in srgb, var(--theme-status-warning, #fcd34d) 45%, transparent);
  border-radius: var(--radius-control, 8px);
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-status-warning, #fcd34d);
}

.capability-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: var(--theme-modal-control-bg, #0b1320);
}

.capability-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--type-sm, 12px);
}

.capability-row.is-supported {
  color: var(--color-success-400, #22c55e);
}

.capability-row.is-unsupported {
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.capability-name {
  font-weight: 600;
}

.capability-reason {
  font-size: var(--type-caption, 10px);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  margin-left: auto;
  text-align: right;
}

.modal-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--type-sm, 12px);
  color: var(--theme-status-error, #f87171);
}

.section-title {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.profile-picker,
.new-profile,
.challenge {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty {
  font-size: var(--type-sm, 12px);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.profile-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  text-align: left;
  padding: 8px 10px;
  background: var(--theme-modal-control-bg, #0b1320);
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: inherit;
  font-size: var(--type-sm, 12px);
  cursor: pointer;
}

.profile-row:hover {
  background: var(--theme-modal-active-bg, #1e293b);
}

.profile-row.selected {
  border-color: var(--theme-modal-accent, #60a5fa);
  background: var(--theme-modal-active-bg, #1e293b);
}

.profile-row:focus-visible {
  outline: 2px solid var(--theme-modal-accent, #60a5fa);
  outline-offset: 1px;
}

.profile-label {
  font-weight: 600;
}

.profile-transport {
  font-size: var(--type-caption, 10px);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  text-align: right;
}

.profile-target {
  grid-column: 1 / -1;
  font-size: var(--type-caption, 10px);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-disabled {
  grid-column: 1 / -1;
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-status-warning, #fcd34d);
}

.mono {
  font-family: var(--app-monospace-font-family);
}

.new-profile-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.new-profile-hint {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-status-warning, #fcd34d);
}

.challenge {
  padding: 10px 12px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-modal-control-bg, #0b1320);
}

.challenge-prompt {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.challenge-fingerprint {
  margin: 0;
  font-size: var(--type-caption, 10px);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  word-break: break-all;
}

.challenge-refusal {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-status-error, #f87171);
}

.challenge-secret {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.challenge-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-label {
  font-size: var(--type-sm, 12px);
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.field-input {
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--theme-input-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: var(--theme-input-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72)));
  color: var(--theme-input-text, var(--theme-text-primary, #e2e8f0));
  font-family: var(--app-monospace-font-family);
  font-size: var(--type-sm, 12px);
  outline: none;
}

.field-input:focus-visible {
  border-color: var(--theme-accent-primary, #60a5fa);
}

.field-hint {
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.action-button {
  padding: 6px 14px;
  border: 1px solid var(--theme-input-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: transparent;
  color: var(--theme-text-primary, #e2e8f0);
  font-family: inherit;
  font-size: var(--type-sm, 12px);
  cursor: pointer;
}

.action-button:hover:not(:disabled) {
  background: var(--theme-surface-panel-hover, rgba(15, 23, 42, 0.9));
}

.action-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.action-button.active {
  border-color: var(--theme-accent-primary, #60a5fa);
  color: var(--theme-accent-primary, #93c5fd);
}

.action-button.save {
  background: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 72%, transparent);
  border-color: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 82%, transparent);
}

.action-button:focus-visible {
  outline: 2px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 1px;
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.status-chip {
  margin-right: auto;
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.status-chip[data-state='connected'] {
  color: var(--color-success-400, #22c55e);
  border-color: var(--color-success-400, #22c55e);
}

.status-chip[data-state='failed'] {
  color: var(--theme-status-error, #f87171);
  border-color: var(--theme-status-error, #f87171);
}

@media (max-width: 480px) {
  .profile-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
