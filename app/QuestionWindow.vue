<template>
  <div class="question-window">
    <div class="question-header">
      <div class="question-title">Question request</div>
      <div class="question-type">{{ request.questions.length }} item(s)</div>
    </div>

    <div class="question-summary">
      <div class="question-row">
        <div class="question-label">Session</div>
        <div class="question-value">{{ request.sessionID }}</div>
      </div>
      <div v-if="request.tool" class="question-row">
        <div class="question-label">Tool</div>
        <div class="question-value">
          message {{ request.tool.messageID }}
          <span class="divider">/</span>
          call {{ request.tool.callID }}
        </div>
      </div>
    </div>

    <div class="question-body">
      <div
        v-for="(item, index) in request.questions"
        :key="`${request.id}-${index}-${item.header}`"
        class="question-section"
      >
        <div class="section-head">
          <div class="section-title">{{ item.header }}</div>
          <div class="section-mode">{{ item.multiple ? 'Multiple' : 'Single' }}</div>
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
          <input
            type="text"
            class="custom-input"
            :value="customAnswers[index] ?? ''"
            :disabled="isSubmitting"
            placeholder="Type your own answer"
            @input="updateCustom(index, $event)"
          />
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
        Reject
      </button>
      <button
        type="button"
        class="question-button is-reply"
        :disabled="isSubmitting || !canReply"
        @click="emitReply"
      >
        Reply
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

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

const props = defineProps<{
  request: QuestionRequest;
  isSubmitting?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (event: 'reply', payload: { requestId: string; answers: string[][] }): void;
  (event: 'reject', requestId: string): void;
}>();

const selectedAnswers = ref<string[][]>([]);
const customAnswers = ref<string[]>([]);

function resetAnswers() {
  selectedAnswers.value = props.request.questions.map(() => []);
  customAnswers.value = props.request.questions.map(() => '');
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
      return;
    }
    selectedAnswers.value[index] = [...current, label];
    return;
  }
  if (current.includes(label)) {
    selectedAnswers.value[index] = [];
    return;
  }
  selectedAnswers.value[index] = [label];
}

function updateCustom(index: number, event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  customAnswers.value[index] = target.value;
}

function buildAnswers() {
  return props.request.questions.map((item, index) => {
    const selected = selectedAnswers.value[index] ?? [];
    const custom = item.custom === false ? '' : (customAnswers.value[index] ?? '').trim();
    const values = custom ? [...selected, custom] : [...selected];
    return Array.from(new Set(values));
  });
}

const canReply = computed(() => buildAnswers().every((answer) => answer.length > 0));

function emitReply() {
  if (!canReply.value) return;
  emit('reply', {
    requestId: props.request.id,
    answers: buildAnswers(),
  });
}

function emitReject() {
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
  color: #d1fae5;
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
  color: #86efac;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.question-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid rgba(52, 211, 153, 0.25);
  border-radius: 8px;
  padding: 6px 8px;
  background: rgba(2, 44, 34, 0.35);
}

.question-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.question-label {
  color: #6ee7b7;
  font-size: 11px;
}

.question-value {
  color: #d1fae5;
  font-size: 11px;
  word-break: break-all;
}

.divider {
  margin: 0 4px;
  color: #34d399;
}

.question-body {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.question-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid rgba(52, 211, 153, 0.25);
  border-radius: 8px;
  padding: 8px;
  background: rgba(6, 24, 18, 0.55);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.section-title {
  color: #a7f3d0;
  font-size: 12px;
  font-weight: 700;
}

.section-mode {
  color: #6ee7b7;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.section-question {
  color: #d1fae5;
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
  border: 1px solid rgba(52, 211, 153, 0.28);
  background: rgba(2, 44, 34, 0.3);
  color: #d1fae5;
  padding: 6px 8px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
}

.option-item.selected {
  border-color: rgba(16, 185, 129, 0.8);
  background: rgba(16, 185, 129, 0.22);
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
  color: #86efac;
}

.custom-answer {
  display: flex;
}

.custom-input {
  width: 100%;
  border-radius: 8px;
  border: 1px solid rgba(52, 211, 153, 0.35);
  background: rgba(2, 44, 34, 0.55);
  color: #d1fae5;
  font-size: 11px;
  padding: 6px 8px;
}

.question-error {
  color: #fecaca;
  font-size: 11px;
}

.question-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  border-top: 1px solid rgba(52, 211, 153, 0.3);
  padding-top: 8px;
}

.question-button {
  border-radius: 8px;
  padding: 6px 10px;
  border: 1px solid rgba(52, 211, 153, 0.45);
  background: #042f2e;
  color: #d1fae5;
  font-size: 11px;
  cursor: pointer;
}

.question-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.question-button.is-reject {
  border-color: rgba(248, 113, 113, 0.6);
  background: rgba(127, 29, 29, 0.35);
}

.question-button.is-reply {
  border-color: rgba(52, 211, 153, 0.7);
  background: rgba(16, 185, 129, 0.26);
}
</style>
