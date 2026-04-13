<template>
  <div class="permission-window">
    <div class="permission-header">
      <div class="permission-title">{{ $t('toolWindow.permission.title') }}</div>
      <div class="permission-type">{{ request.permission }}</div>
    </div>
    <div class="permission-summary">
      <div class="permission-row">
        <div class="permission-label">{{ $t('toolWindow.permission.session') }}</div>
        <div class="permission-value">{{ request.sessionID }}</div>
      </div>
      <div v-if="request.tool" class="permission-row">
        <div class="permission-label">{{ $t('toolWindow.permission.tool') }}</div>
        <div class="permission-value">
          {{ $t('toolWindow.permission.message') }} {{ request.tool.messageID }}
          <span class="divider">/</span>
          {{ $t('toolWindow.permission.call') }} {{ request.tool.callID }}
        </div>
      </div>
      <div class="permission-row">
        <div class="permission-label">{{ $t('toolWindow.permission.items') }}</div>
        <div class="permission-value">
          {{ $t('toolWindow.permission.patternsTitle') }} {{ request.patterns.length }}
          <span class="divider">/</span>
          {{ $t('toolWindow.permission.metadataTitle') }} {{ metadataEntries.length }}
          <span v-if="request.always.length > 0">
            <span class="divider">/</span>
            {{ $t('toolWindow.permission.alwaysAllow') }} {{ request.always.length }}
          </span>
        </div>
      </div>
    </div>

    <div class="permission-body">
      <div class="permission-section">
        <div class="section-title">{{ $t('toolWindow.permission.patternsTitle') }} ({{ request.patterns.length }})</div>
        <ul class="pattern-list">
          <li v-for="pattern in request.patterns" :key="pattern">{{ pattern }}</li>
          <li v-if="request.patterns.length === 0" class="empty">{{ $t('toolWindow.permission.none') }}</li>
        </ul>
      </div>

      <div class="permission-section">
        <div class="section-title">{{ $t('toolWindow.permission.metadataTitle') }} ({{ metadataEntries.length }})</div>
        <div v-if="metadataEntries.length === 0" class="empty">{{ $t('toolWindow.permission.none') }}</div>
        <div v-for="entry in metadataEntries" :key="entry[0]" class="metadata-row">
          <div class="metadata-key">{{ entry[0] }}</div>
          <div class="metadata-value">{{ formatInlineValue(entry[1]) }}</div>
        </div>
      </div>

      <div v-if="request.always.length > 0" class="permission-section">
        <div class="section-title">{{ $t('toolWindow.permission.alwaysAllow') }} ({{ request.always.length }})</div>
        <ul class="pattern-list">
          <li v-for="pattern in request.always" :key="pattern">{{ pattern }}</li>
        </ul>
      </div>

      <div v-if="error" class="permission-error">{{ error }}</div>
    </div>

    <div class="permission-actions">
      <button
        type="button"
        class="permission-button is-once"
        :disabled="isSubmitting"
        @click="emitReply('once')"
      >
        {{ $t('toolWindow.permission.once') }}
      </button>
      <button
        type="button"
        class="permission-button is-always"
        :disabled="isSubmitting"
        @click="emitReply('always')"
      >
        {{ $t('toolWindow.permission.always') }}
      </button>
      <button
        type="button"
        class="permission-button is-reject"
        :disabled="isSubmitting"
        @click="emitReply('reject')"
      >
        {{ $t('toolWindow.permission.reject') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

type PermissionReply = 'once' | 'always' | 'reject';

const props = defineProps<{
  request: PermissionRequest;
  isSubmitting?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (event: 'reply', payload: { requestId: string; reply: PermissionReply }): void;
}>();

const metadataEntries = computed(() => Object.entries(props.request.metadata ?? {}));

function formatInlineValue(value: unknown) {
  if (typeof value === 'string') return trimToLength(value, 140);
  try {
    const compact = JSON.stringify(value);
    return trimToLength(compact ?? String(value), 140);
  } catch {
    return trimToLength(String(value), 140);
  }
}

function trimToLength(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 3) + '...';
}

function emitReply(reply: PermissionReply) {
  emit('reply', { requestId: props.request.id, reply });
}
</script>

<style scoped>
.permission-window {
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  box-sizing: border-box;
  color: #e2e8f0;
  font-size: 12px;
}

.permission-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.permission-title {
  font-size: 13px;
  font-weight: 700;
}

.permission-type {
  font-size: 11px;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  text-align: right;
}

.permission-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 8px;
  padding: 6px 8px;
  background: rgba(15, 23, 42, 0.35);
}

.permission-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.permission-label {
  color: #94a3b8;
  font-size: 11px;
}

.permission-value {
  color: #e2e8f0;
  font-size: 11px;
  word-break: break-all;
}

.divider {
  margin: 0 4px;
  color: #64748b;
}

.permission-body {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.permission-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 8px;
  padding: 6px 8px;
  background: rgba(2, 6, 23, 0.45);
}

.section-title {
  color: #cbd5f5;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pattern-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pattern-list li {
  word-break: break-all;
}

.metadata-row {
  display: grid;
  grid-template-columns: minmax(72px, auto) 1fr;
  gap: 8px;
  align-items: start;
}

.metadata-key {
  color: #94a3b8;
  font-size: 11px;
}

.metadata-value {
  color: #e2e8f0;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty {
  color: #64748b;
  font-size: 11px;
}

.permission-error {
  color: #fecaca;
  font-size: 11px;
}

.permission-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  border-top: 1px solid rgba(148, 163, 184, 0.25);
  padding-top: 8px;
}

.permission-button {
  border-radius: 8px;
  padding: 6px 10px;
  border: 1px solid #334155;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 11px;
  cursor: pointer;
}

.permission-button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.permission-button.is-once {
  background: rgba(14, 116, 144, 0.25);
  border-color: rgba(14, 116, 144, 0.7);
}

.permission-button.is-always {
  background: rgba(34, 197, 94, 0.18);
  border-color: rgba(34, 197, 94, 0.6);
}

.permission-button.is-reject {
  background: rgba(239, 68, 68, 0.18);
  border-color: rgba(239, 68, 68, 0.6);
}
</style>
