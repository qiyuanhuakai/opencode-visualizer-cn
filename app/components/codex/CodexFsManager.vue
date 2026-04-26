<template>
  <section class="codex-fs-manager" :aria-label="t('codexPanel.fsCreateFile')">
    <div class="codex-fs-toolbar">
      <button
        type="button"
        class="codex-small-text-button"
        :disabled="!api.connected.value || api.fsLoading.value"
        @click="openNewFileModal"
      >
        <Icon icon="mdi:file-plus" width="14" />
        {{ t('codexPanel.fsCreateFile') }}
      </button>
      <button
        type="button"
        class="codex-small-text-button"
        :disabled="!api.connected.value || api.fsLoading.value"
        @click="openNewFolderModal"
      >
        <Icon icon="mdi:folder-plus" width="14" />
        {{ t('codexPanel.fsCreateDirectory') }}
      </button>
    </div>

    <!-- New File Modal -->
    <div v-if="showNewFileModal" class="codex-fs-modal">
      <div class="codex-fs-modal-content">
        <div class="codex-fs-modal-header">
          <span>{{ t('codexPanel.fsNewFileTitle') }}</span>
          <button
            type="button"
            class="codex-icon-button"
            :title="t('common.close')"
            @click="closeNewFileModal"
          >
            <Icon icon="mdi:close" width="14" />
          </button>
        </div>
        <label class="codex-fs-field">
          <span>{{ t('codexPanel.fsFileNamePlaceholder') }}</span>
          <input
            v-model="newFileName"
            class="codex-input"
            type="text"
            :placeholder="t('codexPanel.fsFileNamePlaceholder')"
            @keydown.enter.prevent="submitNewFile"
          />
        </label>
        <label class="codex-fs-field">
          <span>{{ t('codexPanel.fsFileContentPlaceholder') }}</span>
          <textarea
            v-model="newFileContent"
            class="codex-input codex-fs-textarea"
            rows="6"
            :placeholder="t('codexPanel.fsFileContentPlaceholder')"
          />
        </label>
        <div class="codex-fs-modal-actions">
          <button
            type="button"
            class="codex-small-text-button"
            @click="closeNewFileModal"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="codex-primary-button"
            :disabled="!newFileName.trim() || submitting"
            @click="submitNewFile"
          >
            {{ submitting ? t('common.processing') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- New Folder Modal -->
    <div v-if="showNewFolderModal" class="codex-fs-modal">
      <div class="codex-fs-modal-content">
        <div class="codex-fs-modal-header">
          <span>{{ t('codexPanel.fsNewDirectoryTitle') }}</span>
          <button
            type="button"
            class="codex-icon-button"
            :title="t('common.close')"
            @click="closeNewFolderModal"
          >
            <Icon icon="mdi:close" width="14" />
          </button>
        </div>
        <label class="codex-fs-field">
          <span>{{ t('codexPanel.fsDirectoryNamePlaceholder') }}</span>
          <input
            v-model="newFolderName"
            class="codex-input"
            type="text"
            :placeholder="t('codexPanel.fsDirectoryNamePlaceholder')"
            @keydown.enter.prevent="submitNewFolder"
          />
        </label>
        <div class="codex-fs-modal-actions">
          <button
            type="button"
            class="codex-small-text-button"
            @click="closeNewFolderModal"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="codex-primary-button"
            :disabled="!newFolderName.trim() || submitting"
            @click="submitNewFolder"
          >
            {{ submitting ? t('common.processing') : t('common.add') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import { useCodexApi } from '../../composables/useCodexApi';

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();

const { t } = useI18n();

const showNewFileModal = ref(false);
const showNewFolderModal = ref(false);
const newFileName = ref('');
const newFileContent = ref('');
const newFolderName = ref('');
const submitting = ref(false);

function openNewFileModal() {
  newFileName.value = '';
  newFileContent.value = '';
  showNewFileModal.value = true;
}

function closeNewFileModal() {
  showNewFileModal.value = false;
  newFileName.value = '';
  newFileContent.value = '';
}

function openNewFolderModal() {
  newFolderName.value = '';
  showNewFolderModal.value = true;
}

function closeNewFolderModal() {
  showNewFolderModal.value = false;
  newFolderName.value = '';
}

function joinPath(cwd: string, name: string): string {
  if (!cwd || cwd === '/') return `/${name}`;
  if (cwd.endsWith('/')) return `${cwd}${name}`;
  return `${cwd}/${name}`;
}

async function submitNewFile() {
  const name = newFileName.value.trim();
  if (!name || submitting.value) return;
  const cwd = props.api.fsCwd.value || '/';
  const path = joinPath(cwd, name);
  submitting.value = true;
  try {
    await props.api.fsWriteFile(path, newFileContent.value);
    closeNewFileModal();
  } catch {
    // error is surfaced via api.fsError in parent
  } finally {
    submitting.value = false;
  }
}

async function submitNewFolder() {
  const name = newFolderName.value.trim();
  if (!name || submitting.value) return;
  const cwd = props.api.fsCwd.value || '/';
  const path = joinPath(cwd, name);
  submitting.value = true;
  try {
    await props.api.fsCreateDirectory(path);
    closeNewFolderModal();
  } catch {
    // error is surfaced via api.fsError in parent
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.codex-fs-manager {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.codex-fs-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.codex-fs-modal {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}

.codex-fs-modal-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  margin: 20px;
  padding: 16px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 14px;
  background: var(--theme-floating-surface-base, rgba(15, 23, 42, 0.98));
  color: var(--theme-floating-text, #e2e8f0);
  overflow: auto;
}

.codex-fs-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 700;
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-fs-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-fs-field .codex-input {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  appearance: none;
  outline: none;
  background: var(--theme-input-bg, rgba(2, 6, 23, 0.65));
  color: var(--theme-text-primary, #e2e8f0);
  padding: 0 10px;
  height: 34px;
}

.codex-fs-field .codex-input:focus {
  border-color: var(--theme-accent-primary, #60a5fa);
}

.codex-fs-textarea {
  resize: vertical;
  padding: 10px !important;
  line-height: 1.45;
  height: auto !important;
}

.codex-fs-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}

.codex-primary-button {
  height: 34px;
  padding: 0 14px;
  font-weight: 700;
  background: var(--theme-accent-primary, #2563eb);
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
}

.codex-primary-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.codex-small-text-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.82));
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
}

.codex-small-text-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.codex-icon-button {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  background: transparent;
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
}
</style>
