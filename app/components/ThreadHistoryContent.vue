<template>
  <div ref="rootEl" class="history-content">
    <div class="history-list">
      <template v-for="entry in visibleEntries" :key="entry.key">
        <div v-if="entry.kind === 'message'" class="history-item" :data-history-key="entry.key">
          <div class="history-meta">
            <span class="history-index">💬</span>
            <span v-if="entry.isSubagent" class="history-session-badge">
              {{ entry.sessionLabel || entry.sessionId || t('threadHistory.subagent') }}
            </span>
            <span v-if="entry.agent" class="history-agent">{{ entry.agent }}</span>
            <span class="history-time">{{ formatMessageTime(entry.time) }}</span>
          </div>
          <div class="history-content-wrapper">
            <MessageViewer
              class="message-viewer-context-history"
              :code="entry.content"
              :lang="'markdown'"
              :theme="theme"
              copy-button
              @rendered="handleRendered"
            />
          </div>
        </div>
        <div
          v-else-if="entry.kind === 'reasoning'"
          class="history-item history-item-reasoning"
          :data-history-key="entry.key"
          @click="handleReasoningClick(entry.part)"
        >
          <div class="history-meta">
            <span class="history-index">🤔</span>
            <span class="history-reasoning-badge">{{ t('threadHistory.thinking') }}</span>
            <span class="history-time">{{ formatMessageTime(entry.time) }}</span>
          </div>
        </div>
        <div
          v-else-if="entry.kind === 'question'"
          class="history-item history-item-question"
          :data-history-key="entry.key"
        >
          <div class="history-meta history-meta-question">
            <span class="history-index">❓</span>
            <span class="history-question-badge">{{ t('threadHistory.question') }}</span>
            <span class="history-question-status" :class="`is-${entry.status}`">{{
              translatedQuestionStatus(entry.status)
            }}</span>
            <span class="history-time">{{ formatMessageTime(entry.time) }}</span>
          </div>
          <div class="history-question-body">
            <div
              v-for="(item, qi) in entry.questions"
              :key="`${item.header}:${item.question}:${qi}`"
              class="history-question-section"
            >
              <div class="history-question-header">{{ item.header }}</div>
              <div class="history-question-text">{{ item.question }}</div>
              <div class="history-question-options">
                <div
                  v-for="(opt, oi) in item.options"
                  :key="oi"
                  class="history-question-option"
                  :class="{ 'is-selected': isOptionSelected(entry, qi, opt.label) }"
                >
                  <span class="option-check">{{
                    isOptionSelected(entry, qi, opt.label) ? '☑' : '☐'
                  }}</span>
                  <span class="option-label">{{ opt.label }}</span>
                  <span v-if="opt.description" class="option-desc">{{ opt.description }}</span>
                </div>
              </div>
              <div v-if="getCustomAnswer(entry, qi)" class="history-question-custom">
                {{ getCustomAnswer(entry, qi) }}
              </div>
            </div>
          </div>
        </div>
        <div
          v-else-if="entry.kind === 'subtask'"
          class="history-item history-item-subtask"
          :data-history-key="entry.key"
        >
          <div class="history-meta">
            <span class="history-index">🤖</span>
            <span class="history-subtask-badge">{{ t('threadHistory.delegation') }}</span>
            <span class="history-time">{{ formatMessageTime(entry.time) }}</span>
          </div>
          <div class="history-tool-content">
            <strong>@{{ entry.part.agent }}</strong>
            <span v-if="entry.part.description"> — {{ entry.part.description }}</span>
            <div v-if="entry.part.prompt" class="history-subtask-prompt">
              {{ entry.part.prompt }}
            </div>
          </div>
        </div>
        <div
          v-else
          class="history-item history-item-tool"
          :data-history-key="entry.key"
          :style="{ '--tool-color': toolHeaderColor(entry.part.tool) }"
          @click="handleToolClick(entry.part)"
        >
          <div class="history-meta">
            <span class="history-index">🔧</span>
            <span
              class="history-tool-badge"
              :class="`history-tool-${normalizeToolName(entry.part.tool)}`"
              >{{ toolBadgeLabel(entry.part.tool) }}</span
            >
            <span class="history-tool-status" :class="`is-${toolStatusLabel(entry.part)}`">{{
              translatedToolStatus(toolStatusLabel(entry.part))
            }}</span>
            <span class="history-time">{{ formatMessageTime(entry.time) }}</span>
          </div>
          <div class="history-tool-content">{{ toolSummary(entry.part) }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import MessageViewer from './MessageViewer.vue';
import { useFloatingWindow } from '../composables/useFloatingWindow';
import { pendingWorkerRenders } from '../composables/useRenderState';
import type { QuestionInfo, ReasoningPart, SubtaskPart, ToolPart } from '../types/sse';
import { settleScrollAnchor } from '../utils/scrollAnchor';
import { resolveToolAccentColor } from '../utils/theme';
import { normalizeToolName } from '../utils/toolNames';

const { t } = useI18n();

type QuestionHistoryEntry = {
  key: string;
  kind: 'question';
  questions: QuestionInfo[];
  status: 'pending' | 'replied' | 'rejected';
  answers?: string[][];
  time: number;
};

type HistoryEntry =
  | {
      key: string;
      kind: 'message';
      content: string;
      time: number;
      agent?: string;
      sessionId?: string;
      sessionLabel?: string;
      isSubagent?: boolean;
    }
  | { key: string; kind: 'tool'; part: ToolPart; time: number }
  | { key: string; kind: 'reasoning'; part: ReasoningPart; time: number }
  | { key: string; kind: 'subtask'; part: SubtaskPart; time: number }
  | QuestionHistoryEntry;

const props = withDefaults(
  defineProps<{
    entries: HistoryEntry[];
    theme?: string;
    onToolClick?: (part: ToolPart) => void;
    onReasoningClick?: (part: ReasoningPart) => void;
  }>(),
  {
    theme: 'github-dark',
  },
);

const floatingWindow = useFloatingWindow();
const rootEl = ref<HTMLElement | null>(null);
const HISTORY_WINDOW_SIZE = 100;
const HISTORY_WINDOW_SHIFT = 20;
const windowStart = ref(Math.max(0, props.entries.length - HISTORY_WINDOW_SIZE));
const windowEnd = ref(props.entries.length);
const visibleEntries = computed(() => props.entries.slice(windowStart.value, windowEnd.value));
let scrollHost: HTMLElement | null = null;
let shiftInProgress = false;

function resetHistoryWindow(): void {
  windowEnd.value = props.entries.length;
  windowStart.value = Math.max(0, windowEnd.value - HISTORY_WINDOW_SIZE);
}

function isTrueAppend(previousKeys: readonly string[], nextKeys: readonly string[]): boolean {
  if (nextKeys.length <= previousKeys.length) return false;
  return previousKeys.every((key, index) => nextKeys[index] === key);
}

watch(
  [() => props.entries, () => props.entries.map((entry) => entry.key)],
  ([, nextKeys], previous) => {
    if (!previous) return;
    const previousKeys = previous[1];
    if (isTrueAppend(previousKeys, nextKeys)) {
      if (windowEnd.value >= previousKeys.length) {
        resetHistoryWindow();
      }
      return;
    }
    const keysUnchanged =
      nextKeys.length === previousKeys.length &&
      previousKeys.every((key, index) => nextKeys[index] === key);
    if (!keysUnchanged) {
      resetHistoryWindow();
    }
  },
);

function historyEntryElement(key: string): HTMLElement | null {
  const escapedKey = CSS.escape(key);
  return rootEl.value?.querySelector<HTMLElement>(`[data-history-key="${escapedKey}"]`) ?? null;
}

async function shiftHistoryWindow(nextStart: number): Promise<void> {
  if (!scrollHost || shiftInProgress || nextStart === windowStart.value) return;
  const retainedIndex = Math.max(nextStart, windowStart.value);
  const anchor = props.entries[retainedIndex];
  const anchorElement = anchor ? historyEntryElement(anchor.key) : null;
  if (!anchor || !anchorElement) return;
  const anchorTop = anchorElement.getBoundingClientRect().top;
  shiftInProgress = true;
  windowStart.value = nextStart;
  windowEnd.value = Math.min(props.entries.length, nextStart + HISTORY_WINDOW_SIZE);
  await nextTick();
  await settleScrollAnchor({
    measureDelta: () => {
      const current = historyEntryElement(anchor.key);
      return current ? current.getBoundingClientRect().top - anchorTop : null;
    },
    applyDelta: (delta) => {
      if (scrollHost) scrollHost.scrollTop += delta;
    },
    hasPendingWork: () => pendingWorkerRenders.value > 0,
    waitForFrame: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  });
  shiftInProgress = false;
}

function onHistoryScroll(): void {
  if (!scrollHost || shiftInProgress) return;
  if (scrollHost.scrollTop <= 120 && windowStart.value > 0) {
    void shiftHistoryWindow(Math.max(0, windowStart.value - HISTORY_WINDOW_SHIFT));
    return;
  }
  const distanceToBottom = scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight;
  if (distanceToBottom <= 120 && windowEnd.value < props.entries.length) {
    void shiftHistoryWindow(
      Math.min(props.entries.length - HISTORY_WINDOW_SIZE, windowStart.value + HISTORY_WINDOW_SHIFT),
    );
  }
}

onMounted(() => {
  scrollHost = rootEl.value?.closest<HTMLElement>('.floating-window-body') ?? null;
  scrollHost?.addEventListener('scroll', onHistoryScroll, { passive: true });
});

onBeforeUnmount(() => {
  scrollHost?.removeEventListener('scroll', onHistoryScroll);
  scrollHost = null;
});

function handleRendered() {
  floatingWindow.notifyContentChange();
}

function handleToolClick(part: ToolPart) {
  props.onToolClick?.(part);
}

function handleReasoningClick(part: ReasoningPart) {
  props.onReasoningClick?.(part);
}

function isOptionSelected(
  entry: QuestionHistoryEntry,
  questionIndex: number,
  label: string,
): boolean {
  if (entry.status !== 'replied' || !entry.answers) return false;
  const answer = entry.answers[questionIndex];
  return Array.isArray(answer) && answer.includes(label);
}

function getCustomAnswer(entry: QuestionHistoryEntry, questionIndex: number): string {
  if (entry.status !== 'replied' || !entry.answers) return '';
  const answer = entry.answers[questionIndex];
  if (!Array.isArray(answer)) return '';
  const question = entry.questions[questionIndex];
  if (!question) return '';
  const optionLabels = new Set(question.options.map((o) => o.label));
  return answer.filter((v) => !optionLabels.has(v)).join(', ');
}

function toolBadgeLabel(tool: string): string {
  const normalizedTool = normalizeToolName(tool);
  switch (normalizedTool) {
    case 'bash':
      return t('toolTitles.shell');
    case 'write':
      return t('toolTitles.write');
    case 'edit':
      return t('toolTitles.edit');
    case 'multiedit':
      return t('toolTitles.edit');
    case 'apply_patch':
      return t('toolTitles.patch');
    default:
      return normalizedTool.toUpperCase();
  }
}

function toolSummary(part: ToolPart): string {
  const input = part.state.input;
  const tool = normalizeToolName(part.tool);
  switch (tool) {
    case 'bash': {
      const cmd = typeof input?.command === 'string' ? input.command.trim() : '';
      return cmd ? `$ ${cmd.split('\n')[0].slice(0, 120)}` : '$ ...';
    }
    case 'write': {
      const path = typeof input?.filePath === 'string' ? input.filePath : '';
      return path || 'write';
    }
    case 'edit': {
      const path = typeof input?.filePath === 'string' ? input.filePath : '';
      return path || 'edit';
    }
    case 'multiedit': {
      const files = Array.isArray(input?.files)
        ? input.files.filter(
            (file): file is string => typeof file === 'string' && file.trim().length > 0,
          )
        : [];
      if (files.length > 0) return files.join(', ');
      const path = typeof input?.filePath === 'string' ? input.filePath : '';
      return path || 'multiedit';
    }
    case 'apply_patch': {
      const state = part.state;
      const metadata =
        state.status === 'completed' || state.status === 'error' || state.status === 'running'
          ? state.metadata
          : undefined;
      const files = Array.isArray(metadata?.files) ? metadata.files : [];
      const paths = files
        .map((f: unknown) => {
          if (!f || typeof f !== 'object') return null;
          const r = f as Record<string, unknown>;
          return typeof r.relativePath === 'string'
            ? r.relativePath
            : typeof r.filePath === 'string'
              ? r.filePath
              : typeof r.file === 'string'
                ? r.file
                : null;
        })
        .filter(Boolean) as string[];
      return paths.length > 0 ? paths.join(', ') : 'patch';
    }
    default:
      return tool;
  }
}

function toolStatusLabel(part: ToolPart): string {
  return part.state.status;
}

function translatedQuestionStatus(status: string): string {
  return t(`questionStatus.${status}`, status);
}

function translatedToolStatus(status: string): string {
  return t(`toolStatus.${status}`, status);
}

function toolHeaderColor(tool: string): string {
  return resolveToolAccentColor(normalizeToolName(tool));
}

function formatMessageTime(value?: number) {
  if (typeof value !== 'number') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
</script>

<style scoped>
.history-content {
  --history-reasoning-color: var(--theme-floating-reasoning-accent, var(--window-color));
  --history-subagent-color: var(--theme-floating-subagent-accent, var(--window-color));
  --history-question-color: var(--theme-status-success, var(--window-color));
}

.history-list {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.history-item {
  border: 1px solid
    color-mix(
      in srgb,
      var(--window-color, #3a4150) 35%,
      var(--floating-border-muted, rgba(90, 100, 120, 0.35))
    );
  border-radius: 8px;
  background: var(--floating-surface-subtle, #1e222a);
}

.history-meta {
  padding: 6px 10px;
  background: color-mix(
    in srgb,
    var(--window-color, #3a4150) 14%,
    var(--floating-surface-muted, #242832)
  );
  border-bottom: 1px solid
    color-mix(in srgb, var(--window-color, #3a4150) 25%, var(--floating-border-muted, #1e293b));
  border-radius: 7px 7px 0 0;
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: var(--floating-text-muted, #94a3b8);
}

.history-index {
  font-weight: 600;
  color: var(--floating-text, #e2e8f0);
}

.history-time {
  margin-left: auto;
}

.history-agent {
  padding: 2px 6px;
  background: color-mix(in srgb, var(--floating-surface-strong, #323a48) 78%, transparent);
  border-radius: 4px;
  color: var(--floating-text-secondary, #cbd5e1);
}

.history-session-badge {
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(
    in srgb,
    var(--history-subagent-color) 18%,
    var(--floating-surface-strong, #323a48)
  );
  color: var(--floating-text, #e2e8f0);
  font-size: 10px;
  font-weight: 600;
}

.history-content-wrapper {
  padding: 10px;
  font-size: var(--message-font-size, 13px);
  line-height: 1.4;
}

.history-item-reasoning {
  cursor: pointer;
  border-color: color-mix(
    in srgb,
    var(--history-reasoning-color) 40%,
    var(--floating-border-muted, #1e293b)
  );
  transition:
    border-color 0.15s,
    background 0.15s;
}

.history-item-reasoning:hover {
  border-color: color-mix(
    in srgb,
    var(--history-reasoning-color) 60%,
    var(--floating-border-muted, #1e293b)
  );
  background: color-mix(
    in srgb,
    var(--history-reasoning-color) 6%,
    var(--floating-surface-base, #1a1d24)
  );
}

.history-item-subtask {
  border-color: color-mix(
    in srgb,
    var(--history-subagent-color) 36%,
    var(--floating-border-muted, #1e293b)
  );
  background: color-mix(
    in srgb,
    var(--history-subagent-color) 6%,
    var(--floating-surface-base, #1a1d24)
  );
}

.history-subtask-badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: color-mix(
    in srgb,
    var(--history-subagent-color) 28%,
    var(--floating-surface-strong, #323a48)
  );
  color: var(--floating-text, #e2e8f0);
}

.history-subtask-prompt {
  margin-top: 6px;
  font-size: 12px;
  color: var(--floating-text-soft, #94a3b8);
  white-space: pre-wrap;
  word-break: break-word;
}

.history-item-reasoning .history-meta {
  background: color-mix(
    in srgb,
    var(--history-reasoning-color) 18%,
    var(--floating-surface-muted, #242832)
  );
  border-bottom: none;
}

.history-reasoning-badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: color-mix(
    in srgb,
    var(--history-reasoning-color) 38%,
    var(--floating-surface-strong, #323a48)
  );
  color: var(--floating-text, #e2e8f0);
}

/* Question entry */
.history-item-question {
  border-color: color-mix(
    in srgb,
    var(--history-question-color) 40%,
    var(--floating-border-muted, #1e293b)
  );
}

.history-meta-question {
  background: color-mix(
    in srgb,
    var(--history-question-color) 18%,
    var(--floating-surface-muted, #242832)
  );
  border-bottom-color: color-mix(
    in srgb,
    var(--history-question-color) 25%,
    var(--floating-border-muted, #1e293b)
  );
}

.history-question-badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: color-mix(
    in srgb,
    var(--history-question-color) 32%,
    var(--floating-surface-strong, #323a48)
  );
  color: var(--floating-text, #e2e8f0);
}

.history-question-status {
  font-size: 10px;
  color: var(--theme-status-neutral, var(--floating-text-muted, #94a3b8));
}

.history-question-status.is-replied {
  color: var(--theme-status-success, var(--floating-text, #e2e8f0));
}

.history-question-status.is-rejected {
  color: var(--theme-status-danger, var(--floating-text, #e2e8f0));
}

.history-question-status.is-pending {
  color: var(--theme-status-warning, var(--floating-text, #e2e8f0));
}

.history-question-body {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-question-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-question-header {
  font-size: 11px;
  font-weight: 600;
  color: var(--floating-text-muted, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.history-question-text {
  font-size: var(--message-font-size, 13px);
  line-height: 1.4;
  color: var(--floating-text, #e2e8f0);
}

.history-question-options {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 4px;
}

.history-question-option {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
  line-height: 1.4;
  color: var(--floating-text-muted, #94a3b8);
  padding: 2px 4px;
  border-radius: 3px;
}

.history-question-option.is-selected {
  color: var(--floating-text, #e2e8f0);
  background: color-mix(in srgb, var(--history-question-color) 10%, transparent);
}

.option-check {
  flex-shrink: 0;
  font-size: 13px;
}

.option-label {
  font-weight: 500;
}

.option-desc {
  color: var(--floating-text-soft, #64748b);
}

.history-question-option.is-selected .option-desc {
  color: var(--floating-text-muted, #94a3b8);
}

.history-question-custom {
  margin-top: 4px;
  padding: 4px 8px;
  background: color-mix(in srgb, var(--history-question-color) 8%, transparent);
  border-left: 2px solid var(--history-question-color);
  border-radius: 2px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--floating-text, #e2e8f0);
}

.history-item-tool {
  cursor: pointer;
  border-color: color-mix(
    in srgb,
    var(--tool-color, #64748b) 40%,
    var(--floating-border-muted, #1e293b)
  );
  transition:
    border-color 0.15s,
    background 0.15s;
}

.history-item-tool:hover {
  border-color: color-mix(
    in srgb,
    var(--tool-color, #64748b) 60%,
    var(--floating-border-muted, #1e293b)
  );
  background: color-mix(
    in srgb,
    var(--tool-color, #64748b) 6%,
    var(--floating-surface-base, #020617)
  );
}

.history-item-tool .history-meta {
  background: color-mix(
    in srgb,
    var(--tool-color, #64748b) 18%,
    var(--floating-surface-muted, rgba(15, 23, 42, 0.95))
  );
  border-bottom-color: color-mix(
    in srgb,
    var(--tool-color, #64748b) 25%,
    var(--floating-border-muted, #1e293b)
  );
}

.history-tool-badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--floating-text, #e2e8f0);
  background: color-mix(
    in srgb,
    var(--tool-color, var(--window-color)) 24%,
    var(--floating-surface-strong, #334155)
  );
}

.history-tool-status {
  font-size: 10px;
  color: var(--theme-status-neutral, var(--floating-text-muted, #94a3b8));
}

.history-tool-status.is-completed {
  color: var(--theme-status-success, var(--floating-text, #e2e8f0));
}

.history-tool-status.is-error {
  color: var(--theme-status-danger, var(--floating-text, #e2e8f0));
}

.history-tool-status.is-running {
  color: var(--theme-status-warning, var(--floating-text, #e2e8f0));
}

.history-tool-content {
  padding: 6px 10px;
  font-family: var(--app-monospace-font-family);
  font-size: 12px;
  line-height: 1.4;
  color: var(--floating-text-muted, #94a3b8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
