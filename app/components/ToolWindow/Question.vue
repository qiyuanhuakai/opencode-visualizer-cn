<template>
  <div class="question-window">
    <div class="question-header">
      <div class="question-title">{{ $t('toolWindow.question.title') }}</div>
      <div class="question-type">{{ $t('toolWindow.question.itemCount', { count: request.questions.length }) }}</div>
    </div>

    <div class="question-summary">
      <div class="question-row">
        <div class="question-label">{{ $t('toolWindow.question.session') }}</div>
        <div class="question-value">{{ request.sessionID }}</div>
      </div>
      <div v-if="request.tool" class="question-row">
        <div class="question-label">{{ $t('toolWindow.question.tool') }}</div>
        <div class="question-value">
          {{ $t('toolWindow.question.message') }} {{ request.tool.messageID }}
          <span class="divider">/</span>
          {{ $t('toolWindow.question.call') }} {{ request.tool.callID }}
        </div>
      </div>
    </div>

    <div class="question-body">
      <div v-if="contextText" class="context-text-area">
        <MessageViewer :code="contextText" lang="markdown" :theme="DEFAULT_SYNTAX_THEME" />
      </div>

      <div
        v-for="(item, index) in request.questions"
        :key="`${request.id}-${index}-${item.header}`"
        class="question-section"
      >
        <div class="section-head">
          <div class="section-title">{{ item.header }}</div>
          <div class="section-mode">{{ item.multiple ? $t('toolWindow.question.modeMultiple') : $t('toolWindow.question.modeSingle') }}</div>
        </div>
        <div class="section-question">{{ item.question }}</div>

        <div class="option-list">
          <button
            v-for="option in item.options"
            :key="option.label"
            type="button"
            class="option-item"
            :class="{ selected: isSelected(index, option.label) }"
            :disabled="isSubmitting"
            @click="toggleOption(index, option.label, !!item.multiple)"
          >
            <span class="option-label">{{ option.label }}</span>
            <span class="option-description">{{ option.description }}</span>
          </button>
        </div>

        <div v-if="item.custom !== false" class="custom-answer">
          <textarea
            class="custom-input"
            rows="3"
            :value="customAnswers[index] ?? ''"
            :disabled="isSubmitting"
            :placeholder="$t('toolWindow.question.customAnswer')"
            @input="updateCustom(index, $event)"
          ></textarea>
        </div>
      </div>

      <div v-if="error" class="question-error">{{ error }}</div>
    </div>

    <div class="question-actions">
      <button
        type="button"
        class="question-button is-reject"
        :disabled="isSubmitting"
        @click="emitReject"
      >
        {{ $t('toolWindow.question.reject') }}
      </button>
      <button
        type="button"
        class="question-button is-reply"
        :disabled="isSubmitting || !canReply"
        @click="emitReply"
      >
        {{ $t('toolWindow.question.reply') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import MessageViewer from '../MessageViewer.vue';
import { StorageKeys, storageGetJSON, storageSetJSON } from '../../utils/storageKeys';
import { DEFAULT_SYNTAX_THEME } from '../../utils/themeTokens';
import { uniqueBy } from '../../utils/array';

type QuestionOption = {
  label: string;
  description: string;
};

type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

type QuestionDraft = {
  selectedAnswers: string[][];
  customAnswers: string[];
};

const props = defineProps<{
  request: QuestionRequest;
  contextText?: string;
  isSubmitting?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (event: 'reply', payload: { requestId: string; answers: string[][] }): void;
  (event: 'reject', requestId: string): void;
}>();

const selectedAnswers = ref<string[][]>([]);
const customAnswers = ref<string[]>([]);

// --- Draft save / restore ---

function draftStorageKey(): string {
  return StorageKeys.drafts.question;
}

function loadAllDrafts(): Record<string, QuestionDraft> {
  return storageGetJSON<Record<string, QuestionDraft>>(draftStorageKey()) ?? {};
}

function saveDraft() {
  const all = loadAllDrafts();
  all[props.request.id] = {
    selectedAnswers: selectedAnswers.value,
    customAnswers: customAnswers.value,
  };
  storageSetJSON(draftStorageKey(), all);
}

function clearDraft() {
  const all = loadAllDrafts();
  delete all[props.request.id];
  storageSetJSON(draftStorageKey(), all);
}

function restoreDraft(): boolean {
  const all = loadAllDrafts();
  const draft = all[props.request.id];
  if (!draft) return false;
  if (
    Array.isArray(draft.selectedAnswers) &&
    draft.selectedAnswers.length === props.request.questions.length
  ) {
    selectedAnswers.value = draft.selectedAnswers;
  }
  if (
    Array.isArray(draft.customAnswers) &&
    draft.customAnswers.length === props.request.questions.length
  ) {
    customAnswers.value = draft.customAnswers;
  }
  return true;
}

let draftTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDraftSave() {
  if (draftTimer !== null) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    saveDraft();
  }, 400);
}

onBeforeUnmount(() => {
  if (draftTimer !== null) {
    clearTimeout(draftTimer);
    saveDraft();
  }
});

// --- Answers ---

function resetAnswers() {
  selectedAnswers.value = props.request.questions.map(() => []);
  customAnswers.value = props.request.questions.map(() => '');
  if (!restoreDraft()) return;
}

watch(
  () => props.request.id,
  () => {
    resetAnswers();
  },
  { immediate: true },
);

function isSelected(index: number, label: string) {
  return selectedAnswers.value[index]?.includes(label) ?? false;
}

function toggleOption(index: number, label: string, multiple: boolean) {
  const current = selectedAnswers.value[index] ?? [];
  if (multiple) {
    if (current.includes(label)) {
      selectedAnswers.value[index] = current.filter((value) => value !== label);
      scheduleDraftSave();
      return;
    }
    selectedAnswers.value[index] = [...current, label];
    scheduleDraftSave();
    return;
  }
  if (current.includes(label)) {
    selectedAnswers.value[index] = [];
    scheduleDraftSave();
    return;
  }
  selectedAnswers.value[index] = [label];
  scheduleDraftSave();
}

function updateCustom(index: number, event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  customAnswers.value[index] = target.value;
  scheduleDraftSave();
}

function buildAnswers() {
  return props.request.questions.map((item, index) => {
    const selected = selectedAnswers.value[index] ?? [];
    const custom = item.custom === false ? '' : (customAnswers.value[index] ?? '').trim();
    const values = custom ? [...selected, custom] : [...selected];
    return uniqueBy(values, x => x);
  });
}

const canReply = computed(() => buildAnswers().every((answer) => answer.length > 0));

function emitReply() {
  if (!canReply.value) return;
  clearDraft();
  emit('reply', {
    requestId: props.request.id,
    answers: buildAnswers(),
  });
}

function emitReject() {
  clearDraft();
  emit('reject', props.request.id);
}
</script>

<style scoped>
.question-window {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  box-sizing: border-box;
  color: var(--theme-text-primary, #d1fae5);
  font-size: 12px;
}

.question-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.question-title {
  font-size: 13px;
  font-weight: 700;
}

.question-type {
  font-size: 11px;
  color: var(--theme-status-success, #86efac);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.question-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--theme-status-success, #86efac) 30%, transparent);
  border-radius: 8px;
  padding: 6px 8px;
  background: var(--theme-surface-success-soft, rgba(2, 44, 34, 0.35));
}

.question-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.question-label {
  color: var(--theme-text-success, #6ee7b7);
  font-size: 11px;
}

.question-value {
  color: var(--theme-text-primary, #d1fae5);
  font-size: 11px;
  word-break: break-all;
}

.divider {
  margin: 0 4px;
  color: var(--theme-status-success, #34d399);
}

.question-body {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.context-text-area {
  border: 1px solid color-mix(in srgb, var(--theme-status-success, #86efac) 24%, transparent);
  border-radius: 8px;
  padding: 8px;
  background: color-mix(in srgb, var(--theme-surface-success-soft, rgba(34, 197, 94, 0.18)) 55%, transparent);
  font-size: 12px;
  line-height: 1.4;
}

.question-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--theme-status-success, #86efac) 30%, transparent);
  border-radius: 8px;
  padding: 8px;
  background: color-mix(in srgb, var(--theme-surface-success-soft, rgba(34, 197, 94, 0.18)) 70%, transparent);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.section-title {
  color: var(--theme-text-primary, #a7f3d0);
  font-size: 12px;
  font-weight: 700;
}

.section-mode {
  color: var(--theme-text-success, #6ee7b7);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.section-question {
  color: var(--theme-text-primary, #d1fae5);
  font-size: 11px;
  line-height: 1.35;
}

.option-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.option-item {
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--theme-status-success, #86efac) 34%, transparent);
  background: color-mix(in srgb, var(--theme-surface-success-soft, rgba(34, 197, 94, 0.18)) 60%, transparent);
  color: var(--theme-text-primary, #d1fae5);
  padding: 6px 8px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
}

.option-item.selected {
  border-color: color-mix(in srgb, var(--theme-status-success, #86efac) 80%, transparent);
  background: color-mix(in srgb, var(--theme-status-success, #86efac) 22%, transparent);
}

.option-item:disabled {
  opacity: 0.65;
  cursor: wait;
}

.option-label {
  font-size: 11px;
  font-weight: 600;
}

.option-description {
  font-size: 10px;
  color: var(--theme-text-success, #86efac);
}

.custom-answer {
  display: flex;
}

.custom-input {
  width: 100%;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--theme-status-success, #86efac) 40%, transparent);
  background: color-mix(in srgb, var(--theme-surface-success-soft, rgba(34, 197, 94, 0.18)) 78%, transparent);
  color: var(--theme-text-primary, #d1fae5);
  font-size: 11px;
  padding: 6px 8px;
  min-height: 3em;
  resize: vertical;
  font-family: inherit;
  line-height: 1.4;
  box-sizing: border-box;
  outline: none;
}

.custom-input:focus {
  border-color: color-mix(in srgb, var(--theme-status-success, #86efac) 60%, transparent);
}

.question-error {
  color: var(--theme-text-danger, #fecaca);
  font-size: 11px;
}

.question-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  border-top: 1px solid color-mix(in srgb, var(--theme-status-success, #86efac) 34%, transparent);
  padding-top: 8px;
}

.question-button {
  border-radius: 8px;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-status-success, #86efac) 45%, transparent);
  background: color-mix(in srgb, var(--theme-surface-success-soft, rgba(34, 197, 94, 0.18)) 90%, #042f2e);
  color: var(--theme-text-primary, #d1fae5);
  font-size: 11px;
  cursor: pointer;
}

.question-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.question-button.is-reject {
  border-color: color-mix(in srgb, var(--theme-status-danger, #fca5a5) 60%, transparent);
  background: var(--theme-surface-danger, rgba(127, 29, 29, 0.35));
}

.question-button.is-reply {
  border-color: color-mix(in srgb, var(--theme-status-success, #86efac) 70%, transparent);
  background: color-mix(in srgb, var(--theme-status-success, #86efac) 26%, transparent);
}
</style>
