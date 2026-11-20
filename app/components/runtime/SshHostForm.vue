<template>
  <form class="ssh-host-form" data-runtime-ui data-testid="ssh-host-form" @submit.prevent="submit">
    <header class="form-header">
      <span class="form-title">{{ rt(transportKind === 'slurm' ? 'Slurm cluster profile' : 'SSH host profile') }}</span>
      <span v-if="!available" class="form-unavailable" data-testid="ssh-host-unavailable">
        {{ rt("unavailable ·") }} {{ rt(unavailableReason) }}
      </span>
    </header>

    <p v-if="transportKind === 'ssh'" class="form-hint">
      {{ rt("The profile stores a locator and a credential reference only. User, identity files, proxy jump/command, host key checking and the known-hosts file resolve from the host\u0027s own ssh config on the bridge, so a locator can never carry a secret.") }}
    </p>
    <p v-else class="form-hint">{{ rt('Configure the Slurm cluster managed by this login Bridge. The cluster identity is stored with the profile and used by its compute runtimes.') }}</p>

    <label class="field">
      <span class="field-label">{{ rt("Name") }}</span>
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
      <span class="field-label">{{ rt(transportKind === 'slurm' ? 'Login host' : 'Host locator') }}</span>
      <input
        v-model="form.endpoint"
        class="field-input"
        type="text"
        :placeholder="transportKind === 'slurm' ? 'localhost' : rt('cluster.example.edu or [cluster.example.edu]:2222')"
        data-testid="ssh-endpoint"
        :disabled="disabled || !available"
        autocomplete="off"
        spellcheck="false"
      />
      <span class="field-hint">{{ rt(transportKind === 'slurm' ? 'Use the current login host name or localhost.' : 'A host or a bracketed host with a port. No user, password, query or fragment.') }}</span>
    </label>

    <label class="field">
      <span class="field-label">{{ rt(transportKind === 'slurm' ? 'Cluster environment UUID' : 'Existing Bridge environment UUID') }}</span>
      <input v-model="form.environmentId" class="field-input" data-testid="ssh-environment-id" required :disabled="disabled || !available" autocomplete="off" spellcheck="false" />
      <span class="field-hint">{{ rt(transportKind === 'slurm' ? 'Keep this identity stable for reconnects and existing jobs.' : 'Copy the environment UUID from the remote Bridge runtime information. It must match the live target.') }}</span>
    </label>
    <button v-if="transportKind === 'slurm'" type="button" class="action-button" data-testid="slurm-generate-environment" :disabled="disabled || !available" @click="generateEnvironment">{{ rt('Generate cluster identity') }}</button>

    <div class="field-row">
      <label class="field">
        <span class="field-label">{{ rt("Role") }}</span>
        <Dropdown v-model="form.role" :label="rt(form.role)" :disabled="disabled || !available" data-testid="ssh-role">
          <DropdownItem v-for="role in roles" :key="role" :value="role">
            <span>{{ rt(role) }}</span>
          </DropdownItem>
        </Dropdown>
      </label>
      <label class="field">
        <span class="field-label">{{ rt("Credential reference") }}</span>
        <input
          v-model="form.credentialRef"
          class="field-input"
          type="text"
          :placeholder='rt("credential-store reference")'
          data-testid="ssh-credential-ref"
          :disabled="disabled || !available"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="field-hint">{{ rt("A reference, never a password, passphrase or OTP.") }}</span>
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
      <span class="field-label">{{ rt("Enable this profile") }}</span>
      <span class="field-hint">{{ rt("A new profile starts disabled; enabling is a separate explicit action.") }}</span>
    </label>

    <p v-if="!environmentResolved" class="form-problems" role="status" data-testid="ssh-environment-unresolved">
      <span class="form-problem">{{ rt('Enter a valid environment UUID before saving.') }}</span>
    </p>

    <p v-if="problems.length" class="form-problems" role="alert" data-testid="ssh-host-problems">
      <span v-for="problem in problems" :key="problem" class="form-problem">{{ rt(problem) }}</span>
    </p>

    <footer class="form-actions">
      <button type="button" class="action-button" data-testid="ssh-host-cancel" :disabled="disabled" @click="$emit('cancel')">
        {{ rt("Cancel") }}
      </button>
      <button
        type="submit"
        class="action-button save"
        data-testid="ssh-host-save"
        :disabled="disabled || !available || !environmentResolved"
      >
        {{ rt("Save profile") }}
      </button>
    </footer>
  </form>
</template>

<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { computed, reactive, ref, watch } from 'vue';
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
    transportKind?: 'ssh' | 'slurm';
    disabled?: boolean;
  }>(),
  { available: true, unavailableReason: '', environmentId: '', transportKind: 'ssh', disabled: false },
);

const emit = defineEmits<{
  (event: 'save', draft: ConnectionProfileDraft): void;
  (event: 'cancel'): void;
}>();

const roles: readonly ConnectionRole[] = ['manager', 'execution'];

const form = reactive({
  name: '',
  endpoint: '',
  role: (props.transportKind === 'slurm' ? 'execution' : 'manager') as ConnectionRole,
  credentialRef: '',
  enabled: false,
  environmentId: props.environmentId,
});
watch(() => props.environmentId, (value, previous) => {
  if (!form.environmentId || form.environmentId === previous) form.environmentId = value;
});

const problems = ref<readonly string[]>([]);
function generateEnvironment(): void {
  if (props.transportKind === 'slurm' && !props.disabled && props.available) form.environmentId = crypto.randomUUID();
}

/**
 * Whether the host has been probed and the stable environment is known.
 *
 * The profile stores the target's own UUID; without it there is nothing stable to bind, so the
 * form says so explicitly instead of inventing an identity from the locator.
 */
const environmentResolved = computed(() => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(form.environmentId.trim()));

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
    problems.value = ['Enter a valid environment UUID before saving.'];
    return;
  }
  try {
    const draft = parseNewConnectionProfile({
      name: form.name,
      transport: { kind: props.transportKind, endpoint: form.endpoint },
      target: props.transportKind === 'slurm'
        ? { kind: 'slurm', clusterEnvironmentId: form.environmentId.trim() }
        : { kind: 'ssh', environmentId: form.environmentId.trim() },
      role: form.role,
      credentialRef: form.credentialRef,
      enabled: form.enabled,
    });
    problems.value = [];
    emit('save', draft);
  } catch (error) {
    const field = error instanceof Error && 'field' in error ? String((error as ProtocolError).field) : 'profile';
    if (field === 'transport.endpoint') {
      problems.value = [props.transportKind === 'slurm'
        ? 'Use the current login host name or localhost.'
        : 'A host or a bracketed host with a port. No user, password, query or fragment.'];
      return;
    }
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
  color: var(--codex-status-warning, var(--theme-text-primary));
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
  border: 1px solid var(--theme-form-control-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: var(--theme-form-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72)));
  color: var(--theme-form-control-text, var(--theme-text-primary, #e2e8f0));
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
  color: var(--codex-status-danger, var(--theme-text-primary));
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
  border: 1px solid var(--theme-form-control-border, var(--theme-border-default, #334155));
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
