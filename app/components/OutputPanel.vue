<template>
  <div class="output-panel-root">
    <div class="output-panel-shell" :style="shellStyle">
      <div
        ref="panelEl"
        class="output-panel-scroll"
        @scroll="handleScroll"
        @wheel="$emit('wheel', $event)"
        @touchmove="$emit('touchmove')"
      >
        <div ref="contentEl" class="output-panel-content">
          <div
            v-if="initialRenderTrackingActive"
            class="absolute w-full h-full m-auto flex justify-center items-center"
          >
            <div class="app-loading-spinner" aria-hidden="true"></div>
          </div>
          <template v-for="root in visibleRoots" :key="root.id">
            <div class="thread-block" v-show="!initialRenderTrackingActive">
              <button
                v-if="root.role === 'user' && root.sessionID"
                type="button"
                class="ib-action ib-top-right"
                @click="confirmFork(root)"
              >
                FORK
              </button>

              <div class="thread-user" :style="getUserBoxStyle(root)">
                <div v-if="root.role === 'user'" class="ib-msg-block ib-msg-user">
                  <div class="ib-msg-row">
                    <MessageViewer
                      :code="getMessageContent(root)"
                      :lang="'markdown'"
                      :theme="theme"
                      @rendered="handleMessageRendered(getThreadUserRenderKey(root))"
                    />
                    <div
                      v-if="getMessageAttachments(root).length > 0"
                      class="output-entry-attachments"
                    >
                      <img
                        v-for="item in getMessageAttachments(root)"
                        :key="item.id"
                        class="output-entry-attachment clickable"
                        :src="item.url"
                        :alt="item.filename"
                        loading="lazy"
                        @click="$emit('open-image', { url: item.url, filename: item.filename })"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div
                v-if="formatThreadTargetLabel(root)"
                class="ib-round-target"
                :style="getRoundTargetStyle(root)"
              >
                {{ formatThreadTargetLabel(root) }}
              </div>

              <div v-if="hasAssistantMessages(root)" class="thread-assistant">
                <Transition name="ib-fade" mode="out-in">
                  <div class="ib-msg-block ib-msg-assistant" :key="getDeferredTransitionKey(root)">
                    <div class="ib-msg-body">
                      <MessageViewer :html="getAssistantHtml(root)" />
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
                        @click="$emit('open-image', { url: item.url, filename: item.filename })"
                      />
                    </div>
                    <button
                      v-if="showHistoryButton(root)"
                      type="button"
                      class="ib-action ib-action-history"
                      :title="`${getHistoryEntries(root).length} entries - click to view history`"
                      @click="showThreadHistory(root)"
                    >
                      History ({{ getHistoryEntries(root).length }})
                    </button>
                  </div>
                </Transition>
              </div>

              <div v-if="getThreadError(root)" class="ib-error-bar">
                <span class="ib-error-icon">⊘</span>
                <span class="ib-error-text">{{ formatMessageError(getThreadError(root)!) }}</span>
              </div>

              <div class="ib-footer">
                <span class="ib-footer-meta">
                  <span v-if="formatThreadTimestamp(root)" class="ib-meta-item">
                    <Icon icon="lucide:clock" :width="10" :height="10" />
                    {{ formatThreadTimestamp(root) }}
                  </span>
                  <span v-if="formatThreadElapsed(root)" class="ib-meta-item">
                    <Icon icon="lucide:timer" :width="10" :height="10" />
                    {{ formatThreadElapsed(root) }}
                  </span>
                  <span
                    v-if="getThreadContextPercent(root) != null"
                    class="ib-meta-item"
                    :class="contextSeverityClass(getThreadContextPercent(root)!)"
                  >
                    <Icon icon="lucide:gauge" :width="10" :height="10" />
                    {{ getThreadContextPercent(root) }}%
                  </span>
                  <span v-if="getThreadTokens(root)" class="ib-meta-item ib-meta-tokens">
                    <span class="ib-token-in" title="Input tokens"
                      ><Icon icon="lucide:arrow-up" :width="9" :height="9" />{{
                        formatTokenCount(getThreadTokens(root)!.input)
                      }}</span
                    >
                    <span class="ib-token-out" title="Output tokens"
                      ><Icon icon="lucide:arrow-down" :width="9" :height="9" />{{
                        formatTokenCount(getThreadTokens(root)!.output)
                      }}</span
                    >
                    <span class="ib-token-reason" title="Reasoning tokens"
                      ><Icon icon="lucide:brain" :width="9" :height="9" />{{
                        formatTokenCount(getThreadTokens(root)!.reasoning)
                      }}</span
                    >
                  </span>
                </span>
                <span class="ib-footer-actions">
                  <button
                    v-if="hasThreadDiffs(root)"
                    type="button"
                    class="ib-action ib-action-diff"
                    @click="showThreadDiff(root)"
                  >
                    DIFF
                  </button>
                  <button
                    v-if="canRevertThread(root)"
                    type="button"
                    class="ib-action ib-action-danger"
                    @click="confirmRevert(root)"
                  >
                    REVERT
                  </button>
                </span>
              </div>
            </div>
          </template>
          <button
            v-show="!isFollowing"
            type="button"
            class="follow-button"
            aria-label="Scroll to latest"
            @click="$emit('resume-follow')"
          >
            <Icon icon="lucide:arrow-down" :width="14" :height="14" />
          </button>
        </div>
      </div>

      <div class="statusbar" role="status" aria-live="polite">
        <div class="statusbar-section statusbar-left">
          <span class="statusbar-text">{{ thinkingDisplayText }}</span>
        </div>
        <div
          class="statusbar-section statusbar-right"
          :class="{ 'is-error': isStatusError, 'is-retry': isRetryStatus }"
        >
          {{ statusText }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import {
  Transition,
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  watchEffect,
} from 'vue';
import MessageViewer from './MessageViewer.vue';
import { renderWorkerHtml } from '../utils/workerRenderer';
import { useMessages } from '../composables/useMessages';
import type {
  MessageAttachment,
  MessageTokens,
  MessageUsage,
} from '../types/message';
import type { MessageInfo, QuestionInfo, ReasoningPart, ToolPart } from '../types/sse';

type DiffEntry = { file: string; diff: string; before?: string; after?: string };

type HistoryEntry =
  | { kind: 'message'; message: MessageInfo; time: number }
  | { kind: 'tool'; part: ToolPart; time: number }
  | { kind: 'reasoning'; part: ReasoningPart; time: number }
  | { kind: 'question'; part: ToolPart; time: number };

type HistoryWindowEntry =
  | { key: string; kind: 'message'; content: string; time: number; agent?: string }
  | { key: string; kind: 'tool'; part: ToolPart; time: number }
  | { key: string; kind: 'reasoning'; part: ReasoningPart; time: number }
  | {
      key: string;
      kind: 'question';
      questions: QuestionInfo[];
      status: 'pending' | 'replied' | 'rejected';
      answers?: string[][];
      time: number;
    };

const HISTORY_TOOL_NAMES = new Set(['bash', 'write', 'edit', 'multiedit', 'apply_patch']);

const msg = useMessages();

const props = defineProps<{
  isFollowing: boolean;
  statusText: string;
  isStatusError: boolean;
  isThinking: boolean;
  isRetryStatus?: boolean;
  busyDescendantCount?: number;
  theme: string;
  resolveAgentColor?: (agent?: string) => string;
  computeContextPercent?: (
    tokens: MessageTokens,
    providerId?: string,
    modelId?: string,
  ) => number | null;
  projectColor?: string;
}>();

const emit = defineEmits<{
  (event: 'scroll'): void;
  (event: 'wheel', eventArg: WheelEvent): void;
  (event: 'touchmove'): void;
  (event: 'resume-follow'): void;
  (event: 'fork-message', payload: { sessionId: string; messageId: string }): void;
  (event: 'revert-message', payload: { sessionId: string; messageId: string }): void;
  (event: 'show-message-diff', payload: { messageKey: string; diffs: DiffEntry[] }): void;
  (event: 'open-image', payload: { url: string; filename: string }): void;
  (event: 'show-thread-history', payload: { entries: HistoryWindowEntry[] }): void;
  (event: 'message-rendered'): void;
  (event: 'content-resized'): void;
  (event: 'initial-render-complete'): void;
}>();

const visibleRoots = computed(() => msg.roots.value);

const cachedThreads = computed(() => {
  const map = new Map<string, MessageInfo[]>();
  for (const root of visibleRoots.value) {
    map.set(root.id, msg.getThread(root.id));
  }
  return map;
});

const cachedFinalAnswers = computed(() => {
  const map = new Map<string, MessageInfo | undefined>();
  for (const root of visibleRoots.value) {
    const thread = cachedThreads.value.get(root.id) ?? [];
    const assistants = thread.filter((m) => m.role === 'assistant' && msg.hasTextContent(m.id));
    map.set(root.id, assistants[assistants.length - 1]);
  }
  return map;
});

function getThread(rootId: string): MessageInfo[] {
  return cachedThreads.value.get(rootId) ?? msg.getThread(rootId);
}



function getFinalAnswer(root: MessageInfo): MessageInfo | undefined {
  if (cachedFinalAnswers.value.has(root.id)) {
    return cachedFinalAnswers.value.get(root.id);
  }
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

function getMessageDiffEntries(message?: MessageInfo): DiffEntry[] {
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

function getFinalAnswerContent(root: MessageInfo): string {
  return getMessageContent(getFinalAnswer(root));
}

function getAssistantMessages(root: MessageInfo): MessageInfo[] {
  return getThread(root.id).filter((msg) => msg.role === 'assistant' && hasTextContent(msg));
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

function formatMessageError(error: { name: string; message: string }): string {
  if (error.name === 'MessageAbortedError') return error.message || 'Aborted';
  const parts: string[] = [];
  if (error.name) parts.push(error.name);
  if (error.message) parts.push(error.message);
  return parts.join(': ') || 'Error';
}

function getThreadDiffs(root: MessageInfo): DiffEntry[] {
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
  return root.role === 'user' && Boolean(root.sessionID) && hasThreadDiffs(root);
}

function confirmFork(root: MessageInfo) {
  if (root.role !== 'user' || !root.sessionID || !root.id) return;
  if (!window.confirm('Fork from this message?')) return;
  emit('fork-message', { sessionId: root.sessionID, messageId: root.id });
}

function confirmRevert(root: MessageInfo) {
  if (root.role !== 'user' || !root.sessionID || !root.id) return;
  if (!window.confirm('Revert to this message?')) return;
  emit('revert-message', { sessionId: root.sessionID, messageId: root.id });
}

function formatThreadTargetLabel(root: MessageInfo): string {
  const final = getFinalAnswer(root);
  const parts: string[] = [];
  const agent = root.agent ?? final?.agent;
  if (agent) parts.push(`Agent ${agent}`);
  const modelPath = getMessageModelPath(root) || getMessageModelPath(final);
  if (modelPath) parts.push(modelPath);
  const variant = root.variant ?? final?.variant;
  if (variant) parts.push(`(${variant})`);
  return parts.join(' ');
}

function getRoundTargetStyle(root: MessageInfo) {
  const final = getFinalAnswer(root);
  const color = props.resolveAgentColor
    ? props.resolveAgentColor(root.agent ?? final?.agent)
    : '#4ade80';
  return { color };
}

function getUserBoxStyle(root: MessageInfo) {
  const final = getFinalAnswer(root);
  const color = props.resolveAgentColor
    ? props.resolveAgentColor(root.agent ?? final?.agent)
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
  const start = getMessageTime(root);
  const end = getCompletedTime(final);
  if (typeof start !== 'number' || typeof end !== 'number') return '';
  const sec = Math.round((end - start) / 1000);
  if (sec < 1) return '';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m${rem}s` : `${min}m`;
}

/**
 * Sum info.tokens across ALL assistant messages in a thread.
 * Context % uses the LAST assistant only (= current context window state).
 */
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

function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'K';
  if (n < 1_000_000) return Math.round(n / 1000) + 'K';
  return (n / 1_000_000).toFixed(1) + 'M';
}

function contextSeverityClass(percent: number): string {
  if (percent >= 90) return 'ib-ctx-critical';
  if (percent >= 75) return 'ib-ctx-high';
  if (percent >= 50) return 'ib-ctx-moderate';
  return 'ib-ctx-low';
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

const panelEl = ref<HTMLDivElement | null>(null);
const contentEl = ref<HTMLDivElement | null>(null);
const pendingInitialRenderKeys = ref(new Set<string>());
const initialRenderTrackingActive = ref(false);
const renderedKeys = ref(new Set<string>());
const thinkingFrames = ['', '.', '..', '...'];
const thinkingIndex = ref(0);
const thinkingSuffix = ref('');
let thinkingTimer: number | undefined;
let contentResizeObserver: ResizeObserver | undefined;

// --- Assistant reply pre-rendering ---
// rootId → pre-rendered HTML
const assistantHtmlCache = reactive(new Map<string, string>());
// rootId → confirmed transition key (deferred until pre-render completes)
const deferredKeyCache = reactive(new Map<string, string>());
// Ordering (non-reactive)
const submitSeqMap = new Map<string, number>();
const appliedSeqMap = new Map<string, number>();
// Deduplication
const lastSubmitted = new Map<string, { answerId: string; content: string; theme: string }>();

function submitAssistantRender(rootId: string, answerId: string, content: string) {
  const seq = (submitSeqMap.get(rootId) ?? 0) + 1;
  submitSeqMap.set(rootId, seq);

  const requestId = `assistant-${rootId}-${seq}`;
  renderWorkerHtml({
    id: requestId,
    code: content,
    lang: 'markdown',
    theme: props.theme,
    gutterMode: 'none',
  }).then((html) => {
    const applied = appliedSeqMap.get(rootId) ?? 0;
    if (seq <= applied) return;
    appliedSeqMap.set(rootId, seq);
    assistantHtmlCache.set(rootId, html);
    deferredKeyCache.set(rootId, answerId);
    handleMessageRendered(getThreadAssistantRenderKeyById(rootId, answerId));
  });
}

function getDeferredTransitionKey(root: MessageInfo): string {
  return deferredKeyCache.get(root.id) ?? getThreadTransitionKey(root);
}

function getAssistantHtml(root: MessageInfo): string | undefined {
  return assistantHtmlCache.get(root.id);
}

watchEffect(() => {
  const theme = props.theme;
  for (const root of visibleRoots.value) {
    if (!hasAssistantMessages(root)) continue;
    const final = getFinalAnswer(root);
    const answerId = final?.id ?? root.id;
    const content = getFinalAnswerContent(root);

    const last = lastSubmitted.get(root.id);
    if (last && last.answerId === answerId && last.content === content && last.theme === theme) {
      continue;
    }
    lastSubmitted.set(root.id, { answerId, content, theme });
    submitAssistantRender(root.id, answerId, content);
  }
});

const thinkingDisplayText = computed(() => {
  if (!props.isThinking) return '🟢 Idle';
  const descendants = props.busyDescendantCount ?? 0;
  const total = Math.max(1, 1 + descendants);
  const heads = '🤔'.repeat(Math.min(total, 8));
  return `${heads} Thinking${thinkingSuffix.value}`;
});

function getThreadUserRenderKey(root: MessageInfo): string {
  return `thread-user:${root.id}`;
}

function getThreadAssistantRenderKey(root: MessageInfo): string {
  const final = getFinalAnswer(root);
  return getThreadAssistantRenderKeyById(root.id, final?.id);
}

function getThreadAssistantRenderKeyById(rootId: string, answerId?: string): string {
  return `thread-assistant:${rootId}:${answerId ?? 'none'}`;
}

function getThreadTransitionKey(root: MessageInfo): string {
  return getFinalAnswer(root)?.id ?? root.id;
}



function collectInitialRenderKeys(): Set<string> {
  const keys = new Set<string>();
  visibleRoots.value.forEach((root) => {
    keys.add(getThreadUserRenderKey(root));
    if (hasAssistantMessages(root)) keys.add(getThreadAssistantRenderKey(root));
  });
  return keys;
}

function beginInitialRenderTracking() {
  const keys = collectInitialRenderKeys();
  pendingInitialRenderKeys.value = keys;
  initialRenderTrackingActive.value = keys.size > 0;
  if (keys.size === 0) emit('initial-render-complete');
}

function handleScroll() {
  emit('scroll');
}

function handleMessageRendered(renderKey: string) {
  renderedKeys.value.add(renderKey);
  emit('message-rendered');
  if (!initialRenderTrackingActive.value) return;
  const keys = pendingInitialRenderKeys.value;
  keys.delete(renderKey);
  if (keys.size > 0) return;
  initialRenderTrackingActive.value = false;
  emit('initial-render-complete');
}

function setupContentResizeObserver() {
  contentResizeObserver?.disconnect();
  contentResizeObserver = undefined;
  if (typeof ResizeObserver === 'undefined') return;
  const target = contentEl.value;
  if (!target) return;
  contentResizeObserver = new ResizeObserver(() => {
    emit('content-resized');
  });
  contentResizeObserver.observe(target);
}

watch(
  () => props.isThinking,
  (active) => {
    if (!active) {
      if (thinkingTimer !== undefined) {
        window.clearInterval(thinkingTimer);
        thinkingTimer = undefined;
      }
      thinkingIndex.value = 0;
      thinkingSuffix.value = '';
      return;
    }
    thinkingIndex.value = 0;
    thinkingSuffix.value = thinkingFrames[thinkingIndex.value] ?? '';
    if (thinkingTimer !== undefined) window.clearInterval(thinkingTimer);
    thinkingTimer = window.setInterval(() => {
      thinkingIndex.value = (thinkingIndex.value + 1) % thinkingFrames.length;
      thinkingSuffix.value = thinkingFrames[thinkingIndex.value] ?? '';
    }, 350);
  },
  { immediate: true },
);

watch(contentEl, () => {
  setupContentResizeObserver();
});

watch(
  () => visibleRoots.value.length,
  (length, previous) => {
    if (length === 0) {
      pendingInitialRenderKeys.value = new Set<string>();
      initialRenderTrackingActive.value = false;
      renderedKeys.value = new Set<string>();
      return;
    }
    if (previous === 0) beginInitialRenderTracking();
  },
);

onMounted(() => {
  setupContentResizeObserver();
  nextTick(() => {
    beginInitialRenderTracking();
    emit('content-resized');
  });
});

onBeforeUnmount(() => {
  contentResizeObserver?.disconnect();
  contentResizeObserver = undefined;
  if (thinkingTimer !== undefined) window.clearInterval(thinkingTimer);
});

const shellStyle = computed(() => {
  if (!props.projectColor) return undefined;
  return { '--project-tint': props.projectColor } as Record<string, string>;
});

defineExpose({ panelEl });
</script>

<style scoped>
.output-panel-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.output-panel-shell {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
  background-color: rgba(15, 23, 42, 0.92);
  background-image: linear-gradient(
    color-mix(in srgb, var(--project-tint, transparent) 9%, transparent),
    color-mix(in srgb, var(--project-tint, transparent) 9%, transparent)
  );
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 12px;
  background-clip: padding-box;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  display: flex;
  flex-direction: column;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
}

.output-panel-scroll {
  display: flex;
  flex-direction: column;
  padding: 10px 12px 12px;
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.output-panel-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 100%;
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

.follow-button {
  position: sticky;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  width: 36px;
  height: 36px;
  aspect-ratio: 1 / 1;
  box-sizing: border-box;
  border-radius: 999px;
  border: 1px solid #334155;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  font-size: 18px;
  line-height: 1;
  display: grid;
  place-items: center;
  box-shadow: 0 10px 24px rgba(2, 6, 23, 0.45);
  cursor: pointer;
  align-self: center;
  margin-top: 4px;
  z-index: 2;
}

.statusbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px;
  border-top: none;
  background: transparent;
  color: #94a3b8;
  font-size: 8pt;
  line-height: 1.2;
  margin: 0;
  border-radius: 0;
  box-sizing: border-box;
  z-index: 2;
}

.statusbar-section {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.statusbar-right {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.statusbar-right.is-error,
.statusbar-right.is-retry {
  color: #fecaca;
}

.follow-button:hover {
  background: rgba(30, 41, 59, 0.98);
}

.thread-block {
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 10px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
}

.thread-user {
  border-left: 3px solid;
  padding-left: 8px;
  width: 100%;
  box-sizing: border-box;
}

.ib-round-target {
  font-size: 10px;
  font-weight: 600;
  margin-top: 4px;
  opacity: 0.7;
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

.ib-streaming-indicator {
  margin-top: 4px;
  padding-left: 6px;
  font-size: 10px;
  color: rgba(148, 163, 184, 0.85);
}

.ib-footer-meta {
  font-size: 10px;
  color: rgba(148, 163, 184, 0.7);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.ib-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.ib-meta-tokens {
  gap: 6px;
}

.ib-token-in,
.ib-token-out,
.ib-token-reason {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.ib-ctx-low {
  color: rgba(96, 165, 250, 0.7);
}
.ib-ctx-moderate {
  color: rgba(251, 191, 36, 0.8);
}
.ib-ctx-high {
  color: rgba(249, 115, 22, 0.85);
}
.ib-ctx-critical {
  color: rgba(248, 113, 113, 0.9);
}

.ib-top-right {
  float: right;
  margin: -2px -2px 4px 8px;
}

.ib-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.ib-footer-actions {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
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

.ib-action-diff {
  border-color: rgba(96, 165, 250, 0.7);
  background: rgba(30, 58, 138, 0.35);
  color: #bfdbfe;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.ib-action-diff:hover {
  background: rgba(30, 64, 175, 0.55);
}

.ib-action-danger {
  border-color: rgba(248, 113, 113, 0.7);
  background: rgba(127, 29, 29, 0.35);
  color: #fecaca;
}

.ib-action-danger:hover {
  background: rgba(153, 27, 27, 0.5);
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

.app-loading-spinner {
  width: 26px;
  height: 26px;
  margin: 0 auto 12px;
  border-radius: 50%;
  border: 3px solid rgba(148, 163, 184, 0.4);
  border-top-color: #e2e8f0;
  animation: app-loading-spin 0.85s linear infinite;
}

@keyframes app-loading-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
