<template>
  <dialog
    ref="dialogRef"
    class="modal-backdrop"
    @close="$emit('close')"
    @pointerdown.stop
    @click.self="dialogRef?.close()"
  >
    <div class="modal">
      <header class="modal-header">
        <div class="modal-title">{{ $t('projectSettings.title') }}</div>
        <button type="button" class="modal-close-button" @click="dialogRef?.close()">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>
      <form class="modal-body" @submit.prevent="handleSubmit">
        <div class="field">
          <label class="field-label">{{ $t('projectSettings.name') }}</label>
          <div class="name-row">
            <input v-model="form.name" type="text" class="field-input" :placeholder="defaultName" />
            <button
              type="button"
              class="sync-button"
              :disabled="!packageJsonName"
              :title="
                packageJsonName
                  ? `${$t('projectSettings.syncFromPackage')}: ${packageJsonName}`
                  : $t('projectSettings.syncFromPackage')
              "
              @click="form.name = packageJsonName!"
            >
              <Icon icon="lucide:refresh-cw" :width="14" :height="14" />
            </button>
          </div>
        </div>

        <div class="field">
          <label class="field-label">{{ $t('projectSettings.icon') }}</label>
          <div class="icon-row">
            <div
              class="icon-preview"
              :class="{ 'drag-over': dragOver, 'has-icon': !!form.iconUrl }"
              @drop.prevent="handleDrop"
              @dragover.prevent="dragOver = true"
              @dragleave="dragOver = false"
              @click="form.iconUrl ? clearIcon() : iconInput?.click()"
            >
              <img v-if="form.iconUrl" :src="form.iconUrl" :alt="$t('projectSettings.iconAlt')" class="icon-image" />
              <span v-else class="icon-letter" :style="avatarStyle">{{ avatarLetter }}</span>
              <div v-if="form.iconUrl" class="icon-overlay delete">
                <Icon icon="lucide:trash-2" :width="20" :height="20" />
              </div>
              <div v-else class="icon-overlay upload">
                <Icon icon="lucide:upload" :width="20" :height="20" />
              </div>
            </div>
            <input
              ref="iconInput"
              type="file"
              accept="image/*"
              class="hidden-input"
              @change="handleFileInput"
            />
            <div class="icon-hint">
              <span>{{ $t('projectSettings.dropHint') }}</span>
              <span>{{ $t('projectSettings.sizeHint') }}</span>
            </div>
          </div>
        </div>

        <div v-if="!form.iconUrl" class="field">
          <label class="field-label">{{ $t('projectSettings.color') }}</label>
          <div class="color-row">
            <button
              v-for="c in COLOR_KEYS"
              :key="c"
              type="button"
              class="color-swatch"
              :class="{ selected: form.color === c }"
              :aria-pressed="form.color === c"
              :aria-label="c"
              @click="form.color = c"
            >
              <span class="swatch-letter" :style="swatchStyle(c)">{{ avatarLetter }}</span>
            </button>
          </div>
        </div>

        <div class="field">
          <label class="field-label">{{ $t('projectSettings.startupScript') }}</label>
          <textarea
            v-model="form.startup"
            class="field-textarea"
            :placeholder="$t('projectSettings.startupPlaceholder')"
            rows="2"
            spellcheck="false"
          />
          <span class="field-description">{{ $t('projectSettings.startupScriptHint') }}</span>
        </div>

        <div class="modal-actions">
          <button type="submit" class="action-button save" :disabled="saving">
            {{ saving ? $t('projectSettings.saving') : $t('projectSettings.save') }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import { Icon } from '@iconify/vue';
import * as opencodeApi from '../utils/opencode';

const COLOR_KEYS = ['pink', 'mint', 'orange', 'purple', 'cyan', 'lime'] as const;

const COLOR_HEX: Record<string, { text: string; bg: string }> = {
  pink: { text: '#e34ba9', bg: '#501b3f' },
  mint: { text: '#95f3d9', bg: '#033a34' },
  orange: { text: '#ff802b', bg: '#5f2a06' },
  purple: { text: '#9d5bd2', bg: '#432155' },
  cyan: { text: '#369eff', bg: '#0f3058' },
  lime: { text: '#c4f042', bg: '#2b3711' },
};

const props = defineProps<{
  open: boolean;
  projectId: string;
  worktree: string;
  name?: string;
  iconColor?: string;
  iconOverride?: string;
  commandsStart?: string;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (
    event: 'save',
    payload: {
      projectId: string;
      worktree: string;
      name: string;
      icon: { color: string; override: string };
      commands: { start: string };
    },
  ): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const iconInput = ref<HTMLInputElement | null>(null);
const saving = ref(false);
const dragOver = ref(false);
const packageJsonName = ref<string | undefined>(undefined);

const form = reactive({
  name: '',
  color: 'pink' as string,
  iconUrl: '',
  startup: '',
});

const defaultName = computed(() => {
  const w = props.worktree || '';
  const parts = w.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || w;
});

const avatarLetter = computed(() => {
  const name = form.name.trim() || defaultName.value;
  // For scoped packages like "@scope/foo", use the basename part
  const basename = name.replace(/^@[^/]*\//, '');
  return (basename.charAt(0) || name.charAt(0)).toUpperCase();
});

const avatarStyle = computed(() => {
  const c = COLOR_HEX[form.color];
  if (!c) return {};
  return { color: c.text, backgroundColor: c.bg };
});

function swatchStyle(key: string) {
  const c = COLOR_HEX[key];
  if (!c) return {};
  return { color: c.text, backgroundColor: c.bg };
}

watch(
  () => props.open,
  (open) => {
    const el = dialogRef.value;
    if (!el) return;
    if (open) {
      form.name = props.name || defaultName.value;
      form.color = props.iconColor || 'pink';
      form.iconUrl = props.iconOverride || '';
      form.startup = props.commandsStart || '';
      saving.value = false;
      dragOver.value = false;
      packageJsonName.value = undefined;
      if (!el.open) el.showModal();
      void fetchPackageJsonName();
    } else if (el.open) {
      el.close();
    }
  },
);

async function fetchPackageJsonName() {
  if (!props.worktree) return;
  try {
    const result = (await opencodeApi.readFileContent({
      directory: props.worktree,
      path: 'package.json',
    })) as { content?: string; encoding?: string } | string;
    const content = typeof result === 'string' ? result : result?.content;
    if (!content) return;
    const isBase64 = typeof result !== 'string' && result?.encoding === 'base64';
    const decoded = isBase64 ? atob(content) : content;
    const parsed = JSON.parse(decoded);
    const name = parsed?.name;
    if (typeof name === 'string' && name.trim()) {
      packageJsonName.value = name.trim();
    }
  } catch {
    // package.json not found or invalid — leave button disabled
  }
}

function handleFileSelect(file: File) {
  if (!file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    form.iconUrl = (e.target?.result as string) || '';
  };
  reader.readAsDataURL(file);
}

function handleDrop(e: DragEvent) {
  dragOver.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) handleFileSelect(file);
}

function handleFileInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) handleFileSelect(file);
  input.value = '';
}

function clearIcon() {
  form.iconUrl = '';
}

async function handleSubmit() {
  saving.value = true;
  try {
    const name = form.name.trim() === defaultName.value ? '' : form.name.trim();
    emit('save', {
      projectId: props.projectId,
      worktree: props.worktree,
      name,
      icon: { color: form.color, override: form.iconUrl },
      commands: { start: form.startup.trim() },
    });
  } finally {
    saving.value = false;
  }
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
  width: min(480px, 95vw);
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
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 6px;
  background: var(--theme-modal-control-bg, transparent);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  cursor: pointer;
}

.modal-close-button:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, #1e293b));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.name-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
}

.name-row .field-input {
  flex: 1 1 auto;
  min-width: 0;
}

.sync-button {
  flex: 0 0 auto;
  width: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid var(--ui-form-button-border);
  border-radius: 8px;
  background: var(--ui-form-button-bg);
  color: var(--ui-form-button-text);
  cursor: pointer;
}

.sync-button:hover:not(:disabled) {
  background: var(--ui-form-button-hover-bg);
  color: var(--ui-form-button-text);
}

.sync-button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.field-input,
.field-textarea {
  appearance: none;
  -webkit-appearance: none;
  background: var(--ui-form-control-bg);
  border: 1px solid var(--ui-form-control-border);
  border-radius: 8px;
  color: var(--ui-form-control-text);
  font-family: inherit;
  font-size: 13px;
  padding: 8px 10px;
  outline: none;
}

.field-input::placeholder,
.field-textarea::placeholder {
  color: var(--ui-form-control-placeholder);
  opacity: 1;
}

.field-input:focus,
.field-textarea:focus {
  border-color: var(--ui-form-control-focus-border);
  background: var(--ui-form-control-bg);
  box-shadow: var(--ui-form-control-focus-ring);
}

.field-textarea {
  resize: vertical;
  min-height: 40px;
}

.field-description {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
}

/* Icon preview */
.icon-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.icon-preview {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  border: 1px solid var(--theme-card-border, var(--theme-modal-border, #334155));
  background: var(--theme-card-bg, var(--theme-modal-control-bg, rgba(15, 23, 42, 0.72)));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--theme-card-border, var(--theme-border-default, #334155)) 25%, transparent);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-preview.drag-over {
  border-color: var(--theme-action-button-accent-border, var(--theme-modal-accent, #3b82f6));
  background: color-mix(
    in srgb,
    var(--theme-action-button-accent-bg, var(--theme-modal-accent, #3b82f6)) 45%,
    var(--theme-card-bg, var(--theme-modal-control-bg, rgba(15, 23, 42, 0.72)))
  );
}

.icon-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.icon-letter {
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
}

.icon-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--theme-modal-control-bg, rgba(15, 23, 42, 0.85)) 88%, transparent);
  opacity: 0;
  transition: opacity 0.15s;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  border-radius: 7px;
}

.icon-preview:hover .icon-overlay {
  opacity: 1;
}

.icon-hint {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--theme-modal-text-muted, #64748b);
}

.hidden-input {
  display: none;
}

/* Color swatches */
.color-row {
  display: flex;
  gap: 6px;
}

.color-swatch {
  width: 40px;
  height: 40px;
  padding: 3px;
  appearance: none;
  -webkit-appearance: none;
  border-radius: 10px;
  border: 2px solid transparent;
  background: transparent;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s;
}

.color-swatch:hover {
  border-color: var(--theme-badge-border, var(--theme-border-strong, #475569));
}

.color-swatch.selected {
  border-color: var(--theme-badge-accent-border, var(--theme-modal-accent, #475569));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-badge-accent-bg, var(--theme-modal-active-bg, rgba(30, 64, 175, 0.2))) 75%, transparent);
}

.swatch-letter {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: 6px;
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
}

/* Actions */
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.action-button {
  appearance: none;
  -webkit-appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  border: 1px solid var(--ui-form-button-border);
  border-radius: 8px;
  padding: 6px 16px;
  font-size: 13px;
  line-height: 1.2;
  font-family: inherit;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease,
    opacity 0.15s ease;
}

.action-button.save {
  background: var(--theme-action-button-accent-bg, color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 18%, transparent));
  color: var(--theme-action-button-accent-text, var(--theme-modal-active-text, var(--theme-text-primary, #dbeafe)));
  border-color: var(--theme-action-button-accent-border, var(--theme-modal-accent, var(--theme-border-accent, rgba(96, 165, 250, 0.35))));
  font-weight: 600;
}

.action-button.save:hover:not(:disabled) {
  background: color-mix(
    in srgb,
    var(--theme-action-button-accent-bg, var(--theme-modal-active-bg, rgba(30, 64, 175, 0.45))) 82%,
    var(--theme-modal-accent, #60a5fa)
  );
}

.action-button.save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
