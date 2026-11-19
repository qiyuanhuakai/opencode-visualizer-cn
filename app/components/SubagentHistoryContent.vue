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
    <button v-if="runtimeHistory && loadError" type="button" class="subagent-close-button" :disabled="loading" @click="runtimeRetry++">{{ t('common.retry') }}</button>
    <button v-if="runtimeHistory && runtimeReader.hasMore.value" type="button" class="subagent-close-button" :disabled="loading" @click="nextRuntimePage">{{ t('subagentHistory.nextPage') }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRuntimeConversation } from '../composables/useRuntimeConversation';
import { createSelectionScope } from '../runtime/selectionScope';
import type { RuntimeClient } from '../runtime/client';
import type { ConnectionProfileId, SessionRef } from '../../shared/runtime/identity.js';
import { parseSubagentHistory } from '../composables/openCodeSubagentHistory';
import type { CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import { useI18n } from 'vue-i18n';
import ThreadHistoryContent from './ThreadHistoryContent.vue';
import { useMessages } from '../composables/useMessages';
import { useFloatingWindow } from '../composables/useFloatingWindow';
import type { HistoryEntry, HistoryWindowEntry } from '../types/message';
import type { ReasoningPart, TextPart, ToolPart } from '../types/sse';
import {
  buildHistoryEntries,
  getHistoryEntryKey,
  selectSubagentMessages,
  toHistoryWindowEntry,
} from '../utils/historyEntries';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    parentThreadId: string;
    sessionLabel?: string;
    theme?: string;
    runtimeHistory?: { open: () => Promise<{ client: RuntimeClient; dispose(): void }>; profileId: ConnectionProfileId; session: SessionRef; observed: () => CodexCanonicalHistoryEntry[] };
    loadHistory?: (threadId: string) => Promise<CodexCanonicalHistoryEntry[]>;
  }>(),
  {
    sessionLabel: '',
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
const legacyLoading = ref(false);
const legacyError = ref('');
const runtimeConnecting = ref(false);
const runtimeRetry = ref(0);
const runtimeReader = useRuntimeConversation({ publish: values => {
  const context = props.runtimeHistory;
  if (!context) return;
  const entries = parseSubagentHistory(values, context.session.nativeSessionId);
  const observed = parseSubagentHistory(context.observed(), context.session.nativeSessionId);
  const merged = new Map([...entries, ...observed].map(entry => [entry.info.id, entry]));
  loadedHistory.value = [...merged.values()].slice(-200);
} });
const loading = computed(() => props.runtimeHistory ? runtimeConnecting.value || runtimeReader.loading.value : legacyLoading.value);
const loadError = computed(() => {
  const error = props.runtimeHistory ? runtimeReader.error.value : legacyError.value;
  return error.startsWith('source_unavailable:') ? t('subagentHistory.loadFailed') : error;
});
async function nextRuntimePage() { try { await runtimeReader.loadMore(); } catch { /* reader exposes the failure */ } }
watch(() => [props.runtimeHistory, runtimeRetry.value] as const, async ([context], _, onCleanup) => {
  if (!context) return;
  runtimeConnecting.value = true;
  let current = true;
  let connection: Awaited<ReturnType<typeof context.open>> | undefined;
  let scope: ReturnType<typeof createSelectionScope> | undefined;
  onCleanup(() => {
    current = false;
    scope?.dispose();
    void runtimeReader.dispose().catch(error => console.error('[Runtime] Subagent history cleanup failed', error)).finally(() => connection?.dispose());
  });
  try {
    connection = await context.open();
    if (!current) { connection.dispose(); return; }
    scope = createSelectionScope({ client: connection.client, profileId: context.profileId });
    const capture = scope.select(context.session);
    if (capture) await runtimeReader.select(connection.client, capture, 'opencode');
  } catch (error) {
    if (current) await runtimeReader.unavailable(error instanceof Error ? error.message : String(error));
  } finally { if (current) runtimeConnecting.value = false; }
}, { immediate: true });
watch(() => [props.parentThreadId, props.loadHistory] as const, async ([threadId, loadHistory], _, onCleanup) => {
  let stale = false;
  onCleanup(() => { stale = true; });
  if (props.runtimeHistory) return;
  loadedHistory.value = [];
  legacyError.value = '';
  legacyLoading.value = !!loadHistory;
  if (!loadHistory) return;
  try {
    const history = await loadHistory(threadId);
    if (!stale) loadedHistory.value = history;
  } catch (error) {
    if (!stale) legacyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (!stale) legacyLoading.value = false;
  }
}, { immediate: true });

function getParts(messageId: string) {
  return props.loadHistory || props.runtimeHistory
    ? loadedHistory.value.find((entry) => entry.info.id === messageId)?.parts ?? []
    : msg.getParts(messageId);
}


function hasTextContent(message: { id: string }): boolean {
  return getParts(message.id).some((part) => part.type === 'text' && !!part.text.trim());
}

function getTextParts(message: { id: string }): TextPart[] {
  return getParts(message.id).filter((part): part is TextPart => part.type === 'text');
}

const subagentMessages = computed(() =>
  props.loadHistory || props.runtimeHistory
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
  internalEntries.value.flatMap((entry): HistoryWindowEntry[] => {
    if (entry.kind !== 'message') {
      return [toHistoryWindowEntry(entry)];
    }
    // Each text part is one utterance: render it as its own history cell
    // instead of joining a message's text parts into a single block.
    return getTextParts(entry.message).map((part) => ({
      ...toHistoryWindowEntry(entry, { content: part.text, isSubagent: true }),
      key: `${getHistoryEntryKey(entry)}:${part.id}`,
    }));
  }),
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
@media (max-width: 640px) {
  .subagent-close-button {
    min-height: 44px;
    min-width: 44px;
  }
}
</style>
