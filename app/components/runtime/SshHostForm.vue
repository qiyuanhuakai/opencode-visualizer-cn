<template>
  <form class="ssh-host-form" data-testid="ssh-host-form" @submit.prevent="submit">
    <header class="form-header">
      <span class="form-title">SSH host profile</span>
      <span v-if="!available" class="form-unavailable" data-testid="ssh-host-unavailable">
        unavailable · {{ unavailableReason }}
      </span>
    </header>

    <p class="form-hint">
      The profile stores a locator and a credential reference only. User, identity files, proxy
      jump/command, host key checking and the known-hosts file resolve from the host's own ssh
      config on the bridge, so a locator can never carry a secret.
    </p>

    <label class="field">
      <span class="field-label">Name</span>
      <input
        v-model="form.name"
        class="field-input"
        type="text"
        data-testid="ssh-name"
        :disabled="disabled || !available"
        autocomplete="off"
        spellcheck="false"
      />
    </label>

    <label class="field">
      <span class="field-label">Host locator</span>
      <input
        v-model="form.endpoint"
        class="field-input"
        type="text"
        placeholder="cluster.example.edu or [cluster.example.edu]:2222"
        data-testid="ssh-endpoint"
        :disabled="disabled || !available"
        autocomplete="off"
        spellcheck="false"
      />
      <span class="field-hint">A host or a bracketed host with a port. No user, password, query or fragment.</span>
    </label>

    <div class="field-row">
      <label class="field">
        <span class="field-label">Role</span>
        <Dropdown v-model="form.role" :disabled="disabled || !available" data-testid="ssh-role">
          <DropdownItem v-for="role in roles" :key="role" :value="role">
            <span>{{ role }}</span>
          </DropdownItem>
        </Dropdown>
      </label>
      <label class="field">
        <span class="field-label">Credential reference</span>
        <input
          v-model="form.credentialRef"
          class="field-input"
          type="text"
          placeholder="credential-store reference"
          data-testid="ssh-credential-ref"
          :disabled="disabled || !available"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="field-hint">A reference, never a password, passphrase or OTP.</span>
      </label>
    </div>

    <label class="field field-check">
      <input
        v-model="form.enabled"
        class="field-checkbox"
        type="checkbox"
        data-testid="ssh-enabled"
        :disabled="disabled || !available"
      />
      <span class="field-label">Enable this profile</span>
      <span class="field-hint">A new profile starts disabled; enabling is a separate explicit action.</span>
    </label>

    <p v-if="!environmentResolved" class="form-problems" role="status" data-testid="ssh-environment-unresolved">
      <span class="form-problem">Probe the host to resolve its stable environment before saving.</span>
    </p>

    <p v-if="problems.length" class="form-problems" role="alert" data-testid="ssh-host-problems">
      <span v-for="problem in problems" :key="problem" class="form-problem">{{ problem }}</span>
    </p>

    <footer class="form-actions">
      <button type="button" class="action-button" data-testid="ssh-host-cancel" :disabled="disabled" @click="$emit('cancel')">
        Cancel
      </button>
      <button
        type="submit"
        class="action-button save"
        data-testid="ssh-host-save"
        :disabled="disabled || !available || !environmentResolved"
      >
        Save profile
      </button>
    </footer>
  </form>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { ConnectionProfileDraft, ConnectionRole } from '../../../shared/runtime/connectionProfile.js';
import { parseNewConnectionProfile } from '../../../shared/runtime/connectionProfile.js';
import type { ProtocolError } from '../../../shared/runtime/capabilities.js';

const props = withDefaults(
  defineProps<{
    /** Whether the SSH capability is available on the resolved capability entry. */
    available?: boolean;
    /** Why the capability is unavailable, rendered next to the disabled form. */
    unavailableReason?: string;
    /**
     * The stable environment UUID the probe resolved for this locator.
     *
     * A profile can only be created once the host has been probed: the environment identity is
     * the target's own UUID, never the locator, so a renamed host or a changed port cannot merge
     * two environments. Empty means the probe has not run yet.
     */
    environmentId?: string;
    disabled?: boolean;
  }>(),
  { available: true, unavailableReason: '', environmentId: '', disabled: false },
);

const emit = defineEmits<{
  (event: 'save', draft: ConnectionProfileDraft): void;
  (event: 'cancel'): void;
}>();

const roles: readonly ConnectionRole[] = ['manager', 'execution'];

const form = reactive({
  name: '',
  endpoint: '',
  role: 'manager' as ConnectionRole,
  credentialRef: '',
  enabled: false,
});

const problems = ref<readonly string[]>([]);

/**
 * Whether the host has been probed and the stable environment is known.
 *
 * The profile stores the target's own UUID; without it there is nothing stable to bind, so the
 * form says so explicitly instead of inventing an identity from the locator.
 */
const environmentResolved = computed(() => props.environmentId.trim().length > 0);

/**
 * Validate through the REAL strict parser.
 *
 * `parseNewConnectionProfile` rejects a secret-bearing or hidden field, requires the target kind
 * to match the transport kind, and defaults `enabled` to false. The form therefore never invents
 * its own notion of a valid profile, and a rejected field is reported with the parser's field
 * name so the user can fix the actual problem.
 */
function submit() {
  if (props.disabled || !props.available) return;
  if (!environmentResolved.value) {
    problems.value = ['target: probe the host to resolve its stable environment before saving'];
    return;
  }
  try {
    const draft = parseNewConnectionProfile({
      name: form.name,
      transport: { kind: 'ssh', endpoint: form.endpoint },
      target: { kind: 'ssh', environmentId: props.environmentId.trim() },
      role: form.role,
      credentialRef: form.credentialRef,
      enabled: form.enabled,
    });
    problems.value = [];
    emit('save', draft);
  } catch (error) {
    const field = error instanceof Error && 'field' in error ? String((error as ProtocolError).field) : 'profile';
    problems.value = [`${field}: ${error instanceof Error ? error.message : 'invalid profile'}`];
  }
}
</script>

<style scoped>
.ssh-host-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, var(--theme-border-muted, rgba(148, 163, 184, 0.18)));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-card-bg, var(--theme-surface-panel, rgba(30, 41, 59, 0.35)));
}

.form-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.form-title {
  font-size: var(--type-heading, 14px);
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.form-unavailable {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-status-warning, #fcd34d);
}

.form-hint {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 8px;
}

.field-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
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

.field-input:disabled {
  opacity: 0.55;
  cursor: default;
}

.field-checkbox {
  width: 14px;
  height: 14px;
  accent-color: var(--theme-accent-primary, #60a5fa);
}

.field-hint {
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.form-problems {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: var(--type-sm, 12px);
  color: var(--theme-status-error, #f87171);
  word-break: break-word;
}

.form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
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

.action-button.save {
  background: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 72%, transparent);
  border-color: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 82%, transparent);
}

.action-button:focus-visible {
  outline: 2px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 1px;
}

@media (max-width: 640px) {
  .field-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
