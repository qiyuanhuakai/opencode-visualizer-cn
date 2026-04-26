<template>
  <section class="codex-feedback-uploader" :aria-label="t('codexPanel.feedbackTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.feedbackTitle') }}</span>
    </div>

    <form class="codex-feedback-form" @submit.prevent="handleSubmit">
      <label class="codex-feedback-field">
        <span>{{ t('codexPanel.feedbackClassification') }}</span>
        <select
          v-model="classification"
          class="codex-input"
          :disabled="!api.connected.value || submitting"
          required
        >
          <option value="">—</option>
          <option value="bug">Bug</option>
          <option value="feature_request">Feature Request</option>
          <option value="performance">Performance</option>
          <option value="other">Other</option>
        </select>
      </label>

      <label class="codex-feedback-field">
        <span>{{ t('codexPanel.feedbackReason') }}</span>
        <textarea
          v-model="reason"
          class="codex-input codex-feedback-textarea"
          :disabled="!api.connected.value || submitting"
          rows="4"
        />
      </label>

      <label class="codex-feedback-field">
        <span>{{ t('codexPanel.feedbackLogs') }}</span>
        <textarea
          v-model="logs"
          class="codex-input codex-feedback-textarea"
          :disabled="!api.connected.value || submitting"
          rows="6"
        />
      </label>

      <div class="codex-feedback-actions">
        <button
          type="submit"
          class="codex-primary-button"
          :disabled="!api.connected.value || submitting || !classification"
        >
          {{ submitting ? t('common.processing') : t('common.submit') }}
        </button>
      </div>
    </form>

    <div v-if="status === 'success'" class="codex-feedback-message is-success">
      <Icon icon="mdi:check-circle" width="16" />
      {{ t('common.success') }}
    </div>
    <div v-else-if="status === 'error'" class="codex-feedback-message is-error">
      <Icon icon="mdi:alert-circle" width="16" />
      {{ errorMessage }}
    </div>

    <div v-if="!api.connected.value" class="codex-empty">
      {{ t('codexPanel.connectToLoad') }}
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { CodexFeedbackUploadParams } from '../../backends/codex/codexAdapter';
import { useCodexApi } from '../../composables/useCodexApi';

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();

const { t } = useI18n();

const classification = ref('');
const reason = ref('');
const logs = ref('');
const submitting = ref(false);
const status = ref<'idle' | 'success' | 'error'>('idle');
const errorMessage = ref('');

async function handleSubmit() {
  if (!props.api.connected.value || submitting.value || !classification.value) return;

  status.value = 'idle';
  errorMessage.value = '';
  submitting.value = true;

  const params: CodexFeedbackUploadParams = {
    classification: classification.value,
    reason: reason.value || undefined,
    logs: logs.value || undefined,
  };

  try {
    await props.api.uploadFeedback(params);
    status.value = 'success';
    classification.value = '';
    reason.value = '';
    logs.value = '';
  } catch (err) {
    status.value = 'error';
    errorMessage.value = err instanceof Error ? err.message : t('common.error');
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.codex-feedback-uploader {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-feedback-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.codex-feedback-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-feedback-field .codex-input {
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

.codex-feedback-field .codex-input:focus {
  border-color: var(--theme-accent-primary, #60a5fa);
}

.codex-feedback-textarea {
  resize: vertical;
  padding: 10px !important;
  line-height: 1.45;
  height: auto !important;
}

.codex-feedback-field select.codex-input {
  cursor: pointer;
}

.codex-feedback-actions {
  display: flex;
  justify-content: flex-end;
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

.codex-feedback-message {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 12px;
}

.codex-feedback-message.is-success {
  color: var(--theme-status-success, #4ade80);
  background: rgba(6, 78, 59, 0.2);
}

.codex-feedback-message.is-error {
  color: var(--theme-status-error, #f87171);
  background: rgba(127, 29, 29, 0.22);
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}
</style>
