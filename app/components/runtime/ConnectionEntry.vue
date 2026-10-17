<template>
  <dialog
    ref="dialogRef"
    class="modal-backdrop"
    :open="open"
    @close="$emit('close')"
    @cancel.prevent
    @click.self="handleClose"
  >
    <div class="modal" data-testid="connection-entry">
      <header class="modal-header">
        <div class="modal-title">{{ $t('app.runtimeConnection.title') }}</div>
        <button type="button" class="modal-close-button" @click="handleClose">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>

      <p class="modal-description">{{ $t('app.runtimeConnection.description') }}</p>

      <div v-if="error" class="modal-error" data-testid="connection-error">
        <Icon icon="lucide:alert-triangle" :width="14" :height="14" />
        <span>{{ error }}</span>
      </div>

      <div class="profile-list" role="group" :aria-label="$t('app.runtimeConnection.profilesLabel')">
        <button
          v-for="profile in profiles"
          :key="profile.profileId"
          type="button"
          class="profile-row"
          :class="{ selected: selectedProfileId === profile.profileId }"
          :data-testid="'connection-profile-row'"
          :data-profile-id="profile.profileId"
          :aria-pressed="selectedProfileId === profile.profileId"
          @click="selectProfile(profile)"
        >
          <span class="profile-label">{{ profile.label }}</span>
          <span class="profile-url">{{ profile.bridgeUrl }}</span>
          <span class="profile-target">{{ profile.target.kind }} · {{ shortTarget(profile.target.environmentId) }}</span>
        </button>
      </div>

      <div v-if="capabilities.length" class="capability-list" data-testid="connection-capabilities">
        <div
          v-for="capability in supportedCapabilities"
          :key="capability.capability"
          class="capability-row is-supported"
          data-testid="connection-capability-supported"
        >
          <Icon icon="lucide:check" :width="14" :height="14" />
          <span class="capability-name">{{ capability.capability }}</span>
          <span class="capability-target">{{ shortTarget(capability.target) }}</span>
        </div>
        <div
          v-for="capability in unsupportedCapabilities"
          :key="capability.capability"
          class="capability-row is-unsupported"
          data-testid="connection-capability-unsupported"
        >
          <Icon icon="lucide:x" :width="14" :height="14" />
          <span class="capability-name">{{ capability.capability }}</span>
          <span class="capability-reason">{{ $t('app.runtimeConnection.unsupported') }} · {{ shortTarget(capability.target) }}</span>
        </div>
      </div>

      <footer class="modal-actions">
        <span class="status-chip" :data-state="status" data-testid="connection-status">
          {{ $t(`app.runtimeConnection.status.${status}`) }}
        </span>
        <button
          type="button"
          class="action-button"
          data-testid="connection-retry"
          :disabled="!canRetry"
          @click="$emit('retry')"
        >
          {{ $t('app.runtimeConnection.retry') }}
        </button>
        <button
          type="button"
          class="action-button save"
          data-testid="connection-connect"
          :disabled="!selectedProfile || status === 'connecting'"
          @click="connect"
        >
          {{ $t('app.runtimeConnection.connect') }}
        </button>
      </footer>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import type { HarnessKind } from '../../../shared/runtime/harnessContract.js';

export type ConnectionProfileEntry = Readonly<{
  profileId: string;
  label: string;
  bridgeUrl: string;
  target: Readonly<{ environmentId: string; kind: HarnessKind }>;
}>;

export type ConnectionCapabilityEntry = Readonly<{
  capability: string;
  supported: boolean;
  target: string;
}>;

const props = withDefaults(
  defineProps<{
    open: boolean;
    profiles: readonly ConnectionProfileEntry[];
    capabilities?: readonly ConnectionCapabilityEntry[];
    status?: 'idle' | 'connecting' | 'ready' | 'error';
    error?: string;
  }>(),
  {
    capabilities: () => [] as readonly ConnectionCapabilityEntry[],
    status: 'idle',
    error: '',
  },
);

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'bind', value: Readonly<{ profileId: string; target: ConnectionProfileEntry['target'] }>): void;
  (event: 'retry'): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const selectedProfileId = ref('');

watch(
  () => props.open,
  (open) => {
    const el = dialogRef.value;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
      if (!selectedProfileId.value && props.profiles.length) {
        selectedProfileId.value = props.profiles[0]!.profileId;
      }
    } else if (el.open) {
      el.close();
    }
  },
);

const selectedProfile = computed(() =>
  props.profiles.find((profile) => profile.profileId === selectedProfileId.value) ?? null,
);

const supportedCapabilities = computed(() =>
  (props.capabilities ?? []).filter((capability) => capability.supported),
);

const unsupportedCapabilities = computed(() =>
  (props.capabilities ?? []).filter((capability) => !capability.supported),
);

const canRetry = computed(() => props.status === 'error');

function selectProfile(profile: ConnectionProfileEntry) {
  selectedProfileId.value = profile.profileId;
}

function connect() {
  const profile = selectedProfile.value;
  if (!profile) return;
  emit('bind', { profileId: profile.profileId, target: profile.target });
}

function handleClose() {
  emit('close');
}

function shortTarget(environmentId: string): string {
  return environmentId.length > 8 ? `${environmentId.slice(0, 8)}…` : environmentId;
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
  width: min(520px, 95vw);
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
  font-size: 14px;
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
  color: var(--theme-modal-text, #e2e8f0);
}

.modal-description {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.modal-error {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--theme-status-error, #f87171);
}

.profile-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 12px;
  text-align: left;
  padding: 8px 10px;
  background: var(--theme-modal-control-bg, #0b1320);
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: inherit;
  font-size: 12px;
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

.profile-url {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  text-align: right;
}

.profile-target {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.capability-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: var(--theme-modal-control-bg, #0b1320);
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
}

.capability-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
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

.capability-target,
.capability-reason {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  margin-left: auto;
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.status-chip {
  margin-right: auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.status-chip[data-state='ready'] {
  color: var(--color-success-400, #22c55e);
  border-color: var(--color-success-400, #22c55e);
}

.status-chip[data-state='error'] {
  color: var(--theme-status-error, #f87171);
  border-color: var(--theme-status-error, #f87171);
}

.action-button {
  background: transparent;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-family: inherit;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  cursor: pointer;
}

.action-button:hover:not(:disabled) {
  background: var(--theme-modal-active-bg, #1e293b);
}

.action-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.action-button.save {
  background: color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 72%, transparent);
  border-color: color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 82%, transparent);
  color: var(--theme-modal-active-text, var(--theme-text-inverse, #e2e8f0));
}

.action-button.save:hover:not(:disabled) {
  background: color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 88%, transparent);
}

.action-button:focus-visible {
  outline: 2px solid var(--theme-modal-accent, #60a5fa);
  outline-offset: 1px;
}
</style>
