<template>
  <div
    class="term"
    @pointerdown.capture="onFocus"
    :data-tool-key="entry.toolKey ?? entry.callId ?? undefined"
    :data-message-key="entry.messageId ? buildMessageKey(entry.messageId, entry.sessionId) : undefined"
    :class="termClass"
    :style="termStyle"
  >
    <div class="term-titlebar" @pointerdown="onDragStart">
      {{ getEntryTitle(entry) }}
    </div>
    <div
      class="term-inner"
      :class="{ 'is-scrolling': entry.scroll }"
      :style="{
        '--scroll-distance': `${entry.scrollDistance}px`,
        '--scroll-duration': `${entry.scrollDuration}s`,
        '--scroll-delay': `${entry.scrollDelay ?? 0.15}s`,
      }"
      @scroll="onFloatingScroll"
      @wheel="onFloatingWheel"
    >
      <div v-if="entry.isShell" class="xterm-host" :data-shell-id="entry.shellId"></div>
      <PermissionWindow
        v-else-if="entry.isPermission && entry.permissionRequest"
        :request="entry.permissionRequest"
        :is-submitting="isPermissionSubmitting(entry.permissionRequest.id)"
        :error="getPermissionError(entry.permissionRequest.id)"
        @reply="onPermissionReply"
      />
      <QuestionWindow
        v-else-if="entry.isQuestion && entry.questionRequest"
        :request="entry.questionRequest"
        :is-submitting="isQuestionSubmitting(entry.questionRequest.id)"
        :error="getQuestionError(entry.questionRequest.id)"
        @reply="onQuestionReply"
        @reject="onQuestionReject"
      />
      <CodeContent
        v-else
        :html="renderedHtml"
        :variant="contentVariant"
        :wrap-mode="viewerWrapMode"
        :gutter-mode="viewerGutterMode"
      />
    </div>
    <div v-if="statusBarText" class="term-statusbar">{{ statusBarText }}</div>
    <div
      v-if="showResizer"
      class="term-resizer"
      @pointerdown="onResizeStart"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import CodeContent from './CodeContent.vue';
import PermissionWindow from './PermissionWindow.vue';
import QuestionWindow from './QuestionWindow.vue';
import { type CodeRenderParams, useCodeRender } from '../utils/useCodeRender';

type PermissionReply = 'once' | 'always' | 'reject';
type QuestionAnswer = string[];

type ToolWindowEntry = {
  time: number;
  x: number;
  y: number;
  header: string;
  scroll: boolean;
  scrollDistance: number;
  scrollDuration: number;
  scrollDelay?: number;
  html: string;
  content?: string;
  lang?: string;
  view?: 'normal' | 'diff' | 'hex';
  grepPattern?: string;
  isWrite: boolean;
  isMessage: boolean;
  isSubagentMessage?: boolean;
  isReasoning?: boolean;
  isShell?: boolean;
  isPermission?: boolean;
  isQuestion?: boolean;
  role?: 'user' | 'assistant';
  toolStatus?: string;
  toolName?: string;
  toolKey?: string;
  toolWrapMode?: 'default' | 'soft';
  toolGutterMode?: 'default' | 'none' | 'grep-source';
  toolGutterLines?: string[];
  messageId?: string;
  sessionId?: string;
  messageAgent?: string;
  messageModel?: string;
  callId?: string;
  contentKey?: string;
  readLineOffset?: number;
  readLineLimit?: number;
  zIndex?: number;
  width?: number;
  height?: number;
  shellId?: string;
  permissionRequest?: { id: string };
  questionRequest?: { id: string };
};

const props = defineProps<{
  entry: ToolWindowEntry;
  getEntryTitle: (entry: ToolWindowEntry) => string;
  resolveAgentTone: (agent?: string) => string;
  buildMessageKey: (messageId: string, sessionId?: string) => string;
  onFocusEntry: (entry: ToolWindowEntry, event: PointerEvent) => void;
  onDragEntry: (entry: ToolWindowEntry, event: PointerEvent) => void;
  onResizeEntry: (entry: ToolWindowEntry, event: PointerEvent) => void;
  onFloatingScrollEntry: (entry: ToolWindowEntry, event: Event) => void;
  onFloatingWheelEntry: (entry: ToolWindowEntry, event: WheelEvent) => void;
  onRenderedEntry: (entry: ToolWindowEntry) => void;
  isPermissionSubmitting: (requestId: string) => boolean;
  getPermissionError: (requestId: string) => string;
  onPermissionReply: (payload: { requestId: string; reply: PermissionReply }) => void;
  isQuestionSubmitting: (requestId: string) => boolean;
  getQuestionError: (requestId: string) => string;
  onQuestionReply: (payload: { requestId: string; answers: QuestionAnswer[] }) => void;
  onQuestionReject: (requestId: string) => void;
  theme: string;
}>();

const entry = computed(() => props.entry);

const showResizer = computed(
  () =>
    entry.value.isReasoning ||
    entry.value.isSubagentMessage ||
    entry.value.isShell ||
    entry.value.isPermission ||
    entry.value.isQuestion,
);

const isFloatingMessage = computed(
  () => entry.value.isReasoning || entry.value.isSubagentMessage,
);

const agentColor = computed(() => {
  if (entry.value.isMessage) {
    return props.resolveAgentTone(entry.value.messageAgent);
  }
  return undefined;
});

const statusBarText = computed(() => {
  if (!isFloatingMessage.value) return '';
  const parts: string[] = [];
  const agent = entry.value.messageAgent?.trim();
  if (agent) parts.push(agent.charAt(0).toUpperCase() + agent.slice(1));
  const model = entry.value.messageModel?.trim();
  if (model) parts.push(model);
  return parts.join(' · ');
});

const termClass = computed(() => ({
  'is-write': entry.value.isWrite,
  'is-message': entry.value.isSubagentMessage,
  'is-tool-error': entry.value.toolStatus === 'error',
  'is-running': entry.value.toolStatus === 'running',
  'is-apply-patch': entry.value.toolName === 'apply_patch',
  'is-reasoning': entry.value.isReasoning || entry.value.isSubagentMessage,
  'is-shell': entry.value.isShell,
  'is-bash': entry.value.toolName === 'bash',
  'is-permission': entry.value.isPermission,
  'is-question': entry.value.isQuestion,
}));

const termStyle = computed(() => {
  const base: Record<string, string | number | undefined> = {
    left: `${entry.value.x ?? 0}px`,
    top: `calc(var(--tool-top-offset) + ${entry.value.y ?? 0}px)`,
    '--term-width': entry.value.width ? `${entry.value.width}px` : undefined,
    '--term-height': entry.value.height ? `${entry.value.height}px` : undefined,
    zIndex: entry.value.zIndex ?? undefined,
  };
  
  if (agentColor.value) {
    const c = agentColor.value;
    base['--agent-color'] = c;
    base.borderColor = c;
    base['--term-border-color'] = c;
  }
  return base;
});

const isDiff = computed(() => entry.value.view === 'diff' && !!entry.value.content);

const contentVariant = computed<'code' | 'diff' | 'message'>(() => {
  if (isDiff.value) return 'diff';
  if (entry.value.isMessage) return 'message';
  return 'code';
});

const viewerWrapMode = computed<'default' | 'soft'>(() => {
  if (entry.value.isMessage) return 'soft';
  return entry.value.toolWrapMode ?? 'default';
});

const viewerGutterMode = computed<'none' | 'single' | 'double'>(() => {
  if (isDiff.value) return 'double';
  if (entry.value.isMessage || entry.value.isReasoning || entry.value.isSubagentMessage) return 'none';
  if (entry.value.toolGutterMode === 'grep-source') return 'single';
  if (entry.value.toolGutterMode === 'none') return 'none';
  return 'single';
});

const renderParams = computed<CodeRenderParams | null>(() => {
  const e = entry.value;
  if (e.isShell || e.isPermission || e.isQuestion) return null;

  if (isDiff.value) {
    return {
      code: '',
      patch: e.content!,
      lang: e.lang ?? 'text',
      theme: props.theme,
      gutterMode: 'double',
    };
  }

  const code = e.isMessage
    ? (e.content ?? '')
    : `${e.header ?? ''}${e.content ?? ''}`;
  if (!code) return null;

  const lang = e.lang ?? (e.isMessage ? 'markdown' : 'text');
  const isGrep = e.toolName === 'grep' || e.toolGutterMode === 'grep-source';

  return {
    code,
    lang,
    theme: props.theme,
    gutterMode: viewerGutterMode.value,
    gutterLines: isGrep ? e.toolGutterLines : undefined,
    grepPattern: isGrep ? e.grepPattern : undefined,
    lineOffset: e.readLineOffset,
    lineLimit: e.readLineLimit,
  };
});

const { html: renderedHtml } = useCodeRender(renderParams);

watch(renderedHtml, (val) => {
  if (val) onRendered();
});

function onFocus(event: PointerEvent) {
  props.onFocusEntry(entry.value, event);
}

function onDragStart(event: PointerEvent) {
  props.onDragEntry(entry.value, event);
}

function onResizeStart(event: PointerEvent) {
  props.onResizeEntry(entry.value, event);
}

function onFloatingScroll(event: Event) {
  props.onFloatingScrollEntry(entry.value, event);
}

function onFloatingWheel(event: WheelEvent) {
  props.onFloatingWheelEntry(entry.value, event);
}

function onRendered() {
  props.onRenderedEntry(entry.value);
}
</script>

<style scoped>
.term {
  position: absolute;
  font-size: var(--term-font-size);
  --message-line-height: var(--term-line-height);
  --term-border-color: #3a4150;
  width: var(--term-width);
  height: var(--term-height);
  background: #1a1d24;
  color: #f3f4f6;
  border: 1px solid #3a4150;
  border-radius: 5px;
  overflow: hidden;
  font-family: var(--term-font-family);
  line-height: var(--term-line-height);
  padding: 0;
  z-index: 12;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

.term.is-message {
  background: #1a1d24;
  border-color: #3a4150;
  --term-border-color: #3a4150;
}

.term.is-message .term-titlebar {
  background: rgba(36, 40, 50, 0.95);
  color: #cbd5e1;
  border-bottom: 1px solid rgba(90, 100, 120, 0.35);
}

.term.is-reasoning {
  --agent-color: #64748b;
  background: color-mix(in srgb, var(--agent-color) 12%, #1a1d24);
  border-color: var(--agent-color);
  --term-border-color: var(--agent-color);
}

.term.is-reasoning .term-titlebar {
  background: color-mix(in srgb, var(--agent-color) 22%, rgba(36, 40, 50, 0.95));
  color: color-mix(in srgb, var(--agent-color) 40%, #e2e8f0);
  border-bottom: 1px solid color-mix(in srgb, var(--agent-color) 35%, rgba(90, 100, 120, 0.35));
}

.term.is-shell,
.term.is-bash {
  background: #190a24;
  border-color: #a855f7;
  --term-border-color: #a855f7;
}

.term.is-shell .term-titlebar,
.term.is-bash .term-titlebar {
  background: rgba(168, 85, 247, 0.18);
  color: #e9d5ff;
  border-bottom: 1px solid rgba(168, 85, 247, 0.35);
}

.term.is-permission {
  background: #1f1303;
  border-color: #f59e0b;
  --term-border-color: #f59e0b;
}

.term.is-question {
  background: #07201b;
  border-color: #34d399;
  --term-border-color: #34d399;
}

.term.is-apply-patch,
.term.is-write {
  background: #0a1628;
  border-color: #3b82f6;
  --term-border-color: #3b82f6;
}

.term.is-tool-error {
  background: #2a0f0f;
  border-color: #ef4444;
  --term-border-color: #ef4444;
}

.term.is-apply-patch .term-titlebar,
.term.is-write .term-titlebar {
  background: rgba(59, 130, 246, 0.18);
  color: #bfdbfe;
  border-bottom: 1px solid rgba(59, 130, 246, 0.35);
}

.term.is-tool-error .term-titlebar {
  background: rgba(239, 68, 68, 0.18);
  color: #fecaca;
  border-bottom: 1px solid rgba(239, 68, 68, 0.35);
}

.term.is-running .term-inner {
  color: #6b7280;
}

.term.is-permission .term-titlebar {
  background: rgba(245, 158, 11, 0.18);
  color: #fcd34d;
  border-bottom: 1px solid rgba(245, 158, 11, 0.35);
}

.term.is-question .term-titlebar {
  background: rgba(52, 211, 153, 0.18);
  color: #6ee7b7;
  border-bottom: 1px solid rgba(52, 211, 153, 0.35);
}

.term-titlebar {
  height: 22px;
  display: flex;
  align-items: center;
  padding: 0 4px;
  font-size: 12px;
  color: #cbd5e1;
  background: rgba(36, 40, 50, 0.95);
  border-bottom: 1px solid rgba(90, 100, 120, 0.35);
  cursor: grab;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.term-titlebar:active {
  cursor: grabbing;
}

.term-inner {
  margin: 0;
  white-space: normal;
  line-height: var(--term-line-height);
  padding: 2px 4px;
  flex: 1;
  overflow: hidden;
}

.term.is-reasoning .term-inner,
.term.is-reasoning .term-inner {
  overflow: auto;
}

.term.is-permission .term-inner,
.term.is-question .term-inner {
  padding: 0;
  overflow: hidden;
}

.term-statusbar {
  flex-shrink: 0;
  height: 18px;
  display: flex;
  align-items: center;
  padding: 0 4px;
  font-size: 10px;
  color: color-mix(in srgb, var(--agent-color, #64748b) 60%, #94a3b8);
  background: color-mix(in srgb, var(--agent-color, #64748b) 6%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--agent-color, #64748b) 18%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}

.xterm-host {
  width: 100%;
  height: 100%;
  display: block;
}

.term-resizer {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: se-resize;
  background: transparent;
  z-index: 2;
}

.term-resizer::before {
  content: '';
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 0 5px 5px;
  border-color: transparent transparent var(--term-border-color) transparent;
}

.term-resizer:hover {
  filter: brightness(1.15);
}

.term-inner.is-scrolling .code-content {
  animation: scroll-down var(--scroll-duration) linear var(--scroll-delay) forwards;
  will-change: transform;
}

@keyframes scroll-down {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(calc(-1 * var(--scroll-distance)));
  }
}

</style>
