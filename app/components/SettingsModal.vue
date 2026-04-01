<template>
  <dialog
    ref="dialogRef"
    class="modal-backdrop"
    @close="$emit('close')"
    @cancel.prevent
    @click.self="dialogRef?.close()"
  >
    <div class="modal">
      <header class="modal-header">
        <div class="modal-title">{{ $t('settings.title') }}</div>
        <button type="button" class="modal-close-button" @click="dialogRef?.close()">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>
      <div class="modal-body">
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">{{ $t('settings.language.label') }}</div>
            <div class="setting-description">{{ $t('settings.language.description') }}</div>
          </div>
          <select v-model="locale" class="language-select">
            <option value="en">{{ $t('settings.language.en') }}</option>
            <option value="zh-CN">{{ $t('settings.language.zhCN') }}</option>
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">{{ $t('settings.enterToSend.label') }}</div>
            <div class="setting-description">{{ $t('settings.enterToSend.description') }}</div>
          </div>
          <label class="toggle-switch">
            <input v-model="enterToSend" type="checkbox" class="toggle-input" />
            <span class="toggle-track" />
          </label>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">{{ $t('settings.showMinimizeButtons.label') }}</div>
            <div class="setting-description">{{ $t('settings.showMinimizeButtons.description') }}</div>
          </div>
          <label class="toggle-switch">
            <input v-model="showMinimizeButtons" type="checkbox" class="toggle-input" />
            <span class="toggle-track" />
          </label>
        </div>

        <div class="setting-row" :class="{ 'setting-row-disabled': !showMinimizeButtons }">
          <div class="setting-info">
            <div class="setting-label">{{ $t('settings.dockAlwaysOpen.label') }}</div>
            <div class="setting-description">{{ $t('settings.dockAlwaysOpen.description') }}</div>
          </div>
          <label
            class="toggle-switch"
            :title="showMinimizeButtons ? $t('settings.dockAlwaysOpen.label') : $t('settings.showMinimizeButtons.label')"
          >
            <input
              v-model="dockAlwaysOpen"
              type="checkbox"
              class="toggle-input"
              :disabled="!showMinimizeButtons"
            />
            <span class="toggle-track" />
          </label>
        </div>

        <div class="setting-row setting-row-stack">
          <div class="setting-info">
            <div class="setting-label">{{ $t('settings.pinnedSessionsLimit.label') }}</div>
            <div class="setting-description">{{ $t('settings.pinnedSessionsLimit.description', { limit: maxPinnedSessionsLimit }) }}</div>
          </div>
          <div class="number-setting-group">
            <input
              v-model.number="pinnedSessionsLimit"
              type="number"
              class="number-input"
              :min="minPinnedSessionsLimit"
              :max="maxPinnedSessionsLimit"
              step="1"
            />
          </div>
        </div>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useSettings } from '../composables/useSettings';
import { getLocale, setLocale } from '../i18n';
import type { Locale } from '../i18n/types';

const props = defineProps<{
  open: boolean;
}>();

defineEmits<{
  (event: 'close'): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const {
  enterToSend,
  showMinimizeButtons,
  dockAlwaysOpen,
  pinnedSessionsLimit,
  minPinnedSessionsLimit,
  maxPinnedSessionsLimit,
} = useSettings();

const locale = ref<Locale>(getLocale());
watch(locale, (newLocale) => {
  setLocale(newLocale);
});

watch(
  () => props.open,
  (open) => {
    const el = dialogRef.value;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  },
);
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
  background: rgba(2, 6, 23, 0.65);
}

.modal {
  width: min(480px, 95vw);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: rgba(15, 23, 42, 0.98);
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
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
  border: 1px solid #334155;
  border-radius: 6px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
}

.modal-close-button:hover {
  background: #1e293b;
  color: #e2e8f0;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border: 1px solid #1e293b;
  border-radius: 8px;
  background: rgba(2, 6, 23, 0.45);
}

.setting-row-stack {
  align-items: flex-start;
}

.setting-row-disabled {
  opacity: 0.55;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: #e2e8f0;
}

.setting-description {
  font-size: 11px;
  color: #64748b;
}

.number-setting-group {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.number-input {
  width: 84px;
  height: 30px;
  border: 1px solid #334155;
  border-radius: 6px;
  background: rgba(2, 6, 23, 0.6);
  color: #e2e8f0;
  font-size: 12px;
  font-family: inherit;
  text-align: right;
  padding: 0 8px;
}

.number-input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.5);
}

.number-input::-webkit-outer-spin-button,
.number-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.number-input {
  -moz-appearance: textfield;
}

.language-select {
  height: 30px;
  border: 1px solid #334155;
  border-radius: 6px;
  background: rgba(2, 6, 23, 0.6);
  color: #e2e8f0;
  font-size: 12px;
  font-family: inherit;
  padding: 0 8px;
  cursor: pointer;
}

.language-select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.5);
}


.toggle-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-track {
  width: 36px;
  height: 20px;
  background: #334155;
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #94a3b8;
  border-radius: 50%;
  transition:
    transform 0.2s,
    background 0.2s;
}

.toggle-input:checked + .toggle-track {
  background: #3b82f6;
}

.toggle-input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: #fff;
}
</style>
