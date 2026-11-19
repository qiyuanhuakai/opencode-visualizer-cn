<template>
  <form class="slurm-form" data-runtime-ui data-testid="slurm-execution-form" @submit.prevent="submit">
    <header class="form-header">
      <span class="form-title">{{ rt("Slurm execution") }}</span>
      <span v-if="!available" class="form-unavailable" data-testid="slurm-form-unavailable">
        {{ rt("unavailable ·") }} {{ rt(unavailableReason) }}
      </span>
    </header>

    <p class="form-hint">
      {{ rt("Resources are requested explicitly.") }} <code>time</code> {{ rt("and") }} <code>gres</code> {{ rt("are always submitted — a blank or inherited value is never sent, so the preview is the request.") }}
    </p>

    <label class="field">
      <span class="field-label">{{ rt('Connection mode') }}</span>
      <Dropdown v-model="form.mode" :label="rt(form.mode === 'relay' ? 'Slurm stdio relay' : 'Compute TCP')" :disabled="disabled || !available" data-testid="slurm-mode">
        <DropdownItem value="relay">{{ rt('Slurm stdio relay') }}</DropdownItem>
        <DropdownItem value="tcp">{{ rt('Compute TCP') }}</DropdownItem>
      </Dropdown>
    </label>
    <label class="field">
      <span class="field-label">{{ rt('Compute working directory') }}</span>
      <input v-model="form.computeWorkingRoot" class="field-input" data-testid="slurm-working-root" required :disabled="disabled || !available" autocomplete="off" spellcheck="false" />
      <span class="field-hint">{{ rt('Existing absolute directory on the compute node.') }}</span>
    </label>
    <label class="field">
      <span class="field-label">{{ rt('Compute state directory') }}</span>
      <input v-model="form.computeStateRoot" class="field-input" data-testid="slurm-state-root" required :disabled="disabled || !available" autocomplete="off" spellcheck="false" />
      <span class="field-hint">{{ rt('Absolute directory for runtime state and installation, separate from the working directory.') }}</span>
    </label>

    <div class="field-row">
      <label class="field">
        <span class="field-label">{{ rt("Partition") }}</span>
        <input
          v-model="form.partition"
          class="field-input"
          type="text"
          data-testid="slurm-partition"
          :disabled="disabled || !available"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ rt("Account") }}</span>
        <input
          v-model="form.account"
          class="field-input"
          type="text"
          :placeholder='rt("optional")'
          data-testid="slurm-account"
          :disabled="disabled || !available"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
    </div>

    <div class="field-row">
      <label class="field">
        <span class="field-label">{{ rt("CPUs") }}</span>
        <input
          v-model.number="form.cpus"
          class="field-input"
          type="number"
          min="1"
          step="1"
          data-testid="slurm-cpus"
          :disabled="disabled || !available"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ rt("Memory") }}</span>
        <input
          v-model="form.memory"
          class="field-input"
          type="text"
          :placeholder='rt("4096 or 4096M")'
          data-testid="slurm-memory"
          :disabled="disabled || !available"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
    </div>

    <div class="field-row">
      <label class="field">
        <span class="field-label">{{ rt("Time limit") }}</span>
        <input
          v-model="form.time"
          class="field-input"
          type="text"
          placeholder="HH:MM:SS"
          data-testid="slurm-time"
          :disabled="disabled || !available"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <label class="field">
        <span class="field-label">GRES</span>
        <input
          v-model="form.gres"
          class="field-input"
          type="text"
          placeholder="none"
          data-testid="slurm-gres"
          :disabled="disabled || !available"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="field-hint">{{ rt("Explicit, never inherited.") }} <code>none</code> {{ rt("is written out.") }}</span>
      </label>
    </div>

    <label class="field">
      <span class="field-label">{{ rt("Ownership") }}</span>
      <Dropdown v-model="form.ownership" :label="rt(ownerships.find(entry => entry.value === form.ownership)?.label ?? 'Ownership')" :disabled="disabled || !available" data-testid="slurm-ownership">
        <DropdownItem v-for="entry in ownerships" :key="entry.value" :value="entry.value">
          <span>{{ rt(entry.label) }}</span>
        </DropdownItem>
      </Dropdown>
      <span class="field-hint">
        {{ rt("A borrowed allocation is never cancelled by this client, including on disconnect.") }}
      </span>
    </label>

    <label v-if="form.ownership === 'borrowed'" class="field">
      <span class="field-label">{{ rt('Existing Slurm job ID') }}</span>
      <input v-model="form.jobId" class="field-input" data-testid="slurm-job-id" required inputmode="numeric" pattern="[0-9]+" :disabled="disabled || !available" autocomplete="off" />
      <span class="field-hint">{{ rt('Use a running allocation with enough resources for the compute service and relay reserve.') }}</span>
    </label>

    <section
      v-if="preview"
      class="resource-preview"
      data-testid="slurm-resource-preview"
      :data-bound="String(previewDescribesDraft)"
      :data-stale="String(preview !== null && !previewDescribesDraft)"
      :data-nodes="preview.nodes"
      :data-ntasks="preview.ntasks"
      :data-cpus="preview.cpus"
      :data-memory-mib="preview.memoryMiB"
      :data-time-seconds="preview.timeSeconds"
      :data-gres="preview.gres"
      :data-requests-gpu="String(preview.requestsGpu)"
      :data-partition="preview.partition"
      :data-account="preview.account ?? ''"
    >
      <span class="preview-title">{{ rt("Submission preview") }}</span>
      <dl class="preview-grid">
        <div class="preview-cell">
          <dt>{{ rt("Nodes / tasks") }}</dt>
          <dd data-testid="slurm-preview-nodes">{{ preview.nodes }} / {{ preview.ntasks }}</dd>
        </div>
        <div class="preview-cell">
          <dt>{{ rt("CPUs") }}</dt>
          <dd data-testid="slurm-preview-cpus">{{ preview.cpus }}</dd>
        </div>
        <div class="preview-cell">
          <dt>{{ rt("Memory") }}</dt>
          <dd data-testid="slurm-preview-memory">{{ preview.memory }} ({{ preview.memoryMiB }} MiB)</dd>
        </div>
        <div class="preview-cell">
          <dt>{{ rt("Time limit") }}</dt>
          <dd data-testid="slurm-preview-time">{{ timePreview }}</dd>
        </div>
        <div class="preview-cell">
          <dt>GRES</dt>
          <dd data-testid="slurm-preview-gres">{{ preview.gres }}</dd>
        </div>
        <div class="preview-cell">
          <dt>{{ rt("Account") }}</dt>
          <dd data-testid="slurm-preview-account">{{ preview.account ?? '—' }}</dd>
        </div>
      </dl>
      <p class="preview-note" data-testid="slurm-preview-note">
        {{ rt(previewNote) }}
      </p>
      <p v-if="previewStale" class="preview-stale" role="status" data-testid="slurm-preview-stale">
        {{ rt("This preview no longer describes the request above. Submit is disabled until a preview for the current resources arrives.") }}
      </p>
    </section>

    <p v-if="problems.length" class="form-problems" role="alert" data-testid="slurm-form-problems">
      <span v-for="problem in problems" :key="problem" class="form-problem">{{ rt(problem) }}</span>
    </p>

    <footer class="form-actions">
      <button type="button" class="action-button" data-testid="slurm-form-cancel" :disabled="disabled" @click="$emit('cancel')">
        {{ rt("Cancel") }}
      </button>
      <button
        type="submit"
        class="action-button save"
        data-testid="slurm-form-submit"
        :disabled="disabled || !available || preview === null || !deploymentReady || !previewDescribesDraft"
      >
        {{ rt("Submit") }}
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
import type { SlurmOwnership, SlurmResourceInput, SlurmResourcePreview } from '../../composables/useRuntimeProfiles';
import { slurmMemoryMiB, slurmTimePreview, slurmTimeSeconds, validateSlurmResourceInput } from '../../composables/useRuntimeProfiles';
import type { ManagedSlurmRequest } from '../../composables/useManagedRemote';

const props = withDefaults(
  defineProps<{
    available?: boolean;
    unavailableReason?: string;
    /** The bridge-produced preview for the current request. Rendered as-is, never re-derived. */
    preview?: SlurmResourcePreview | null;
    disabled?: boolean;
  }>(),
  { available: true, unavailableReason: '', preview: null, disabled: false },
);

const emit = defineEmits<{
  (event: 'submit', request: ManagedSlurmRequest): void;
  (event: 'cancel'): void;
  (event: 'preview-request', draft: Readonly<{ resources: SlurmResourceInput; ownership: SlurmOwnership }>): void;
}>();

const ownerships: readonly { value: SlurmOwnership; label: string }[] = Object.freeze([
  { value: 'owned', label: 'Owned — this client may stop it' },
  { value: 'borrowed', label: 'Borrowed — never cancelled by this client' },
]);

const form = reactive({
  partition: '',
  account: '',
  cpus: 1,
  memory: '',
  time: '',
  gres: 'none',
  ownership: 'owned' as SlurmOwnership,
  mode: 'relay',
  computeWorkingRoot: '',
  computeStateRoot: '',
  jobId: '',
});

const problems = ref<readonly string[]>([]);
const deploymentReady = computed(() =>
  (form.mode === 'relay' || form.mode === 'tcp')
  && form.computeWorkingRoot.trim().startsWith('/')
  && form.computeStateRoot.trim().startsWith('/')
  && form.computeWorkingRoot.trim() !== form.computeStateRoot.trim()
  && (form.ownership === 'owned' || /^\d+$/u.test(form.jobId.trim())));

/** The request the form would submit right now, normalized exactly the way `submit` sends it. */
const draft = computed<SlurmResourceInput>(() => Object.freeze({
  partition: form.partition,
  account: form.account.trim().length === 0 ? null : form.account.trim(),
  cpus: form.cpus,
  memory: form.memory,
  time: form.time,
  gres: form.gres,
}));

/**
 * Whether the bridge preview on screen describes the request the form would submit.
 *
 * `memoryMiB` and `timeSeconds` are read out of the draft by the ONE normalizer
 * (`shared/runtime/slurmResources.js` — the same code the bridge runs to build the preview), never
 * by a second parse written here. Two parsers for one value are two truths that drift: the local
 * `parseInt` read `8G` as 8 while the bridge reads 8192 MiB, so a preview answering `8` still
 * looked like a match after the field became `8G` (submitting 8192 MiB behind an 8 MiB preview),
 * and a correct 8192 MiB preview was refused as stale. The local colon-split also rejected the
 * bridge's own legal shorthand `60`. A preview that answers a DIFFERENT request — an older memory
 * unit, an unreadable wall-clock, or a superseded draft whose answer has not landed — is stale, and
 * a stale preview refuses the submit rather than sending a request the user cannot see.
 */
const previewDescribesDraft = computed<boolean>(() => {
  const current = props.preview;
  if (current === null) return false;
  const resources = draft.value;
  return current.partition === resources.partition
    && current.cpus === resources.cpus
    && current.memoryMiB === slurmMemoryMiB(resources.memory)
    && current.timeSeconds === slurmTimeSeconds(resources.time)
    && current.gres === resources.gres
    && current.account === resources.account;
});

const previewStale = computed<boolean>(() => props.preview !== null && !previewDescribesDraft.value);

const timePreview = computed(() => (props.preview === null ? '' : slurmTimePreview(props.preview)));

const previewNote = computed(() => {
  if (props.preview === null) return '';
  if (props.preview.requestsGpu) {
    return 'This request asks for a GPU. A GPU request is never implied; it comes from the explicit GRES above.';
  }
  return 'No GPU is requested. GRES is written explicitly as none.';
});

// Every edit asks the container for a preview of the FULL draft, so the bridge-produced preview can
// be re-bound to what is about to be submitted instead of left describing an older request.
watch([draft, () => form.ownership], () => {
  emit('preview-request', { resources: draft.value, ownership: form.ownership });
});

function submit() {
  if (props.disabled || !props.available) return;
  if (!deploymentReady.value || (form.mode !== 'relay' && form.mode !== 'tcp')) {
    problems.value = ['Specify distinct absolute compute directories and a valid job ID for a borrowed allocation.'];
    return;
  }
  const resources = draft.value;
  const invalid = validateSlurmResourceInput(resources);
  if (invalid.length > 0) {
    problems.value = Object.freeze(invalid.map((field) => rt('{field} is required', { field: rt(field) })));
    return;
  }
  if (props.preview === null) {
    problems.value = Object.freeze(['the bridge preview has not arrived yet — nothing is submitted without it']);
    return;
  }
  if (!previewDescribesDraft.value) {
    problems.value = Object.freeze(['the preview no longer describes this request — refresh it before submitting']);
    return;
  }
  problems.value = [];
  emit('submit', {
    resources, ownership: form.ownership, mode: form.mode,
    computeWorkingRoot: form.computeWorkingRoot.trim(), computeStateRoot: form.computeStateRoot.trim(),
    ...(form.ownership === 'borrowed' ? { jobId: form.jobId.trim() } : {}),
  });
}
</script>

<style scoped>
.slurm-form {
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

.form-hint code {
  font-family: var(--app-monospace-font-family);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
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

.field-hint {
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.field-hint code {
  font-family: var(--app-monospace-font-family);
}

.resource-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
}

.preview-title {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-text-muted, #94a3b8);
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px 10px;
  margin: 0;
}

.preview-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.preview-cell dt {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.preview-cell dd {
  margin: 0;
  font-family: var(--app-monospace-font-family);
  font-size: var(--type-sm, 12px);
  color: var(--theme-text-primary, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-note {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.preview-stale {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--codex-status-warning, var(--theme-text-primary));
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
  .field-row,
  .preview-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
