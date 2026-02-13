<template>
  <div class="output-panel-root">
    <div class="output-panel-shell">
      <div
        ref="panelEl"
        class="output-panel-scroll"
        :class="{ 'is-initial-loading': initialRenderTrackingActive }"
        @scroll="handleScroll"
        @wheel="$emit('wheel', $event)"
        @touchmove="$emit('touchmove')"
      >
        <div ref="contentEl" class="output-panel-content">
          <template
            v-for="q in filteredQueue"
            :key="q.messageKey ?? q.roundId ?? q.messageId ?? q.time"
          >
            <!-- ===== Round: nested box layout ===== -->
            <div v-if="q.isRound" v-show="isEntryRendered(q)" class="info-block">
              <!-- Fork button (top-right) -->
              <button
                v-if="q.roundId && q.sessionId"
                type="button"
                class="ib-action ib-top-right"
                @click="confirmFork(q)"
              >
                FORK
              </button>

              <!-- User message (always visible, agent theme left border) -->
              <div class="ib-user-box" :style="getUserBoxStyle(q)">
                <template v-for="(group, gi) in groupRoundMessages(q)" :key="gi">
                  <template v-if="group.role === 'user'">
                    <div class="ib-msg-block ib-msg-user">
                      <div
                        v-for="(msg, mi) in group.messages"
                        :key="msg.messageId ?? mi"
                        class="ib-msg-row"
                      >
                        <MessageViewer
                          :code="msg.content"
                          :lang="'markdown'"
                          :theme="theme"
                          @rendered="handleMessageRendered(getRoundUserRenderKey(q, msg, mi))"
                        />
                        <div
                          v-if="msg.attachments && msg.attachments.length > 0"
                          class="output-entry-attachments"
                        >
                          <img
                            v-for="item in msg.attachments"
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
                  </template>
                </template>
              </div>

              <!-- Target agent/model separator -->
              <div
                v-if="formatRoundTargetLabel(q)"
                class="ib-round-target"
                :style="getRoundTargetStyle(q)"
              >
                {{ formatRoundTargetLabel(q) }}
              </div>

              <!-- Assistant response area (no collapse, fade transition per message) -->
              <div v-if="hasAssistantMessages(q)" class="ib-response-area">
                <template v-for="(group, gi) in groupRoundMessages(q)" :key="gi">
                  <template v-if="group.role === 'assistant'">
                    <Transition name="ib-fade" mode="out-in">
                      <div
                        class="ib-msg-block ib-msg-assistant"
                        :key="getGroupTransitionKey(group)"
                      >
                        <div class="ib-msg-body">
                          <MessageViewer
                            :code="group.messages[group.messages.length - 1]?.content ?? ''"
                            :lang="'markdown'"
                            :theme="theme"
                            @rendered="handleMessageRendered(getRoundAssistantRenderKey(q, group))"
                          />
                        </div>
                        <button
                           v-if="group.messages.length > 1 || (isThinking && isLastAssistantGroup(q, gi))"
                           type="button"
                           class="ib-action ib-action-history"
                           :title="`${group.messages.length} messages – click to view history`"
                           @click="showGroupHistory(q, group)"
                         >
                           ^ {{ group.messages.length }}
                         </button>
                      </div>
                    </Transition>
                  </template>
                </template>
              </div>

              <!-- Error indicator (e.g. abort) -->
              <div v-if="q.messageError" class="ib-error-bar">
                <span class="ib-error-icon">⊘</span>
                <span class="ib-error-text">{{ formatMessageError(q.messageError) }}</span>
              </div>

              <!-- Footer: meta left, actions right -->
              <div class="ib-footer">
                <span class="ib-footer-meta">{{ formatRoundFooterMeta(q) }}</span>
                <span class="ib-footer-actions">
                  <button
                    v-if="q.messageKey && hasMessageDiffs(q.messageKey)"
                    type="button"
                    class="ib-action ib-action-diff"
                    @click="showRoundDiff(q)"
                  >
                    DIFF
                  </button>
                  <button
                    v-if="q.roundId && q.sessionId && q.messageKey && hasMessageDiffs(q.messageKey)"
                    type="button"
                    class="ib-action ib-action-danger"
                    @click="confirmRevert(q)"
                  >
                    REVERT
                  </button>
                </span>
              </div>
            </div>

            <!-- ===== Non-round fallback ===== -->
            <div
              v-else
              v-show="isEntryRendered(q)"
              class="output-entry"
              :class="{ 'is-user': q.role === 'user', 'is-question-answer': q.isQuestionAnswer }"
              :style="getEntryStyle(q)"
            >
              <div
                v-if="q.role === 'user' && formatMessageAgent(q)"
                class="output-entry-agent"
                :style="getAgentTextStyle(q)"
              >
                {{ formatMessageAgent(q) }}
              </div>
              <div
                class="output-entry-inner"
                :class="{ 'is-scrolling': q.scroll }"
                :style="{
                  '--scroll-distance': `${q.scrollDistance}px`,
                  '--scroll-duration': `${q.scrollDuration}s`,
                }"
              >
                <MessageViewer
                  :code="q.content"
                  :lang="'markdown'"
                  :theme="theme"
                  @rendered="handleMessageRendered(getEntryRenderKey(q))"
                />
                <div
                  v-if="q.attachments && q.attachments.length > 0"
                  class="output-entry-attachments"
                >
                  <img
                    v-for="item in q.attachments"
                    :key="item.id"
                    class="output-entry-attachment clickable"
                    :src="item.url"
                    :alt="item.filename"
                    loading="lazy"
                    @click="$emit('open-image', { url: item.url, filename: item.filename })"
                  />
                </div>
              </div>
              <div v-if="hasFooter(q)" class="output-entry-footer">
                <div class="output-entry-footer-left">
                  <span v-if="formatMessageMeta(q)" class="output-entry-meta">{{
                    formatMessageMeta(q)
                  }}</span>
                  <span
                    v-if="formatMessageMeta(q) && formatMessageUsage(q)"
                    class="output-entry-sep"
                    >•</span
                  >
                  <span v-if="formatMessageUsage(q)" class="output-entry-usage">{{
                    formatMessageUsage(q)
                  }}</span>
                </div>
                <div class="output-entry-footer-right">
                  <button
                    v-if="q.role === 'assistant' && q.messageKey && hasMessageDiffs(q.messageKey)"
                    type="button"
                    class="output-entry-action output-entry-action-diff"
                    @click="showMessageDiff(q)"
                  >
                    DIFF
                  </button>
                  <button
                    v-if="q.role === 'user' && q.messageId && q.sessionId"
                    type="button"
                    class="output-entry-action"
                    @click="confirmFork(q)"
                  >
                    FORK
                  </button>
                  <button
                    v-if="
                      q.role === 'user' &&
                      q.messageId &&
                      q.sessionId &&
                      q.messageKey &&
                      hasMessageDiffs(q.messageKey)
                    "
                    type="button"
                    class="output-entry-action output-entry-action-danger"
                    @click="confirmRevert(q)"
                  >
                    REVERT
                  </button>
                </div>
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
import { Transition, computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MessageViewer from './MessageViewer.vue';
import { Icon } from '@iconify/vue';
type FileReadEntry = {
  time: number;
  expiresAt: number;
  x: number;
  y: number;
  header: string;
  content: string;
  scroll: boolean;
  scrollDistance: number;
  scrollDuration: number;
  html: string;
  attachments?: Array<{ id: string; url: string; mime: string; filename: string }>;
  isWrite: boolean;
  isMessage: boolean;
  isSubagentMessage?: boolean;
  sessionId?: string;
  role?: 'user' | 'assistant';
  messageAgent?: string;
  messageModel?: string;
  messageProviderId?: string;
  messageModelId?: string;
  messageUsage?: {
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache?: {
        read: number;
        write: number;
      };
    };
    cost?: number;
    contextPercent?: number | null;
  };
  messageVariant?: string;
  messageTime?: number;
  toolStatus?: string;
  toolName?: string;
  messageId?: string;
  messageKey?: string;
  callId?: string;
  isRound?: boolean;
  roundId?: string;
  roundMessages?: RoundMessage[];
  roundDiffs?: Array<{ file: string; diff: string; before?: string; after?: string }>;
  messageError?: { name: string; message: string } | null;
  isQuestionAnswer?: boolean;
};

type RoundMessage = {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<{ id: string; url: string; mime: string; filename: string }>;
  agent?: string;
  model?: string;
  providerId?: string;
  modelId?: string;
  variant?: string;
  time?: number;
  usage?: {
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache?: {
        read: number;
        write: number;
      };
    };
    cost?: number;
    contextPercent?: number | null;
  };
};

const props = defineProps<{
  queue: FileReadEntry[];
  isFollowing: boolean;
  statusText: string;
  isStatusError: boolean;
  isThinking: boolean;
  isRetryStatus?: boolean;
  busyDescendantCount?: number;
  theme: string;
  resolveAgentColor?: (agent?: string) => string;
  messageDiffs?: Map<
    string,
    Array<{ file: string; diff: string; before?: string; after?: string }>
  >;
}>();

const emit = defineEmits<{
  (event: 'scroll'): void;
  (event: 'wheel', eventArg: WheelEvent): void;
  (event: 'touchmove'): void;
  (event: 'resume-follow'): void;
  (event: 'fork-message', payload: { sessionId: string; messageId: string }): void;
  (event: 'revert-message', payload: { sessionId: string; messageId: string }): void;
  (
    event: 'show-message-diff',
    payload: {
      messageKey: string;
      diffs: Array<{ file: string; diff: string; before?: string; after?: string }>;
    },
  ): void;
  (event: 'show-message-history', payload: { roundId: string; contents: string[] }): void;
  (event: 'open-image', payload: { url: string; filename: string }): void;
  (event: 'message-rendered'): void;
  (event: 'content-resized'): void;
  (event: 'initial-render-complete'): void;
}>();

const filteredQueue = computed(() =>
  props.queue.filter((entry) => entry.isMessage && !entry.isSubagentMessage),
);

function formatRoundMeta(entry: FileReadEntry): string {
  // Find last assistant sub-message for model info, or use root
  const messages = entry.roundMessages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const model = lastAssistant?.model ?? entry.messageModel;
  const variant = lastAssistant?.variant ?? entry.messageVariant;
  const modelPart = variant ? `${model} (${variant})` : model || '';
  const timestamp = formatMessageTime(lastAssistant?.time ?? entry.messageTime);
  return [timestamp, modelPart].filter(Boolean).join(' - ');
}

function formatRoundUsage(entry: FileReadEntry): string {
  const messages = entry.roundMessages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const usage = lastAssistant?.usage ?? entry.messageUsage;
  if (!usage) return '';
  const tokens = usage.tokens;
  if (!tokens) return '';
  const input = formatCompactCount(tokens.input);
  const output = formatCompactCount(tokens.output);
  const reasoning = formatCompactCount(tokens.reasoning);
  if (reasoning) return `in ${input} + out ${output} + re ${reasoning}`;
  return `in ${input} + out ${output}`;
}

function formatRoundTimestamp(entry: FileReadEntry): string {
  const messages = entry.roundMessages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  return formatMessageTime(lastAssistant?.time ?? entry.messageTime);
}

function formatRoundElapsed(entry: FileReadEntry): string {
  const messages = entry.roundMessages ?? [];
  const userMsg = messages.find((m) => m.role === 'user');
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const start = userMsg?.time ?? entry.messageTime;
  const end = lastAssistant?.time;
  if (typeof start !== 'number' || typeof end !== 'number') return '';
  const sec = Math.round((end - start) / 1000);
  if (sec < 1) return '';
  if (sec < 60) return `thought ${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `thought ${min}m${rem}s` : `thought ${min}m`;
}

function formatRoundFooterMeta(entry: FileReadEntry): string {
  const parts: string[] = [];
  const ts = formatRoundTimestamp(entry);
  if (ts) parts.push(ts);
  const elapsed = formatRoundElapsed(entry);
  if (elapsed) parts.push(elapsed);
  return parts.join(', ');
}

function showGroupHistory(entry: FileReadEntry, group: MessageGroup) {
  const roundId = entry.roundId ?? entry.messageKey ?? String(entry.time);
  const contents = group.messages.map((msg) => msg.content).filter(Boolean);
  if (contents.length === 0) return;
  emit('show-message-history', { roundId, contents });
}

function formatMessageError(error: { name: string; message: string }): string {
  if (error.name === 'MessageAbortedError') {
    return error.message || 'Aborted';
  }
  const parts: string[] = [];
  if (error.name) parts.push(error.name);
  if (error.message) parts.push(error.message);
  return parts.join(': ') || 'Error';
}

function showRoundDiff(entry: FileReadEntry) {
  if (!entry.messageKey) return;
  const diffs = props.messageDiffs?.get(entry.messageKey);
  if (!diffs || diffs.length === 0) return;
  emit('show-message-diff', { messageKey: entry.messageKey, diffs });
}

// --- Nested box helpers ---

type MessageGroup = {
  role: 'user' | 'assistant';
  agent?: string;
  model?: string;
  providerId?: string;
  modelId?: string;
  variant?: string;
  messages: RoundMessage[];
};

function groupRoundMessages(entry: FileReadEntry): MessageGroup[] {
  const messages = entry.roundMessages ?? [];
  if (messages.length === 0) return [];
  const groups: MessageGroup[] = [];
  let current: MessageGroup | null = null;
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'user' : 'assistant';
    const agent = msg.agent;
    // Merge consecutive messages from same role+agent
    if (current && current.role === role && current.agent === agent) {
      current.messages.push(msg);
      // Update model/variant to latest
      if (msg.model) current.model = msg.model;
      if (msg.providerId) current.providerId = msg.providerId;
      if (msg.modelId) current.modelId = msg.modelId;
      if (msg.variant) current.variant = msg.variant;
    } else {
      current = {
        role,
        agent,
        model: msg.model,
        providerId: msg.providerId,
        modelId: msg.modelId,
        variant: msg.variant,
        messages: [msg],
      };
      groups.push(current);
    }
  }
  return groups;
}

function hasAssistantMessages(entry: FileReadEntry): boolean {
   return (entry.roundMessages ?? []).some((m) => m.role === 'assistant');
 }

 function isLastAssistantGroup(entry: FileReadEntry, groupIndex: number): boolean {
   const groups = groupRoundMessages(entry);
   // Find the last assistant group
   for (let i = groups.length - 1; i >= 0; i--) {
     if (groups[i].role === 'assistant') {
       return i === groupIndex;
     }
   }
   return false;
 }

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatSenderLabel(group: MessageGroup): string {
  if (group.role === 'user') return 'You';
  const parts: string[] = [];
  if (group.agent) parts.push(capitalize(group.agent));
  const modelPath =
    group.providerId && group.modelId ? `${group.providerId}/${group.modelId}` : group.model || '';
  if (modelPath) parts.push(modelPath);
  if (group.variant) parts.push(`(${group.variant})`);
  return parts.join(' ') || 'Assistant';
}

function formatRoundTargetLabel(entry: FileReadEntry): string {
  const parts: string[] = [];
  if (entry.messageAgent) parts.push(capitalize(entry.messageAgent));
  const modelPath =
    entry.messageProviderId && entry.messageModelId
      ? `${entry.messageProviderId}/${entry.messageModelId}`
      : entry.messageModel || '';
  if (modelPath) parts.push(modelPath);
  if (entry.messageVariant) parts.push(`(${entry.messageVariant})`);
  return parts.join(' ');
}

function getSenderStyle(group: MessageGroup) {
  if (group.role === 'user') return { color: '#94a3b8' }; // gray
  const color = props.resolveAgentColor ? props.resolveAgentColor(group.agent) : '#4ade80';
  return { color };
}

function getRoundTargetStyle(entry: FileReadEntry) {
  const color = props.resolveAgentColor ? props.resolveAgentColor(entry.messageAgent) : '#4ade80';
  return { color };
}

function getUserBoxStyle(entry: FileReadEntry) {
  const agent = entry.messageAgent;
  const color = props.resolveAgentColor ? props.resolveAgentColor(agent) : '#334155';
  if (color.startsWith('#') && color.length === 7) {
    return { borderLeftColor: `${color}99` };
  }
  return { borderLeftColor: color };
}

function getGroupTransitionKey(group: MessageGroup): string {
  // Key by last message ID so Transition triggers when the displayed message changes
  const last = group.messages[group.messages.length - 1];
  return last?.messageId ?? String(group.messages.length);
}

function hasRoundFooterActions(entry: FileReadEntry): boolean {
  if (entry.messageKey && hasMessageDiffs(entry.messageKey)) return true; // DIFF & REVERT
  return false;
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

const thinkingDisplayText = computed(() => {
  if (!props.isThinking) return '🟢 Idle';
  const descendants = props.busyDescendantCount ?? 0;
  const total = Math.max(1, 1 + descendants);
  const heads = '🤔'.repeat(Math.min(total, 8));
  return `${heads} Thinking${thinkingSuffix.value}`;
});

function getEntryRenderKey(entry: FileReadEntry): string {
  return `entry:${entry.messageKey ?? entry.messageId ?? entry.time}`;
}

function getRoundUserRenderKey(entry: FileReadEntry, msg: RoundMessage, index: number): string {
  const roundKey = entry.roundId ?? entry.messageId ?? entry.messageKey ?? entry.time;
  return `round-user:${roundKey}:${msg.messageId ?? index}`;
}

function getRoundAssistantRenderKey(entry: FileReadEntry, group: MessageGroup): string {
  const roundKey = entry.roundId ?? entry.messageId ?? entry.messageKey ?? entry.time;
  return `round-assistant:${roundKey}:${getGroupTransitionKey(group)}`;
}

function isEntryRendered(entry: FileReadEntry): boolean {
  if (entry.isRound) {
    const groups = groupRoundMessages(entry);
    return groups.every((group) => {
      if (group.role === 'user') {
        return group.messages.every((msg, index) =>
          renderedKeys.value.has(getRoundUserRenderKey(entry, msg, index)),
        );
      }
      if (group.role === 'assistant') {
        return renderedKeys.value.has(getRoundAssistantRenderKey(entry, group));
      }
      return true;
    });
  }
  return renderedKeys.value.has(getEntryRenderKey(entry));
}

function collectInitialRenderKeys(): Set<string> {
  const keys = new Set<string>();
  filteredQueue.value.forEach((entry) => {
    if (entry.isRound) {
      const groups = groupRoundMessages(entry);
      groups.forEach((group) => {
        if (group.role === 'user') {
          group.messages.forEach((msg, index) => {
            keys.add(getRoundUserRenderKey(entry, msg, index));
          });
          return;
        }
        if (group.role === 'assistant') {
          keys.add(getRoundAssistantRenderKey(entry, group));
        }
      });
      return;
    }
    keys.add(getEntryRenderKey(entry));
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
  initialRenderTrackingActive.value = false;
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

function hasMessageDiffs(messageKey: string) {
  const diffs = props.messageDiffs?.get(messageKey);
  return Boolean(diffs && diffs.length > 0);
}

function showMessageDiff(entry: FileReadEntry) {
  if (!entry.messageKey) return;
  const diffs = props.messageDiffs?.get(entry.messageKey);
  if (!diffs || diffs.length === 0) return;
  emit('show-message-diff', { messageKey: entry.messageKey, diffs });
}

function confirmFork(entry: FileReadEntry) {
  if (!entry.sessionId || !entry.messageId || entry.role !== 'user') return;
  if (!window.confirm('Fork from this message?')) return;
  emit('fork-message', { sessionId: entry.sessionId, messageId: entry.messageId });
}

function confirmRevert(entry: FileReadEntry) {
  if (!entry.sessionId || !entry.messageId || entry.role !== 'user') return;
  if (!window.confirm('Revert to this message?')) return;
  emit('revert-message', { sessionId: entry.sessionId, messageId: entry.messageId });
}

function hasFooter(entry: FileReadEntry) {
  if (formatMessageMeta(entry)) return true;
  if (formatMessageUsage(entry)) return true;
  if (entry.role === 'user' && entry.messageId && entry.sessionId) return true;
  if (entry.role === 'assistant' && entry.messageKey && hasMessageDiffs(entry.messageKey))
    return true;
  return false;
}

function formatMessageMeta(entry: FileReadEntry) {
  const model = entry.messageModel?.trim();
  const variant = entry.messageVariant?.trim();
  const modelPart = variant ? `${model} (${variant})` : model || '';
  const timestamp = formatMessageTime(entry.messageTime);
  return [timestamp, modelPart].filter(Boolean).join(' - ');
}

function formatMessageUsage(entry: FileReadEntry) {
  if (!entry.messageUsage) return '';
  if (entry.role !== 'assistant') return '';
  const tokens = entry.messageUsage.tokens;
  if (!tokens) return '';
  const input = formatCompactCount(tokens.input);
  const output = formatCompactCount(tokens.output);
  const reasoning = formatCompactCount(tokens.reasoning);
  if (input === '0' && output === '0' && reasoning === '0') return '';
  const cost =
    typeof entry.messageUsage.cost === 'number' ? formatCost(entry.messageUsage.cost) : '$--';
  return `In ${input} / Out ${output} / Reason ${reasoning} / ${cost}`;
}

function formatCompactCount(value: number) {
  if (!Number.isFinite(value)) return '0';
  if (value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

function formatCost(value: number) {
  if (!Number.isFinite(value)) return '$--';
  if (value === 0) return '$0.000';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function formatMessageAgent(entry: FileReadEntry) {
  const agent = entry.messageAgent?.trim();
  if (!agent) return '';
  return `[${agent.toUpperCase()}]`;
}

function getEntryStyle(entry: FileReadEntry) {
  if (entry.role !== 'user') return {};
  const agent = entry.messageAgent;
  // If no resolver, fallback to neutral
  const color = props.resolveAgentColor ? props.resolveAgentColor(agent) : '#334155';

  // If hex 6-digit, add alpha
  if (color.startsWith('#') && color.length === 7) {
    return {
      backgroundColor: `${color}2E`, // ~0.18
      borderColor: `${color}99`, // ~0.60
    };
  }
  return { borderColor: color };
}

function getAgentTextStyle(entry: FileReadEntry) {
  const agent = entry.messageAgent;
  const color = props.resolveAgentColor ? props.resolveAgentColor(agent) : '#bfdbfe';
  return { color };
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
  () => filteredQueue.value.length,
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
  background: rgba(15, 23, 42, 0.92);
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

.output-panel-scroll.is-initial-loading {
  visibility: hidden;
}

.output-panel-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 100%;
}

.output-entry {
  position: relative;
  display: flex;
  flex-direction: column;
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 10px 10px;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
}

.output-entry.is-user {
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(148, 163, 184, 0.55);
  padding-top: 18px;
  padding-bottom: 10px;
}

.output-entry.is-question-answer {
  border-color: rgba(34, 197, 94, 0.7);
  background: rgba(6, 32, 18, 0.5);
}

.output-entry-inner {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  --message-line-height: 1.2;
  line-height: var(--message-line-height);
}

.output-entry-agent {
  position: absolute;
  top: 6px;
  left: 6px;
  font-size: 10px;
  color: rgba(191, 219, 254, 0.9);
}

.output-entry-footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  min-height: 18px;
}

.output-entry-footer-left {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.output-entry-footer-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.output-entry-meta {
  font-size: 10px;
  color: rgba(191, 219, 254, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.output-entry-sep {
  font-size: 10px;
  color: rgba(148, 163, 184, 0.5);
  flex-shrink: 0;
}

.output-entry-usage {
  font-size: 10px;
  color: rgba(148, 163, 184, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.output-entry-action {
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

.output-entry-action:hover {
  background: rgba(30, 41, 59, 0.92);
}

.output-entry-action-danger {
  border-color: rgba(248, 113, 113, 0.7);
  background: rgba(127, 29, 29, 0.35);
  color: #fecaca;
}

.output-entry-action-danger:hover {
  background: rgba(153, 27, 27, 0.5);
}

.output-entry-action-diff {
  border-color: rgba(96, 165, 250, 0.7);
  background: rgba(30, 58, 138, 0.35);
  color: #bfdbfe;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.output-entry-action-diff:hover {
  background: rgba(30, 64, 175, 0.55);
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

.output-entry-inner.is-scrolling {
  animation: scroll-down var(--scroll-duration) linear forwards;
}

.output-panel-shell .output-entry-inner.is-scrolling {
  animation: none;
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

/* === Nested Box Design === */

.info-block {
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 10px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
}

.ib-user-box {
  border-left: 3px solid; /* color via inline style from getUserBoxStyle */
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

.ib-response-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.ib-sender {
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 2px;
  /* Color set via inline style */
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

.ib-footer-meta {
  font-size: 10px;
  color: rgba(148, 163, 184, 0.7);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Fork button: top-right of info-block */
.ib-top-right {
  float: right;
  margin: -2px -2px 4px 8px;
}

/* Footer: meta left, actions right */
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

/* Fade transition for message changes */
.ib-fade-enter-active,
.ib-fade-leave-active {
  transition: opacity 0.25s ease;
}

.ib-fade-enter-from,
.ib-fade-leave-to {
  opacity: 0;
}
</style>
