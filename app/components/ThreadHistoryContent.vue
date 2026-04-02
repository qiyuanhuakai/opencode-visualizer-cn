<template>
  <div class="history-content">
    <div class="history-list">
      <template v-for="entry in props.entries" :key="entry.key">
        <div v-if="entry.kind === 'message'" class="history-item">
          <div class="history-meta">
            <span class="history-index">💬</span>
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
          @click="handleReasoningClick(entry.part)"
        >
          <div class="history-meta">
            <span class="history-index">🤔</span>
            <span class="history-reasoning-badge">{{ t('threadHistory.thinking') }}</span>
            <span class="history-time">{{ formatMessageTime(entry.time) }}</span>
          </div>
        </div>
        <div v-else-if="entry.kind === 'question'" class="history-item history-item-question">
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
          v-else
          class="history-item history-item-tool"
          :style="{ '--tool-color': toolHeaderColor(entry.part.tool) }"
          @click="handleToolClick(entry.part)"
        >
          <div class="history-meta">
            <span class="history-index">🔧</span>
            <span class="history-tool-badge" :class="`history-tool-${entry.part.tool}`">{{
              toolBadgeLabel(entry.part.tool)
            }}</span>
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
import { useI18n } from 'vue-i18n';
import MessageViewer from './MessageViewer.vue';
import { useFloatingWindow } from '../composables/useFloatingWindow';
import type { QuestionInfo, ReasoningPart, ToolPart } from '../types/sse';

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
  | { key: string; kind: 'message'; content: string; time: number; agent?: string }
  | { key: string; kind: 'tool'; part: ToolPart; time: number }
  | { key: string; kind: 'reasoning'; part: ReasoningPart; time: number }
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
  switch (tool) {
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
      return tool.toUpperCase();
  }
}

function toolSummary(part: ToolPart): string {
  const input = part.state.input;
  switch (part.tool) {
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
      return part.tool;
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
  switch (tool) {
    case 'bash':
      return '#a855f7';
    case 'edit':
    case 'multiedit':
    case 'apply_patch':
      return '#f97316';
    case 'write':
      return '#f97316';
    default:
      return '#64748b';
  }
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
}

.history-list {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.history-item {
  border: 1px solid #334155;
  border-radius: 8px;
  background: #020617;
}

.history-meta {
  padding: 6px 10px;
  background: color-mix(in srgb, #60a5fa 12%, #0f172a);
  border-bottom: 1px solid #1e293b;
  border-radius: 7px 7px 0 0;
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: #94a3b8;
}

.history-index {
  font-weight: 600;
  color: #e2e8f0;
}

.history-time {
  margin-left: auto;
}

.history-agent {
  padding: 2px 6px;
  background: #1e293b;
  border-radius: 4px;
  color: #cbd5e1;
}

.history-content-wrapper {
  padding: 10px;
  font-size: 13px;
  line-height: 1.4;
}

.history-item-reasoning {
  cursor: pointer;
  border-color: color-mix(in srgb, #8b5cf6 40%, #1e293b);
  transition:
    border-color 0.15s,
    background 0.15s;
}

.history-item-reasoning:hover {
  border-color: color-mix(in srgb, #8b5cf6 60%, #1e293b);
  background: color-mix(in srgb, #8b5cf6 6%, #020617);
}

.history-item-reasoning .history-meta {
  background: color-mix(in srgb, #8b5cf6 18%, rgba(15, 23, 42, 0.95));
  border-bottom: none;
}

.history-reasoning-badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: rgba(88, 28, 135, 0.5);
  color: #d8b4fe;
}

/* Question entry */
.history-item-question {
  border-color: color-mix(in srgb, #34d399 40%, #1e293b);
}

.history-meta-question {
  background: color-mix(in srgb, #34d399 18%, rgba(15, 23, 42, 0.95));
  border-bottom-color: color-mix(in srgb, #34d399 25%, #1e293b);
}

.history-question-badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: rgba(6, 78, 59, 0.6);
  color: #6ee7b7;
}

.history-question-status {
  font-size: 10px;
  color: #64748b;
}

.history-question-status.is-replied {
  color: #4ade80;
}

.history-question-status.is-rejected {
  color: #f87171;
}

.history-question-status.is-pending {
  color: #fbbf24;
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
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.history-question-text {
  font-size: 13px;
  line-height: 1.4;
  color: #e2e8f0;
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
  color: #94a3b8;
  padding: 2px 4px;
  border-radius: 3px;
}

.history-question-option.is-selected {
  color: #e2e8f0;
  background: rgba(52, 211, 153, 0.1);
}

.option-check {
  flex-shrink: 0;
  font-size: 13px;
}

.option-label {
  font-weight: 500;
}

.option-desc {
  color: #64748b;
}

.history-question-option.is-selected .option-desc {
  color: #94a3b8;
}

.history-question-custom {
  margin-top: 4px;
  padding: 4px 8px;
  background: rgba(52, 211, 153, 0.08);
  border-left: 2px solid #34d399;
  border-radius: 2px;
  font-size: 12px;
  line-height: 1.4;
  color: #e2e8f0;
}

.history-item-tool {
  cursor: pointer;
  border-color: color-mix(in srgb, var(--tool-color, #64748b) 40%, #1e293b);
  transition:
    border-color 0.15s,
    background 0.15s;
}

.history-item-tool:hover {
  border-color: color-mix(in srgb, var(--tool-color, #64748b) 60%, #1e293b);
  background: color-mix(in srgb, var(--tool-color, #64748b) 6%, #020617);
}

.history-item-tool .history-meta {
  background: color-mix(in srgb, var(--tool-color, #64748b) 18%, rgba(15, 23, 42, 0.95));
  border-bottom-color: color-mix(in srgb, var(--tool-color, #64748b) 25%, #1e293b);
}

.history-tool-badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: #e2e8f0;
  background: #334155;
}

.history-tool-badge.history-tool-bash {
  background: rgba(22, 78, 99, 0.7);
  color: #67e8f9;
}

.history-tool-badge.history-tool-write {
  background: rgba(21, 94, 117, 0.5);
  color: #a5f3fc;
}

.history-tool-badge.history-tool-edit,
.history-tool-badge.history-tool-multiedit {
  background: rgba(30, 58, 138, 0.5);
  color: #bfdbfe;
}

.history-tool-badge.history-tool-apply_patch {
  background: rgba(30, 58, 138, 0.5);
  color: #bfdbfe;
}

.history-tool-status {
  font-size: 10px;
  color: #64748b;
}

.history-tool-status.is-completed {
  color: #4ade80;
}

.history-tool-status.is-error {
  color: #f87171;
}

.history-tool-status.is-running {
  color: #fbbf24;
}

.history-tool-content {
  padding: 6px 10px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 12px;
  line-height: 1.4;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
