<template>
  <div class="output-panel-root">
    <div class="output-panel-shell" :style="shellStyle">
      <div v-if="projectName" class="project-name-bar">
        {{ projectName }}
      </div>
      <div class="output-panel-main">
        <div
          ref="panelEl"
          class="output-panel-scroll"
          @scroll="onPanelScroll"
          @wheel="$emit('wheel', $event)"
          @touchmove="$emit('touchmove')"
        >
          <div ref="contentEl" class="output-panel-content" @click="handleContentClick">
            <div
              v-if="isLoading"
              class="absolute w-full h-full m-auto flex justify-center items-center"
            >
              <div class="app-loading-spinner" aria-hidden="true"></div>
            </div>

            <div class="output-panel-messages" :class="{ 'is-anchor-pending': shouldHideMessages }">
              <!-- Normal rendering for small sessions (≤20 threads) -->
              <template v-if="!shouldVirtualize">
                <template v-for="root in visibleRoots" :key="root.id">
                  <ThreadBlock
                    v-show="!isLoading && shouldRenderRoot(root)"
                    :root="root"
                    :theme="theme"
                    :files-with-basenames="filesWithBasenames"
                    :is-reverted-preview="isRevertedPreview(root)"
                    :current-session-id="currentSessionId"
                    :session-history-meta-by-id="sessionHistoryMetaById"
                    :resolve-agent-color="resolveAgentColor"
                    :resolve-model-meta="resolveModelMeta"
                    :compute-context-percent="computeContextPercent"
                    :session-revert="sessionRevert"
                    :assistant-html="getAssistantHtml(root.id)"
                    :deferred-transition-key="getDeferredTransitionKey(root)"
                    @fork-message="emit('fork-message', $event)"
                    @revert-message="emit('revert-message', $event)"
                    @undo-revert="emit('undo-revert')"
                    @show-message-diff="emit('show-message-diff', $event)"
                    @open-image="emit('open-image', $event)"
                    @show-thread-history="emit('show-thread-history', $event)"
                    @message-rendered="handleMessageRendered"
                  />
                </template>
              </template>

              <!-- Virtual scroll for large sessions (>20 threads) -->
              <template v-else>
                <div class="virtual-scroll-spacer" :style="{ height: `${virtualTopSpacerHeight}px` }"></div>
                <div
                  v-for="root in visibleThreadRoots"
                  :key="root.id"
                  class="virtual-scroll-item"
                  :ref="(el) => setThreadRef(el as HTMLElement | null, root.id)"
                >
                  <ThreadBlock
                    v-show="!isLoading && shouldRenderRoot(root)"
                    :root="root"
                    :theme="theme"
                    :files-with-basenames="filesWithBasenames"
                    :is-reverted-preview="isRevertedPreview(root)"
                    :current-session-id="currentSessionId"
                    :session-history-meta-by-id="sessionHistoryMetaById"
                    :resolve-agent-color="resolveAgentColor"
                    :resolve-model-meta="resolveModelMeta"
                    :compute-context-percent="computeContextPercent"
                    :session-revert="sessionRevert"
                    :assistant-html="getAssistantHtml(root.id)"
                    :deferred-transition-key="getDeferredTransitionKey(root)"
                    @fork-message="emit('fork-message', $event)"
                    @revert-message="emit('revert-message', $event)"
                    @undo-revert="emit('undo-revert')"
                    @show-message-diff="emit('show-message-diff', $event)"
                    @open-image="emit('open-image', $event)"
                    @show-thread-history="emit('show-thread-history', $event)"
                    @message-rendered="handleMessageRendered"
                  />
                </div>
                <div class="virtual-scroll-spacer" :style="{ height: `${virtualBottomSpacerHeight}px` }"></div>
              </template>
            </div>

            <FileRefPopup ref="fileRefPopupRef" :files="files" @open-file="handlePopupOpenFile" />
          </div>
        </div>

        <button
          v-show="!isFollowing"
          type="button"
          class="follow-button"
          :aria-label="$t('outputPanel.scrollToLatest')"
          @click="$emit('resume-follow')"
        >
          <Icon icon="lucide:arrow-down" :width="14" :height="14" />
        </button>
      </div>

      <StatusBar
        :thinking-display-text="thinkingDisplayText"
        :status-text="statusText"
        :is-status-error="isStatusError"
        :is-retry-status="!!isRetryStatus"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import FileRefPopup from './FileRefPopup.vue';
import StatusBar from './StatusBar.vue';
import ThreadBlock from './ThreadBlock.vue';
import { useFileTree } from '../composables/useFileTree';

import { useMessages } from '../composables/useMessages';
import { useAssistantPreRenderer } from '../composables/useAssistantPreRenderer';
import { useThinkingAnimation } from '../composables/useThinkingAnimation';
import type {
  HistoryWindowEntry,
  MessageDiffEntry,
  MessageTokens,
  ModelMeta,
} from '../types/message';
import type { MessageInfo } from '../types/sse';

const msg = useMessages();
const { t } = useI18n();

const props = defineProps<{
  isFollowing: boolean;
  statusText: string;
  isStatusError: boolean;
  isThinking: boolean;
  isRetryStatus?: boolean;
  busyDescendantCount?: number;
  theme: string;
  resolveAgentColor?: (agent?: string) => string;
  resolveModelMeta?: (modelPath?: string) => ModelMeta | undefined;
  computeContextPercent?: (
    tokens: MessageTokens,
    providerId?: string,
    modelId?: string,
  ) => number | null;
  projectName?: string;
  projectColor?: string;
  currentSessionId?: string;
  sessionHistoryMetaById?: Record<string, { parentID?: string; label: string }>;
  isLoading?: boolean;
  isAnchoring?: boolean;
  sessionRevert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  } | null;
}>();

const emit = defineEmits<{
  (event: 'scroll'): void;
  (event: 'wheel', eventArg: WheelEvent): void;
  (event: 'touchmove'): void;
  (event: 'resume-follow'): void;
  (event: 'fork-message', payload: { sessionId: string; messageId: string }): void;
  (event: 'revert-message', payload: { sessionId: string; messageId: string }): void;
  (event: 'undo-revert'): void;
  (event: 'show-message-diff', payload: { messageKey: string; diffs: MessageDiffEntry[] }): void;
  (event: 'open-image', payload: { url: string; filename: string }): void;
  (event: 'show-thread-history', payload: { entries: HistoryWindowEntry[] }): void;
  (event: 'open-file', path: string, lines?: string): void;
  (event: 'show-commit', hash: string): void;
  (event: 'message-rendered'): void;
  (event: 'content-resized'): void;
}>();

const visibleRoots = computed(() => {
  const currentSessionId = props.currentSessionId?.trim();
  if (!currentSessionId) return msg.roots.value;
  return msg.roots.value.filter((root) => root.sessionID === currentSessionId);
});

const revertedPreviewRootId = computed(() => {
  const revert = props.sessionRevert;
  if (!revert?.messageID) return null;
  for (const root of visibleRoots.value) {
    if (root.role !== 'user') continue;
    if (root.id >= revert.messageID) return root.id;
  }
  return null;
});

const { files } = useFileTree();

const filesWithBasenames = computed(() => {
  const set = new Set<string>();
  // Sort by length ascending so shorter paths are processed first
  // This allows early termination when a suffix is already in the set
  const sortedFiles = [...files.value].sort((a, b) => a.length - b.length);

  for (const path of sortedFiles) {
    const segments = path.split('/');
    // Build suffixes from end to start to avoid repeated slice/join operations
    let suffix = '';
    for (let i = segments.length - 1; i >= 0; i--) {
      suffix = suffix ? `${segments[i]}/${suffix}` : segments[i];
      // If this suffix is already in set, longer suffixes from this path
      // would also be covered (since we sorted by length), so we can break
      if (set.has(suffix)) break;
      set.add(suffix);
    }
  }
  return Array.from(set);
});

function getFinalAnswer(root: MessageInfo): MessageInfo | undefined {
  return msg.getFinalAnswer(root.id);
}

function hasAssistantMessages(root: MessageInfo): boolean {
  const thread = msg.getThread(root.id);
  return thread.some((item) => item.role === 'assistant' && msg.hasTextContent(item.id));
}

function getFinalAnswerContent(root: MessageInfo): string {
  const final = getFinalAnswer(root);
  if (!final) return '';
  return msg.getTextContent(final.id);
}

function getThreadAssistantRenderKeyById(rootId: string, answerId?: string): string {
  return `thread-assistant:${rootId}:${answerId ?? 'none'}`;
}

function getThreadTransitionKey(root: MessageInfo): string {
  return getFinalAnswer(root)?.id ?? root.id;
}

function handleMessageRendered() {
  emit('message-rendered');
}

const { thinkingDisplayText } = useThinkingAnimation(
  computed(() => props.isThinking),
  computed(() => props.busyDescendantCount ?? 0),
  t,
);

function isRevertedRoot(root: MessageInfo): boolean {
  const revert = props.sessionRevert;
  if (!revert?.messageID) return false;
  return root.id >= revert.messageID;
}

function isRevertedPreview(root: MessageInfo): boolean {
  return revertedPreviewRootId.value === root.id;
}

function shouldRenderRoot(root: MessageInfo): boolean {
  if (!isRevertedRoot(root)) return true;
  return isRevertedPreview(root);
}

const panelEl = ref<HTMLDivElement | null>(null);
const contentEl = ref<HTMLDivElement | null>(null);
const fileRefPopupRef = ref<{
  handleContentClick: (event: MouseEvent) => void;
  closeFilePopup: () => void;
} | null>(null);
let contentResizeObserver: ResizeObserver | undefined;
let resizeNotifyFrameId: number | null = null;
let scrollToBottomFrameId: number | null = null;
let settleScrollToBottom: (() => void) | null = null;
let restoreAnchorFrameId: number | null = null;
let restoreAnchorToken = 0;

// ── Virtual scroll ──────────────────────────────────────────────
const THREAD_ESTIMATED_HEIGHT = 240;
const OVERSCAN_COUNT = 2;

const scrollTop = ref(0);
const containerHeight = ref(0);
const measuredHeights = shallowRef<Map<string, number>>(new Map());
let pendingScrollTop = 0;
let scrollFrameId: number | null = null;

let containerHeightFrameId: number | null = null;
let containerResizeObserver: ResizeObserver | undefined;

let threadResizeObserver: ResizeObserver | undefined;
const observedThreadElements = new Map<Element, string>();
const threadElementsById = new Map<string, HTMLElement>();
let heightUpdateFrameId: number | null = null;
const pendingHeightUpdates = new Map<string, number>();

const shouldVirtualize = computed(() => visibleRoots.value.length > 20);
const shouldHideMessages = computed(() => Boolean(props.isAnchoring && !props.isLoading));

function getThreadHeight(root: MessageInfo): number {
  if (!shouldRenderRoot(root)) return 0;
  return measuredHeights.value.get(root.id) ?? THREAD_ESTIMATED_HEIGHT;
}

const threadOffsets = computed(() => {
  const map = new Map<string, number>();
  const offsets: number[] = [];
  let offset = 0;
  for (const root of visibleRoots.value) {
    map.set(root.id, offset);
    offsets.push(offset);
    offset += getThreadHeight(root);
  }
  return { map, offsets, totalHeight: offset };
});

const visibleThreadWindow = computed(() => {
  const roots = visibleRoots.value;
  if (roots.length <= 20) {
    return {
      roots,
      startIdx: 0,
      endIdx: roots.length,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    };
  }

  const { offsets } = threadOffsets.value;

  // Binary search for first visible item
  let lo = 0;
  let hi = roots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const itemBottom = offsets[mid] + getThreadHeight(roots[mid]);
    if (itemBottom < scrollTop.value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const startIdx = Math.max(0, lo - OVERSCAN_COUNT);

  // Find last visible item
  let endIdx = lo;
  while (endIdx < roots.length && offsets[endIdx] < scrollTop.value + containerHeight.value) {
    endIdx++;
  }
  endIdx = Math.min(roots.length, endIdx + OVERSCAN_COUNT);

  let visibleHeight = 0;
  for (let idx = startIdx; idx < endIdx; idx++) {
    visibleHeight += getThreadHeight(roots[idx]);
  }

  return {
    roots: roots.slice(startIdx, endIdx),
    startIdx,
    endIdx,
    topSpacerHeight: offsets[startIdx] ?? 0,
    bottomSpacerHeight: Math.max(0, threadOffsets.value.totalHeight - (offsets[startIdx] ?? 0) - visibleHeight),
  };
});

const visibleThreadRoots = computed(() => visibleThreadWindow.value.roots);
const virtualTopSpacerHeight = computed(() => visibleThreadWindow.value.topSpacerHeight);
const virtualBottomSpacerHeight = computed(() => visibleThreadWindow.value.bottomSpacerHeight);

const { getAssistantHtml, getDeferredTransitionKey } = useAssistantPreRenderer({
  visibleRoots: visibleThreadRoots,
  theme: computed(() => props.theme),
  filesWithBasenames,
  getFinalAnswer,
  hasAssistantMessages,
  getFinalAnswerContent,
  getThreadTransitionKey,
  getThreadAssistantRenderKeyById,
  onRendered: handleMessageRendered,
});

function onPanelScroll() {
  const panel = panelEl.value;
  if (!panel) return;

  // RAF-throttled scroll tracking for virtual scroll
  pendingScrollTop = panel.scrollTop;
  if (scrollFrameId !== null) return;
  scrollFrameId = requestAnimationFrame(() => {
    scrollFrameId = null;
    scrollTop.value = pendingScrollTop;
  });
}

function updateContainerHeight() {
  if (!panelEl.value) return;
  const nextHeight = panelEl.value.clientHeight;
  if (containerHeight.value === nextHeight) return;
  containerHeight.value = nextHeight;
}

function scheduleContainerHeightUpdate() {
  if (containerHeightFrameId !== null) return;
  containerHeightFrameId = requestAnimationFrame(() => {
    containerHeightFrameId = null;
    updateContainerHeight();
  });
}

function setupContainerResizeObserver() {
  containerResizeObserver?.disconnect();
  containerResizeObserver = undefined;
  if (typeof ResizeObserver === 'undefined') return;
  const target = panelEl.value;
  if (!target) return;
  containerResizeObserver = new ResizeObserver(() => {
    scheduleContainerHeightUpdate();
  });
  containerResizeObserver.observe(target);
}

function setupThreadResizeObserver() {
  threadResizeObserver?.disconnect();
  observedThreadElements.clear();
  threadResizeObserver = undefined;
  if (typeof ResizeObserver === 'undefined') return;

  threadResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const rootId = observedThreadElements.get(entry.target);
      if (!rootId) continue;
      pendingHeightUpdates.set(rootId, entry.contentRect.height);
    }
    if (heightUpdateFrameId !== null) return;
    heightUpdateFrameId = requestAnimationFrame(() => {
      heightUpdateFrameId = null;
      if (pendingHeightUpdates.size === 0) return;
      const anchor = captureViewportAnchor();
      const newHeights = new Map(measuredHeights.value);
      for (const [rootId, height] of pendingHeightUpdates) {
        newHeights.set(rootId, height);
      }
      pendingHeightUpdates.clear();
      measuredHeights.value = newHeights;
      emit('content-resized');
      if (anchor) {
        restoreAnchorToken += 1;
        const token = restoreAnchorToken;
        nextTick(() => {
          if (token !== restoreAnchorToken) return;
          if (restoreAnchorFrameId !== null) {
            cancelAnimationFrame(restoreAnchorFrameId);
          }
          restoreAnchorFrameId = requestAnimationFrame(() => {
            restoreAnchorFrameId = null;
            if (token !== restoreAnchorToken) return;
            restoreViewportAnchor(anchor);
          });
        });
      }
    });
  });
}

function observeThreadElement(el: HTMLElement | null, rootId: string) {
  if (!el || !threadResizeObserver) return;
  // Clean up any previous observation for this rootId
  for (const [observedEl, observedId] of observedThreadElements) {
    if (observedId === rootId && observedEl !== el) {
      threadResizeObserver.unobserve(observedEl);
      observedThreadElements.delete(observedEl);
      if (threadElementsById.get(rootId) === observedEl) {
        threadElementsById.delete(rootId);
      }
    }
  }
  observedThreadElements.set(el, rootId);
  threadElementsById.set(rootId, el);
  threadResizeObserver.observe(el);
}

function unobserveThreadElement(el: Element | null) {
  if (!el || !threadResizeObserver) return;
  const rootId = observedThreadElements.get(el);
  if (rootId && threadElementsById.get(rootId) === el) {
    threadElementsById.delete(rootId);
  }
  observedThreadElements.delete(el);
  threadResizeObserver.unobserve(el);
}

type ViewportAnchor = {
  rootId: string;
  offsetTop: number;
};

function captureViewportAnchor(): ViewportAnchor | null {
  if (!shouldVirtualize.value || props.isFollowing) return null;
  const panel = panelEl.value;
  if (!panel) return null;
  const panelTop = panel.getBoundingClientRect().top;
  for (const root of visibleThreadRoots.value) {
    const el = threadElementsById.get(root.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= panelTop) continue;
    return {
      rootId: root.id,
      offsetTop: rect.top - panelTop,
    };
  }
  return null;
}

function restoreViewportAnchor(anchor: ViewportAnchor) {
  const panel = panelEl.value;
  const el = threadElementsById.get(anchor.rootId);
  if (!panel || !el) return;
  const panelTop = panel.getBoundingClientRect().top;
  const nextTop = el.getBoundingClientRect().top - panelTop;
  const delta = nextTop - anchor.offsetTop;
  if (Math.abs(delta) <= 0.5) return;
  panel.scrollTop += delta;
  pendingScrollTop = panel.scrollTop;
  scrollTop.value = panel.scrollTop;
}

function setThreadRef(el: unknown, rootId: string) {
  if (el instanceof HTMLElement) {
    observeThreadElement(el, rootId);
  } else if (el === null) {
    for (const [observedEl, observedId] of observedThreadElements) {
      if (observedId === rootId) {
        unobserveThreadElement(observedEl);
        break;
      }
    }
  }
}

function handleContentClick(event: MouseEvent) {
  fileRefPopupRef.value?.handleContentClick(event);
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const commitRefEl = target.closest('[data-commit-ref]');
  if (!(commitRefEl instanceof HTMLElement)) return;
  const hash = commitRefEl.dataset.commitRef?.trim();
  if (!hash) return;
  emit('show-commit', hash);
}

function handlePopupOpenFile(path: string, lines?: string) {
  emit('open-file', path, lines);
}

function setupContentResizeObserver() {
  contentResizeObserver?.disconnect();
  contentResizeObserver = undefined;
  if (typeof ResizeObserver === 'undefined') return;
  const target = contentEl.value;
  if (!target) return;
  contentResizeObserver = new ResizeObserver(() => {
    if (resizeNotifyFrameId !== null) return;
    resizeNotifyFrameId = requestAnimationFrame(() => {
      resizeNotifyFrameId = null;
      emit('content-resized');
    });
  });
  contentResizeObserver.observe(target);
}

watch(contentEl, () => {
  setupContentResizeObserver();
});

onMounted(() => {
  setupContentResizeObserver();
  setupContainerResizeObserver();
  setupThreadResizeObserver();
  nextTick(() => {
    emit('content-resized');
    updateContainerHeight();
  });
});

onBeforeUnmount(() => {
  contentResizeObserver?.disconnect();
  contentResizeObserver = undefined;
  containerResizeObserver?.disconnect();
  containerResizeObserver = undefined;
  threadResizeObserver?.disconnect();
  threadResizeObserver = undefined;
  observedThreadElements.clear();
  threadElementsById.clear();
  if (resizeNotifyFrameId !== null) {
    cancelAnimationFrame(resizeNotifyFrameId);
    resizeNotifyFrameId = null;
  }
  if (scrollFrameId !== null) {
    cancelAnimationFrame(scrollFrameId);
    scrollFrameId = null;
  }
  if (containerHeightFrameId !== null) {
    cancelAnimationFrame(containerHeightFrameId);
    containerHeightFrameId = null;
  }
  if (heightUpdateFrameId !== null) {
    cancelAnimationFrame(heightUpdateFrameId);
    heightUpdateFrameId = null;
  }
  if (scrollToBottomFrameId !== null) {
    cancelAnimationFrame(scrollToBottomFrameId);
    scrollToBottomFrameId = null;
  }
  if (restoreAnchorFrameId !== null) {
    cancelAnimationFrame(restoreAnchorFrameId);
    restoreAnchorFrameId = null;
  }
  restoreAnchorToken += 1;
  settleScrollToBottom?.();
  settleScrollToBottom = null;
  fileRefPopupRef.value?.closeFilePopup();
});

function scrollToBottom(): Promise<void> {
  const panel = panelEl.value;
  if (!panel) return Promise.resolve();

  if (scrollToBottomFrameId !== null) {
    cancelAnimationFrame(scrollToBottomFrameId);
    scrollToBottomFrameId = null;
  }
  settleScrollToBottom?.();
  settleScrollToBottom = null;

  return new Promise((resolve) => {
    let attempts = 0;
    let stableFrames = 0;
    let lastTarget = -1;
    const maxAttempts = 12;

    const finish = () => {
      if (scrollToBottomFrameId !== null) {
        cancelAnimationFrame(scrollToBottomFrameId);
        scrollToBottomFrameId = null;
      }
      if (settleScrollToBottom === finish) {
        settleScrollToBottom = null;
      }
      resolve();
    };

    settleScrollToBottom = finish;

    const tick = () => {
      const currentPanel = panelEl.value;
      if (!currentPanel) {
        finish();
        return;
      }

      attempts += 1;
      const target = Math.max(0, currentPanel.scrollHeight - currentPanel.clientHeight);
      if (target !== lastTarget || Math.abs(currentPanel.scrollTop - target) > 0.5) {
        currentPanel.scrollTop = target;
      }
      lastTarget = target;

      const gap = Math.max(0, currentPanel.scrollHeight - currentPanel.clientHeight - currentPanel.scrollTop);
      stableFrames = gap <= 0.5 ? stableFrames + 1 : 0;
      if (stableFrames >= 2 || attempts >= maxAttempts) {
        finish();
        return;
      }

      scrollToBottomFrameId = requestAnimationFrame(tick);
    };

    scrollToBottomFrameId = requestAnimationFrame(tick);
  });
}

const shellStyle = computed(() => {
  if (!props.projectColor) return undefined;
  return {
    '--project-tint': props.projectColor,
  } as Record<string, string>;
});

const statusText = computed(() => props.statusText);
const isStatusError = computed(() => props.isStatusError);
const isRetryStatus = computed(() => props.isRetryStatus);
const isFollowing = computed(() => props.isFollowing);
defineExpose({ panelEl, scrollToBottom });
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
  background-color: var(--theme-output-bg, rgba(15, 23, 42, 0.92));
  background-image: linear-gradient(
    color-mix(in srgb, var(--project-tint, transparent) 9%, transparent),
    color-mix(in srgb, var(--project-tint, transparent) 9%, transparent)
  );
  color: var(--theme-text-primary, #e2e8f0);
  border: 1px solid var(--theme-output-border, #334155);
  border-radius: 12px;
  background-clip: padding-box;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  display: flex;
  flex-direction: column;
  font-family: var(--app-monospace-font-family);
  font-size: var(--app-monospace-font-size, 13px);
}

.output-panel-scroll {
  display: flex;
  flex-direction: column;
  padding: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  mask-image: linear-gradient(
    to bottom,
    transparent,
    black 12px,
    black calc(100% - 12px),
    transparent
  );
}

.output-panel-main {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.output-panel-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 12px;
}

.output-panel-messages {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.output-panel-messages.is-anchor-pending {
  visibility: hidden;
  pointer-events: none;
}

.output-panel-content :deep(.markdown-host code.file-ref) {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: rgba(125, 211, 252, 0.4);
  text-underline-offset: 2px;
}

.output-panel-content :deep(.markdown-host code.file-ref:hover) {
  text-decoration-color: #7dd3fc;
  color: var(--theme-status-info, #7dd3fc);
}

.output-panel-content :deep(.markdown-host code.commit-ref) {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: rgba(125, 211, 252, 0.4);
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}

.output-panel-content :deep(.markdown-host code.commit-ref:hover) {
  text-decoration-color: #7dd3fc;
  text-decoration-style: dotted;
  color: var(--theme-status-info, #7dd3fc);
}

.output-panel-content :deep(.markdown-host code.color-ref::before) {
  content: '';
  display: inline-block;
  width: 0.85em;
  height: 0.85em;
  margin-right: 0.35em;
  vertical-align: middle;
  background-color: var(--preview-color);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.5);
}

.project-name-bar {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.03em;
  color: color-mix(in srgb, var(--project-tint, var(--theme-output-text, #94a3b8)) 60%, var(--theme-output-text, #94a3b8));
  padding: 12px 12px 0;
  user-select: none;
}

.follow-button {
  position: absolute;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  width: 36px;
  height: 36px;
  aspect-ratio: 1 / 1;
  box-sizing: border-box;
  border-radius: 999px;
  border: 1px solid var(--theme-output-border, #334155);
  background: var(--theme-output-control-bg, rgba(15, 23, 42, 0.92));
  color: var(--theme-output-text, #e2e8f0);
  font-size: 18px;
  line-height: 1;
  display: grid;
  place-items: center;
  box-shadow: 0 10px 24px color-mix(in srgb, var(--theme-output-bg, rgba(2, 6, 23, 0.45)) 55%, transparent);
  cursor: pointer;
  z-index: 3;
}

.follow-button:hover {
  background: var(--theme-output-active-bg, rgba(30, 41, 59, 0.98));
}

.virtual-scroll-spacer {
  min-height: 0;
}

.virtual-scroll-item {
  will-change: transform;
}

.app-loading-spinner {
  width: 26px;
  height: 26px;
  margin: 0 auto 12px;
  border-radius: 50%;
  border: 3px solid rgba(148, 163, 184, 0.4);
  border-top-color: var(--theme-text-primary, #e2e8f0);
  animation: app-loading-spin 0.85s linear infinite;
}

@keyframes app-loading-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
