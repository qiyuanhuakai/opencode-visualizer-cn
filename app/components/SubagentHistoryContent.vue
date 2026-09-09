<template>
  <div class="subagent-history">
    <div class="subagent-header">
      <div class="subagent-header-meta">
        <span class="subagent-header-icon" aria-hidden="true">🤖</span>
        <div class="subagent-header-text">
          <h2 class="subagent-header-title">
            {{ t('subagentHistory.title') }}
          </h2>
          <div class="subagent-header-id" :title="parentThreadId">
            {{ sessionLabel || parentThreadId }}
          </div>
        </div>
      </div>
      <button
        type="button"
        class="subagent-close-button"
        :title="t('subagentHistory.close')"
        @click="handleClose"
      >
        {{ t('subagentHistory.close') }}
      </button>
    </div>
    <div v-if="loading" class="subagent-empty">{{ t('common.loading') }}</div>
    <div v-else-if="loadError" class="subagent-empty" role="alert">{{ loadError }}</div>
    <ThreadHistoryContent
      v-else-if="entries.length > 0"
      :entries="entries"
      :theme="theme"
      :on-tool-click="handleToolClick"
      :on-reasoning-click="handleReasoningClick"
    />
    <div v-else class="subagent-empty">
      {{ t('subagentHistory.empty') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import { useI18n } from 'vue-i18n';
import ThreadHistoryContent from './ThreadHistoryContent.vue';
import { useMessages } from '../composables/useMessages';
import { useFloatingWindow } from '../composables/useFloatingWindow';
import type { HistoryEntry, HistoryWindowEntry } from '../types/message';
import type { ReasoningPart, ToolPart } from '../types/sse';
import {
  buildHistoryEntries,
  selectSubagentMessages,
  toHistoryWindowEntry,
} from '../utils/historyEntries';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    parentThreadId: string;
    sessionLabel?: string;
    theme?: string;
    loadHistory?: (threadId: string) => Promise<CodexCanonicalHistoryEntry[]>;
  }>(),
  {
    sessionLabel: '',
    theme: 'github-dark',
  },
);

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'tool-click', part: ToolPart): void;
  (event: 'reasoning-click', part: ReasoningPart): void;
}>();

const msg = useMessages();
const floatingWindow = useFloatingWindow();
const loadedHistory = ref<CodexCanonicalHistoryEntry[]>([]);
const loading = ref(false);
const loadError = ref('');
watch(() => [props.parentThreadId, props.loadHistory] as const, async ([threadId, loadHistory], _, onCleanup) => {
  let stale = false;
  onCleanup(() => { stale = true; });
  loadedHistory.value = [];
  loadError.value = '';
  loading.value = !!loadHistory;
  if (!loadHistory) return;
  try {
    const history = await loadHistory(threadId);
    if (!stale) loadedHistory.value = history;
  } catch (error) {
    if (!stale) loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (!stale) loading.value = false;
  }
}, { immediate: true });

function getParts(messageId: string) {
  return props.loadHistory
    ? loadedHistory.value.find((entry) => entry.info.id === messageId)?.parts ?? []
    : msg.getParts(messageId);
}


function hasTextContent(message: { id: string }): boolean {
  return getParts(message.id).some((part) => part.type === 'text' && !!part.text.trim());
}

function getMessageContent(message: { id: string }): string {
  return getParts(message.id).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

const subagentMessages = computed(() =>
  props.loadHistory
    ? loadedHistory.value.map((entry) => entry.info)
    : selectSubagentMessages(msg.roots.value, (rootId) => msg.getThread(rootId), props.parentThreadId),
);

const internalEntries = computed<HistoryEntry[]>(() =>
  buildHistoryEntries({
    messages: subagentMessages.value,
    hasTextContent,
    getParts,
  }),
);

const entries = computed<HistoryWindowEntry[]>(() =>
  internalEntries.value.map((entry) =>
    toHistoryWindowEntry(
      entry,
      entry.kind === 'message'
        ? { content: getMessageContent(entry.message), isSubagent: true }
        : undefined,
    ),
  ),
);

function handleClose() {
  emit('close');
  floatingWindow.close();
}

function handleToolClick(part: ToolPart) {
  emit('tool-click', part);
}

function handleReasoningClick(part: ReasoningPart) {
  emit('reasoning-click', part);
}
</script>

<style scoped>
.subagent-history {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--floating-surface-base, #1a1d24);
}

.subagent-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--floating-surface-muted, #242832);
  border-bottom: 1px solid var(--floating-surface-outline, var(--floating-border-muted, #1e293b));
}

.subagent-header-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}

.subagent-header-icon {
  font-size: 18px;
  line-height: 1;
  flex-shrink: 0;
}

.subagent-header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.subagent-header-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--floating-surface-title-text, var(--floating-text, #e2e8f0));
}

.subagent-header-id {
  font-family: var(--app-monospace-font-family);
  font-size: 12px;
  line-height: 1.4;
  color: var(--floating-text-muted, #94a3b8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subagent-close-button {
  flex-shrink: 0;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid var(--floating-surface-outline, var(--floating-border-muted, #1e293b));
  background: var(--floating-surface-hover, var(--floating-surface-strong, #323a48));
  color: var(--floating-surface-title-text, var(--floating-text, #e2e8f0));
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.subagent-close-button:hover {
  background: var(--floating-surface-active, var(--floating-surface-strong, #323a48));
  border-color: var(--floating-surface-outline, var(--floating-border-muted, #1e293b));
}

.subagent-empty {
  padding: 24px;
  text-align: center;
  color: var(--floating-text-muted, #94a3b8);
  font-size: 13px;
}
</style>
