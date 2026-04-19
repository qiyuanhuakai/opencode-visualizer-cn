<template>
  <div class="thread-block" :class="{ 'is-reverted-preview': isRevertedPreview }">
    <button
      v-if="isRevertedPreview"
      type="button"
      class="ib-action ib-action-undo ib-top-right"
      @click="confirmUndoRevert()"
    >
      {{ t('threadBlock.undo') }}
    </button>
    <button
      v-else-if="root.role === 'user' && root.sessionID"
      type="button"
      class="ib-action ib-top-right"
      @click="confirmFork()"
    >
      {{ t('threadBlock.fork') }}
    </button>

    <div class="thread-user" :style="userBoxStyle">
      <div
        v-if="root.role === 'user'"
        class="ib-msg-block ib-msg-user"
        :class="{ 'ib-msg-user-reverted': isRevertedPreview }"
      >
        <div class="ib-msg-row">
          <MessageViewer
            class="message-viewer-context-user"
            :key="`user-${root.id}`"
            :code="getMessageContent(root)"
            :lang="'markdown'"
            :theme="theme"
            :files="filesWithBasenames"
            copy-button
            @rendered="emit('message-rendered', getThreadUserRenderKey(root))"
          />
          <div v-if="userAttachments.length > 0" class="output-entry-attachments">
            <img
              v-for="item in userAttachments"
              :key="item.id"
              class="output-entry-attachment clickable"
              :src="item.url"
              :alt="item.filename"
              loading="lazy"
              @click="emit('open-image', { url: item.url, filename: item.filename })"
            />
          </div>
        </div>
      </div>
    </div>

    <ThreadTarget
      v-if="!isRevertedPreview"
      :target="threadTarget"
      :agent-style="threadTargetAgentStyle"
    />

    <div v-if="!isRevertedPreview && hasAssistantText" class="thread-assistant">
      <Transition :name="assistantTransitionName" :mode="assistantTransitionMode">
        <div class="ib-msg-block ib-msg-assistant" :key="deferredTransitionKey">
          <div class="ib-msg-body">
            <MessageViewer
              class="message-viewer-context-assistant"
              :html="assistantHtml"
              copy-button
            />
          </div>
          <div
            v-if="assistantAttachments.length > 0"
            class="output-entry-attachments"
          >
            <img
              v-for="item in assistantAttachments"
              :key="item.id"
              class="output-entry-attachment clickable"
              :src="item.url"
              :alt="item.filename"
              loading="lazy"
              @click="emit('open-image', { url: item.url, filename: item.filename })"
            />
          </div>
          <button
            v-if="hasHistory"
            type="button"
            class="ib-action ib-action-history"
            :title="t('threadBlock.historyTitle', { count: historyCount })"
            @click="showThreadHistory()"
          >
            {{ t('threadBlock.historyLabel') }} ({{ historyCount }})
          </button>
        </div>
      </Transition>
    </div>

    <div v-if="!isRevertedPreview && threadError" class="ib-error-bar">
      <span class="ib-error-icon">⊘</span>
      <span class="ib-error-text">{{ formatMessageError(threadError, (key) => t(key)) }}</span>
    </div>

    <ThreadFooter
      v-if="!isRevertedPreview"
      :timestamp="formatThreadTimestamp(root)"
      :elapsed="formatThreadElapsed(root)"
      :context-percent="threadContextPercent"
      :tokens="threadTokens"
      :has-diffs="hasThreadDiffs"
      :can-revert="canRevertThread(root)"
      @show-diff="showThreadDiff(root)"
      @revert="confirmRevert(root)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, Transition } from 'vue';
import { useI18n } from 'vue-i18n';
import MessageViewer from './MessageViewer.vue';
import ThreadFooter from './ThreadFooter.vue';
import ThreadTarget from './ThreadTarget.vue';
import { useMessages } from '../composables/useMessages';
import type {
  HistoryEntry,
  HistoryWindowEntry,
  MessageAttachment,
  MessageDiffEntry,
  MessageTokens,
  MessageUsage,
  ModelMeta,
  ThreadTarget as ThreadTargetType,
} from '../types/message';
import type { MessageInfo, QuestionInfo, SubtaskPart, ToolPart } from '../types/sse';
import { getMessageVariant } from '../types/sse';
import { formatElapsedTime, formatMessageError, formatMessageTime } from '../utils/formatters';

const { t } = useI18n();

const HISTORY_TOOL_NAMES = new Set(['bash', 'write', 'edit', 'multiedit', 'apply_patch']);

const props = defineProps<{
  root: MessageInfo;
  theme: string;
  filesWithBasenames: string[];
  isRevertedPreview: boolean;
  currentSessionId?: string;
  sessionHistoryMetaById?: Record<string, { parentID?: string; label: string }>;
  resolveAgentColor?: (agent?: string) => string;
  resolveModelMeta?: (modelPath?: string) => ModelMeta | undefined;
  computeContextPercent?: (
    tokens: MessageTokens,
    providerId?: string,
    modelId?: string,
  ) => number | null;
  sessionRevert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  } | null;
  assistantHtml?: string;
  deferredTransitionKey: string;
}>();

const emit = defineEmits<{
  (event: 'fork-message', payload: { sessionId: string; messageId: string }): void;
  (event: 'revert-message', payload: { sessionId: string; messageId: string }): void;
  (event: 'undo-revert'): void;
  (event: 'show-message-diff', payload: { messageKey: string; diffs: MessageDiffEntry[] }): void;
  (event: 'open-image', payload: { url: string; filename: string }): void;
  (event: 'show-thread-history', payload: { entries: HistoryWindowEntry[] }): void;
  (event: 'message-rendered', renderKey: string): void;
}>();

const msg = useMessages();

const threadMessages = computed(() => msg.getThread(props.root.id));
const assistantMessages = computed(() =>
  threadMessages.value.filter((item) => item.role === 'assistant' && hasTextContent(item)),
);
const finalAnswer = computed(() => assistantMessages.value[assistantMessages.value.length - 1]);
const hasAssistantText = computed(() => assistantMessages.value.length > 0);
const userAttachments = computed(() => getMessageAttachments(props.root));
const assistantAttachments = computed(() => getMessageAttachments(finalAnswer.value));
const historyEntries = computed(() => getHistoryEntries());
const historyCount = computed(() => historyEntries.value.length);
const hasHistory = computed(() => historyCount.value > 0);
const threadError = computed(() => getThreadError());
const userBoxStyle = computed(() => getUserBoxStyle());
const assistantStatus = computed(() => {
  const final = finalAnswer.value;
  return final ? msg.getStatus(final.id) : 'complete';
});
const threadTokens = computed(() => getThreadTokens());
const threadContextPercent = computed(() => getThreadContextPercent());
const threadDiffs = computed(() => getThreadDiffs());
const hasThreadDiffs = computed(() => threadDiffs.value.length > 0);
const assistantTransitionName = computed(() =>
  assistantStatus.value === 'streaming' ? undefined : 'ib-fade',
);
const assistantTransitionMode = computed(() =>
  assistantStatus.value === 'streaming' ? undefined : 'out-in',
);

const threadTarget = computed<ThreadTargetType>(() => buildThreadTarget(props.root));
const threadTargetAgentStyle = computed(() => {
  const color = props.resolveAgentColor
    ? props.resolveAgentColor(threadTarget.value.agent)
    : '#4ade80';
  return { color };
});

const subagentThreadMessages = computed(() => {
  const currentSessionId = props.currentSessionId?.trim();
  if (!currentSessionId) return [] as MessageInfo[];

  const rootCreatedAt = props.root.time.created;

  return msg.roots.value
    .filter((root) => root.role === 'user')
    .filter((root) => root.sessionID !== currentSessionId)
    .filter((root) => props.sessionHistoryMetaById?.[root.sessionID]?.parentID === currentSessionId)
    .filter((root) => {
      const createdAt = root.time.created;
      return createdAt >= rootCreatedAt;
    })
    .flatMap((root) => msg.getThread(root.id))
    .filter((item) => item.role === 'assistant');
});

function hasTextContent(message?: MessageInfo): boolean {
  if (!message) return false;
  return msg.hasTextContent(message.id);
}

function getMessageContent(message?: MessageInfo): string {
  if (!message) return '';
  return msg.getTextContent(message.id);
}

function getMessageAttachments(message?: MessageInfo): MessageAttachment[] {
  if (!message) return [];
  return msg.getImageAttachments(message.id) ?? [];
}

function getMessageError(message?: MessageInfo): { name: string; message: string } | null {
  if (!message) return null;
  return msg.getError(message.id);
}

function getMessageUsage(message?: MessageInfo): MessageUsage | undefined {
  if (!message) return undefined;
  return msg.getUsage(message.id);
}

function getMessageDiffEntries(message?: MessageInfo): MessageDiffEntry[] {
  if (!message) return [];
  return msg.getDiffs(message.id) ?? [];
}

function getMessageModelPath(message?: MessageInfo): string {
  if (!message) return '';
  return msg.getModelPath(message.id) ?? '';
}

function getMessageTime(message?: MessageInfo): number | undefined {
  if (!message) return undefined;
  return msg.getTime(message.id);
}

function getToolPartTime(part: ToolPart): number {
  const state = part.state;
  if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
    return state.time.start;
  }
  return 0;
}

function getSubtaskPartTime(part: SubtaskPart, fallbackTime: number): number {
  void part;
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

function getHistoryEntries(): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const allHistoryMessages = [...threadMessages.value, ...subagentThreadMessages.value];
  for (const msgInfo of allHistoryMessages) {
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
}

function getHistoryEntryKey(entry: HistoryEntry): string {
  if (entry.kind === 'message') return `msg:${entry.message.id}`;
  if (entry.kind === 'reasoning') return `reasoning:${entry.part.id}`;
  if (entry.kind === 'question') return `question:${entry.part.callID}`;
  if (entry.kind === 'subtask') return `subtask:${entry.part.id}`;
  return `tool:${entry.part.callID}`;
}

function showThreadHistory() {
  const entries = historyEntries.value.map((entry) => {
    if (entry.kind === 'message') {
      return {
        key: getHistoryEntryKey(entry),
        kind: 'message',
        content: getMessageContent(entry.message),
        time: entry.time,
        sessionId: entry.message.sessionID,
        isSubagent: Boolean(props.currentSessionId && entry.message.sessionID !== props.currentSessionId),
        agent:
          entry.message.role === 'assistant' && 'agent' in entry.message && entry.message.agent
            ? entry.message.agent
            : undefined,
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
  });
  emit('show-thread-history', { entries });
}

function getThreadError(): { name: string; message: string } | null {
  const final = finalAnswer.value;
  const finalError = getMessageError(final);
  if (finalError) return finalError;
  for (let index = threadMessages.value.length - 1; index >= 0; index--) {
    const error = getMessageError(threadMessages.value[index]);
    if (error) return error;
  }
  return null;
}

function getThreadDiffs(): MessageDiffEntry[] {
  return getMessageDiffEntries(props.root);
}

function showThreadDiff(root: MessageInfo) {
  const diffs = threadDiffs.value;
  if (diffs.length === 0) return;
  emit('show-message-diff', { messageKey: root.id, diffs });
}

function canRevertThread(root: MessageInfo): boolean {
  if (props.sessionRevert) return false;
  return root.role === 'user' && Boolean(root.sessionID);
}

function confirmFork() {
  const root = props.root;
  if (root.role !== 'user' || !root.sessionID || !root.id) return;
  if (!window.confirm(t('threadBlock.confirmFork'))) return;
  emit('fork-message', { sessionId: root.sessionID, messageId: root.id });
}

function confirmRevert(root: MessageInfo) {
  if (root.role !== 'user' || !root.sessionID || !root.id) return;
  if (!window.confirm(t('threadBlock.confirmRevert'))) return;
  emit('revert-message', { sessionId: root.sessionID, messageId: root.id });
}

function confirmUndoRevert() {
  if (!props.sessionRevert) return;
  if (!window.confirm(t('threadBlock.confirmUndoRevert'))) return;
  emit('undo-revert');
}

function buildThreadTarget(root: MessageInfo): ThreadTargetType {
  const final = finalAnswer.value;
  const agent = root.agent ?? final?.agent;
  const modelPath = getMessageModelPath(root) || getMessageModelPath(final);
  const modelMeta = props.resolveModelMeta?.(modelPath);
  const variant = getMessageVariant(root) ?? (final ? getMessageVariant(final) : undefined);
  return {
    agent,
    modelDisplayName: modelMeta?.displayName,
    providerLabel: modelMeta?.providerLabel,
    variant,
  };
}

function getUserBoxStyle() {
  const final = finalAnswer.value;
  const color = props.resolveAgentColor
    ? props.resolveAgentColor(props.root.agent ?? final?.agent)
    : '#334155';
  if (color.startsWith('#') && color.length === 7) {
    return { borderLeftColor: `${color}99` };
  }
  return { borderLeftColor: color };
}

function formatThreadTimestamp(root: MessageInfo): string {
  return formatMessageTime(getMessageTime(finalAnswer.value) ?? getMessageTime(root));
}

function getCompletedTime(message?: MessageInfo): number | undefined {
  if (!message) return undefined;
  return msg.getCompletedTime(message.id);
}

function formatThreadElapsed(root: MessageInfo): string {
  return formatElapsedTime(getMessageTime(root), getCompletedTime(finalAnswer.value));
}

function getThreadTokens(): MessageTokens | null {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let totalAcc = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let found = false;

  for (const m of assistantMessages.value) {
    const usage = getMessageUsage(m);
    if (!usage) continue;
    const t = usage.tokens;
    if (t.input <= 0 && t.output <= 0) continue;
    input += t.input;
    output += t.output;
    reasoning += t.reasoning;
    totalAcc += t.total ?? 0;
    cacheRead += t.cache?.read ?? 0;
    cacheWrite += t.cache?.write ?? 0;
    found = true;
  }

  if (!found) return null;
  return {
    input,
    output,
    reasoning,
    total: totalAcc || undefined,
    cache: { read: cacheRead, write: cacheWrite },
  };
}

function getThreadContextPercent(): number | null {
  if (!props.computeContextPercent) return null;
  let lastUsage: MessageUsage | undefined;

  for (const m of assistantMessages.value) {
    const usage = getMessageUsage(m);
    if (usage && (usage.tokens.input > 0 || usage.tokens.output > 0)) {
      lastUsage = usage;
    }
  }

  if (!lastUsage) return null;
  const value = props.computeContextPercent(
    lastUsage.tokens,
    lastUsage.providerId,
    lastUsage.modelId,
  );
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function getThreadUserRenderKey(root: MessageInfo): string {
  return `thread-user:${root.id}`;
}
</script>

<style scoped>
.thread-block {
  --ui-chip-border-neutral: var(--theme-chip-border-neutral, var(--theme-chat-border, rgba(148, 163, 184, 0.65)));
  --ui-chip-border-subtle: var(--theme-chip-border-subtle, color-mix(in srgb, var(--theme-chip-border-neutral, var(--theme-chat-border, rgba(148, 163, 184, 0.5))) 80%, transparent));
  --ui-chip-bg-neutral: var(--theme-chip-bg-neutral, var(--theme-chat-control-bg, rgba(15, 23, 42, 0.75)));
  --ui-chip-bg-hover: var(--theme-chip-bg-hover, var(--theme-chat-active-bg, rgba(30, 41, 59, 0.92)));
  --ui-chip-fg-neutral: var(--theme-chip-fg-neutral, var(--theme-chat-text, #bfdbfe));
  background: var(--theme-chat-bg, rgba(2, 6, 23, 0.6));
  border: 1px solid var(--theme-chat-border, #1e293b);
  border-radius: 10px;
  padding: 10px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
}

.thread-block.is-reverted-preview > .thread-user {
  opacity: 0.45;
}

.thread-block.is-reverted-preview > .ib-top-right {
  position: relative;
  z-index: 1;
}

.thread-user {
  border-left: 3px solid;
  padding-left: 8px;
  width: 100%;
  box-sizing: border-box;
}

.ib-msg-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ib-msg-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ib-msg-user {
  font-size: 13px;
  padding: 4px 0;
}

.ib-msg-user-reverted {
  text-decoration: line-through;
}

.ib-msg-assistant {
  margin-top: 4px;
}

.thread-assistant {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.ib-msg-body {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  --message-line-height: 1.2;
  line-height: var(--message-line-height);
  padding-top: 3px;
  padding-left: 6px;
}

.ib-top-right {
  float: right;
  margin: -2px -2px 4px 8px;
}

.ib-action {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  flex: 0 0 auto;
  height: var(--ui-chip-height);
  border: 1px solid var(--ui-chip-border-neutral);
  border-radius: var(--ui-chip-radius);
  background: var(--ui-chip-bg-neutral);
  color: var(--ui-chip-fg-neutral);
  font-family: var(--ui-chip-font-family);
  font-size: var(--ui-chip-font-size);
  font-weight: 600;
  letter-spacing: var(--ui-chip-letter-spacing);
  line-height: 1;
  padding: 0 var(--ui-chip-padding-x);
  margin: 0;
  cursor: pointer;
  white-space: nowrap;
  vertical-align: top;
}

.ib-action:hover {
  background: var(--ui-chip-bg-hover);
}

.ib-action-undo {
  border-color: var(--theme-dropdown-accent, rgba(96, 165, 250, 0.7));
  background: var(--theme-dropdown-active-bg, rgba(30, 58, 138, 0.35));
  color: var(--theme-chip-fg-neutral, #bfdbfe);
}

.ib-action-undo:hover {
  background: var(--theme-chip-bg-hover, rgba(30, 64, 175, 0.55));
}

.ib-action-history {
  border-color: var(--ui-chip-border-subtle);
  background: var(--theme-chat-control-bg, rgba(30, 41, 59, 0.35));
  color: var(--theme-chat-text-muted, #94a3b8);
  margin-top: 4px;
  align-self: flex-end;
}

.ib-action-history:hover {
  background: var(--theme-chat-active-bg, rgba(51, 65, 85, 0.55));
  color: var(--theme-chat-text, #cbd5e1);
}

.ib-error-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--theme-surface-danger, rgba(127, 29, 29, 0.3));
  border: 1px solid color-mix(in srgb, var(--theme-status-danger, #fca5a5) 40%, transparent);
  color: var(--theme-text-danger, #fca5a5);
  font-size: 11px;
  line-height: 1.3;
}

.ib-error-icon {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--theme-status-danger, #f87171);
}

.ib-error-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ib-fade-enter-active,
.ib-fade-leave-active {
  transition: opacity 0.3s ease;
}

.ib-fade-enter-from,
.ib-fade-leave-to {
  opacity: 0;
}

.output-entry-attachments {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 6px;
  margin-top: 6px;
}

.output-entry-attachment {
  width: 100%;
  max-height: 180px;
  border-radius: 8px;
  border: 1px solid var(--theme-chat-border, var(--theme-border-default, #1e293b));
  object-fit: cover;
  background: var(--theme-chat-control-bg, var(--theme-surface-panel-muted, #0b1320));
}

.output-entry-attachment.clickable {
  cursor: pointer;
}
</style>
