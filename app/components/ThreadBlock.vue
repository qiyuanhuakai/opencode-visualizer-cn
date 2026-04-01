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

    <div class="thread-user" :style="getUserBoxStyle()">
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
          <div v-if="getMessageAttachments(root).length > 0" class="output-entry-attachments">
            <img
              v-for="item in getMessageAttachments(root)"
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

    <div v-if="!isRevertedPreview && hasAssistantMessages(root)" class="thread-assistant">
      <Transition name="ib-fade" mode="out-in">
        <div class="ib-msg-block ib-msg-assistant" :key="deferredTransitionKey">
          <div class="ib-msg-body">
            <MessageViewer
              class="message-viewer-context-assistant"
              :html="assistantHtml"
              copy-button
            />
          </div>
          <div
            v-if="getMessageAttachments(getFinalAnswer(root)).length > 0"
            class="output-entry-attachments"
          >
            <img
              v-for="item in getMessageAttachments(getFinalAnswer(root))"
              :key="item.id"
              class="output-entry-attachment clickable"
              :src="item.url"
              :alt="item.filename"
              loading="lazy"
              @click="emit('open-image', { url: item.url, filename: item.filename })"
            />
          </div>
          <button
            v-if="showHistoryButton(root)"
            type="button"
            class="ib-action ib-action-history"
            :title="t('threadBlock.historyTitle', { count: getHistoryEntries(root).length })"
            @click="showThreadHistory(root)"
          >
            {{ t('threadBlock.historyLabel') }} ({{ getHistoryEntries(root).length }})
          </button>
        </div>
      </Transition>
    </div>

    <div v-if="!isRevertedPreview && getThreadError(root)" class="ib-error-bar">
      <span class="ib-error-icon">⊘</span>
      <span class="ib-error-text">{{ formatMessageError(getThreadError(root)!, (key) => t(key)) }}</span>
    </div>

    <ThreadFooter
      v-if="!isRevertedPreview"
      :timestamp="formatThreadTimestamp(root)"
      :elapsed="formatThreadElapsed(root)"
      :context-percent="getThreadContextPercent(root)"
      :tokens="getThreadTokens(root)"
      :has-diffs="hasThreadDiffs(root)"
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
import type { MessageInfo, QuestionInfo, ToolPart } from '../types/sse';
import { formatElapsedTime, formatMessageError, formatMessageTime } from '../utils/formatters';

const { t } = useI18n();

const HISTORY_TOOL_NAMES = new Set(['bash', 'write', 'edit', 'multiedit', 'apply_patch']);

const props = defineProps<{
  root: MessageInfo;
  theme: string;
  filesWithBasenames: string[];
  isRevertedPreview: boolean;
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

const threadTarget = computed<ThreadTargetType>(() => buildThreadTarget(props.root));
const threadTargetAgentStyle = computed(() => {
  const color = props.resolveAgentColor
    ? props.resolveAgentColor(threadTarget.value.agent)
    : '#4ade80';
  return { color };
});

function getThread(rootId: string): MessageInfo[] {
  return msg.getThread(rootId);
}

function getFinalAnswer(root: MessageInfo): MessageInfo | undefined {
  return msg.getFinalAnswer(root.id);
}

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

function getAssistantMessages(root: MessageInfo): MessageInfo[] {
  return getThread(root.id).filter((item) => item.role === 'assistant' && hasTextContent(item));
}

function hasAssistantMessages(root: MessageInfo): boolean {
  return getAssistantMessages(root).length > 0;
}

function getToolPartTime(part: ToolPart): number {
  const state = part.state;
  if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
    return state.time.start;
  }
  return 0;
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

function getHistoryEntries(root: MessageInfo): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const thread = getThread(root.id);
  for (const msgInfo of thread) {
    if (msgInfo.role !== 'assistant') continue;
    if (hasTextContent(msgInfo)) {
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
  return `tool:${entry.part.callID}`;
}

function showHistoryButton(root: MessageInfo): boolean {
  return getHistoryEntries(root).length > 0;
}

function showThreadHistory(root: MessageInfo) {
  const entries = getHistoryEntries(root).map((entry) => {
    if (entry.kind === 'message') {
      return {
        key: getHistoryEntryKey(entry),
        kind: 'message',
        content: getMessageContent(entry.message),
        time: entry.time,
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
    return {
      key: getHistoryEntryKey(entry),
      kind: 'tool',
      part: entry.part,
      time: entry.time,
    } satisfies HistoryWindowEntry;
  });
  emit('show-thread-history', { entries });
}

function getThreadError(root: MessageInfo): { name: string; message: string } | null {
  const final = getFinalAnswer(root);
  const finalError = getMessageError(final);
  if (finalError) return finalError;
  const thread = getThread(root.id);
  for (let index = thread.length - 1; index >= 0; index--) {
    const error = getMessageError(thread[index]);
    if (error) return error;
  }
  return null;
}

function getThreadDiffs(root: MessageInfo): MessageDiffEntry[] {
  return getMessageDiffEntries(root);
}

function hasThreadDiffs(root: MessageInfo): boolean {
  return getThreadDiffs(root).length > 0;
}

function showThreadDiff(root: MessageInfo) {
  const diffs = getThreadDiffs(root);
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
  const final = getFinalAnswer(root);
  const agent = root.agent ?? final?.agent;
  const modelPath = getMessageModelPath(root) || getMessageModelPath(final);
  const modelMeta = props.resolveModelMeta?.(modelPath);
  const variant = root.variant ?? final?.variant;
  return {
    agent,
    modelDisplayName: modelMeta?.displayName,
    providerLabel: modelMeta?.providerLabel,
    variant,
  };
}

function getUserBoxStyle() {
  const final = getFinalAnswer(props.root);
  const color = props.resolveAgentColor
    ? props.resolveAgentColor(props.root.agent ?? final?.agent)
    : '#334155';
  if (color.startsWith('#') && color.length === 7) {
    return { borderLeftColor: `${color}99` };
  }
  return { borderLeftColor: color };
}

function formatThreadTimestamp(root: MessageInfo): string {
  return formatMessageTime(getMessageTime(getFinalAnswer(root)) ?? getMessageTime(root));
}

function getCompletedTime(message?: MessageInfo): number | undefined {
  if (!message) return undefined;
  return msg.getCompletedTime(message.id);
}

function formatThreadElapsed(root: MessageInfo): string {
  const final = getFinalAnswer(root);
  return formatElapsedTime(getMessageTime(root), getCompletedTime(final));
}

function getThreadTokens(root: MessageInfo): MessageTokens | null {
  const thread = getThread(root.id);
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let totalAcc = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let found = false;

  for (const m of thread) {
    if (m.role !== 'assistant') continue;
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

function getThreadContextPercent(root: MessageInfo): number | null {
  if (!props.computeContextPercent) return null;
  const thread = getThread(root.id);
  let lastUsage: MessageUsage | undefined;

  for (const m of thread) {
    if (m.role !== 'assistant') continue;
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
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid #1e293b;
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
  border: 1px solid rgba(148, 163, 184, 0.65);
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.75);
  color: #bfdbfe;
  font-size: 10px;
  line-height: 1;
  padding: 3px 7px;
  cursor: pointer;
  white-space: nowrap;
}

.ib-action:hover {
  background: rgba(30, 41, 59, 0.92);
}

.ib-action-undo {
  border-color: rgba(96, 165, 250, 0.7);
  background: rgba(30, 58, 138, 0.35);
  color: #bfdbfe;
}

.ib-action-undo:hover {
  background: rgba(30, 64, 175, 0.55);
}

.ib-action-history {
  border-color: rgba(148, 163, 184, 0.5);
  background: rgba(30, 41, 59, 0.35);
  color: #94a3b8;
  font-size: 10px;
  margin-top: 4px;
  align-self: flex-end;
}

.ib-action-history:hover {
  background: rgba(51, 65, 85, 0.55);
  color: #cbd5e1;
}

.ib-error-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(127, 29, 29, 0.3);
  border: 1px solid rgba(248, 113, 113, 0.4);
  color: #fca5a5;
  font-size: 11px;
  line-height: 1.3;
}

.ib-error-icon {
  flex-shrink: 0;
  font-size: 13px;
  color: #f87171;
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
  border: 1px solid #1e293b;
  object-fit: cover;
  background: #0b1320;
}

.output-entry-attachment.clickable {
  cursor: pointer;
}
</style>
