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
    <ThreadHistoryContent
      v-if="entries.length > 0"
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
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ThreadHistoryContent from './ThreadHistoryContent.vue';
import { useMessages } from '../composables/useMessages';
import { useFloatingWindow } from '../composables/useFloatingWindow';
import type {
  HistoryEntry,
  HistoryWindowEntry,
} from '../types/message';
import type { QuestionInfo, ReasoningPart, SubtaskPart, ToolPart } from '../types/sse';

const { t } = useI18n();

const HISTORY_TOOL_NAMES = new Set([
  'bash',
  'write',
  'edit',
  'multiedit',
  'apply_patch',
  'websearch',
  'read',
  'grep',
  'glob',
  'webfetch',
  'codesearch',
]);

const props = withDefaults(
  defineProps<{
    parentThreadId: string;
    sessionLabel?: string;
    theme?: string;
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

function hasTextContent(message: { id: string }): boolean {
  return msg.hasTextContent(message.id);
}

function getMessageContent(message: { id: string }): string {
  return msg.getTextContent(message.id);
}

function getToolPartTime(part: ToolPart): number {
  const state = part.state;
  if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
    return state.time.start;
  }
  return 0;
}

function getSubtaskPartTime(_part: SubtaskPart, fallbackTime: number): number {
  return fallbackTime;
}

function extractQuestionInfos(part: ToolPart): QuestionInfo[] {
  const raw = part.state.input?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is QuestionInfo =>
      q &&
      typeof q === 'object' &&
      typeof q.question === 'string' &&
      typeof q.header === 'string' &&
      Array.isArray(q.options),
  );
}

function resolveQuestionStatus(part: ToolPart): 'pending' | 'replied' | 'rejected' {
  if (part.state.status === 'completed') return 'replied';
  if (part.state.status === 'error') return 'rejected';
  return 'pending';
}

function extractQuestionAnswers(part: ToolPart): string[][] | undefined {
  if (part.state.status !== 'completed') return undefined;
  const answers = part.state.metadata?.answers;
  if (!Array.isArray(answers)) return undefined;
  return answers as string[][];
}

function getHistoryEntryKey(entry: HistoryEntry): string {
  if (entry.kind === 'message') return `msg:${entry.message.id}`;
  if (entry.kind === 'reasoning') return `reasoning:${entry.part.id}`;
  if (entry.kind === 'question') return `question:${entry.part.callID}`;
  if (entry.kind === 'subtask') return `subtask:${entry.part.id}`;
  return `tool:${entry.part.callID}`;
}

const subagentRoots = computed(() => {
  const target = props.parentThreadId.trim();
  if (!target) return [] as ReturnType<typeof msg.getThread>;
  return msg.roots.value
    .filter((root) => root.sessionID === target)
    .filter((root) => root.role === 'user');
});

const subagentMessages = computed(() => {
  return subagentRoots.value.flatMap((root) => msg.getThread(root.id));
});

const internalEntries = computed<HistoryEntry[]>(() => {
  const entries: HistoryEntry[] = [];
  for (const msgInfo of subagentMessages.value) {
    if (msgInfo.role === 'assistant' && hasTextContent(msgInfo)) {
      entries.push({ kind: 'message', message: msgInfo, time: msgInfo.time.created });
    }
    const parts = msg.getParts(msgInfo.id);
    for (const part of parts) {
      if (part.type === 'reasoning') {
        if (part.text) {
          entries.push({ kind: 'reasoning', part, time: part.time.start });
        }
        continue;
      }
      if (part.type === 'subtask') {
        entries.push({ kind: 'subtask', part, time: getSubtaskPartTime(part, msgInfo.time.created) });
        continue;
      }
      if (part.type !== 'tool') continue;
      if (part.state.status === 'pending') continue;
      if (part.tool === 'question') {
        entries.push({ kind: 'question', part, time: getToolPartTime(part) });
        continue;
      }
      if (!HISTORY_TOOL_NAMES.has(part.tool)) continue;
      entries.push({ kind: 'tool', part, time: getToolPartTime(part) });
    }
  }
  return entries.sort((a, b) => a.time - b.time);
});

const entries = computed<HistoryWindowEntry[]>(() =>
  internalEntries.value.map((entry) => {
    if (entry.kind === 'message') {
      return {
        key: getHistoryEntryKey(entry),
        kind: 'message',
        content: getMessageContent(entry.message),
        time: entry.time,
        sessionId: entry.message.sessionID,
        isSubagent: true,
      } satisfies HistoryWindowEntry;
    }
    if (entry.kind === 'reasoning') {
      return {
        key: getHistoryEntryKey(entry),
        kind: 'reasoning',
        part: entry.part,
        time: entry.time,
      } satisfies HistoryWindowEntry;
    }
    if (entry.kind === 'question') {
      return {
        key: getHistoryEntryKey(entry),
        kind: 'question',
        questions: extractQuestionInfos(entry.part),
        status: resolveQuestionStatus(entry.part),
        answers: extractQuestionAnswers(entry.part),
        time: entry.time,
      } satisfies HistoryWindowEntry;
    }
    if (entry.kind === 'subtask') {
      return {
        key: getHistoryEntryKey(entry),
        kind: 'subtask',
        part: entry.part,
        time: entry.time,
      } satisfies HistoryWindowEntry;
    }
    return {
      key: getHistoryEntryKey(entry),
      kind: 'tool',
      part: entry.part,
      time: entry.time,
    } satisfies HistoryWindowEntry;
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
  background: color-mix(in srgb, #0ea5e9 14%, var(--floating-surface-muted, #242832));
  border-bottom: 1px solid color-mix(in srgb, #0ea5e9 35%, var(--floating-border-muted, #1e293b));
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
  color: #7dd3fc;
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
  border: 1px solid color-mix(in srgb, #0ea5e9 35%, var(--floating-border-muted, #1e293b));
  background: color-mix(in srgb, #0ea5e9 8%, var(--floating-surface-strong, #323a48));
  color: var(--floating-text, #e2e8f0);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.subagent-close-button:hover {
  background: color-mix(in srgb, #0ea5e9 18%, var(--floating-surface-strong, #323a48));
  border-color: color-mix(in srgb, #0ea5e9 60%, var(--floating-border-muted, #1e293b));
}

.subagent-empty {
  padding: 24px;
  text-align: center;
  color: var(--floating-text-muted, #94a3b8);
  font-size: 13px;
}
</style>
