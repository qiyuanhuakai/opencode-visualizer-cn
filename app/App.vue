<template>
  <div ref="appEl" class="app">
    <header class="app-header">
      <TopPanel
        :base-worktrees="baseWorktreeOptions"
        :base-worktree="selectedProjectDirectory"
        :active-directories="worktrees"
        :active-directory="selectedWorktreeDir"
        :active-directory-meta="worktreeMetaByDir"
        :sessions="filteredSessions"
        :session-status-by-id="sessionStatusByIdRecord"
        :home-path="homePath"
        v-model:base-worktree="selectedProjectDirectory"
        v-model:active-directory="selectedWorktreeDir"
        v-model:selected-session-id="selectedSessionId"
        @open-directory="openProjectPicker"
        @create-worktree="createWorktree"
        @new-session="createNewSession"
        @delete-active-directory="deleteWorktree"
        @delete-session="deleteSession"
      />
    </header>
    <main ref="outputEl" class="app-output">
      <div class="output-workspace">
        <div class="tool-window-layer" :class="{ 'todo-collapsed': sidePanelCollapsed }">
          <div class="output-split" :class="{ 'todo-collapsed': sidePanelCollapsed }">
            <OutputPanel
              ref="outputPanelRef"
              class="output-panel"
              :queue="queue"
              :is-following="isFollowing"
              :status-text="statusText"
              :is-status-error="isStatusError"
              :is-thinking="isThinking"
              :is-retry-status="!!retryStatus"
              :busy-descendant-count="busyDescendantSessionIds.length"
              :theme="shikiTheme"
              :resolve-agent-color="resolveAgentColorForName"
              :message-diffs="messageDiffsByKey"
              @scroll="handleOutputPanelScroll"
              @wheel="handleOutputPanelWheel"
              @touchmove="handleOutputPanelScroll"
              @resume-follow="resumeFollow"
              @fork-message="handleForkMessage"
              @revert-message="handleRevertMessage"
              @show-message-diff="handleShowMessageDiff"
              @show-message-history="handleShowMessageHistory"
            />
            <SidePanel
              class="todo-panel"
              :collapsed="sidePanelCollapsed"
              :active-tab="sidePanelActiveTab"
              :todo-sessions="todoPanelSessions"
              :tree-nodes="treeNodes"
              :expanded-tree-paths="expandedTreePaths"
              :selected-tree-path="selectedTreePath"
              :tree-loading="treeLoading"
              :tree-error="treeError"
              :tree-status-by-path="sessionStatusByPath"
              @toggle-collapse="toggleSidePanelCollapsed"
              @change-tab="setSidePanelTab"
              @toggle-dir="toggleTreeDirectory"
              @select-file="selectTreeFile"
              @open-diff="openSessionDiff"
              @open-file="openFileViewer"
            />
          </div>
          <div ref="toolWindowCanvasEl" class="tool-window-canvas">
            <TransitionGroup appear name="fade">
              <ToolWindow
                v-for="q in queue.filter((entry) => !entry.isMessage || entry.isSubagentMessage)"
                :key="q.permissionId ?? q.questionId ?? q.callId ?? q.messageId ?? q.time"
                :entry="q"
                :get-entry-title="getEntryTitle"
                :resolve-agent-tone="resolveAgentTone"
                :build-message-key="buildMessageKey"
                :on-focus-entry="focusTerm"
                :on-drag-entry="startTermDrag"
                :on-resize-entry="startTermResize"
                :on-floating-scroll-entry="handleFloatingScroll"
                :on-floating-wheel-entry="handleFloatingWheel"
                :on-rendered-entry="handleToolWindowRendered"
                :is-permission-submitting="isPermissionSubmitting"
                :get-permission-error="getPermissionError"
                :on-permission-reply="handlePermissionReply"
                :is-question-submitting="isQuestionSubmitting"
                :get-question-error="getQuestionError"
                :on-question-reply="handleQuestionReply"
                :on-question-reject="handleQuestionReject"
                :theme="shikiTheme"
              />
              <FileViewerWindow
                v-for="q in fileViewerQueue"
                :key="q.toolKey ?? q.path ?? q.time"
                :entry="q"
                :title="getEntryTitle(q)"
                :on-focus-entry="focusTerm"
                :on-drag-entry="startTermDrag"
                :on-resize-entry="startTermResize"
                :on-floating-scroll-entry="handleFloatingScroll"
                :on-floating-wheel-entry="handleFloatingWheel"
                :on-close-entry="closeFileViewer"
                :theme="shikiTheme"
              />
            </TransitionGroup>
          </div>
        </div>
      </div>
    </main>
    <footer
      ref="inputEl"
      class="app-input"
      :style="inputHeight !== null ? { height: `${inputHeight}px` } : undefined"
    >
      <div class="input-resizer" @pointerdown="startInputResize"></div>
      <InputPanel
        :can-send="canSend"
        :agent-options="agentOptions"
        :has-agent-options="hasAgentOptions"
        :agent-color="currentAgentColor"
        :model-options="modelOptions"
        :thinking-options="thinkingOptions"
        :has-model-options="hasModelOptions"
        :has-thinking-options="hasThinkingOptions"
        :can-attach="canAttach"
        :is-thinking="isThinking"
        :can-abort="canAbort"
        :commands="commandOptions"
        :attachments="attachments"
        :message-input="messageInput"
        :selected-mode="selectedMode"
        :selected-model="selectedModel"
        :selected-thinking="selectedThinking"
        @update:message-input="handleMessageInputUpdate"
        @update:selected-mode="handleSelectedModeUpdate"
        @update:selected-model="handleSelectedModelUpdate"
        @update:selected-thinking="handleSelectedThinkingUpdate"
        @send="sendMessage"
        @abort="abortSession"
        @add-attachments="handleAddAttachments"
        @remove-attachment="removeAttachment"
      />
    </footer>
    <ProjectPicker
      :open="isProjectPickerOpen"
      :base-url="OPENCODE_BASE_URL"
      :initial-directory="selectedProjectDirectory || selectedWorktreeDir"
      @close="isProjectPickerOpen = false"
      @select="handleProjectDirectorySelect"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { bundledThemes } from 'shiki/bundle/web';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import InputPanel from './components/InputPanel.vue';
import OutputPanel from './components/OutputPanel.vue';
import ProjectPicker from './components/ProjectPicker.vue';
import hexdump from '@kikuchan/hexdump';
import FileViewerWindow from './components/FileViewerWindow.vue';
import SidePanel from './components/SidePanel.vue';
import ToolWindow from './components/ToolWindow.vue';
import TopPanel from './components/TopPanel.vue';
import { useOutputPanelFollow } from './composables/useOutputPanelFollow';
import * as opencodeApi from './utils/opencode';
import { opencodeTheme, resolveTheme, resolveAgentColor } from './utils/theme';

const OPENCODE_BASE_URL = 'http://localhost:4096';
const FOLLOW_THRESHOLD_PX = 24;
const FLOATING_FOLLOW_THRESHOLD_PX = 2;
const TOOL_PENDING_TTL_MS = 60_000;
const TOOL_COMPLETE_TTL_MS = 2_000;
const TOOL_SCROLL_SPEED_PX_S = 2000;
const TOOL_SCROLL_HOLD_MS = 250;
const SUBAGENT_ACTIVE_TTL_MS = 60 * 60 * 1000;
const SIDE_PANEL_COLLAPSED_STORAGE_KEY = 'opencode.sidePanelCollapsed.v1';
const SIDE_PANEL_TAB_STORAGE_KEY = 'opencode.sidePanelTab.v1';
const SHELL_WINDOW_Z_BASE = 1_000_000;
const PERMISSION_WINDOW_WIDTH = 760;
const PERMISSION_WINDOW_HEIGHT = 340;
const PERMISSION_WINDOW_MIN_WIDTH = 560;
const PERMISSION_WINDOW_MIN_HEIGHT = 220;
const QUESTION_WINDOW_WIDTH = 760;
const QUESTION_WINDOW_HEIGHT = 380;
const QUESTION_WINDOW_MIN_WIDTH = 560;
const QUESTION_WINDOW_MIN_HEIGHT = 240;
const FILE_VIEWER_WINDOW_WIDTH = 840;
const FILE_VIEWER_WINDOW_HEIGHT = 520;
const FILE_VIEWER_WINDOW_MIN_WIDTH = 460;
const FILE_VIEWER_WINDOW_MIN_HEIGHT = 260;
const TERM_COLUMNS = 80;
const TERM_ROWS = 25;
const TERM_FONT_SIZE_PX = 13;
const TERM_LINE_HEIGHT = 1.1;
const TERM_TITLEBAR_HEIGHT_PX = 22;
const TERM_WINDOW_BORDER_PX = 2;
const TERM_INNER_PADDING_X_PX = 4;
const TERM_INNER_PADDING_Y_PX = 4;
const TERM_GUTTER_WIDTH_EM = 3.2;
const TERM_FONT_FAMILY =
  "'Iosevka Term', 'Iosevka Fixed', 'JetBrains Mono', 'Cascadia Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";
const MAIN_REASONING_TITLE = 'Reasoning';
const REASONING_CLOSE_DELAY_MS = 3000;
const SHELL_PTY_STORAGE_KEY = 'opencode.shellPtys';
const COMPOSER_DRAFT_STORAGE_KEY = 'opencode.composerDrafts.v1';
const ATTACHMENT_MIME_ALLOWLIST = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

type FileReadEntry = {
  time: number;
  expiresAt: number;
  x: number;
  y: number;
  header: string;
  path?: string;
  content: string;
  scroll: boolean;
  scrollDistance: number;
  scrollDuration: number;
  scrollDelay: number;
  html: string;
  attachments?: MessageAttachment[];
  isWrite: boolean;
  isMessage: boolean;
  isSubagentMessage?: boolean;
  isReasoning?: boolean;
  isShell?: boolean;
  isPermission?: boolean;
  isQuestion?: boolean;
  sessionId?: string;
  toolKey?: string;
  role?: 'user' | 'assistant';
  toolStatus?: string;
  toolName?: string;
  toolTitle?: string;
  lang?: string;
  view?: 'normal' | 'diff' | 'hex';
  grepPattern?: string;
  toolWrapMode?: 'default' | 'soft';
  toolGutterMode?: 'default' | 'none' | 'grep-source';
  toolGutterLines?: string[];
  messageId?: string;
  messageKey?: string;
  messageAgent?: string;
  messageModel?: string;
  messageProviderId?: string;
  messageModelId?: string;
  messageUsage?: MessageUsage;
  messageVariant?: string;
  messageTime?: number;
  callId?: string;
  permissionId?: string;
  questionId?: string;
  follow?: boolean;
  zIndex?: number;
  width?: number;
  height?: number;
  shellId?: string;
  shellTitle?: string;
  permissionRequest?: PermissionRequest;
  questionRequest?: QuestionRequest;
  isBinary?: boolean;
  isLoading?: boolean;
  isDiff?: boolean;
  diffCode?: string;
  diffAfter?: string;
  diffTabs?: Array<{ file: string; before: string; after: string }>;
  classification?: 'real_user' | 'system_injection' | 'unknown';
  contentKey?: string;
  readLineOffset?: number;
  readLineLimit?: number;
  isRound?: boolean;
  roundId?: string;
  roundMessages?: RoundMessage[];
  roundDiffs?: MessageDiffEntry[];
  messageError?: { name: string; message: string } | null;
};

type RoundMessage = {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: MessageAttachment[];
  agent?: string;
  model?: string;
  providerId?: string;
  modelId?: string;
  variant?: string;
  time?: number;
  usage?: MessageUsage;
};

type TodoItem = {
  id: string;
  content: string;
  status: string;
  priority: string;
};

type TodoPanelSession = {
  sessionId: string;
  title: string;
  isSubagent: boolean;
  todos: TodoItem[];
  loading: boolean;
  error?: string;
};

type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: TreeNode[];
  loaded?: boolean;
  ignored?: boolean;
  synthetic?: boolean;
};

type FileNode = {
  name?: string;
  path: string;
  type?: string;
  ignored?: boolean;
};


type FileContentResponse = {
  content?: string;
  encoding?: string;
  type?: 'text' | 'binary';
};

type SessionDiffEntry = {
  file?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  status?: 'added' | 'modified' | 'deleted';
};

type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

type PermissionReply = 'once' | 'always' | 'reject';

type QuestionOption = {
  label: string;
  description: string;
};

type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

type QuestionAnswer = string[];

type ReasoningFinish = {
  id: string;
  time: number;
};

type PtyInfo = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
};

type ShellSession = {
  pty: PtyInfo;
  entry: FileReadEntry;
  terminal: Terminal;
  fitAddon: FitAddon;
  socket?: WebSocket;
  sessionId: string;
};

type Attachment = {
  id: string;
  filename: string;
  mime: string;
  dataUrl: string;
};

type MessageAttachment = {
  id: string;
  url: string;
  mime: string;
  filename: string;
};

type ComposerDraft = {
  messageInput: string;
  attachments: Attachment[];
  agent: string;
  model: string;
  variant?: string;
  updatedAt: number;
  rev: number;
  writerTabId: string;
};

const queue = ref<FileReadEntry[]>([]);
const appEl = ref<HTMLDivElement | null>(null);
const outputEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLElement | null>(null);
const toolWindowCanvasEl = ref<HTMLDivElement | null>(null);
const outputPanelRef = ref<{ panelEl: HTMLDivElement | null } | null>(null);
const isFollowing = ref(true);
const {
  scrollToBottom,
  updateFollowState,
  handleOutputPanelScroll,
  handleOutputPanelWheel,
  scheduleFollowScroll,
  resumeFollow,
} = useOutputPanelFollow({
  outputPanelRef,
  isFollowing,
  followThresholdPx: FOLLOW_THRESHOLD_PX,
});
const runningToolIds = reactive(new Set<string>());
const subagentSessionExpiry = new Map<string, number>();
const messageSummaryTitleById = new Map<string, string>();
type MessageDiffEntry = { file: string; diff: string; before?: string; after?: string };
const messageDiffsByKey = reactive(new Map<string, Array<MessageDiffEntry>>());
const reasoningTitleBySessionId = new Map<string, string>();
type SessionStatusType = 'busy' | 'idle' | 'retry';

const sessionStatusByKey = new Map<string, SessionStatusType>();
const sessionStatusVersion = ref(0);
const reasoningCloseTimers = new Map<string, number>();
const lastReasoningMessageIdByKey = new Map<string, string>();
const messageAttachmentsById = new Map<string, MessageAttachment[]>();
const activeReasoningMessageIdByKey = new Map<string, string>();
const finishedReasoningByKey = new Map<string, ReasoningFinish>();
const globalEventHooks = new Set<(payload: unknown, eventType: string) => void>();
let unregisterSessionStatusGlobalHook: (() => void) | null = null;
const dragState = ref<{
  entry: FileReadEntry;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  maxX: number;
  maxY: number;
  toolTop: number;
} | null>(null);
const resizeState = ref<{
  entry: FileReadEntry;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
} | null>(null);
const inputResizeState = ref<{
  startY: number;
  startHeight: number;
  minHeight: number;
  maxHeight: number;
} | null>(null);
const inputHeight = ref<number | null>(null);
let nextWindowZIndex = 20;
let sessionStatusRequestId = 0;
let primaryHistoryRequestId = 0;
const messageIndexById = new Map<string, number>();
const toolIndexByCallId = new Map<string, number>();
const userMessageIds = new Set<string>();
const userMessageMetaById = new Map<string, UserMessageMeta>();
const userMessageTimeById = new Map<string, number>();
const messageContentById = new Map<string, string>();
const messagePartsById = new Map<string, Map<string, string>>();
const messagePartOrderById = new Map<string, string[]>();
const messageUsageByKey = new Map<string, MessageUsage>();
const recentUserInputs: { text: string; time: number }[] = [];
const composerDraftRevisionByContext = new Map<string, number>();
const composerDraftTabId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const shellSessionsByPtyId = new Map<string, ShellSession>();
const shellPtyIdsBySessionId = new Map<string, Set<string>>();
const pendingShellFits = new Map<string, number>();
const pendingToolScrollFrames = new Map<string, number>();
const pendingReadFullCodeByCallId = new Map<string, string>();
const pendingReadInfoByCallId = new Map<string, {
  path: string;
  readOffset: number;
  readLimit?: number;
  lang?: string;
  toolTitle?: string;
  eventType: string;
}>();
const permissionSendingById = ref<Record<string, boolean>>({});
const permissionErrorById = ref<Record<string, string>>({});
const questionSendingById = ref<Record<string, boolean>>({});
const questionErrorById = ref<Record<string, string>>({});
const pendingWorktreeMetaByDir = new Map<string, VcsInfo>();
const sidePanelCollapsed = ref(readSidePanelCollapsed());
const sidePanelActiveTab = ref(readSidePanelTab());
const todosBySessionId = ref<Record<string, TodoItem[]>>({});
const todoLoadingBySessionId = ref<Record<string, boolean>>({});
const todoErrorBySessionId = ref<Record<string, string>>({});
let todoReloadRequestId = 0;
const treeNodes = ref<TreeNode[]>([]);
const expandedTreePathSet = ref(new Set<string>());
const selectedTreePath = ref('');
const treeLoading = ref(false);
const treeError = ref('');
const sessionStatusByPath = ref<Record<string, 'added' | 'modified' | 'deleted'>>({});
const sessionDiffEntries = ref<SessionDiffEntry[]>([]);
const sessionDiffByPath = ref<Record<string, SessionDiffEntry>>({});
let treeRequestId = 0;
let sessionDiffRequestId = 0;
const fileViewerQueue = ref<FileReadEntry[]>([]);

type ProjectInfo = {
  id: string;
  worktree?: string;
  sandboxes?: string[];
};

type SessionInfo = {
  id: string;
  projectID?: string;
  parentID?: string;
  title?: string;
  slug?: string;
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
  };
};

type WorktreeInfo = {
  name: string;
  branch: string;
  directory: string;
};

type VcsInfo = {
  branch: string;
};

type ProviderModel = {
  id: string;
  name?: string;
  providerID?: string;
  variants?: Record<string, unknown>;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  capabilities?: {
    attachment?: boolean;
  };
};

type ProviderInfo = {
  id: string;
  name?: string;
  models?: Record<string, ProviderModel>;
};

type ProviderResponse = {
  providers?: ProviderInfo[];
  default?: Record<string, string>;
};

type AgentInfo = {
  name: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  color?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  variant?: string;
};

type CommandInfo = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: string;
  template?: string;
  hints?: string[];
};

const projects = ref<ProjectInfo[]>([]);
const worktrees = ref<string[]>([]);
const worktreeMetaByDir = ref<Record<string, VcsInfo>>({});
const worktreeMetaRequestIdByDir = new Map<string, number>();
let worktreeMetaRequestId = 0;
const sessions = ref<SessionInfo[]>([]);
const sessionParentById = shallowRef(new Map<string, string | undefined>());
const providers = ref<ProviderInfo[]>([]);
const agents = ref<AgentInfo[]>([]);
const commands = ref<CommandInfo[]>([]);
const modelOptions = ref<
  Array<{
    id: string;
    label: string;
    displayName: string;
    providerID?: string;
    providerLabel?: string;
    variants?: Record<string, unknown>;
    attachmentCapable?: boolean;
  }>
>([]);
const agentOptions = ref<Array<{ id: string; label: string; description?: string; color?: string }>>([]);
const thinkingOptions = ref<Array<string | undefined>>([]);
const providersLoaded = ref(false);
const providersLoading = ref(false);
const providersFetchCount = ref(0);
const agentsLoading = ref(false);
const commandsLoading = ref(false);
const selectedProjectId = ref('');
const selectedWorktreeDir = ref('');
const selectedSessionId = ref('');
const selectedProjectDirectory = ref('');
const homePath = ref('');
const serverWorktreePath = ref('');
const initialQuery = readQuerySelection();
if (initialQuery.projectId) selectedProjectId.value = initialQuery.projectId;
if (initialQuery.sessionId) selectedSessionId.value = initialQuery.sessionId;
const isProjectPickerOpen = ref(false);
const selectedMode = ref('build');
const selectedModel = ref('');
const selectedThinking = ref<string | undefined>(undefined);
const projectError = ref('');
const worktreeError = ref('');
const sessionError = ref('');
const messageInput = ref('');
const attachments = ref<Attachment[]>([]);
const sendStatus = ref('Ready');
const isSending = ref(false);
const isAborting = ref(false);
const isBootstrapping = ref(false);
const retryStatus = ref<{
  message: string;
  next: number;
  attempt: number;
} | null>(null);

const statusText = computed(() => {
  if (retryStatus.value) {
    const timeStr = formatRetryTime(retryStatus.value.next);
    return `${retryStatus.value.message} | Next: ${timeStr}`;
  }
  return projectError.value || worktreeError.value || sessionError.value || sendStatus.value;
});
const isStatusError = computed(() =>
  Boolean(projectError.value || worktreeError.value || sessionError.value || retryStatus.value),
);

const baseWorktreeOptions = computed(() => {
  const unique = new Set<string>();
  projects.value.forEach((project) => {
    const value = project.worktree?.trim();
    if (value) unique.add(value);
  });
  return Array.from(unique);
});

const filteredSessions = computed(() =>
  sessions.value.filter((session) => {
    if (session.parentID) return false;
    const directory = selectedWorktreeDir.value || selectedProjectDirectory.value || '';
    if (directory && session.directory && session.directory !== directory) return false;
    return true;
  }),
);

const activeDirectory = computed(() =>
  selectedWorktreeDir.value || selectedProjectDirectory.value || '',
);

const allowedSessionIds = computed(() => {
  const rootId = selectedSessionId.value;
  if (!rootId) return new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  sessionParentById.value.forEach((parentId, sessionId) => {
    if (!parentId) return;
    const bucket = childrenByParent.get(parentId) ?? [];
    bucket.push(sessionId);
    childrenByParent.set(parentId, bucket);
  });
  const allowed = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (allowed.has(current)) continue;
    allowed.add(current);
    const children = childrenByParent.get(current);
    if (children) stack.push(...children);
  }
  return allowed;
});

const todoPanelCount = computed(() =>
  Object.values(todosBySessionId.value).reduce((sum, todos) => sum + todos.length, 0),
);

const todoPanelSessions = computed(() => {
  const allowed = allowedSessionIds.value;
  if (allowed.size === 0) return [] as TodoPanelSession[];
  const list = Array.from(allowed).map((sessionId) => {
    const session = sessions.value.find((item) => item.id === sessionId);
    const title = sessionLabel(session ?? { id: sessionId });
    const isSubagent = Boolean(sessionParentById.value.get(sessionId));
    return {
      sessionId,
      title,
      isSubagent,
      todos: todosBySessionId.value[sessionId] ?? [],
      loading: Boolean(todoLoadingBySessionId.value[sessionId]),
      error: todoErrorBySessionId.value[sessionId],
    };
  });
  const visible = list.filter((entry) => entry.todos.length > 0 || Boolean(entry.error));
  if (visible.length === 0) return [] as TodoPanelSession[];
  visible.sort((a, b) => {
    if (a.sessionId === selectedSessionId.value) return -1;
    if (b.sessionId === selectedSessionId.value) return 1;
    if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
  return visible;
});

const expandedTreePaths = computed(() => Array.from(expandedTreePathSet.value));

const canSend = computed(() =>
  Boolean(
    selectedSessionId.value &&
      !isSending.value &&
      (messageInput.value.trim().length > 0 || attachments.value.length > 0),
  ),
);

const busyDescendantSessionIds = computed(() => {
  const allowed = allowedSessionIds.value;
  const selected = selectedSessionId.value;
  const tick = sessionStatusVersion.value;
  if (tick < 0) return [] as string[];
  const ids: string[] = [];
  for (const sid of allowed) {
    if (sid === selected) continue;
    const status = getSessionStatus(sid);
    if (status === 'busy' || status === 'retry') ids.push(sid);
  }
  return ids;
});

const isThinking = computed(() => {
  const selected = selectedSessionId.value;
  const tick = sessionStatusVersion.value;
  void tick;
  const ownStatus = selected ? getSessionStatus(selected) : undefined;
  return Boolean(
    ownStatus === 'busy' ||
    ownStatus === 'retry' ||
    busyDescendantSessionIds.value.length > 0 ||
    runningToolIds.size > 0 ||
    isSending.value ||
    isAborting.value,
  );
});
const canAbort = computed(() =>
  Boolean(selectedSessionId.value && isThinking.value && !isAborting.value),
);
const hasAgentOptions = computed(() => agentOptions.value.length > 0);
const hasModelOptions = computed(() => modelOptions.value.length > 0);
const hasThinkingOptions = computed(() => thinkingOptions.value.length > 0);
const canAttach = computed(() => {
  const selected = modelOptions.value.find((m) => m.id === selectedModel.value);
  return selected?.attachmentCapable !== false;
});
const commandOptions = computed(() => {
  const list = commands.value.slice();
  const hasShell = list.some((command) => command.name.toLowerCase() === 'shell');
  if (!hasShell) {
    list.push({
      name: 'shell',
      description: 'Open a local shell session.',
      source: 'local',
    });
  }
  const hasDebug = list.some((command) => command.name.toLowerCase() === 'debug');
  if (!hasDebug) {
    list.push({
      name: 'debug',
      description: 'Preview tool windows with synthetic debug events.',
      source: 'local',
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
});

function projectLabel(project: ProjectInfo) {
  if (project.id === 'global') return 'global /';
  if (project.worktree) return project.worktree;
  return project.id;
}

function projectBaseDirectory(project: ProjectInfo) {
  if (project.worktree && project.worktree.trim()) return project.worktree;
  return project.id;
}

function normalizeDirectory(value: string) {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed || value;
}

function replaceHomePrefix(path: string) {
  const normalizedPath = normalizeDirectory(path);
  const normalizedHome = normalizeDirectory(homePath.value);
  if (!normalizedHome || !normalizedPath.startsWith('/')) return normalizedPath;
  if (normalizedPath === normalizedHome) return '~';
  const prefix = `${normalizedHome}/`;
  if (normalizedPath.startsWith(prefix)) {
    return `~/${normalizedPath.slice(prefix.length)}`;
  }
  return normalizedPath;
}

function sessionLabel(session: SessionInfo) {
  return session.title || session.slug || session.id;
}

function getSelectedWorktreeDirectory() {
  return selectedWorktreeDir.value.trim();
}

function resolveWorktreeRelativePath(path?: string) {
  if (!path) return undefined;
  const normalizedPath = normalizeDirectory(path);
  const base = normalizeDirectory(getSelectedWorktreeDirectory());
  if (!base) return replaceHomePrefix(normalizedPath);
  if (!normalizedPath.startsWith('/')) return normalizedPath;
  if (normalizedPath === base) return '.';
  const prefix = `${base}/`;
  if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length);
  return replaceHomePrefix(normalizedPath);
}

function requireSelectedWorktree(context: 'send') {
  const directory = getSelectedWorktreeDirectory();
  if (directory) return directory;
  const message = 'No worktree selected.';
  sendStatus.value = message;
  return '';
}

function sessionSortKey(session: SessionInfo) {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function pickPreferredSessionId(list: SessionInfo[]) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const sorted = list
    .filter((session) => !session.parentID)
    .slice()
    .sort((a, b) => sessionSortKey(b) - sessionSortKey(a));
  return sorted[0]?.id ?? '';
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

const resolvedTheme = computed(() => resolveTheme(opencodeTheme, 'dark'));

function resolveAgentColorForName(agentName?: string) {
  const name = agentName || 'opencode';
  const agent = agents.value.find((a) => a.name === name);
  return resolveAgentColor(name, agent?.color, agents.value, resolvedTheme.value);
}

const currentAgentColor = computed(() => resolveAgentColorForName(selectedMode.value));

function resolveAgentTone(agent?: string) {
  return resolveAgentColorForName(agent);
}

function buildThinkingOptions(variants?: Record<string, unknown>) {
  const keys = Object.keys(variants ?? {}).sort();
  return [undefined, ...keys] as Array<string | undefined>;
}

type QuerySelection = {
  projectId: string;
  sessionId: string;
};

function readQuerySelection(): QuerySelection {
  if (typeof window === 'undefined') return { projectId: '', sessionId: '' };
  const params = new URLSearchParams(window.location.search);
  return {
    projectId: params.get('project')?.trim() ?? '',
    sessionId: params.get('session')?.trim() ?? '',
  };
}

function replaceQuerySelection(projectId: string, sessionId: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const nextProject = projectId.trim();
  const nextSession = sessionId.trim();
  const params = url.searchParams;
  const currentProject = params.get('project') ?? '';
  const currentSession = params.get('session') ?? '';
  const hasLegacyWorktree = params.has('worktree');
  const sameSelection =
    currentProject === nextProject && currentSession === nextSession && !hasLegacyWorktree;
  if (sameSelection) return;
  if (nextProject) params.set('project', nextProject);
  else params.delete('project');
  if (nextSession) params.set('session', nextSession);
  else params.delete('session');
  params.delete('worktree');
  url.search = params.toString();
  window.history.replaceState({}, '', url.toString());
}

function buildMessageKey(messageId: string, sessionId?: string) {
  return `${sessionId ?? 'root'}:${messageId}`;
}

function buildComposerContextKey(projectId: string, sessionId: string) {
  const normalizedProjectId = projectId.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedProjectId || !normalizedSessionId) return '';
  return `${normalizedProjectId}:${normalizedSessionId}`;
}

function normalizeStoredAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const filename = typeof record.filename === 'string' ? record.filename.trim() : '';
  const mime = typeof record.mime === 'string' ? record.mime.trim() : '';
  const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
  if (!id || !filename || !mime || !dataUrl) return null;
  return { id, filename, mime, dataUrl };
}

function normalizeStoredComposerDraft(value: unknown): ComposerDraft | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const messageInput = typeof record.messageInput === 'string' ? record.messageInput : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
        .map((item) => normalizeStoredAttachment(item))
        .filter((item): item is Attachment => Boolean(item))
    : [];
  const agent = typeof record.agent === 'string' ? record.agent : '';
  const model = typeof record.model === 'string' ? record.model : '';
  const variant = typeof record.variant === 'string' ? record.variant : undefined;
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : Date.now();
  const rev = typeof record.rev === 'number' ? record.rev : updatedAt;
  const writerTabId = typeof record.writerTabId === 'string' ? record.writerTabId : '';
  return {
    messageInput,
    attachments,
    agent,
    model,
    variant,
    updatedAt,
    rev,
    writerTabId,
  };
}

function parseComposerDraftStore(raw: string | null) {
  if (!raw) return {} as Record<string, ComposerDraft>;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {} as Record<string, ComposerDraft>;
    const normalized: Record<string, ComposerDraft> = {};
    Object.entries(parsed).forEach(([key, value]) => {
      const draft = normalizeStoredComposerDraft(value);
      if (!draft) return;
      normalized[key] = draft;
    });
    return normalized;
  } catch {
    return {} as Record<string, ComposerDraft>;
  }
}

function readComposerDraftStore() {
  if (typeof window === 'undefined') return {} as Record<string, ComposerDraft>;
  return parseComposerDraftStore(window.localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY));
}

function writeComposerDraftStore(store: Record<string, ComposerDraft>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(store));
  } catch {
    return;
  }
}

function readComposerDraft(contextKey: string) {
  if (!contextKey) return null;
  const store = readComposerDraftStore();
  return store[contextKey] ?? null;
}

function nextComposerDraftRevision(contextKey: string, existingDraft?: ComposerDraft | null) {
  const storeRev = existingDraft?.rev ?? 0;
  const knownRev = composerDraftRevisionByContext.get(contextKey) ?? 0;
  const nextRev = Math.max(storeRev, knownRev) + 1;
  composerDraftRevisionByContext.set(contextKey, nextRev);
  return nextRev;
}

function writeComposerDraft(contextKey: string, draft: ComposerDraft) {
  if (!contextKey) return;
  const store = readComposerDraftStore();
  store[contextKey] = draft;
  composerDraftRevisionByContext.set(contextKey, draft.rev);
  writeComposerDraftStore(store);
}

function removeComposerDraft(contextKey: string) {
  if (!contextKey) return;
  const store = readComposerDraftStore();
  if (!(contextKey in store)) return;
  delete store[contextKey];
  composerDraftRevisionByContext.delete(contextKey);
  writeComposerDraftStore(store);
}

function readSidePanelCollapsed() {
  if (typeof window === 'undefined') return false;
  const raw = window.localStorage.getItem(SIDE_PANEL_COLLAPSED_STORAGE_KEY);
  return raw === '1';
}

function persistSidePanelCollapsed(value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDE_PANEL_COLLAPSED_STORAGE_KEY, value ? '1' : '0');
  } catch {
    return;
  }
}

function readSidePanelTab() {
  if (typeof window === 'undefined') return 'todo' as const;
  const raw = window.localStorage.getItem(SIDE_PANEL_TAB_STORAGE_KEY);
  return raw === 'tree' ? 'tree' : 'todo';
}

function persistSidePanelTab(value: 'todo' | 'tree') {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDE_PANEL_TAB_STORAGE_KEY, value);
  } catch {
    return;
  }
}

function toggleSidePanelCollapsed() {
  sidePanelCollapsed.value = !sidePanelCollapsed.value;
  persistSidePanelCollapsed(sidePanelCollapsed.value);
  nextTick(() => {
    scheduleShellFitAll();
  });
}

function setSidePanelTab(value: 'todo' | 'tree') {
  if (sidePanelActiveTab.value === value) return;
  sidePanelActiveTab.value = value;
  persistSidePanelTab(value);
}

function resolveProjectIdForSession(sessionId: string) {
  const matched = sessions.value.find((session) => session.id === sessionId);
  if (matched?.projectID) return matched.projectID;
  if (selectedSessionId.value === sessionId) return selectedProjectId.value;
  return '';
}



function clearComposerInputState() {
  messageInput.value = '';
  attachments.value = [];
}

function draftKeyForSelectedContext() {
  return buildComposerContextKey(selectedProjectId.value, selectedSessionId.value);
}

function applyComposerDraftToComposerState(draft: ComposerDraft, contextKey: string) {
  composerDraftRevisionByContext.set(contextKey, draft.rev);
  messageInput.value = draft.messageInput;
  attachments.value = draft.attachments.slice();
  if (draft.agent) selectedMode.value = draft.agent;
  if (draft.model) selectedModel.value = draft.model;
  selectedThinking.value = draft.variant;
}

function restoreComposerDraftForContext(contextKey: string) {
  if (!contextKey) return;
  const draft = readComposerDraft(contextKey);
  if (!draft) return;
  applyComposerDraftToComposerState(draft, contextKey);
}

function persistComposerDraftForCurrentContext() {
  const contextKey = draftKeyForSelectedContext();
  if (!contextKey) return;
  const existingDraft = readComposerDraft(contextKey);
  const rev = nextComposerDraftRevision(contextKey, existingDraft);
  const draft: ComposerDraft = {
    messageInput: messageInput.value,
    attachments: attachments.value.map((item) => ({
      id: item.id,
      filename: item.filename,
      mime: item.mime,
      dataUrl: item.dataUrl,
    })),
    agent: selectedMode.value,
    model: selectedModel.value,
    variant: selectedThinking.value,
    updatedAt: Date.now(),
    rev,
    writerTabId: composerDraftTabId,
  };
  writeComposerDraft(contextKey, draft);
}

function clearComposerDraftForCurrentContext() {
  const contextKey = draftKeyForSelectedContext();
  if (!contextKey) return;
  removeComposerDraft(contextKey);
}

function handleMessageInputUpdate(value: string) {
  messageInput.value = value;
  persistComposerDraftForCurrentContext();
}

function applyAgentDefaults(agentName: string) {
  const agent = agents.value.find((a) => a.name === agentName);
  const defaultModel = agent?.model;
  if (defaultModel?.providerID && defaultModel?.modelID) {
    const match = modelOptions.value.find(
      (m) => m.id === defaultModel.modelID && m.providerID === defaultModel.providerID,
    );
    if (match) {
      selectedModel.value = match.id;
      // Also apply recommended variant from agent if available
      const nextThinkingOptions = buildThinkingOptions(match.variants);
      thinkingOptions.value = nextThinkingOptions;
      if (agent?.variant && nextThinkingOptions.includes(agent.variant)) {
        selectedThinking.value = agent.variant;
      } else {
        selectedThinking.value = nextThinkingOptions[0];
      }
    }
  }
}

function handleSelectedModeUpdate(value: string) {
  selectedMode.value = value;
  applyAgentDefaults(value);
  persistComposerDraftForCurrentContext();
}

function handleSelectedModelUpdate(value: string) {
  selectedModel.value = value;
  nextTick(() => {
    persistComposerDraftForCurrentContext();
  });
}

function handleSelectedThinkingUpdate(value: string | undefined) {
  selectedThinking.value = value;
  persistComposerDraftForCurrentContext();
}


function handleComposerDraftStorage(event: StorageEvent) {
  if (event.storageArea !== window.localStorage) return;
  if (event.key !== COMPOSER_DRAFT_STORAGE_KEY) return;
  const contextKey = draftKeyForSelectedContext();
  if (!contextKey) return;
  const store = parseComposerDraftStore(event.newValue);
  const draft = store[contextKey] ?? null;
  const knownRev = composerDraftRevisionByContext.get(contextKey) ?? 0;
  if (!draft) {
    composerDraftRevisionByContext.delete(contextKey);
    clearComposerInputState();
    return;
  }
  if (draft.rev < knownRev) return;
  applyComposerDraftToComposerState(draft, contextKey);
}

function buildComposerDraftFromUserMessage(payload: {
  sessionId: string;
  messageId: string;
}): Omit<ComposerDraft, 'rev' | 'writerTabId'> {
  const messageKey = buildMessageKey(payload.messageId, payload.sessionId);
  const messageEntry = queue.value.find(
    (entry) =>
      entry.isMessage &&
      !entry.isSubagentMessage &&
      entry.role === 'user' &&
      entry.sessionId === payload.sessionId &&
      entry.messageId === payload.messageId,
  );
  const messageInput = messageContentById.get(messageKey) ?? messageEntry?.content ?? '';
  const sourceAttachments =
    messageAttachmentsById.get(messageKey) ?? messageEntry?.attachments ?? [];
  const attachmentsForDraft: Attachment[] = sourceAttachments.map((item) => ({
    id: item.id,
    filename: item.filename,
    mime: item.mime,
    dataUrl: item.url,
  }));
  const meta = userMessageMetaById.get(payload.messageId);
  return {
    messageInput,
    attachments: attachmentsForDraft,
    agent: meta?.agent ?? '',
    model: meta?.modelId ?? '',
    variant: meta?.variant,
    updatedAt: Date.now(),
  };
}

function seedForkedSessionComposerDraft(
  payload: { sessionId: string; messageId: string },
  forkedSession: SessionInfo,
) {
  if (!forkedSession.id) return;
  const projectId = forkedSession.projectID || resolveProjectIdForSession(payload.sessionId);
  const contextKey = buildComposerContextKey(projectId, forkedSession.id);
  if (!contextKey) return;
  const draft = buildComposerDraftFromUserMessage(payload);
  const existingDraft = readComposerDraft(contextKey);
  writeComposerDraft(contextKey, {
    ...draft,
    rev: nextComposerDraftRevision(contextKey, existingDraft),
    writerTabId: composerDraftTabId,
  });
}

function clamp(value: number, min: number, max: number) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function syncNextWindowZIndex(entries: FileReadEntry[] = queue.value) {
  let maxZ = nextWindowZIndex;
  entries.forEach((entry) => {
    if (typeof entry.zIndex === 'number' && entry.zIndex > maxZ) maxZ = entry.zIndex;
  });
  nextWindowZIndex = maxZ;
}

function buildSessionStatusKey(projectId: string, sessionId: string) {
  const normalizedProjectId = projectId.trim();
  return normalizedProjectId ? `${normalizedProjectId}:${sessionId}` : '';
}

function resolveProjectIdForStatus(sessionId: string, projectId?: string) {
  const normalizedProjectId = projectId?.trim();
  if (normalizedProjectId) return normalizedProjectId;
  const resolved = resolveProjectIdForSession(sessionId);
  if (resolved) return resolved;
  if (selectedProjectId.value) return selectedProjectId.value;
  return '';
}

function buildSessionStatusKeyForSession(sessionId: string, projectId?: string) {
  if (!sessionId) return '';
  const resolvedProjectId = resolveProjectIdForStatus(sessionId, projectId);
  if (!resolvedProjectId) return '';
  return buildSessionStatusKey(resolvedProjectId, sessionId);
}

function getSessionStatus(sessionId: string, projectId?: string) {
  if (!sessionId) return undefined;
  const key = buildSessionStatusKeyForSession(sessionId, projectId);
  if (key) {
    const status = sessionStatusByKey.get(key);
    if (status !== undefined) return status;
  }
  const suffix = `:${sessionId}`;
  for (const [entryKey, status] of sessionStatusByKey) {
    if (entryKey.endsWith(suffix)) return status;
  }
  return undefined;
}

function getDescendantSessionIds(rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  sessionParentById.value.forEach((parentId, sessionId) => {
    if (!parentId) return;
    const bucket = childrenByParent.get(parentId) ?? [];
    bucket.push(sessionId);
    childrenByParent.set(parentId, bucket);
  });
  const result: string[] = [];
  const stack = childrenByParent.get(rootId) ?? [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    result.push(current);
    const children = childrenByParent.get(current);
    if (children) stack.push(...children);
  }
  return result;
}

function hasAnyBusyDescendant(rootId: string, projectId?: string): boolean {
  const descendants = getDescendantSessionIds(rootId);
  return descendants.some((sid) => {
    const status = getSessionStatus(sid, projectId);
    return status === 'busy' || status === 'retry';
  });
}

const sessionStatusByIdRecord = computed<Record<string, SessionStatusType>>(() => {
  const tick = sessionStatusVersion.value;
  const next: Record<string, SessionStatusType> = {};
  if (tick < 0) return next;
  sessions.value.forEach((session) => {
    if (session.parentID) return;
    const ownStatus = getSessionStatus(session.id, session.projectID);
    if (ownStatus === 'busy' || ownStatus === 'retry') {
      next[session.id] = ownStatus;
    } else if (hasAnyBusyDescendant(session.id, session.projectID)) {
      next[session.id] = 'busy';
    } else if (ownStatus) {
      next[session.id] = ownStatus;
    }
  });
  return next;
});

function setSessionStatus(sessionId: string, status: SessionStatusType, projectId?: string) {
  if (!sessionId) return;
  const key = buildSessionStatusKeyForSession(sessionId, projectId);
  if (!key) return;
  if (sessionStatusByKey.get(key) === status) return;
  sessionStatusByKey.set(key, status);
  sessionStatusVersion.value += 1;
}

function deleteSessionStatus(sessionId: string, projectId?: string) {
  if (!sessionId) return;
  const keysToDelete = new Set<string>();
  const key = buildSessionStatusKeyForSession(sessionId, projectId);
  if (key) keysToDelete.add(key);
  const suffix = `:${sessionId}`;
  sessionStatusByKey.forEach((_, entryKey) => {
    if (entryKey.endsWith(suffix)) keysToDelete.add(entryKey);
  });
  if (keysToDelete.size === 0) return;
  keysToDelete.forEach((entryKey) => {
    sessionStatusByKey.delete(entryKey);
  });
  sessionStatusVersion.value += 1;
}

/**
 * Sync local session statuses with the API response.
 * - For sessions unknown locally (no entry): set the status from the API (busy/idle/retry).
 * - For sessions that are locally busy/retry but NOT present in the API response: demote to idle.
 * The API only returns busy sessions, so absence means the session is idle.
 */
function syncSessionStatuses(entries: [string, SessionStatusType][], projectId?: string) {
  if (!projectId) return;
  const apiBusyKeys = new Set<string>();
  let didUpdate = false;

  // Apply API entries: merge missing, and collect keys reported as busy
  entries.forEach(([sessionId, status]) => {
    if (!sessionId) return;
    const key = buildSessionStatusKeyForSession(sessionId, projectId);
    if (!key) return;
    apiBusyKeys.add(key);
    const current = sessionStatusByKey.get(key);
    if (current === undefined) {
      sessionStatusByKey.set(key, status);
      didUpdate = true;
    }
  });

  // Demote locally busy/retry sessions that are NOT in the API response to idle.
  // The API only returns busy sessions, so absence means idle.
  const prefix = `${projectId}:`;
  sessionStatusByKey.forEach((status, key) => {
    if (!key.startsWith(prefix)) return;
    if (status !== 'busy' && status !== 'retry') return;
    if (apiBusyKeys.has(key)) return;
    sessionStatusByKey.set(key, 'idle');
    didUpdate = true;
  });

  if (didUpdate) sessionStatusVersion.value += 1;
}

function nextWindowZ() {
  syncNextWindowZIndex();
  nextWindowZIndex += 1;
  return nextWindowZIndex;
}

function measureTerminalCellWidth(fontFamily: string, fontSizePx: number) {
  if (typeof document === 'undefined') return fontSizePx * 0.62;
  const probe = document.createElement('span');
  probe.textContent = 'MMMMMMMMMM';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.whiteSpace = 'pre';
  probe.style.fontFamily = fontFamily;
  probe.style.fontSize = `${fontSizePx}px`;
  probe.style.lineHeight = String(TERM_LINE_HEIGHT);
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  const width = rect.width / 10;
  return Number.isFinite(width) && width > 0 ? width : fontSizePx * 0.62;
}

function getTerminalWindowSize() {
  const cellWidth = measureTerminalCellWidth(TERM_FONT_FAMILY, TERM_FONT_SIZE_PX);
  const lineHeightPx = TERM_FONT_SIZE_PX * TERM_LINE_HEIGHT;
  const gutterWidthPx = TERM_FONT_SIZE_PX * TERM_GUTTER_WIDTH_EM;
  const contentWidth = TERM_COLUMNS * cellWidth;
  const contentHeight = TERM_ROWS * lineHeightPx;
  const width = Math.ceil(
    contentWidth + gutterWidthPx + TERM_INNER_PADDING_X_PX + TERM_WINDOW_BORDER_PX,
  );
  const height = Math.ceil(
    contentHeight + TERM_TITLEBAR_HEIGHT_PX + TERM_INNER_PADDING_Y_PX + TERM_WINDOW_BORDER_PX,
  );
  return { width, height };
}

function syncCanvasTermMetrics() {
  const canvas = toolWindowCanvasEl.value;
  if (!canvas) return;
  const { width, height } = getTerminalWindowSize();
  canvas.style.setProperty('--term-font-family', TERM_FONT_FAMILY);
  canvas.style.setProperty('--term-font-size', `${TERM_FONT_SIZE_PX}px`);
  canvas.style.setProperty('--term-line-height', String(TERM_LINE_HEIGHT));
  canvas.style.setProperty('--term-width', `${width}px`);
  canvas.style.setProperty('--term-height', `${height}px`);
}

function handleWindowResize() {
  syncCanvasTermMetrics();
  scheduleShellFitAll();
}

function bringToFront(entry: FileReadEntry) {
  const z = nextWindowZ();
  entry.zIndex = entry.isShell ? SHELL_WINDOW_Z_BASE + z : z;
}

function getCanvasMetrics() {
  const canvas = toolWindowCanvasEl.value;
  if (!canvas) return null;
  const canvasRect = canvas.getBoundingClientRect();
  const styles = getComputedStyle(canvas);
  const toolTop = Number.parseFloat(styles.getPropertyValue('--tool-top-offset')) || 0;
  const toolAreaValue = styles.getPropertyValue('--tool-area-height').trim();
  const parsedToolArea = Number.parseFloat(toolAreaValue);
  const toolAreaHeight =
    toolAreaValue.endsWith('px') && Number.isFinite(parsedToolArea) && parsedToolArea > 0
      ? parsedToolArea
      : canvasRect.height - toolTop;
  const widthValue = styles.getPropertyValue('--term-width');
  const heightValue = styles.getPropertyValue('--term-height');
  const parsedWidth = Number.parseFloat(widthValue);
  const parsedHeight = Number.parseFloat(heightValue);
  const termWidth = Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : 640;
  const termHeight = Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : 350;
  return { canvasRect, toolTop, toolAreaHeight, termWidth, termHeight };
}

function getRandomWindowPosition(size?: { width?: number; height?: number }) {
  const metrics = getCanvasMetrics();
  if (!metrics) return { x: 0, y: 0 };
  const { canvasRect, toolAreaHeight, termWidth, termHeight } = metrics;
  const targetWidth = size?.width ?? termWidth;
  const targetHeight = size?.height ?? termHeight;
  const maxLeft = Math.max(0, canvasRect.width - targetWidth);
  const maxTop = Math.max(0, toolAreaHeight - targetHeight);
  return {
    x: Math.round(Math.random() * maxLeft),
    y: Math.round(Math.random() * maxTop),
  };
}

function loadShellPtyStorage() {
  if (typeof window === 'undefined') return {} as Record<string, string[]>;
  try {
    const raw = window.localStorage.getItem(SHELL_PTY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistShellPtyStorage() {
  if (typeof window === 'undefined') return;
  const data: Record<string, string[]> = {};
  shellPtyIdsBySessionId.forEach((set, sessionId) => {
    data[sessionId] = Array.from(set);
  });
  try {
    window.localStorage.setItem(SHELL_PTY_STORAGE_KEY, JSON.stringify(data));
  } catch {
    return;
  }
}

function hydrateShellPtyStorage() {
  const stored = loadShellPtyStorage();
  Object.entries(stored).forEach(([sessionId, list]) => {
    if (!Array.isArray(list)) return;
    const set = new Set<string>();
    list.forEach((id) => {
      if (typeof id === 'string') set.add(id);
    });
    if (set.size > 0) shellPtyIdsBySessionId.set(sessionId, set);
  });
}

function addShellPtyId(sessionId: string, ptyId: string) {
  const set = shellPtyIdsBySessionId.get(sessionId) ?? new Set<string>();
  set.add(ptyId);
  shellPtyIdsBySessionId.set(sessionId, set);
  persistShellPtyStorage();
}

function removeShellPtyId(sessionId: string, ptyId: string) {
  const set = shellPtyIdsBySessionId.get(sessionId);
  if (!set) return;
  set.delete(ptyId);
  if (set.size === 0) shellPtyIdsBySessionId.delete(sessionId);
  persistShellPtyStorage();
}

function getShellPtyIds(sessionId: string) {
  return shellPtyIdsBySessionId.get(sessionId) ?? new Set<string>();
}

function parseShellArgs(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return { command: undefined, args: [] as string[] };
  const parts = trimmed.split(/\s+/g).filter(Boolean);
  return { command: parts[0], args: parts.slice(1) };
}

function isRenderableImageUrl(url: string) {
  return (
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('blob:')
  );
}

function normalizeAttachments(list: MessageAttachment[]) {
  const seen = new Set<string>();
  const result: MessageAttachment[] = [];
  list.forEach((item) => {
    const key = `${item.url}|${item.mime}|${item.filename}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(item);
  });
  return result;
}

function extractImageAttachmentsFromParts(parts: unknown) {
  if (!Array.isArray(parts)) return [] as MessageAttachment[];
  const attachments: MessageAttachment[] = [];
  parts.forEach((part, index) => {
    if (!part || typeof part !== 'object') return;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type !== 'file' && type !== 'image') return;
    const mime = typeof record.mime === 'string' ? record.mime : '';
    if (!mime.startsWith('image/')) return;
    const url =
      (typeof record.url === 'string' ? record.url : undefined) ??
      (typeof record.dataUrl === 'string' ? record.dataUrl : undefined) ??
      '';
    if (!url || !isRenderableImageUrl(url)) return;
    const filename = typeof record.filename === 'string' ? record.filename : 'image';
    const id = typeof record.id === 'string' ? record.id : `img-${index}-${url.slice(0, 16)}`;
    attachments.push({ id, url, mime, filename });
  });
  return normalizeAttachments(attachments);
}

function generateAttachmentId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('File read failed.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('File read failed.'));
    };
    reader.readAsDataURL(file);
  });
}

async function handleAddAttachments(files: File[]) {
  const accepted = files.filter((file) => ATTACHMENT_MIME_ALLOWLIST.has(file.type));
  if (accepted.length === 0) {
    sendStatus.value = 'Unsupported attachment type.';
    return;
  }
  try {
    const next = await Promise.all(
      accepted.map(async (file) => ({
        id: generateAttachmentId(),
        filename: file.name || 'image',
        mime: file.type || 'application/octet-stream',
        dataUrl: await readFileAsDataUrl(file),
      })),
    );
    attachments.value = [...attachments.value, ...next];
    persistComposerDraftForCurrentContext();
  } catch (error) {
    sendStatus.value = `Attachment failed: ${toErrorMessage(error)}`;
  }
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((item) => item.id !== id);
  persistComposerDraftForCurrentContext();
}

function getSessionTitle(sessionId?: string) {
  if (!sessionId) return undefined;
  const session = sessions.value.find((item) => item.id === sessionId);
  return session?.title || session?.slug || session?.id;
}

function mergeReasoningContent(
  prior: string,
  incoming: string,
  options?: { ensureTrailingNewline?: boolean },
) {
  if (!incoming) return prior;
  if (!prior) return incoming;
  const ensureTrailingNewline = options?.ensureTrailingNewline ?? false;
  if (ensureTrailingNewline && incoming.startsWith(prior)) {
    const remainder = incoming.slice(prior.length);
    if (!prior.endsWith('\n') && !remainder.startsWith('\n')) {
      return `${prior}\n${remainder}`;
    }
    return incoming;
  }
  let nextPrior = prior;
  if (ensureTrailingNewline && !nextPrior.endsWith('\n')) {
    nextPrior = `${nextPrior}\n`;
  }
  if (incoming.startsWith(nextPrior)) return incoming;
  if (nextPrior.includes(incoming)) return nextPrior;
  const maxCheck = Math.min(nextPrior.length, incoming.length);
  let overlap = 0;
  for (let size = 1; size <= maxCheck; size += 1) {
    if (nextPrior.endsWith(incoming.slice(0, size))) overlap = size;
  }
  const needsSeparator = overlap === 0 && !nextPrior.endsWith('\n');
  const separator = needsSeparator ? '\n' : '';
  return `${nextPrior}${separator}${incoming.slice(overlap)}`;
}

function getBundledThemeNames() {
  if (Array.isArray(bundledThemes)) {
    return bundledThemes
      .map((theme) => {
        if (typeof theme === 'string') return theme;
        if (theme && typeof theme === 'object' && 'name' in theme) return String(theme.name ?? '');
        return '';
      })
      .filter((name) => name.length > 0);
  }
  return Object.keys(bundledThemes);
}

function pickShikiTheme(names: string[]) {
  if (names.length === 0) return 'github-dark';
  const preferred = [
    'github-dark',
    'github-dark-dimmed',
    'vitesse-dark',
    'dark-plus',
    'nord',
    'dracula',
    'monokai',
  ];
  for (const theme of preferred) {
    if (names.includes(theme)) return theme;
  }
  const darkMatch = names.find((name) => /dark|night|nord|dracula|monokai/i.test(name));
  return darkMatch ?? names[0];
}

function getEntryTitle(entry: FileReadEntry) {
  const prefix = getEntryPrefix(entry);
  const isFloatingMessage = entry.isReasoning || entry.isSubagentMessage;
  const withPrefix = (title: string) => {
    const resolvedTitle = title.trim() || 'message';
    if (isFloatingMessage) return `🤔 ${resolvedTitle}`;
    return `[${prefix}] ${resolvedTitle}`;
  };
  if (entry.isPermission) {
    const permission = entry.permissionRequest?.permission;
    return permission ? withPrefix(`Permission: ${permission}`) : withPrefix('Permission request');
  }
  if (entry.isQuestion) {
    const header = entry.questionRequest?.questions?.[0]?.header;
    return header ? withPrefix(`Question: ${header}`) : withPrefix('Question request');
  }
  if (entry.isShell) return withPrefix(entry.shellTitle ?? 'Shell');
  if (entry.isReasoning) {
    const sessionTitle = getSessionTitle(entry.sessionId);
    const reasoningTitle = entry.sessionId
      ? reasoningTitleBySessionId.get(entry.sessionId)
      : undefined;
    return withPrefix(reasoningTitle ?? sessionTitle ?? 'Reasoning');
  }
  if (entry.isSubagentMessage) {
    const sessionTitle = getSessionTitle(entry.sessionId);
    if (sessionTitle) return withPrefix(sessionTitle);
  }
  const displayPath = resolveWorktreeRelativePath(entry.path);
  if (displayPath && (entry.toolName === 'read' || entry.toolName === 'apply_patch'))
    return withPrefix(displayPath);
  if (entry.toolTitle) return withPrefix(entry.toolTitle);
  if (entry.toolName) return withPrefix(entry.toolName);
  if (displayPath) return withPrefix(displayPath);
  if (entry.header) {
    const cleaned = entry.header.trim().replace(/^#\s*/, '').trim();
    if (cleaned) return withPrefix(cleaned);
  }
  return withPrefix('tool');
}

function getEntryPrefix(entry: FileReadEntry) {
  if (entry.isPermission) return 'PERMISSION';
  if (entry.isQuestion) return 'QUESTION';
  if (entry.isShell) return 'SHELL';
  if (entry.isReasoning) return 'MESSAGE';
  if (entry.isSubagentMessage || entry.isMessage) return 'MESSAGE';
  if (entry.toolName === 'apply_patch') return 'PATCH';
  if (entry.toolName === 'edit' || entry.toolName === 'multiedit') return 'EDIT';
  if (entry.toolName === 'write' || entry.isWrite) return 'WRITE';
  if (entry.toolName === 'read') return 'READ';
  if (entry.toolName === 'grep') return 'GREP';
  if (entry.toolName === 'glob') return 'GLOB';
  if (entry.toolName === 'list') return 'LS';
  if (entry.toolName === 'bash') return 'SHELL';
  if (entry.toolName === 'webfetch') return 'FETCH';
  if (entry.toolName === 'websearch') return 'SEARCH';
  if (entry.toolName === 'codesearch') return 'CODE';
  if (entry.toolName) return entry.toolName.toUpperCase();
  return 'MESSAGE';
}

function getSubagentExpiry(sessionId?: string) {
  const now = Date.now();
  if (!sessionId) return now + SUBAGENT_ACTIVE_TTL_MS;
  const stored = subagentSessionExpiry.get(sessionId);
  if (stored !== undefined) return stored;
  const status = getSessionStatus(sessionId);
  if (status === 'busy' || status === 'retry') return Number.MAX_SAFE_INTEGER;
  if (status === 'idle') return now;
  return now + SUBAGENT_ACTIVE_TTL_MS;
}

function updateSubagentExpiry(sessionId: string, status: 'busy' | 'idle') {
  const now = Date.now();
  const expiresAt = status === 'idle' ? now : Number.MAX_SAFE_INTEGER;
  subagentSessionExpiry.set(sessionId, expiresAt);
  queue.value.forEach((entry) => {
    if (entry.sessionId === sessionId && entry.isSubagentMessage) {
      entry.expiresAt = expiresAt;
    }
  });
}

function updateReasoningExpiry(sessionId: string | undefined, status: 'busy' | 'idle') {
  if (!sessionId && !selectedSessionId.value) return;
  const targetSessionId = sessionId ?? selectedSessionId.value;
  if (!targetSessionId) return;
  const reasoningKey = getReasoningKey(targetSessionId);
  const finish = getReasoningFinish(reasoningKey);
  const isFinished = Boolean(finish);
  if (status === 'idle' && !isFinished) return;
  if (status === 'busy' && isFinished) return;
  const now = Date.now();
  const nextExpiresAt =
    status === 'busy'
      ? Number.MAX_SAFE_INTEGER
      : finish
        ? finish.time + REASONING_CLOSE_DELAY_MS
        : now;
  queue.value.forEach((entry) => {
    if (!entry.isReasoning) return;
    const matchesSession =
      entry.sessionId === targetSessionId ||
      (!entry.sessionId && targetSessionId === selectedSessionId.value);
    if (!matchesSession) return;
    entry.expiresAt = nextExpiresAt;
  });
}

function startInputResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const output = outputEl.value;
  const input = inputEl.value;
  if (!output || !input) return;
  const outputRect = output.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();
  const totalHeight = Math.max(0, outputRect.height + inputRect.height);
  const minOutputHeight = 180;
  const maxInputHeight = Math.max(120, totalHeight - minOutputHeight);
  const minInputHeight = Math.min(200, maxInputHeight);
  inputResizeState.value = {
    startY: event.clientY,
    startHeight: inputRect.height,
    minHeight: minInputHeight,
    maxHeight: maxInputHeight,
  };
  inputHeight.value = inputRect.height;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function startTermDrag(entry: FileReadEntry, event: PointerEvent) {
  if (event.button !== 0) return;
  resizeState.value = null;
  const metrics = getCanvasMetrics();
  if (!metrics) return;
  const termEl = (event.currentTarget as HTMLElement).closest('.term') as HTMLElement | null;
  const { canvasRect, toolTop, toolAreaHeight, termWidth, termHeight } = metrics;
  const termRect = termEl?.getBoundingClientRect();
  const resolvedWidth = termRect?.width ?? termWidth;
  const resolvedHeight = termRect?.height ?? termHeight;
  const maxX = Math.max(0, canvasRect.width - resolvedWidth);
  const maxY = Math.max(0, toolAreaHeight - resolvedHeight);
  const startLeft = termRect ? termRect.left - canvasRect.left : entry.x;
  const startTop = termRect ? termRect.top - canvasRect.top : toolTop + entry.y;
  dragState.value = {
    entry,
    startX: event.clientX,
    startY: event.clientY,
    startLeft,
    startTop,
    maxX,
    maxY,
    toolTop,
  };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function startTermResize(entry: FileReadEntry, event: PointerEvent) {
  if (event.button !== 0) return;
  dragState.value = null;
  const metrics = getCanvasMetrics();
  if (!metrics) return;
  const termEl = (event.currentTarget as HTMLElement).closest('.term') as HTMLElement | null;
  const termRect = termEl?.getBoundingClientRect();
  if (!termRect) return;
  const { canvasRect, toolTop, toolAreaHeight } = metrics;
  const offsetLeft = termRect.left - canvasRect.left;
  const offsetTop = termRect.top - canvasRect.top;
  const maxWidth = Math.max(200, canvasRect.width - offsetLeft);
  const maxHeight = Math.max(200, toolTop + toolAreaHeight - offsetTop);
  const isFileViewer = entry.toolKey?.startsWith('file-viewer:');
  const minWidth = entry.isPermission
    ? PERMISSION_WINDOW_MIN_WIDTH
    : entry.isQuestion
      ? QUESTION_WINDOW_MIN_WIDTH
      : isFileViewer
        ? FILE_VIEWER_WINDOW_MIN_WIDTH
        : 320;
  const minHeight = entry.isPermission
    ? PERMISSION_WINDOW_MIN_HEIGHT
    : entry.isQuestion
      ? QUESTION_WINDOW_MIN_HEIGHT
      : isFileViewer
        ? FILE_VIEWER_WINDOW_MIN_HEIGHT
        : 220;
  resizeState.value = {
    entry,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: termRect.width,
    startHeight: termRect.height,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
  };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  event.stopPropagation();
  event.preventDefault();
}

function focusTerm(entry: FileReadEntry, event: PointerEvent) {
  if (event.button !== 0) return;
  bringToFront(entry);
}

function handlePointerMove(event: PointerEvent) {
  if (inputResizeState.value) {
    const { startY, startHeight, minHeight, maxHeight } = inputResizeState.value;
    const dy = event.clientY - startY;
    inputHeight.value = clamp(startHeight - dy, minHeight, maxHeight);
    scheduleShellFitAll();
    return;
  }
  if (resizeState.value) {
    const { entry, startX, startY, startWidth, startHeight, minWidth, minHeight, maxWidth, maxHeight } =
      resizeState.value;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    entry.width = clamp(startWidth + dx, minWidth, maxWidth);
    entry.height = clamp(startHeight + dy, minHeight, maxHeight);
    if (entry.isShell && entry.shellId) scheduleShellFit(entry.shellId);
    return;
  }
  if (!dragState.value) return;
  const { entry, startX, startY, startLeft, startTop, maxX, maxY, toolTop } = dragState.value;
  const dx = event.clientX - startX;
  const dy = event.clientY - startY;
  const nextLeft = clamp(startLeft + dx, 0, maxX);
  const nextTop = clamp(startTop + dy, toolTop, toolTop + maxY);
  entry.x = nextLeft;
  entry.y = nextTop - toolTop;
}

function handlePointerUp() {
  dragState.value = null;
  resizeState.value = null;
  if (inputResizeState.value) scheduleShellFitAll();
  inputResizeState.value = null;
}

function getReasoningKey(sessionId?: string) {
  return sessionId ?? selectedSessionId.value ?? 'main';
}

function getReasoningFinish(reasoningKey: string, messageId?: string) {
  const finished = finishedReasoningByKey.get(reasoningKey);
  if (!finished) return null;
  if (messageId && finished.id !== messageId) return null;
  const activeId = activeReasoningMessageIdByKey.get(reasoningKey);
  if (activeId && finished.id !== activeId) return null;
  return finished;
}

function markReasoningFinished(sessionId?: string, messageId?: string) {
  const resolvedSessionId = sessionId ?? selectedSessionId.value;
  const reasoningKey = getReasoningKey(resolvedSessionId);
  const activeId = activeReasoningMessageIdByKey.get(reasoningKey);
  const resolvedMessageId = messageId ?? activeId;
  if (!resolvedMessageId) return false;
  if (activeId && resolvedMessageId !== activeId) return false;
  finishedReasoningByKey.set(reasoningKey, { id: resolvedMessageId, time: Date.now() });
  return true;
}

function clearReasoningCloseTimer(reasoningKey: string) {
  const existing = reasoningCloseTimers.get(reasoningKey);
  if (existing === undefined) return;
  window.clearTimeout(existing);
  reasoningCloseTimers.delete(reasoningKey);
}

function clearReasoningCloseTimerForSession(sessionId?: string) {
  clearReasoningCloseTimer(getReasoningKey(sessionId));
}

function scheduleReasoningClose(sessionId?: string) {
  const resolvedSessionId = sessionId ?? selectedSessionId.value;
  const reasoningKey = getReasoningKey(resolvedSessionId);
  clearReasoningCloseTimer(reasoningKey);
  if (!resolvedSessionId) return;
  const timer = window.setTimeout(() => {
    reasoningCloseTimers.delete(reasoningKey);
    updateReasoningExpiry(resolvedSessionId, 'idle');
  }, REASONING_CLOSE_DELAY_MS);
  reasoningCloseTimers.set(reasoningKey, timer);
}

function scheduleReasoningScroll(messageKey: string) {
  nextTick(() => {
    requestAnimationFrame(() => {
      const canvas = toolWindowCanvasEl.value;
      if (!canvas) return;
      const entry = queue.value.find((item) => item.messageKey === messageKey);
      if (entry && entry.follow === false) return;
      if (entry) entry.follow = true;
      const term = canvas.querySelector(
        `[data-message-key="${messageKey}"] .term-inner`,
      ) as HTMLElement | null;
      if (!term) return;
      term.scrollTop = Math.max(0, term.scrollHeight - term.clientHeight);
    });
  });
}

function isNearBottom(target: HTMLElement, threshold = FLOATING_FOLLOW_THRESHOLD_PX) {
  return target.scrollHeight - target.clientHeight - target.scrollTop <= threshold;
}

function updateFloatingFollow(entry: FileReadEntry, target: HTMLElement) {
  const nextFollow = isNearBottom(target);
  if (entry.follow !== nextFollow) entry.follow = nextFollow;
}

function handleFloatingScroll(entry: FileReadEntry, event: Event) {
  if (!entry.isReasoning && !entry.isSubagentMessage) return;
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  updateFloatingFollow(entry, target);
}

function handleFloatingWheel(entry: FileReadEntry, event: WheelEvent) {
  if (!entry.isReasoning && !entry.isSubagentMessage) return;
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  requestAnimationFrame(() => {
    updateFloatingFollow(entry, target);
  });
}

function handleToolWindowRendered(entry: FileReadEntry) {
  if (entry.isReasoning || entry.isSubagentMessage) {
    if (entry.messageKey) scheduleReasoningScroll(entry.messageKey);
    return;
  }
  if (!entry.toolKey) return;
  scheduleToolScrollAnimation(entry.toolKey);
}

function scheduleToolScrollAnimation(toolKey: string) {
  const existing = pendingToolScrollFrames.get(toolKey);
  if (existing !== undefined) {
    cancelAnimationFrame(existing);
    pendingToolScrollFrames.delete(toolKey);
  }
  nextTick(() => {
    const frame = requestAnimationFrame(() => {
      pendingToolScrollFrames.delete(toolKey);
      const canvas = toolWindowCanvasEl.value;
      if (!canvas) return;
      const term = canvas.querySelector(
        `[data-tool-key="${toolKey}"] .term-inner`,
      ) as HTMLElement | null;
      if (!term) return;
      const host = term.querySelector('.code-content, .shiki-host') as HTMLElement | null;
      if (!host) return;

      const distance = Math.max(0, host.scrollHeight - term.clientHeight);
      const entry = queue.value.find((e) => e.toolKey === toolKey);
      if (!entry) return;

      if (distance <= 1) {
        if (!entry.scroll) return;
        entry.scroll = false;
        entry.scrollDistance = 0;
        entry.scrollDuration = 0;
        return;
      }

      const duration = distance / TOOL_SCROLL_SPEED_PX_S;
      const sameDistance = Math.abs((entry.scrollDistance ?? 0) - distance) < 1;
      const sameDuration = Math.abs((entry.scrollDuration ?? 0) - duration) < 0.01;
      if (entry.scroll && sameDistance && sameDuration) return;

      if (entry.scroll) {
        entry.scroll = false;
        entry.scrollDistance = distance;
        entry.scrollDuration = duration;
        nextTick(() => {
          requestAnimationFrame(() => {
            const current = queue.value.find((e) => e.toolKey === toolKey);
            if (!current) return;
            current.scroll = true;
            current.scrollDistance = distance;
            current.scrollDuration = duration;
          });
        });
        return;
      }

      entry.scroll = true;
      entry.scrollDistance = distance;
      entry.scrollDuration = duration;
    });
    pendingToolScrollFrames.set(toolKey, frame);
  });
}

function upsertSessionFromEvent(info: SessionInfo) {
  const existingIndex = sessions.value.findIndex((session) => session.id === info.id);
  if (existingIndex >= 0) {
    sessions.value.splice(existingIndex, 1, { ...sessions.value[existingIndex], ...info });
  } else {
    sessions.value.push(info);
  }
}

function buildSessionParentMap(list: SessionInfo[]) {
  const map = new Map<string, string | undefined>();
  list.forEach((session) => {
    map.set(session.id, session.parentID);
  });
  return map;
}

function setSessions(list: SessionInfo[]) {
  const next = Array.isArray(list) ? list : [];
  sessions.value = next;
  sessionParentById.value = buildSessionParentMap(next);
}

function clearSessions() {
  sessions.value = [];
  sessionParentById.value = new Map();
}

function upsertSessionGraph(info: SessionInfo) {
  const next = new Map(sessionParentById.value);
  next.set(info.id, info.parentID);
  sessionParentById.value = next;
}

function removeSessionFromGraph(sessionId: string) {
  const next = new Map(sessionParentById.value);
  next.delete(sessionId);
  sessionParentById.value = next;
}

async function fetchHomePath() {
  try {
    const data = (await opencodeApi.getPathInfo(OPENCODE_BASE_URL)) as { home?: string; worktree?: string };
    if (typeof data.home === 'string' && data.home.trim()) {
      homePath.value = data.home.trim();
    }
    if (typeof data.worktree === 'string' && data.worktree.trim()) {
      serverWorktreePath.value = data.worktree.trim();
    }
  } catch {
    return;
  }
}

async function fetchProjects(directory?: string) {
  projectError.value = '';
  try {
    const data = (await opencodeApi.listProjects(OPENCODE_BASE_URL, directory)) as ProjectInfo[];
    projects.value = Array.isArray(data) ? data : [];
  } catch (error) {
    projectError.value = `Project load failed: ${toErrorMessage(error)}`;
  }
}

function upsertProject(next: ProjectInfo) {
  const index = projects.value.findIndex((project) => project.id === next.id);
  if (index >= 0) {
    projects.value.splice(index, 1, { ...projects.value[index], ...next });
  } else {
    projects.value.unshift(next);
  }
}

async function fetchCurrentProject(directory?: string) {
  try {
    const data = (await opencodeApi.getCurrentProject(OPENCODE_BASE_URL, directory)) as ProjectInfo;
    return data && typeof data.id === 'string' ? data : null;
  } catch {
    return null;
  }
}

function resolveDirectory(directory: string, baseDir: string) {
  const trimmed = directory.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return trimmed;
  if (!baseDir) return trimmed;
  if (trimmed === '.') return baseDir;
  return baseDir.replace(/\/+$/, '') + '/' + trimmed.replace(/^\.\//, '');
}

function projectSessionDirectories(project?: ProjectInfo) {
  if (!project) return [] as string[];
  const baseDir = serverWorktreePath.value;
  const candidates = [] as string[];
  if (project.worktree) candidates.push(resolveDirectory(project.worktree, baseDir));
  if (Array.isArray(project.sandboxes)) {
    candidates.push(...project.sandboxes.map((s) => resolveDirectory(s, baseDir)));
  }
  return Array.from(
    new Set(candidates.map((directory) => directory.trim()).filter((directory) => directory)),
  );
}

async function fetchSessions(options: {
  directory?: string;
  roots?: boolean;
  search?: string;
  limit?: number;
} = {}) {
  const list = await listSessionsByDirectory(options);
  if (options.directory && selectedWorktreeDir.value && options.directory !== selectedWorktreeDir.value) {
    return;
  }
  setSessions(list);
}

async function listSessionsByDirectory(options: {
  directory?: string;
  roots?: boolean;
  search?: string;
  limit?: number;
} = {}) {
  sessionError.value = '';
  try {
    const data = (await opencodeApi.listSessions(OPENCODE_BASE_URL, options)) as SessionInfo[];
    return Array.isArray(data) ? data : [];
  } catch (error) {
    const message = `Session load failed: ${toErrorMessage(error)}`;
    sessionError.value = message;
    return [] as SessionInfo[];
  }
}

function refreshSessionsForDirectory(directory?: string) {
  if (!directory) {
    clearSessions();
    return Promise.resolve();
  }
  return fetchSessions({ directory });
}

async function fetchWorktrees(directory?: string) {
  worktreeError.value = '';
  if (!directory) {
    worktrees.value = [];
    return;
  }
  try {
    const baseDir = directory.trim();
    const data = await opencodeApi.listWorktrees(OPENCODE_BASE_URL, baseDir);
    const list = Array.isArray(data)
      ? data.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (directory !== selectedProjectDirectory.value) return;
    if (baseDir && !list.includes(baseDir)) list.unshift(baseDir);
    const current = selectedWorktreeDir.value;
    if (current && !list.includes(current)) list.unshift(current);
    worktrees.value = list;
  } catch (error) {
    worktreeError.value = `Worktree load failed: ${toErrorMessage(error)}`;
  }
}

async function fetchWorktreeMeta(directory: string) {
  const trimmed = directory.trim();
  if (!trimmed) return;
  const normalized = normalizeDirectory(trimmed);
  const requestId = ++worktreeMetaRequestId;
  worktreeMetaRequestIdByDir.set(normalized, requestId);
  try {
    const data = (await opencodeApi.getVcsInfo(OPENCODE_BASE_URL, trimmed)) as VcsInfo;
    if (!data || typeof data.branch !== 'string') return;
    if (worktreeMetaRequestIdByDir.get(normalized) !== requestId) return;
    worktreeMetaByDir.value = {
      ...worktreeMetaByDir.value,
      [normalized]: { branch: data.branch },
    };
  } catch {
    return;
  }
}

function resolveWorktreeMetadata(list: string[]) {
  const next: Record<string, VcsInfo> = {};
  list.forEach((dir) => {
    const normalized = normalizeDirectory(dir);
    const existing = worktreeMetaByDir.value[normalized];
    const pending = pendingWorktreeMetaByDir.get(normalized);
    if (existing) next[normalized] = existing;
    else if (pending) next[normalized] = pending;
    if (pending) pendingWorktreeMetaByDir.delete(normalized);
  });
  worktreeMetaByDir.value = next;
  list.forEach((dir) => {
    const normalized = normalizeDirectory(dir);
    if (worktreeMetaByDir.value[normalized]) return;
    void fetchWorktreeMeta(dir);
  });
}

function hasWorktreeDirectory(directory: string) {
  const normalized = normalizeDirectory(directory);
  return worktrees.value.some((entry) => normalizeDirectory(entry) === normalized);
}

function appendWorktreeDirectory(directory: string) {
  const trimmed = directory.trim();
  if (!trimmed) return;
  if (hasWorktreeDirectory(trimmed)) return;
  worktrees.value = [trimmed, ...worktrees.value];
}

function storePendingWorktreeMeta(directory: string, branch?: string) {
  if (!branch) return;
  const normalized = normalizeDirectory(directory);
  pendingWorktreeMetaByDir.set(normalized, { branch });
}

async function handleWorktreeReady(event: { directory: string; branch?: string }) {
  const directory = event.directory.trim();
  if (!directory) return;
  storePendingWorktreeMeta(directory, event.branch);
  const selectedProject = selectedProjectId.value;
  if (!selectedProject) return;
  const project = projects.value.find((item) => item.id === selectedProject);
  if (!project) return;
  const candidates = projectSessionDirectories(project);
  const normalized = normalizeDirectory(directory);
  const matchesProject = candidates.some((entry) => normalizeDirectory(entry) === normalized);
  if (!matchesProject) return;
  appendWorktreeDirectory(directory);
}

async function createWorktree() {
  worktreeError.value = '';
  if (!selectedProjectDirectory.value) {
    worktreeError.value = 'Worktree base directory not set.';
    return;
  }
  try {
    const data = (await opencodeApi.createWorktree(
      OPENCODE_BASE_URL,
      selectedProjectDirectory.value,
    )) as WorktreeInfo;
    if (data && typeof data.directory === 'string') {
      if (!worktrees.value.includes(data.directory)) {
        worktrees.value.unshift(data.directory);
      }
      selectedWorktreeDir.value = data.directory;
    }
    void fetchWorktrees(selectedProjectDirectory.value || undefined);
  } catch (error) {
    worktreeError.value = `Worktree create failed: ${toErrorMessage(error)}`;
  }
}

async function deleteWorktree(directory: string) {
  worktreeError.value = '';
  if (!directory) return;
  if (!selectedProjectDirectory.value) {
    worktreeError.value = 'Worktree base directory not set.';
    return;
  }
  const baseDir = selectedProjectDirectory.value.replace(/\/+$/, '');
  const targetDir = directory.replace(/\/+$/, '');
  if (baseDir && targetDir === baseDir) return;
  try {
    await opencodeApi.deleteWorktree(OPENCODE_BASE_URL, selectedProjectDirectory.value, targetDir);
    if (normalizeDirectory(selectedWorktreeDir.value) === targetDir) selectedWorktreeDir.value = '';
    void fetchWorktrees(selectedProjectDirectory.value || undefined);
  } catch (error) {
    worktreeError.value = `Worktree delete failed: ${toErrorMessage(error)}`;
  }
}

function openProjectPicker() {
  isProjectPickerOpen.value = true;
}

async function createNewSession() {
  sessionError.value = '';
  try {
    const data = (await opencodeApi.createSession(
      OPENCODE_BASE_URL,
      activeDirectory.value || undefined,
    )) as SessionInfo;
    if (data && typeof data.id === 'string') {
      const matchesDirectory =
        !data.directory || data.directory === selectedWorktreeDir.value || !selectedWorktreeDir.value;
      if (matchesDirectory) {
        const existing = sessions.value.find((session) => session.id === data.id);
        if (!existing) sessions.value.unshift(data);
        upsertSessionGraph(data);
      }
      selectedSessionId.value = data.id;
      if (data.projectID) selectedProjectId.value = data.projectID;
      if (data.directory) selectedWorktreeDir.value = data.directory;
    }
    void refreshSessionsForDirectory(activeDirectory.value || undefined);
  } catch (error) {
    sessionError.value = `Session create failed: ${toErrorMessage(error)}`;
  }
}

async function deleteSession(sessionId: string) {
  sessionError.value = '';
  if (!sessionId) return;
  try {
    const directory = activeDirectory.value.trim();
    await opencodeApi.deleteSession(OPENCODE_BASE_URL, sessionId, directory || undefined);
    if (selectedSessionId.value === sessionId) selectedSessionId.value = '';
    removeSessionFromGraph(sessionId);
    deleteSessionStatus(sessionId, selectedProjectId.value);
    sessions.value = sessions.value.filter((session) => session.id !== sessionId);
    void refreshSessionsForDirectory(activeDirectory.value || undefined);
  } catch (error) {
    sessionError.value = `Session delete failed: ${toErrorMessage(error)}`;
  }
}

async function handleForkMessage(payload: { sessionId: string; messageId: string }) {
  sessionError.value = '';
  try {
    sendStatus.value = 'Forking...';
    const data = (await opencodeApi.forkSession(
      OPENCODE_BASE_URL,
      payload.sessionId,
      payload.messageId,
      activeDirectory.value.trim() || undefined,
    )) as SessionInfo;
    if (data && typeof data.id === 'string') {
      upsertSessionGraph(data);
      const exists = sessions.value.some((session) => session.id === data.id);
      if (!exists) sessions.value.unshift(data);
      seedForkedSessionComposerDraft(payload, data);
      if (data.projectID) selectedProjectId.value = data.projectID;
      if (data.directory) selectedWorktreeDir.value = data.directory;
      selectedSessionId.value = data.id;
      void refreshSessionsForDirectory(data.directory || activeDirectory.value || undefined);
    }
    sendStatus.value = 'Forked.';
  } catch (error) {
    sessionError.value = `Session fork failed: ${toErrorMessage(error)}`;
  }
}

async function handleRevertMessage(payload: { sessionId: string; messageId: string }) {
  sessionError.value = '';
  try {
    sendStatus.value = 'Reverting...';
    await opencodeApi.revertSession(
      OPENCODE_BASE_URL,
      payload.sessionId,
      payload.messageId,
      activeDirectory.value.trim() || undefined,
    );
    sendStatus.value = 'Reverted.';
    if (selectedSessionId.value === payload.sessionId) reloadSelectedSessionState();
    void refreshSessionsForDirectory(activeDirectory.value || undefined);
  } catch (error) {
    sessionError.value = `Session revert failed: ${toErrorMessage(error)}`;
  }
}

async function handleProjectDirectorySelect(directory: string) {
  isProjectPickerOpen.value = false;
  if (!directory) return;
  selectedProjectDirectory.value = directory;
  selectedWorktreeDir.value = directory;
  selectedSessionId.value = '';
  worktrees.value = [];
  clearSessions();
  const current = await fetchCurrentProject(directory);
  await fetchProjects();
  if (current) {
    upsertProject(current);
    selectedProjectId.value = current.id;
  } else if (projects.value.length > 0) {
    const match = projects.value.find((project) => project.worktree === directory);
    if (match) selectedProjectId.value = match.id;
  }
  await fetchWorktrees(directory);
  await refreshSessionsForDirectory(directory);
}

async function bootstrapSelections() {
  if (isBootstrapping.value) return;
  isBootstrapping.value = true;
  try {
    await fetchProjects();
    const hasProject = Boolean(selectedProjectId.value);
    const hasSession = Boolean(selectedSessionId.value);
    if (hasProject !== hasSession) {
      selectedProjectId.value = '';
      selectedSessionId.value = '';
      replaceQuerySelection('', '');
    }

    if (selectedProjectId.value && selectedSessionId.value) {
      const selectedProject = projects.value.find((project) => project.id === selectedProjectId.value);
      if (!selectedProject) {
        selectedProjectId.value = '';
        selectedSessionId.value = '';
        replaceQuerySelection('', '');
        return;
      }
      const candidates = projectSessionDirectories(selectedProject)
        .map((directory) => directory.trim())
        .filter((directory) => directory.length > 0);
      const uniqueDirectories = Array.from(new Set(candidates));
      const checks = await Promise.all(
        uniqueDirectories.map(async (directory) => {
          const list = await listSessionsByDirectory({ directory });
          const found = list.find(
            (session) =>
              session.id === selectedSessionId.value && session.projectID === selectedProjectId.value,
          );
          if (!found) return null;
          return { directory };
        }),
      );
      const matched = checks.find((entry) => Boolean(entry));
      if (matched) {
        const targetSessionId = selectedSessionId.value;
        selectedProjectDirectory.value = selectedProject.worktree?.trim() || matched.directory;
        selectedWorktreeDir.value = matched.directory;
        await fetchCommands(selectedWorktreeDir.value);
        await fetchWorktrees(selectedProjectDirectory.value);
        await refreshSessionsForDirectory(selectedWorktreeDir.value);
        if (targetSessionId) {
          retryStatus.value = null;
          await fetchHistory(targetSessionId);
          await restoreShellSessions(targetSessionId);
          await fetchSessionStatus(selectedWorktreeDir.value || undefined);
        }
      } else {
        selectedProjectId.value = '';
        selectedSessionId.value = '';
        replaceQuerySelection('', '');
      }
      return;
    }

    const current = await fetchCurrentProject();
    if (current?.worktree) {
      selectedProjectDirectory.value = current.worktree;
      selectedWorktreeDir.value = current.worktree;
      selectedProjectId.value = current.id;
      await fetchWorktrees(current.worktree);
      await fetchCommands(current.worktree);
      await refreshSessionsForDirectory(current.worktree);
      return;
    }

    const fallback = baseWorktreeOptions.value[0] ?? '';
    if (fallback) {
      selectedProjectDirectory.value = fallback;
      selectedWorktreeDir.value = fallback;
      const matched = projects.value.find((project) => project.worktree === fallback);
      if (matched?.id) selectedProjectId.value = matched.id;
      await fetchWorktrees(fallback);
      await fetchCommands(fallback);
      await refreshSessionsForDirectory(fallback);
    } else {
      clearSessions();
    }
  } finally {
    isBootstrapping.value = false;
    if (activeDirectory.value) {
      void fetchSessionStatus(activeDirectory.value || undefined);
    }
    if (activeDirectory.value) {
      void loadTreePath('.');
      void refreshSessionDiff();
    }
  }
}


async function fetchProviders() {
  if (providersLoading.value || providersLoaded.value) return;
  providersLoading.value = true;
  providersFetchCount.value += 1;
  log('providers fetch start', providersFetchCount.value);
  try {
    const data = (await opencodeApi.listProviders(OPENCODE_BASE_URL)) as ProviderResponse;
    providers.value = Array.isArray(data.providers) ? data.providers : [];
    const models: Array<{
      id: string;
      label: string;
      displayName: string;
      providerID?: string;
      providerLabel?: string;
      variants?: Record<string, unknown>;
      attachmentCapable?: boolean;
    }> = [];
    providers.value.forEach((provider) => {
      Object.values(provider.models ?? {}).forEach((model) => {
        const providerID = model.providerID?.trim() || provider.id?.trim() || 'unknown';
        const providerLabel = provider.name?.trim() || providerID;
        const modelDisplayName = model.name?.trim() || model.id;
        const label = `${modelDisplayName} [${providerID}/${model.id}]`;
        models.push({
          id: model.id,
          label,
          displayName: modelDisplayName,
          providerID,
          providerLabel: providerLabel,
          variants: model.variants,
          attachmentCapable: model.capabilities?.attachment !== false,
        });
      });
    });
    models.sort((a, b) => {
      const providerA = a.providerLabel ?? a.providerID ?? 'unknown';
      const providerB = b.providerLabel ?? b.providerID ?? 'unknown';
      const providerCompare = providerA.localeCompare(providerB);
      if (providerCompare !== 0) return providerCompare;
      return a.label.localeCompare(b.label);
    });
    const sameModels =
      models.length === modelOptions.value.length &&
      models.every((model, index) => model.id === modelOptions.value[index]?.id);
    if (!sameModels) {
      modelOptions.value = models;
      log('providers models updated', models.length);
    }

    if (!selectedModel.value) {
      const defaults = data.default ?? {};
      const preferredModelId = Object.values(defaults)[0];
      const firstModel = modelOptions.value[0]?.id;
      selectedModel.value = preferredModelId || firstModel || '';
    }
    const selectedInfo = modelOptions.value.find((model) => model.id === selectedModel.value);
    const nextThinkingOptions = buildThinkingOptions(selectedInfo?.variants);
    const sameThinking =
      nextThinkingOptions.length === thinkingOptions.value.length &&
      nextThinkingOptions.every((value, index) => value === thinkingOptions.value[index]);
    if (!sameThinking) thinkingOptions.value = nextThinkingOptions;
    if (selectedThinking.value === undefined || !nextThinkingOptions.includes(selectedThinking.value)) {
      selectedThinking.value = thinkingOptions.value[0];
      log('providers thinking set', selectedThinking.value);
    }
    refreshMessageUsageContextPercent();
    providersLoaded.value = true;
    log('providers fetch done');
  } catch (error) {
    log('Provider load failed', error);
  } finally {
    providersLoading.value = false;
  }
}

async function fetchAgents() {
  if (agentsLoading.value) return;
  agentsLoading.value = true;
  try {
    const data = (await opencodeApi.listAgents(OPENCODE_BASE_URL)) as AgentInfo[];
    agents.value = Array.isArray(data) ? data : [];
    const options = agents.value
      .filter((agent) => agent.mode === 'primary' || agent.mode === 'all')
      .filter((agent) => !agent.hidden)
      .map((agent) => ({
        id: agent.name,
        label: agent.name ? `${agent.name.charAt(0).toUpperCase()}${agent.name.slice(1)}` : agent.name,
        description: agent.description,
        color: agent.color,
      }));
    agentOptions.value = options;
    if (!selectedMode.value || !options.some((option) => option.id === selectedMode.value)) {
      const preferred = options.find((option) => option.id === 'build')?.id ?? options[0]?.id;
      if (preferred) {
        selectedMode.value = preferred;
        // Apply recommended model+variant for the initially selected agent
        // (only if no draft will override via restoreComposerDraftForContext)
        applyAgentDefaults(preferred);
      }
    }
  } catch (error) {
    log('Agent load failed', error);
  } finally {
    agentsLoading.value = false;
  }
}

async function fetchCommands(directory?: string) {
  if (commandsLoading.value) return;
  commandsLoading.value = true;
  try {
    const data = (await opencodeApi.listCommands(OPENCODE_BASE_URL, directory)) as CommandInfo[];
    const list = Array.isArray(data) ? data : [];
    list.sort((a, b) => a.name.localeCompare(b.name));
    commands.value = list;
  } catch (error) {
    log('Command load failed', error);
  } finally {
    commandsLoading.value = false;
  }
}

/**
 * Fetch session statuses from the API and fully sync local state.
 * Fills unknown entries AND demotes locally-busy sessions to idle
 * when they are absent from the API response.
 */
async function fetchSessionStatus(directory?: string) {
  const requestId = ++sessionStatusRequestId;
  const directoryAtRequest = directory ?? '';
  try {
    const data = (await opencodeApi.getSessionStatusMap(
      OPENCODE_BASE_URL,
      directory,
    )) as Record<string, { type?: string }>;
    if (requestId !== sessionStatusRequestId) return;
    if (directoryAtRequest !== (activeDirectory.value || '')) return;
    const nextEntries: [string, SessionStatusType][] = [];
    Object.entries(data ?? {}).forEach(([sessionId, status]) => {
      const type = typeof status?.type === 'string' ? status.type : '';
      if (type === 'busy' || type === 'idle') {
        nextEntries.push([sessionId, type]);
      } else if (type === 'retry') {
        nextEntries.push([sessionId, 'retry']);
      }
    });
    syncSessionStatuses(nextEntries, selectedProjectId.value);
    if (selectedSessionId.value) {
      const nextStatus = getSessionStatus(selectedSessionId.value);
      if (nextStatus !== 'retry') {
        retryStatus.value = null;
      }
    }
  } catch (error) {
    log('Session status sync failed', error);
  }
}

async function fetchPendingPermissions(directory?: string) {
  try {
    const data = await opencodeApi.listPendingPermissions(OPENCODE_BASE_URL, directory);
    if (!Array.isArray(data)) return;
    data
      .map((entry) => parsePermissionRequest(entry))
      .filter((entry): entry is PermissionRequest => Boolean(entry))
      .filter((entry) => isPermissionSessionAllowed(entry))
      .forEach((entry) => {
        upsertPermissionEntry(entry);
      });
  } catch (error) {
    log('Permission list failed', error);
  }
}

async function fetchPendingQuestions(directory?: string) {
  try {
    const data = await opencodeApi.listPendingQuestions(OPENCODE_BASE_URL, directory);
    if (!Array.isArray(data)) return;
    data
      .map((entry) => parseQuestionRequest(entry))
      .filter((entry): entry is QuestionRequest => Boolean(entry))
      .filter((entry) => isQuestionSessionAllowed(entry))
      .forEach((entry) => {
        upsertQuestionEntry(entry);
      });
  } catch (error) {
    log('Question list failed', error);
  }
}

type UserMessageSelection = {
  agent?: string;
  modelId?: string;
  variant?: string;
};

type UserMessageMeta = {
  agent?: string;
  providerId?: string;
  modelId?: string;
  variant?: string;
};

type UserMessageDisplay = {
  agent?: string;
  model?: string;
  variant?: string;
};

type MessageTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache?: {
    read: number;
    write: number;
  };
};

type MessageUsage = {
  tokens: MessageTokens;
  cost?: number;
  providerId?: string;
  modelId?: string;
  contextPercent?: number | null;
};

function extractMessageTime(info?: Record<string, unknown>): number | undefined {
  if (!info) return undefined;
  const time = info.time as Record<string, unknown> | undefined;
  if (!time || typeof time !== 'object') return undefined;
  const created = time.created;
  return typeof created === 'number' ? created : undefined;
}

function parseUserMessageMeta(info?: Record<string, unknown>): UserMessageMeta | null {
  if (!info) return null;
  const agent = typeof info.agent === 'string' ? info.agent.trim() : '';
  const model = (info.model as Record<string, unknown> | undefined) ?? undefined;
  const providerId =
    typeof info.providerID === 'string'
      ? info.providerID.trim()
      : typeof model?.providerID === 'string'
        ? model.providerID.trim()
        : '';
  const modelId =
    typeof info.modelID === 'string'
      ? String(info.modelID).trim()
      : typeof model?.modelID === 'string'
        ? String(model.modelID).trim()
        : '';
  const variant = typeof info.variant === 'string' ? info.variant.trim() : '';
  if (!agent && !modelId && !providerId && !variant) return null;
  return {
    agent: agent || undefined,
    providerId: providerId || undefined,
    modelId: modelId || undefined,
    variant: variant || undefined,
  };
}

function formatUserMessageModel(meta: UserMessageMeta | null): string | undefined {
  if (!meta) return undefined;
  const providerId = meta.providerId?.trim() ?? '';
  const modelId = meta.modelId?.trim() ?? '';
  if (providerId && modelId) return `${providerId}/${modelId}`;
  return modelId || providerId || undefined;
}

function resolveProviderModelLimit(providerId?: string, modelId?: string) {
  const normalizedProvider = providerId?.trim() ?? '';
  const normalizedModel = modelId?.trim() ?? '';
  if (!normalizedProvider || !normalizedModel) return null;
  const provider = providers.value.find((item) => item.id === normalizedProvider);
  if (!provider) return null;
  const model = provider.models?.[normalizedModel];
  if (!model || !model.limit) return null;
  return model.limit;
}

function computeContextPercent(tokens: MessageTokens, providerId?: string, modelId?: string) {
  const limit = resolveProviderModelLimit(providerId, modelId);
  const contextLimit = limit?.context;
  if (!contextLimit || !Number.isFinite(contextLimit) || contextLimit <= 0) return null;
  const total = tokens.input + tokens.output + tokens.reasoning;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((total / contextLimit) * 100);
}

function parseMessageTokens(value: unknown): MessageTokens | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const input = typeof record.input === 'number' ? record.input : 0;
  const output = typeof record.output === 'number' ? record.output : 0;
  const reasoning = typeof record.reasoning === 'number' ? record.reasoning : 0;
  const cache = record.cache && typeof record.cache === 'object' ? (record.cache as Record<string, unknown>) : null;
  const cacheRead = cache && typeof cache.read === 'number' ? cache.read : 0;
  const cacheWrite = cache && typeof cache.write === 'number' ? cache.write : 0;
  if (!Number.isFinite(input) && !Number.isFinite(output) && !Number.isFinite(reasoning)) return null;
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    reasoning: Number.isFinite(reasoning) ? reasoning : 0,
    cache: {
      read: Number.isFinite(cacheRead) ? cacheRead : 0,
      write: Number.isFinite(cacheWrite) ? cacheWrite : 0,
    },
  };
}

function resolveMessageUsage(payload: unknown, eventType: string): MessageUsage | null {
  if (!payload || typeof payload !== 'object') return null;
  if (!MESSAGE_EVENT_TYPES.has(eventType)) return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const info =
    properties?.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : undefined;
  const part =
    properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined;
  const partType = typeof part?.type === 'string' ? part.type : undefined;
  const isStepFinish = partType === 'step-finish';
  const tokensSource = isStepFinish ? part?.tokens : info?.tokens;
  const tokens = parseMessageTokens(tokensSource);
  if (!tokens) return null;
  const modelInfo =
    info?.model && typeof info.model === 'object'
      ? (info.model as Record<string, unknown>)
      : undefined;
  const providerId =
    typeof info?.providerID === 'string'
      ? info.providerID
      : typeof modelInfo?.providerID === 'string'
        ? (modelInfo.providerID as string)
        : undefined;
  const modelId =
    typeof info?.modelID === 'string'
      ? info.modelID
      : typeof modelInfo?.modelID === 'string'
        ? (modelInfo.modelID as string)
        : undefined;
  const costSource = isStepFinish ? part?.cost : info?.cost;
  const cost = typeof costSource === 'number' ? costSource : undefined;
  const contextPercent = computeContextPercent(tokens, providerId, modelId);
  return {
    tokens,
    cost,
    providerId: providerId?.trim() || undefined,
    modelId: modelId?.trim() || undefined,
    contextPercent,
  };
}

function resolveMessageUsageFromInfo(info?: Record<string, unknown>): MessageUsage | null {
  if (!info) return null;
  const tokens = parseMessageTokens(info.tokens);
  if (!tokens) return null;
  const modelInfo =
    info.model && typeof info.model === 'object'
      ? (info.model as Record<string, unknown>)
      : undefined;
  const providerId =
    typeof info.providerID === 'string'
      ? info.providerID
      : typeof modelInfo?.providerID === 'string'
        ? (modelInfo.providerID as string)
        : undefined;
  const modelId =
    typeof info.modelID === 'string'
      ? info.modelID
      : typeof modelInfo?.modelID === 'string'
        ? (modelInfo.modelID as string)
        : undefined;
  const cost = typeof info.cost === 'number' ? info.cost : undefined;
  return {
    tokens,
    cost,
    providerId: providerId?.trim() || undefined,
    modelId: modelId?.trim() || undefined,
    contextPercent: computeContextPercent(tokens, providerId, modelId),
  };
}

function extractUsageUpdate(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  if (!MESSAGE_EVENT_TYPES.has(eventType)) return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const info =
    properties?.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : undefined;
  const part =
    properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined;
  const partType = typeof part?.type === 'string' ? part.type : undefined;
  const isMessageUpdated = String(eventType).toLowerCase().includes('message.updated');
  if (partType && partType !== 'step-finish' && !isMessageUpdated) return null;
  const usage = resolveMessageUsage(payload, eventType);
  if (!usage) return null;
  const messageId =
    (part?.messageID as string | undefined) ??
    (info?.id as string | undefined) ??
    (info?.messageId as string | undefined) ??
    (properties?.messageId as string | undefined) ??
    (properties?.id as string | undefined) ??
    (record.messageId as string | undefined) ??
    (record.id as string | undefined);
  const sessionId =
    (typeof part?.sessionID === 'string' ? (part.sessionID as string) : undefined) ??
    (typeof info?.sessionID === 'string' ? (info.sessionID as string) : undefined) ??
    extractSessionId(payload);
  if (!messageId) return null;
  return { messageId, sessionId, usage };
}

function resolveUserMessageDisplay(meta: UserMessageMeta | null): UserMessageDisplay | null {
  if (!meta) return null;
  const model = formatUserMessageModel(meta);
  const hasAny = Boolean(meta.agent || model || meta.variant);
  if (!hasAny) return null;
  return {
    agent: meta.agent,
    model,
    variant: meta.variant,
  };
}

function applyMessageUsageToQueue(messageId: string, sessionId: string | undefined, usage: MessageUsage) {
  const messageKey = sessionId ? buildMessageKey(messageId, sessionId) : undefined;
  if (messageKey) messageUsageByKey.set(messageKey, usage);
  const index = messageKey ? messageIndexById.get(messageKey) : undefined;
  const updateRoundEntry = (entryIndex: number) => {
    const existing = queue.value[entryIndex];
    if (!existing || !existing.isMessage || !existing.isRound) return false;
    if (sessionId && existing.sessionId && existing.sessionId !== sessionId) return false;
    const existingRoundMessages = existing.roundMessages ?? [];
    const roundMessageIndex = existingRoundMessages.findIndex((entry) => entry.messageId === messageId);
    if (roundMessageIndex < 0) return false;
    const currentRoundMessage = existingRoundMessages[roundMessageIndex];
    if (!currentRoundMessage) return false;
    const providerId = usage.providerId ?? currentRoundMessage.providerId ?? existing.messageProviderId;
    const modelId = usage.modelId ?? currentRoundMessage.modelId ?? existing.messageModelId;
    const contextPercent =
      usage.contextPercent ?? computeContextPercent(usage.tokens, providerId, modelId);
    const nextRoundMessage: RoundMessage = {
      ...currentRoundMessage,
      providerId: providerId ?? undefined,
      modelId: modelId ?? undefined,
      usage: {
        ...usage,
        providerId: providerId ?? undefined,
        modelId: modelId ?? undefined,
        contextPercent,
      },
    };
    const nextRoundMessages = [...existingRoundMessages];
    nextRoundMessages.splice(roundMessageIndex, 1, nextRoundMessage);
    queue.value.splice(entryIndex, 1, {
      ...existing,
      messageProviderId:
        existing.messageId === messageId ? (providerId ?? undefined) : existing.messageProviderId,
      messageModelId: existing.messageId === messageId ? (modelId ?? undefined) : existing.messageModelId,
      messageUsage:
        existing.messageId === messageId
          ? {
              ...usage,
              providerId: providerId ?? undefined,
              modelId: modelId ?? undefined,
              contextPercent,
            }
          : existing.messageUsage,
      roundMessages: nextRoundMessages,
    });
    return true;
  };
  const updateEntry = (entryIndex: number) => {
    const existing = queue.value[entryIndex];
    if (!existing || !existing.isMessage) return;
    const providerId = usage.providerId ?? existing.messageProviderId;
    const modelId = usage.modelId ?? existing.messageModelId;
    const contextPercent =
      usage.contextPercent ?? computeContextPercent(usage.tokens, providerId, modelId);
    queue.value.splice(entryIndex, 1, {
      ...existing,
      messageProviderId: providerId,
      messageModelId: modelId,
      messageUsage: {
        ...usage,
        providerId: providerId ?? undefined,
        modelId: modelId ?? undefined,
        contextPercent,
      },
    });
  };
  if (index !== undefined) {
    if (updateRoundEntry(index)) return;
    updateEntry(index);
    return;
  }
  queue.value.forEach((entry, entryIndex) => {
    if (!entry.isMessage) return;
    if (sessionId && entry.sessionId && entry.sessionId !== sessionId) return;
    if (updateRoundEntry(entryIndex)) return;
    if (entry.messageId !== messageId) return;
    updateEntry(entryIndex);
  });
}

function refreshMessageUsageContextPercent() {
  messageUsageByKey.forEach((usage, messageKey) => {
    const providerId = usage.providerId;
    const modelId = usage.modelId;
    const contextPercent = computeContextPercent(usage.tokens, providerId, modelId);
    messageUsageByKey.set(messageKey, {
      ...usage,
      contextPercent,
    });
  });
  queue.value.forEach((entry, index) => {
    if (!entry.isMessage || !entry.messageUsage || !entry.messageKey) return;
    const usage = messageUsageByKey.get(entry.messageKey) ?? entry.messageUsage;
    const providerId = usage.providerId ?? entry.messageProviderId;
    const modelId = usage.modelId ?? entry.messageModelId;
    const contextPercent = computeContextPercent(usage.tokens, providerId, modelId);
    queue.value.splice(index, 1, {
      ...entry,
      messageProviderId: providerId,
      messageModelId: modelId,
      messageUsage: {
        ...usage,
        providerId: providerId ?? undefined,
        modelId: modelId ?? undefined,
        contextPercent,
      },
    });
  });
}

function storeUserMessageMeta(messageId: string | undefined, meta: UserMessageMeta | null) {
  if (!messageId || !meta) return;
  userMessageMetaById.set(messageId, meta);
}

function storeUserMessageTime(messageId: string | undefined, messageTime?: number) {
  if (!messageId || typeof messageTime !== 'number') return;
  userMessageTimeById.set(messageId, messageTime);
}

function resolveUserMessageMetaForMessage(
  messageId?: string,
  fallbackId?: string,
  meta?: UserMessageMeta | null,
): UserMessageMeta | null {
  if (meta) return meta;
  if (messageId && userMessageMetaById.has(messageId)) {
    return userMessageMetaById.get(messageId) ?? null;
  }
  if (fallbackId && userMessageMetaById.has(fallbackId)) {
    return userMessageMetaById.get(fallbackId) ?? null;
  }
  return null;
}

function resolveUserMessageTimeForMessage(
  messageId?: string,
  fallbackId?: string,
  messageTime?: number,
): number | undefined {
  if (typeof messageTime === 'number') return messageTime;
  if (messageId && userMessageTimeById.has(messageId)) {
    return userMessageTimeById.get(messageId);
  }
  if (fallbackId && userMessageTimeById.has(fallbackId)) {
    return userMessageTimeById.get(fallbackId);
  }
  return undefined;
}

function applyUserMessageMetaToQueue(messageId: string, meta: UserMessageMeta) {
  const displayMeta = resolveUserMessageDisplay(meta);
  if (!displayMeta) return;
  queue.value.forEach((entry, index) => {
    const matchesReasoningMessage = Boolean(
      entry.isReasoning &&
        activeReasoningMessageIdByKey.get(getReasoningKey(entry.sessionId)) === messageId,
    );
    if (!entry.isMessage) return;
    if (entry.isRound && entry.roundMessages) {
      const existingRoundMessages = entry.roundMessages;
      const roundMessageIndex = existingRoundMessages.findIndex((roundEntry) => roundEntry.messageId === messageId);
      if (roundMessageIndex >= 0) {
        const roundMessage = existingRoundMessages[roundMessageIndex];
        if (!roundMessage) return;
        const nextRoundMessages = [...existingRoundMessages];
        nextRoundMessages.splice(roundMessageIndex, 1, {
          ...roundMessage,
          agent: displayMeta.agent ?? roundMessage.agent,
          model: displayMeta.model ?? roundMessage.model,
          variant: displayMeta.variant ?? roundMessage.variant,
        });
        queue.value.splice(index, 1, {
          ...entry,
          messageAgent: entry.messageId === messageId ? (displayMeta.agent ?? entry.messageAgent) : entry.messageAgent,
          messageModel: entry.messageId === messageId ? (displayMeta.model ?? entry.messageModel) : entry.messageModel,
          messageVariant:
            entry.messageId === messageId ? (displayMeta.variant ?? entry.messageVariant) : entry.messageVariant,
          roundMessages: nextRoundMessages,
        });
        return;
      }
    }
    if (entry.messageId !== messageId && !matchesReasoningMessage) return;
    queue.value.splice(index, 1, {
      ...entry,
      messageAgent: displayMeta.agent ?? entry.messageAgent,
      messageModel: displayMeta.model ?? entry.messageModel,
      messageVariant: displayMeta.variant ?? entry.messageVariant,
    });
  });
}

function applyUserMessageTimeToQueue(messageId: string, messageTime: number) {
  queue.value.forEach((entry, index) => {
    const matchesReasoningMessage = Boolean(
      entry.isReasoning &&
        activeReasoningMessageIdByKey.get(getReasoningKey(entry.sessionId)) === messageId,
    );
    if (!entry.isMessage) return;
    if (entry.isRound && entry.roundMessages) {
      const existingRoundMessages = entry.roundMessages;
      const roundMessageIndex = existingRoundMessages.findIndex((roundEntry) => roundEntry.messageId === messageId);
      if (roundMessageIndex >= 0) {
        const roundMessage = existingRoundMessages[roundMessageIndex];
        if (!roundMessage) return;
        const nextRoundMessages = [...existingRoundMessages];
        nextRoundMessages.splice(roundMessageIndex, 1, {
          ...roundMessage,
          time: messageTime,
        });
        queue.value.splice(index, 1, {
          ...entry,
          messageTime: entry.messageId === messageId ? messageTime : entry.messageTime,
          roundMessages: nextRoundMessages,
        });
        return;
      }
    }
    if (entry.messageId !== messageId && !matchesReasoningMessage) return;
    queue.value.splice(index, 1, {
      ...entry,
      messageTime,
    });
  });
}

function pickLastUserSelection(messages: Array<Record<string, unknown>>): UserMessageSelection | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    const info = (entry?.info as Record<string, unknown> | undefined) ?? undefined;
    const role = typeof info?.role === 'string' ? info.role : '';
    if (role !== 'user') continue;
    const meta = parseUserMessageMeta(info);
    if (!meta) continue;
    return {
      agent: meta.agent,
      modelId: meta.modelId,
      variant: meta.variant,
    };
  }
  return null;
}

function hasStoredComposerDraftForSession(sessionId: string) {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return false;
  const projectId = resolveProjectIdForSession(normalizedSessionId) || selectedProjectId.value;
  const contextKey = buildComposerContextKey(projectId, normalizedSessionId);
  if (contextKey) return Boolean(readComposerDraft(contextKey));
  const suffix = `:${normalizedSessionId}`;
  const store = readComposerDraftStore();
  return Object.keys(store).some((key) => key.endsWith(suffix));
}

async function fetchHistory(sessionId: string, isSubagentMessage = false) {
  if (!sessionId) return;
  const requestId = !isSubagentMessage ? ++primaryHistoryRequestId : 0;
  const requestedDirectory = !isSubagentMessage ? getSelectedWorktreeDirectory() : '';
  try {
    const directory = getSelectedWorktreeDirectory();
    const data = (await opencodeApi.listSessionMessages(
      OPENCODE_BASE_URL,
      sessionId,
      { directory: directory || undefined },
    )) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return;
    if (!isSubagentMessage) {
      if (requestId !== primaryHistoryRequestId) return;
      if (selectedSessionId.value !== sessionId) return;
      if (getSelectedWorktreeDirectory() !== requestedDirectory) return;
    }
    // NOTE: Disabled — subagent messages with role=user cause incorrect restoration
    // if (!isSubagentMessage && !hasStoredComposerDraftForSession(sessionId)) {
    //   const selection = pickLastUserSelection(data);
    //   if (selection) {
    //     if (selection.agent) selectedMode.value = selection.agent;
    //     if (selection.modelId) selectedModel.value = selection.modelId;
    //     if (selection.variant) {
    //       selectedThinking.value = selection.variant;
    //     } else if (selection.agent || selection.modelId) {
    //       selectedThinking.value = undefined;
    //     }
    //   }
    // }
    data.forEach((message, index) => {
      const info = message.info as Record<string, unknown> | undefined;
      const parts = message.parts as unknown;
      const id = typeof info?.id === 'string' ? info.id : undefined;
      const role = typeof info?.role === 'string' ? info.role : undefined;
       if (id && role === 'assistant' && Array.isArray(parts)) {
         extractMessageDiffsFromParts(parts, id, sessionId);
       }
     });

    const history = data
      .map((message, sourceIndex) => {
        const info = message.info as Record<string, unknown> | undefined;
        const parts = message.parts as unknown;
        const text = extractMessageTextFromParts(parts) ?? '';
        const attachments = extractImageAttachmentsFromParts(parts);
        const id = typeof info?.id === 'string' ? info.id : undefined;
        const role = typeof info?.role === 'string' ? info.role : undefined;
        const parentID = typeof info?.parentID === 'string' ? info.parentID : undefined;
        const finish = typeof info?.finish === 'string' ? info.finish : undefined;
        const meta = parseUserMessageMeta(info);
        const usage = resolveMessageUsageFromInfo(info);
        const messageTime = extractMessageTime(info);
        if (!id) return null;
        if (!parentID && (!text.trim() && attachments.length === 0)) {
          return {
            id,
            role,
            parentID,
            finish,
            text,
            attachments,
            meta,
            usage,
            messageTime,
            info,
            sourceIndex,
          };
        }
        const hasError = info?.error && typeof info.error === 'object';
        if (parentID && !text.trim() && attachments.length === 0 && !hasError) return null;
        return {
          id,
          role,
          parentID,
          finish,
          text,
          attachments,
          meta,
          usage,
          messageTime,
          info,
          sourceIndex,
        };
      })
      .filter(
        (entry): entry is {
          id: string;
          role?: string;
          parentID?: string;
          finish?: string;
          text: string;
          attachments: MessageAttachment[];
          meta: UserMessageMeta | null;
          usage: MessageUsage | null;
          messageTime?: number;
          info?: Record<string, unknown>;
          sourceIndex: number;
        } => Boolean(entry),
      );
    const historyMeta = new Map<string, {
      displayMeta: ReturnType<typeof resolveUserMessageDisplay>;
      resolvedTime?: number;
      usageProviderId?: string;
      usageModelId?: string;
      historyUsage?: MessageUsage;
    }>();

    history.forEach((entry) => {
      storeUserMessageMeta(entry.id, entry.meta);
      const resolvedMeta = resolveUserMessageMetaForMessage(entry.id, undefined, entry.meta);
      const displayMeta = resolveUserMessageDisplay(resolvedMeta);
      storeUserMessageTime(entry.id, entry.messageTime);
      const resolvedTime = resolveUserMessageTimeForMessage(entry.id, undefined, entry.messageTime);
      const usageProviderId = entry.usage?.providerId ?? resolvedMeta?.providerId;
      const usageModelId = entry.usage?.modelId ?? resolvedMeta?.modelId;
      const historyUsage = entry.usage
        ? {
            ...entry.usage,
            providerId: usageProviderId,
            modelId: usageModelId,
            contextPercent:
              entry.usage.contextPercent ??
              computeContextPercent(entry.usage.tokens, usageProviderId, usageModelId),
          }
        : undefined;

      const messageKey = buildMessageKey(entry.id, sessionId);
      if (historyUsage) messageUsageByKey.set(messageKey, historyUsage);
      historyMeta.set(entry.id, {
        displayMeta,
        resolvedTime,
        usageProviderId,
        usageModelId,
        historyUsage,
      });
    });

    if (isSubagentMessage) {
      history.forEach((entry) => {
        const isUserEntry = entry.role === 'user';
        const isAssistantEntry = !isUserEntry;
        const messageKey = buildMessageKey(entry.id, sessionId);
        if (messageIndexById.has(messageKey)) return;
        const resolved = historyMeta.get(entry.id);
        const header = '';
        const time = Date.now();
        const text = `${header}${entry.text}`;
        const messageColumns = 52;
        const visibleLines = 12;
        const lines = countWrappedLines(text, messageColumns);
        const overflowLines = Math.max(0, lines - visibleLines);
        const lineHeight = 16;
        const scrollDistance = Math.max(0, overflowLines * lineHeight);
        const scrollDuration =
          overflowLines > 0 ? Math.min(0.25, Math.max(0.08, overflowLines * 0.01)) : 0;
        const expiresAt = getSubagentExpiry(sessionId);
        const randomPosition = getRandomWindowPosition();
        queue.value.push({
          time,
          expiresAt,
          x: randomPosition.x,
          y: randomPosition.y,
          header,
          content: entry.text,
          role: isUserEntry ? 'user' : 'assistant',
          messageAgent: resolved?.displayMeta?.agent,
          messageModel: resolved?.displayMeta?.model,
          messageProviderId: resolved?.usageProviderId,
          messageModelId: resolved?.usageModelId,
          messageUsage: resolved?.historyUsage,
          messageVariant: resolved?.displayMeta?.variant,
          messageTime: resolved?.resolvedTime,
          scroll: overflowLines > 0,
          scrollDistance,
          scrollDuration,
          html: '',
          attachments: entry.attachments,
          isWrite: false,
          isMessage: true,
          isSubagentMessage,
          messageId: entry.id,
          messageKey,
          follow: true,
          sessionId,
          zIndex: nextWindowZ(),
        });
        if (entry.attachments.length > 0) {
          messageAttachmentsById.set(messageKey, entry.attachments);
        }
        messageIndexById.set(messageKey, queue.value.length - 1);
        messageContentById.set(messageKey, entry.text);
      });
      return;
    }

    // Build round groups
    const roundRoots = new Map<string, typeof history[0]>();
    const roundChildren = new Map<string, Array<typeof history[0]>>();
    for (const entry of history) {
      if (!entry.parentID) {
        roundRoots.set(entry.id, entry);
        if (!roundChildren.has(entry.id)) roundChildren.set(entry.id, []);
      } else {
        const children = roundChildren.get(entry.parentID) ?? [];
        children.push(entry);
        roundChildren.set(entry.parentID, children);
      }
    }

    for (const root of history) {
      if (root.parentID) continue;
      if (!roundRoots.has(root.id)) continue;
      const messageKey = buildMessageKey(root.id, sessionId);
      if (messageIndexById.has(messageKey)) continue;
      const rootResolved = historyMeta.get(root.id);
      const header = '';
      const time = Date.now();
      const expiresAt = time + 1000 * 60 * 30;
      const roundItems = [root, ...(roundChildren.get(root.id) ?? [])].sort((a, b) => {
        const aTime = typeof a.messageTime === 'number' ? a.messageTime : undefined;
        const bTime = typeof b.messageTime === 'number' ? b.messageTime : undefined;
        if (aTime !== undefined && bTime !== undefined && aTime !== bTime) return aTime - bTime;
        return a.sourceIndex - b.sourceIndex;
      });
      const roundMessages: RoundMessage[] = roundItems.map((item) => {
        const resolved = historyMeta.get(item.id);
        return {
          messageId: item.id,
          role: item.role === 'user' ? 'user' : 'assistant',
          content: item.text,
          attachments: item.attachments.length > 0 ? item.attachments : undefined,
          agent: resolved?.displayMeta?.agent,
          model: resolved?.displayMeta?.model,
          providerId: resolved?.usageProviderId,
          modelId: resolved?.usageModelId,
          variant: resolved?.displayMeta?.variant,
          time: resolved?.resolvedTime,
          usage: resolved?.historyUsage,
        };
      });
      const roundDiffs = root.role === 'user' ? extractSummaryDiffs(root.info) : [];
      // Extract error from the last assistant message in the round (e.g. MessageAbortedError)
      const lastAssistantItem = [...roundItems].reverse().find((item) => item.role !== 'user');
      const roundError = extractMessageError(lastAssistantItem?.info) ?? extractMessageError(root.info);

      queue.value.push({
        time,
        expiresAt,
        x: 0,
        y: 0,
        header,
        content: root.text,
        role: root.role === 'user' ? 'user' : 'assistant',
        messageAgent: rootResolved?.displayMeta?.agent,
        messageModel: rootResolved?.displayMeta?.model,
        messageProviderId: rootResolved?.usageProviderId,
        messageModelId: rootResolved?.usageModelId,
        messageUsage: rootResolved?.historyUsage,
        messageVariant: rootResolved?.displayMeta?.variant,
        messageTime: rootResolved?.resolvedTime,
        scroll: false,
        scrollDistance: 0,
        scrollDuration: 0,
         html: '',
         attachments: root.attachments,
         isWrite: false,
         isMessage: true,
         isSubagentMessage: false,
         isRound: true,
        roundId: root.id,
        roundMessages,
        roundDiffs,
        messageError: roundError,
        messageId: root.id,
        messageKey,
        sessionId,
      });
      if (root.attachments.length > 0) {
        messageAttachmentsById.set(messageKey, root.attachments);
      }
      messageIndexById.set(messageKey, queue.value.length - 1);
      messageContentById.set(messageKey, root.text);
      messageDiffsByKey.set(messageKey, roundDiffs);
    }

    scheduleFollowScroll();
  } catch (error) {
    log('History load failed', error);
  }
}

function buildPtyWsUrl(path: string, directory?: string) {
  return opencodeApi.createWsUrl(OPENCODE_BASE_URL, path, { directory });
}

function parsePtyInfo(value: unknown): PtyInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const title = typeof record.title === 'string' ? record.title : '';
  const command = typeof record.command === 'string' ? record.command : '';
  const args = Array.isArray(record.args) ? record.args.map((arg) => String(arg)) : [];
  const cwd = typeof record.cwd === 'string' ? record.cwd : '';
  const status = record.status === 'running' || record.status === 'exited' ? record.status : 'running';
  const pid = typeof record.pid === 'number' ? record.pid : 0;
  if (!id) return null;
  return { id, title, command, args, cwd, status, pid };
}

async function fetchPtyList(directory?: string) {
  const data = await opencodeApi.listPtys(OPENCODE_BASE_URL, directory);
  if (!Array.isArray(data)) return [] as PtyInfo[];
  return data.map(parsePtyInfo).filter((pty): pty is PtyInfo => Boolean(pty));
}

async function createPtySession(sessionId: string, command?: string, args?: string[]) {
  const directory = activeDirectory.value || undefined;
  const data = await opencodeApi.createPty(OPENCODE_BASE_URL, {
    directory,
    command,
    args,
    cwd: directory,
    title: `Shell (${sessionId.slice(0, 6)})`,
  });
  return parsePtyInfo(data);
}

async function updatePtySize(ptyId: string, rows: number, cols: number, directory?: string) {
  const data = await opencodeApi.updatePtySize(OPENCODE_BASE_URL, ptyId, {
    directory,
    rows,
    cols,
  });
  return parsePtyInfo(data);
}

function ensureShellWindow(pty: PtyInfo, sessionId: string, options: { preserve?: boolean } = {}) {
  if (shellSessionsByPtyId.has(pty.id)) return;
  const time = Date.now();
  const randomPosition = getRandomWindowPosition();
  const entry: FileReadEntry = {
    time,
    expiresAt: Number.MAX_SAFE_INTEGER,
    x: randomPosition.x,
    y: randomPosition.y,
    header: '',
    path: undefined,
    content: '',
    scroll: false,
    scrollDistance: 0,
    scrollDuration: 0,
    html: '',
    isWrite: false,
    isMessage: false,
    isShell: true,
    shellId: pty.id,
    shellTitle: pty.title || 'Shell',
    sessionId,
    zIndex: SHELL_WINDOW_Z_BASE + nextWindowZ(),
  };
  queue.value.push(entry);
  if (!options.preserve) addShellPtyId(sessionId, pty.id);
  const terminal = new Terminal({
    fontFamily: TERM_FONT_FAMILY,
    fontSize: TERM_FONT_SIZE_PX,
    lineHeight: TERM_LINE_HEIGHT,
    cursorBlink: true,
    theme: {
      background: '#050505',
      foreground: '#e2e8f0',
      cursor: '#e2e8f0',
      selectionBackground: 'rgba(148, 163, 184, 0.3)',
    },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  shellSessionsByPtyId.set(pty.id, {
    pty,
    entry,
    terminal,
    fitAddon,
    sessionId,
  });
  nextTick(() => {
    const host = toolWindowCanvasEl.value?.querySelector(
      `[data-shell-id="${pty.id}"]`,
    ) as HTMLElement | null;
    if (!host) return;
    terminal.open(host);
    scheduleShellFit(pty.id);
    connectShellSocket(pty.id);
  });
}

function scheduleShellFitAll() {
  shellSessionsByPtyId.forEach((_, ptyId) => {
    scheduleShellFit(ptyId);
  });
}

function scheduleShellFit(ptyId: string) {
  const existing = pendingShellFits.get(ptyId);
  if (existing) cancelAnimationFrame(existing);
  const handle = requestAnimationFrame(() => {
    pendingShellFits.delete(ptyId);
    const session = shellSessionsByPtyId.get(ptyId);
    if (!session) return;
    const terminalElement = session.terminal.element;
    if (!terminalElement || !terminalElement.isConnected) return;
    try {
      session.fitAddon.fit();
    } catch (error) {
      log('PTY fit failed', error);
      return;
    }
    const rows = session.terminal.rows;
    const cols = session.terminal.cols;
    if (rows > 0 && cols > 0) {
      const directory = session.pty.cwd || activeDirectory.value || undefined;
      updatePtySize(ptyId, rows, cols, directory).catch((error) => {
        log('PTY resize failed', error);
      });
    }
  });
  pendingShellFits.set(ptyId, handle);
}

function connectShellSocket(ptyId: string) {
  const session = shellSessionsByPtyId.get(ptyId);
  if (!session) return;
  const directory = session.pty.cwd || activeDirectory.value || undefined;
  const url = buildPtyWsUrl(`/pty/${ptyId}/connect`, directory);
  const socket = new WebSocket(url);
  session.socket = socket;
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      session.terminal.write(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      session.terminal.write(new Uint8Array(event.data));
    }
  });
  socket.addEventListener('open', () => {
    session.terminal.focus();
  });
  session.terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  });
  socket.addEventListener('close', () => {
    session.terminal.write('\r\n[disconnected]\r\n');
  });
}

function removeShellWindow(ptyId: string, options: { preserve?: boolean } = {}) {
  const session = shellSessionsByPtyId.get(ptyId);
  if (!session) return;
  const pending = pendingShellFits.get(ptyId);
  if (pending) cancelAnimationFrame(pending);
  pendingShellFits.delete(ptyId);
  session.socket?.close();
  session.terminal.dispose();
  shellSessionsByPtyId.delete(ptyId);
  const index = queue.value.findIndex((entry) => entry.isShell && entry.shellId === ptyId);
  if (index >= 0) queue.value.splice(index, 1);
  if (!options.preserve) removeShellPtyId(session.sessionId, ptyId);
}

function disposeShellWindows(options: { preserve?: boolean } = {}) {
  const ids = Array.from(shellSessionsByPtyId.keys());
  ids.forEach((ptyId) => removeShellWindow(ptyId, options));
}

async function restoreShellSessions(sessionId: string) {
  if (!sessionId) return;
  const tracked = getShellPtyIds(sessionId);
  if (tracked.size === 0) return;
  try {
    const ptys = await fetchPtyList(activeDirectory.value || undefined);
    const available = new Map<string, PtyInfo>();
    ptys.forEach((pty) => available.set(pty.id, pty));
    tracked.forEach((ptyId) => {
      const pty = available.get(ptyId);
      if (!pty) {
        removeShellPtyId(sessionId, ptyId);
        return;
      }
      if (pty.status === 'exited') {
        removeShellPtyId(sessionId, ptyId);
        return;
      }
      ensureShellWindow(pty, sessionId, { preserve: true });
    });
  } catch (error) {
    log('PTY restore failed', error);
  }
}

async function openShellFromInput(input: string) {
  const sessionId = selectedSessionId.value;
  if (!sessionId) return;
  const { command, args } = parseShellArgs(input);
  const pty = await createPtySession(sessionId, command, args);
  if (pty) ensureShellWindow(pty, sessionId);
}

function parseSlashCommand(input: string) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.slice(1).match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  const name = match[1]?.trim();
  if (!name) return null;
  const args = match[2] ?? '';
  return { name, arguments: args };
}

function findCommandByName(name: string) {
  const target = name.toLowerCase();
  return commands.value.find((command) => command.name.toLowerCase() === target) ?? null;
}

type DebugToolEvent = {
  status: 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  output?: unknown;
  metadata?: Record<string, unknown>;
  error?: unknown;
  delayMs?: number;
  toolName?: string;
  callIdSuffix?: string;
};

function buildDebugToolEvents(tool: string): DebugToolEvent[] | null {
  const basePath = getSelectedWorktreeDirectory() || '/tmp/debug';
  const sampleFile = `${basePath.replace(/\/+$/, '')}/app/App.vue`;
  const sampleAltFile = `${basePath.replace(/\/+$/, '')}/app/utils/workerRenderer.ts`;
  const debugReadLines = [
    '<template>',
    '  <div ref="appEl" class="app">',
    '    <header class="app-header">',
    '      <TopPanel',
    '        :base-worktrees="baseWorktreeOptions"',
    '        :base-worktree="selectedProjectDirectory"',
    '        :active-directories="worktrees"',
    '        :active-directory="selectedWorktreeDir"',
    '        :active-directory-meta="worktreeMetaByDir"',
    '        :sessions="filteredSessions"',
    '        :session-status-by-id="sessionStatusByIdRecord"',
    '        :home-path="homePath"',
    '        v-model:base-worktree="selectedProjectDirectory"',
    '        v-model:active-directory="selectedWorktreeDir"',
    '        v-model:selected-session-id="selectedSessionId"',
    '        @open-directory="openProjectPicker"',
    '        @create-worktree="createWorktree"',
    '        @new-session="createNewSession"',
    '        @delete-active-directory="deleteWorktree"',
    '        @delete-session="deleteSession"',
    '      />',
    '    </header>',
    '    <main ref="outputEl" class="app-output">',
    '      <div class="output-workspace">',
    '        <div class="tool-window-layer" :class="{ \'todo-collapsed\': sidePanelCollapsed }">',
    '          <div class="output-split" :class="{ \'todo-collapsed\': sidePanelCollapsed }">',
    '            <OutputPanel',
    '              ref="outputPanelRef"',
    '              class="output-panel"',
    '              :queue="queue"',
    '              :is-following="isFollowing"',
    '              :status-text="statusText"',
    '              :is-status-error="isStatusError"',
    '              :is-thinking="isThinking"',
    '              :is-retry-status="!!retryStatus"',
    '              :busy-descendant-count="busyDescendantSessionIds.length"',
    '              :theme="shikiTheme"',
    '              :resolve-agent-color="resolveAgentColorForName"',
    '              :message-diffs="messageDiffsByKey"',
    '              @scroll="handleOutputPanelScroll"',
    '              @wheel="handleOutputPanelWheel"',
    '              @touchmove="handleOutputPanelScroll"',
    '              @resume-follow="resumeFollow"',
    '              @fork-message="handleForkMessage"',
    '              @revert-message="handleRevertMessage"',
    '              @show-message-diff="handleShowMessageDiff"',
    '              @show-message-history="handleShowMessageHistory"',
    '            />',
    '            <SidePanel',
    '              class="todo-panel"',
    '              :collapsed="sidePanelCollapsed"',
    '              :active-tab="sidePanelActiveTab"',
    '              :todo-sessions="todoPanelSessions"',
    '              :tree-nodes="treeNodes"',
    '              :expanded-tree-paths="expandedTreePaths"',
    '              :selected-tree-path="selectedTreePath"',
    '              :tree-loading="treeLoading"',
    '              :tree-error="treeError"',
    '              :tree-status-by-path="sessionStatusByPath"',
    '              @toggle-collapse="toggleSidePanelCollapsed"',
    '              @change-tab="setSidePanelTab"',
    '              @toggle-dir="toggleTreeDirectory"',
    '              @select-file="selectTreeFile"',
    '              @open-diff="openSessionDiff"',
    '              @open-file="openFileViewer"',
    '            />',
    '          </div>',
    '          <div ref="toolWindowCanvasEl" class="tool-window-canvas">',
    '            <TransitionGroup appear name="fade">',
    '              <ToolWindow',
    '                v-for="q in queue.filter((entry) => !entry.isMessage || entry.isSubagentMessage)"',
    '                :key="q.permissionId ?? q.questionId ?? q.callId ?? q.messageId ?? q.time"',
    '                :entry="q"',
    '                :get-entry-title="getEntryTitle"',
    '                :resolve-agent-tone="resolveAgentTone"',
    '                :build-message-key="buildMessageKey"',
    '                :on-focus-entry="focusTerm"',
    '                :on-drag-entry="startTermDrag"',
    '                :on-resize-entry="startTermResize"',
    '                :on-floating-scroll-entry="handleFloatingScroll"',
    '                :on-floating-wheel-entry="handleFloatingWheel"',
    '                :on-rendered-entry="handleToolWindowRendered"',
    '                :is-permission-submitting="isPermissionSubmitting"',
    '                :get-permission-error="getPermissionError"',
    '                :on-permission-reply="handlePermissionReply"',
    '                :is-question-submitting="isQuestionSubmitting"',
    '                :get-question-error="getQuestionError"',
    '                :on-question-reply="handleQuestionReply"',
    '                :on-question-reject="handleQuestionReject"',
    '                :theme="shikiTheme"',
    '              />',
    '              <FileViewerWindow',
    '                v-for="q in fileViewerQueue"',
    '                :key="q.toolKey ?? q.path ?? q.time"',
    '                :entry="q"',
    '                :title="getEntryTitle(q)"',
    '                :on-focus-entry="focusTerm"',
    '                :on-drag-entry="startTermDrag"',
    '                :on-resize-entry="startTermResize"',
    '                :on-floating-scroll-entry="handleFloatingScroll"',
    '                :on-floating-wheel-entry="handleFloatingWheel"',
    '                :on-close-entry="closeFileViewer"',
    '                :theme="shikiTheme"',
    '              />',
    '            </TransitionGroup>',
    '          </div>',
    '        </div>',
    '      </div>',
    '    </main>',
    '    <footer',
    '      ref="inputEl"',
    '      class="app-input"',
    '      :style="inputHeight !== null ? { height: \`${inputHeight}px\` } : undefined"',
    '    >',
    '      <div class="input-resizer" @pointerdown="startInputResize"></div>',
    '      <InputPanel',
    '        :can-send="canSend"',
    '        :agent-options="agentOptions"',
    '        :has-agent-options="hasAgentOptions"',
    '        :agent-color="currentAgentColor"',
    '        :model-options="modelOptions"',
    '        :thinking-options="thinkingOptions"',
    '        :has-model-options="hasModelOptions"',
    '        :has-thinking-options="hasThinkingOptions"',
    '        :can-attach="canAttach"',
    '        :is-thinking="isThinking"',
    '        :can-abort="canAbort"',
    '        :commands="commandOptions"',
    '        :attachments="attachments"',
    '        :message-input="messageInput"',
    '      />',
    '    </footer>',
    '  </div>',
    '</template>',
  ];
  const debugReadBody = debugReadLines
    .map((line, index) => `${String(index + 1).padStart(5, '0')}| ${line}`)
    .join('\n');
  const debugReadOutput = `<file>\n${debugReadBody}\n</file>`;
  switch (tool) {
    case 'apply_patch': {
      const patchInput = {
        patchText: [
          '*** Begin Patch',
          '*** Update File: app/components/CodeContent.vue',
          '@@',
          '-  min-height: 1.2em;',
          '+  min-height: 1em;',
          '-  column-gap: 0;',
          '+  column-gap: 0.5ch;',
          '@@',
          '-  padding: 0 1ch 0 1ch;',
          '+  padding: 0 0.75ch 0 1ch;',
          '@@',
          '-  padding-left: 1ch;',
          '+  padding-left: 0.75ch;',
          '*** End Patch',
        ].join('\n'),
      };
      const patchDiff = [
        'diff --git a/app/components/CodeContent.vue b/app/components/CodeContent.vue',
        '--- a/app/components/CodeContent.vue',
        '+++ b/app/components/CodeContent.vue',
        '@@ -9,7 +9,8 @@',
        ' <script setup lang="ts">',
        " import { computed } from 'vue';",
        ' ',
        ' const props = defineProps<{',
        '   html: string;',
        "-  variant?: 'code' | 'diff' | 'message' | 'binary';",
        "+  variant?: 'code' | 'diff' | 'message' | 'binary' | 'log';",
        "+  maxHeight?: string;",
        "   wrapMode?: 'default' | 'soft';",
        "   gutterMode?: 'none' | 'single' | 'double';",
        ' }>();',
        ' ',
        ' const rootClass = computed(() => ({',
        "   'is-diff': props.variant === 'diff',",
        "   'is-message': props.variant === 'message',",
        "   'is-binary': props.variant === 'binary',",
        "+  'is-log': props.variant === 'log',",
        "   'wrap-soft': props.wrapMode === 'soft',",
        "   'no-gutter': props.gutterMode === 'none',",
        ' }));',
        ' <\/script>',
        ' ',
        ' <style scoped>',
        ' .code-content {',
        '   line-height: inherit;',
        '   color: inherit;',
        '-  min-height: 1.2em;',
        '+  min-height: 1em;',
        ' }',
        ' ',
        ' .code-content :deep(pre),',
        ' .code-content :deep(code) {',
        '   margin: 0;',
        '   padding: 0;',
        '   background: transparent !important;',
        '   background-color: transparent !important;',
        '   line-height: inherit !important;',
        '   font-family: inherit;',
        '   font-size: inherit;',
        '   white-space: normal;',
        ' }',
        ' ',
        ' .code-content :deep(pre.shiki) {',
        '   background: transparent !important;',
        '   background-color: transparent !important;',
        '   color: inherit;',
        '   display: block;',
        '   line-height: inherit !important;',
        ' }',
        ' ',
        ' .code-content :deep(code) {',
        '   display: grid;',
        '   grid-template-columns: max-content max-content 1fr;',
        '-  column-gap: 0;',
        '+  column-gap: 0.5ch;',
        ' }',
        ' ',
        ' .code-content :deep(.code-row) {',
        '   display: grid;',
        '   grid-template-columns: subgrid;',
        '   grid-column: 1 / -1;',
        '   align-items: start;',
        ' }',
        ' ',
        ' .code-content :deep(.code-gutter) {',
        '   text-align: right;',
        '   color: #8a8a8a;',
        '   white-space: pre;',
        '   font-variant-numeric: tabular-nums;',
        '-  padding: 0 1ch 0 1ch;',
        '+  padding: 0 0.75ch 0 1ch;',
        ' }',
        ' ',
        ' .code-content :deep(.code-gutter.span-2) {',
        '   grid-column: 1 / 3;',
        ' }',
        ' ',
        ' .code-content :deep(.line) {',
        '   display: block;',
        '   min-height: 1em;',
        '   white-space: pre;',
        '   box-sizing: border-box;',
        '-  padding-left: 1ch;',
        '+  padding-left: 0.75ch;',
        ' }',
        ' ',
        ' .code-content :deep(.line:empty)::after {',
        "   content: ' ';",
        ' }',
        ' ',
        ' /* no-gutter */',
        ' ',
        ' .code-content.no-gutter :deep(code) {',
        '   grid-template-columns: 1fr;',
        ' }',
        ' ',
        ' .code-content.no-gutter :deep(.code-gutter) {',
        '   display: none;',
        ' }',
        ' ',
        ' .code-content.no-gutter :deep(.line) {',
        '   padding-left: 0;',
        ' }',
      ].join('\n');
      const patchMeta = {
        files: [{ relativePath: 'app/components/CodeContent.vue', diff: patchDiff }],
      };
      return [
        { status: 'running', input: patchInput, metadata: patchMeta, output: patchDiff },
        { status: 'completed', delayMs: 550, input: patchInput, metadata: patchMeta, output: 'Success. Updated the following files:\nM app/components/CodeContent.vue' },
      ];
    }
    case 'bash': {
      const bashInput = {
        command: 'git diff --stat',
        workdir: basePath,
        description: 'Show file change statistics',
      };
      const bashOutput = [
        ' app/App.vue                           | 142 +++++++++++++++++++++++++++++++++--',
        ' app/components/ToolWindow.vue          |  87 ++++++++++++---------',
        ' app/components/FileViewerWindow.vue    |  41 ++++++++---',
        ' app/components/CodeContent.vue         |  38 +++++----',
        ' app/components/OutputPanel.vue         |  29 ++++---',
        ' app/components/InputPanel.vue          |  35 ++++++---',
        ' app/components/SidePanel.vue           |  52 ++++++++++---',
        ' app/components/TopPanel.vue            |  24 ++++--',
        ' app/components/MessageViewer.vue       |  63 ++++++++++------',
        ' app/components/PermissionWindow.vue    |  19 +++--',
        ' app/components/QuestionWindow.vue      |  22 +++---',
        ' app/components/TreeView.vue            |  27 +++++--',
        ' app/components/TodoPanel.vue           |  15 ++--',
        ' app/components/TodoList.vue            |  33 ++++++---',
        ' app/components/ProjectPicker.vue       |  28 ++++---',
        ' app/components/Dropdown.vue            |  11 ++-',
        ' app/components/Dropdown/Item.vue       |   9 ++-',
        ' app/utils/useCodeRender.ts             |  18 +++--',
        ' app/utils/workerRenderer.ts            |  25 +++---',
        ' app/utils/opencode.ts                  |  34 ++++++--',
        ' app/utils/theme.ts                     |   8 +-',
        ' app/composables/useOutputPanelFollow.ts|  13 ++-',
        ' app/workers/render-worker.ts           |  22 +++---',
        ' app/main.ts                            |   6 +-',
        ' app/env.d.ts                           |   3 +-',
        ' vite.config.ts                         |  12 ++-',
        ' tsconfig.json                          |   4 +-',
        ' package.json                           |   3 +-',
        ' package-lock.json                      |  48 ++++++------',
        ' index.html                             |   5 +-',
        ' server/dev.ts                          |  17 +++--',
        ' server/proxy.ts                        |  11 ++-',
        ' .gitignore                             |   2 +-',
        ' .eslintrc.cjs                          |   8 ++-',
        ' 34 files changed, 782 insertions(+), 315 deletions(-)',
      ].join('\n');
      return [
        { status: 'running', input: bashInput, output: bashOutput },
        { status: 'completed', delayMs: 500, input: bashInput, output: bashOutput },
      ];
    }
    case 'batch':
      return [
        {
          status: 'running',
          toolName: 'glob',
          callIdSuffix: 'glob',
          input: { pattern: '**/*.{vue,ts}', path: basePath },
          output: '',
        },
        {
          status: 'running',
          toolName: 'grep',
          callIdSuffix: 'grep',
          delayMs: 0,
          input: {
            pattern: 'useCodeRender|renderWorkerHtml|CodeRenderParams',
            path: `${basePath}/app`,
            include: '*.{vue,ts}',
          },
          output: '',
        },
        {
          status: 'completed',
          toolName: 'glob',
          callIdSuffix: 'glob',
          delayMs: 420,
          input: { pattern: '**/*.{vue,ts}', path: basePath },
          output: [
            `${basePath}/app/App.vue`,
            `${basePath}/app/main.ts`,
            `${basePath}/app/env.d.ts`,
            `${basePath}/app/components/CodeContent.vue`,
            `${basePath}/app/components/ToolWindow.vue`,
            `${basePath}/app/components/FileViewerWindow.vue`,
            `${basePath}/app/utils/useCodeRender.ts`,
            `${basePath}/app/workers/render-worker.ts`,
          ].join('\n'),
        },
        {
          status: 'completed',
          toolName: 'grep',
          callIdSuffix: 'grep',
          delayMs: 0,
          input: {
            pattern: 'useCodeRender|renderWorkerHtml|CodeRenderParams',
            path: `${basePath}/app`,
            include: '*.{vue,ts}',
          },
          output: [
            'Found 8 matches in 4 files',
            '',
            `${basePath}/app/utils/useCodeRender.ts:`,
            '  Line 4: export type CodeRenderParams = {',
            '  Line 22: export function useCodeRender(',
            '',
            `${basePath}/app/utils/workerRenderer.ts:`,
            '  Line 47: export function renderWorkerHtml(payload: RenderRequest) {',
            '',
            `${basePath}/app/components/ToolWindow.vue:`,
            "  Line 61: import { type CodeRenderParams, useCodeRender } from '../utils/useCodeRender';",
          ].join('\n'),
        },
      ];
    case 'codesearch': {
      const csInput = { query: 'vue composable web worker rendering' };
      const csOutput = [
        '## Results (18 matches across 9 repositories)',
        '',
        '### shikijs/shiki — packages/shiki/src/core.ts',
        '```typescript',
        'export function createHighlighterCore(options: HighlighterCoreOptions) {',
        '  const themes = new Map<string, ThemeRegistrationResolved>()',
        '  const langs = new Map<string, Grammar>()',
        '  return {',
        '    codeToHtml(code, options) { ... },',
        '    codeToTokens(code, options) { ... },',
        '    loadTheme(...themes) { ... },',
        '    loadLanguage(...langs) { ... },',
        '  }',
        '}',
        '```',
        '',
        '### nicolo-ribaudo/shiki-worker — src/worker.ts',
        '```typescript',
        "import { createHighlighter } from 'shiki';",
        'let highlighter: Awaited<ReturnType<typeof createHighlighter>> | null = null;',
        'self.onmessage = async (event: MessageEvent<RenderRequest>) => {',
        '  if (!highlighter) highlighter = await createHighlighter({ ... });',
        '  const { code, lang, theme } = event.data;',
        '  const html = highlighter.codeToHtml(code, { lang, theme });',
        '  self.postMessage({ id: event.data.id, ok: true, html });',
        '};',
        '```',
        '',
        '### vueuse/vueuse — packages/core/useWebWorkerFn/index.ts',
        '```typescript',
        'export function useWebWorkerFn<T extends (...args: unknown[]) => unknown>(',
        '  fn: T,',
        '  options: UseWebWorkerFnOptions = {},',
        ') {',
        '  const worker = ref<Worker | undefined>()',
        '  const result = ref<ReturnType<T> | undefined>()',
        '  const error = shallowRef<unknown>()',
        '  const workerStatus = ref<UseWebWorkerFnReturn["workerStatus"]>("PENDING")',
        '  ...',
        '}',
        '```',
      ].join('\n');
      return [
        { status: 'running', input: csInput, output: '' },
        { status: 'completed', delayMs: 420, input: csInput, output: csOutput },
      ];
    }
    case 'edit': {
      const editInput = {
        filePath: `${basePath.replace(/\/+$/, '')}/app/components/ToolWindow.vue`,
        oldString: 'const showResizer = computed(',
        newString: 'const showResizer = computed<boolean>(',
      };
      const editDiff = [
        'diff --git a/app/components/ToolWindow.vue b/app/components/ToolWindow.vue',
        '--- a/app/components/ToolWindow.vue',
        '+++ b/app/components/ToolWindow.vue',
        '@@ -56,10 +56,12 @@',
        ' <script setup lang="ts">',
        " import { computed, watch } from 'vue';",
        "+import { onMounted, ref } from 'vue';",
        " import CodeContent from './CodeContent.vue';",
        " import PermissionWindow from './PermissionWindow.vue';",
        " import QuestionWindow from './QuestionWindow.vue';",
        " import { type CodeRenderParams, useCodeRender } from '../utils/useCodeRender';",
        ' ',
        " type PermissionReply = 'once' | 'always' | 'reject';",
        ' type QuestionAnswer = string[];',
        ' ',
        ' type ToolWindowEntry = {',
        '   time: number;',
        '   x: number;',
        '   y: number;',
        '   header: string;',
        '   scroll: boolean;',
        '   scrollDistance: number;',
        '   scrollDuration: number;',
        '   html: string;',
        '   content?: string;',
        '   lang?: string;',
        "+  view?: 'normal' | 'diff' | 'hex';",
        '   grepPattern?: string;',
        '-  diffLang?: string;',
        '   grepPattern?: string;',
        '   isWrite: boolean;',
        '   isMessage: boolean;',
        '   isSubagentMessage?: boolean;',
        '   isReasoning?: boolean;',
        '   isShell?: boolean;',
        '   isPermission?: boolean;',
        '   isQuestion?: boolean;',
        "   role?: 'user' | 'assistant';",
        '   toolStatus?: string;',
        '   toolName?: string;',
        '   toolKey?: string;',
        "   toolWrapMode?: 'default' | 'soft';",
        "   toolGutterMode?: 'default' | 'none' | 'grep-source';",
        '   toolGutterLines?: string[];',
        '   messageId?: string;',
        '   sessionId?: string;',
        '   messageAgent?: string;',
        '   messageModel?: string;',
        '   callId?: string;',
        '   contentKey?: string;',
        '   readLineOffset?: number;',
        '   readLineLimit?: number;',
        '   zIndex?: number;',
        '   width?: number;',
        '   height?: number;',
        '   shellId?: string;',
        '   permissionRequest?: { id: string };',
        '   questionRequest?: { id: string };',
        ' };',
        ' ',
        '@@ -130,7 +132,7 @@',
        '   const entry = computed(() => props.entry);',
        ' ',
        '-  const showResizer = computed(',
        '+  const showResizer = computed<boolean>(',
        '     () =>',
        '       entry.value.isReasoning ||',
        '       entry.value.isSubagentMessage ||',
        '       entry.value.isShell ||',
        '       entry.value.isPermission ||',
        '       entry.value.isQuestion,',
        '   );',
        ' ',
        '@@ -194,8 +196,12 @@',
        '   const isDiff = computed(() => entry.value.view === \'diff\' && !!entry.value.content);',
        ' ',
        "-  const contentVariant = computed<'code' | 'diff' | 'message'>(() => {",
        "+  const contentVariant = computed<'code' | 'diff' | 'message' | 'log'>(() => {",
        '     if (isDiff.value) return \'diff\';',
        '     if (entry.value.isMessage) return \'message\';',
        "+    if (entry.value.toolName === 'bash') return 'log';",
        '     return \'code\';',
        '   });',
      ].join('\n');
      const editMeta = { diff: editDiff };
      return [
        { status: 'running', input: editInput, metadata: editMeta, output: editDiff },
        { status: 'completed', delayMs: 420, input: editInput, metadata: editMeta, output: 'Applied edit' },
      ];
    }
    case 'glob': {
      const globInput = { pattern: '**/*.{vue,ts}', path: basePath };
      const globOutput = [
        `${basePath}/app/App.vue`,
        `${basePath}/app/main.ts`,
        `${basePath}/app/env.d.ts`,
        `${basePath}/app/components/CodeContent.vue`,
        `${basePath}/app/components/Dropdown.vue`,
        `${basePath}/app/components/Dropdown/Item.vue`,
        `${basePath}/app/components/FileViewerWindow.vue`,
        `${basePath}/app/components/InputPanel.vue`,
        `${basePath}/app/components/MessageViewer.vue`,
        `${basePath}/app/components/OutputPanel.vue`,
        `${basePath}/app/components/PermissionWindow.vue`,
        `${basePath}/app/components/ProjectPicker.vue`,
        `${basePath}/app/components/QuestionWindow.vue`,
        `${basePath}/app/components/SidePanel.vue`,
        `${basePath}/app/components/TodoList.vue`,
        `${basePath}/app/components/TodoPanel.vue`,
        `${basePath}/app/components/ToolWindow.vue`,
        `${basePath}/app/components/TopPanel.vue`,
        `${basePath}/app/components/TreeView.vue`,
        `${basePath}/app/composables/useOutputPanelFollow.ts`,
        `${basePath}/app/utils/opencode.ts`,
        `${basePath}/app/utils/theme.ts`,
        `${basePath}/app/utils/useCodeRender.ts`,
        `${basePath}/app/utils/workerRenderer.ts`,
        `${basePath}/app/workers/render-worker.ts`,
        `${basePath}/server/dev.ts`,
        `${basePath}/server/proxy.ts`,
        `${basePath}/vite.config.ts`,
      ].join('\n');
      return [
        { status: 'running', input: globInput, output: '' },
        { status: 'completed', delayMs: 360, input: globInput, output: globOutput },
      ];
    }
    case 'grep': {
      const grepInput = { pattern: 'useCodeRender|renderWorkerHtml|CodeRenderParams', path: `${basePath}/app`, include: '*.{vue,ts}' };
      const grepOutput = [
        `Found 18 matches in 7 files`,
        ``,
        `${basePath}/app/utils/useCodeRender.ts:`,
        `  Line 4:   export type CodeRenderParams = {`,
        `  Line 22:  export function useCodeRender(`,
        `  Line 23:    params: WatchSource<CodeRenderParams | null>,`,
        `  Line 38:    renderWorkerHtml({`,
        ``,
        `${basePath}/app/utils/workerRenderer.ts:`,
        `  Line 47:  export function renderWorkerHtml(payload: RenderRequest) {`,
        `  Line 49:    return new Promise<string>((resolve, reject) => {`,
        ``,
        `${basePath}/app/components/ToolWindow.vue:`,
        `  Line 61:  import { type CodeRenderParams, useCodeRender } from '../utils/useCodeRender';`,
        `  Line 213: const renderParams = computed<CodeRenderParams | null>(() => {`,
        `  Line 247: const { html: renderedHtml } = useCodeRender(renderParams);`,
        ``,
        `${basePath}/app/components/FileViewerWindow.vue:`,
        `  Line 41:  import { type CodeRenderParams, useCodeRender } from '../utils/useCodeRender';`,
        `  Line 95:  const renderParams = computed<CodeRenderParams | null>(() => {`,
        `  Line 130: const { html: renderedHtml } = useCodeRender(renderParams);`,
        ``,
        `${basePath}/app/App.vue:`,
        `  Line 2098: function handleToolWindowRendered(entry: FileReadEntry) {`,
        `  Line 2107: function scheduleToolScrollAnimation(toolKey: string) {`,
        `  Line 5011: function injectSyntheticEvent(part: Record<string, unknown>) {`,
        `  Line 8888: function upsertToolEntry(entry: {`,
        ``,
        `${basePath}/app/workers/render-worker.ts:`,
        `  Line 601: async function renderCodeHtml(request: RenderRequest) {`,
        `  Line 630: function renderRequest(request: RenderRequest): Promise<string> {`,
        `  Line 667: self.onmessage = (event: MessageEvent<RenderRequest>) => {`,
        ``,
        `${basePath}/app/main.ts:`,
        `  Line 3:   import App from './App.vue';`,
        `  Line 5:   createApp(App).mount('#app');`,
      ].join('\n');
      return [
        { status: 'running', input: grepInput, output: '' },
        { status: 'completed', delayMs: 380, input: grepInput, output: grepOutput },
      ];
    }
    case 'list': {
      const listInput = { path: basePath };
      const listOutput = [
        '.',
        '├── package.json',
        '├── tsconfig.json',
        '├── vite.config.ts',
        '├── index.html',
        '├── app',
        '│   ├── App.vue',
        '│   ├── main.ts',
        '│   ├── components',
        '│   │   ├── CodeContent.vue',
        '│   │   ├── Dropdown.vue',
        '│   │   ├── Dropdown',
        '│   │   │   └── Item.vue',
        '│   │   ├── FileViewerWindow.vue',
        '│   │   ├── InputPanel.vue',
        '│   │   ├── MessageViewer.vue',
        '│   │   ├── OutputPanel.vue',
        '│   │   ├── PermissionWindow.vue',
        '│   │   ├── ProjectPicker.vue',
        '│   │   ├── QuestionWindow.vue',
        '│   │   ├── SidePanel.vue',
        '│   │   ├── TodoList.vue',
        '│   │   ├── TodoPanel.vue',
        '│   │   ├── ToolWindow.vue',
        '│   │   ├── TopPanel.vue',
        '│   │   └── TreeView.vue',
        '│   ├── composables',
        '│   │   └── useOutputPanelFollow.ts',
        '│   ├── utils',
        '│   │   ├── opencode.ts',
        '│   │   ├── theme.ts',
        '│   │   ├── useCodeRender.ts',
        '│   │   └── workerRenderer.ts',
        '│   └── workers',
        '│       └── render-worker.ts',
        '├── server',
        '│   └── dev.ts',
        '└── dist',
        '    └── ...',
      ].join('\n');
      return [
        { status: 'running', input: listInput, output: listOutput },
        { status: 'completed', delayMs: 360, input: listInput, output: listOutput },
      ];
    }
    case 'multiedit': {
      const multiEditInput = {
        filePath: `${basePath.replace(/\/+$/, '')}/app/components/FileViewerWindow.vue`,
        edits: [
          { oldString: "import { computed, ref } from 'vue';", newString: "import { computed, ref, watch } from 'vue';" },
          { oldString: 'const entry = computed(() => props.entry);', newString: 'const entry = computed(() => props.entry);\nconst isActive = ref(false);' },
        ],
      };
      const multiDiff1 = [
        'diff --git a/app/components/FileViewerWindow.vue b/app/components/FileViewerWindow.vue',
        '--- a/app/components/FileViewerWindow.vue',
        '+++ b/app/components/FileViewerWindow.vue',
        '@@ -1,36 +1,36 @@',
        ' <template>',
        '   <div class="file-viewer" :style="style" @pointerdown.capture="onFocus">',
        '     <div class="viewer-titlebar" @pointerdown="onDragStart">',
        '       <span class="viewer-title">{{ title }}</span>',
        '       <button',
        '         type="button"',
        '         class="viewer-close"',
        '         aria-label="Close file viewer"',
        '         @pointerdown.stop',
        '         @click.stop="onClose"',
        '       >',
        '         \u00d7',
        '       </button>',
        '     </div>',
        '     <div v-if="entry.diffTabs && entry.diffTabs.length > 1" class="viewer-tabs">',
        '       <button',
        '         v-for="(tab, i) in entry.diffTabs"',
        '         :key="tab.file"',
        '         type="button"',
        '         class="viewer-tab"',
        '         :class="{ active: i === activeTabIndex }"',
        '         @click="activeTabIndex = i"',
        '       >',
        '         {{ basename(tab.file) }}',
        '       </button>',
        '     </div>',
        '     <div class="viewer-body" @scroll="onFloatingScroll" @wheel="onFloatingWheel">',
        '-      <CodeContent',
        '+      <div v-if="showLoading" class="viewer-loading">Loading\u2026</div>',
        '+      <CodeContent',
        '+        v-else',
        '         :html="renderedHtml || entry.html"',
        "         :variant=\"entry.isDiff ? 'diff' : entry.isBinary ? 'binary' : 'code'\"",
        "         :gutter-mode=\"entry.isDiff ? 'double' : 'single'\"",
        '       />',
        '     </div>',
        '   </div>',
        ' </template>',
        ' ',
        ' <script setup lang="ts">',
        "-import { computed, ref } from 'vue';",
        "+import { computed, ref, watch } from 'vue';",
        " import CodeContent from './CodeContent.vue';",
        " import { type CodeRenderParams, useCodeRender } from '../utils/useCodeRender';",
        ' ',
      ].join('\n');
      const multiDiff2 = [
        'diff --git a/app/components/FileViewerWindow.vue b/app/components/FileViewerWindow.vue',
        '--- a/app/components/FileViewerWindow.vue',
        '+++ b/app/components/FileViewerWindow.vue',
        '@@ -62,6 +62,7 @@',
        ' const props = defineProps<{',
        '   entry: ViewerEntry;',
        '   title: string;',
        '   onFocusEntry: (entry: ViewerEntry, event: PointerEvent) => void;',
        '   onDragEntry: (entry: ViewerEntry, event: PointerEvent) => void;',
        '   onResizeEntry: (entry: ViewerEntry, event: PointerEvent) => void;',
        '   onFloatingScrollEntry: (entry: ViewerEntry, event: Event) => void;',
        '   onFloatingWheelEntry: (entry: ViewerEntry, event: WheelEvent) => void;',
        '   onCloseEntry: (entry: ViewerEntry) => void;',
        '   theme: string;',
        ' }>();',
        ' ',
        ' const entry = computed(() => props.entry);',
        '+const isActive = ref(false);',
        ' ',
        ' const activeTabIndex = ref(0);',
        ' ',
        ' const activeDiffCode = computed(() => {',
        '   const tabs = props.entry.diffTabs;',
        "   if (!tabs || tabs.length === 0) return props.entry.diffCode ?? '';",
        "   return tabs[activeTabIndex.value]?.before ?? '';",
        ' });',
        ' ',
        ' const activeDiffAfter = computed(() => {',
        '   const tabs = props.entry.diffTabs;',
        '   if (!tabs || tabs.length === 0) return props.entry.diffAfter;',
        '   return tabs[activeTabIndex.value]?.after;',
        ' });',
        ' ',
        ' const activeDiffLang = computed(() => {',
        '   const tabs = props.entry.diffTabs;',
        "   if (!tabs || tabs.length === 0) return props.entry.lang ?? 'text';",
        "   const file = tabs[activeTabIndex.value]?.file ?? '';",
        "   const ext = file.split('.').pop() ?? '';",
        '   const langMap: Record<string, string> = {',
        "     ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',",
        "     vue: 'vue', css: 'css', scss: 'scss', html: 'html',",
        "     json: 'json', md: 'markdown', py: 'python', rs: 'rust',",
        '   };',
        "   return langMap[ext] ?? 'text';",
        ' });',
        ' ',
        '+watch(isActive, (val) => {',
        "+  if (val) console.log('FileViewerWindow activated');",
        '+});',
      ].join('\n');
      const multiMeta = { results: [{ diff: multiDiff1 }, { diff: multiDiff2 }] };
      return [
        { status: 'running', input: multiEditInput, output: 'Applying 2 edits...' },
        { status: 'completed', delayMs: 430, input: multiEditInput, metadata: multiMeta, output: 'Applied 2 edits' },
      ];
    }
    case 'plan_enter':
      return [
        {
          status: 'completed',
          input: {},
          output: 'Switched to plan agent',
        },
      ];
    case 'plan_exit':
      return [
        {
          status: 'completed',
          input: {},
          output: 'Switched to build agent',
        },
      ];
    case 'read':
      return [
        {
          status: 'running',
          input: { filePath: sampleFile, offset: 0, limit: 120 },
          output: debugReadOutput,
        },
        {
          status: 'completed',
          delayMs: 380,
          input: { filePath: sampleFile, offset: 0, limit: 120 },
          output: debugReadOutput,
        },
      ];
    case 'task': {
      const taskInput = { description: 'Analyze rendering pipeline and worker usage' };
      const taskOutput = [
        'task_id: task_debug_1',
        '<task_result>',
        '## Rendering Pipeline Analysis',
        '',
        '### Architecture',
        'The app uses a Web Worker (`render-worker.ts`) for syntax highlighting via Shiki.',
        'The pipeline is: `useCodeRender` composable → `renderWorkerHtml` → Worker → HTML result.',
        '',
        '### Component Usage',
        '',
        '| Component | Render Method | Worker | Notes |',
        '|-----------|--------------|--------|-------|',
        '| ToolWindow.vue | useCodeRender | Yes | Ephemeral, auto-expire, scroll animation |',
        '| FileViewerWindow.vue | useCodeRender | Yes | Persistent, user-opened, Loading state |',
        '| OutputPanel.vue | MessageViewer (v-for) | No | Static HTML from SSE events |',
        '| CodeContent.vue | v-html (display only) | No | Pure CSS, no logic |',
        '',
        '### Key Composable: `useCodeRender`',
        '',
        '- Watches `CodeRenderParams` source reactively',
        '- Sends render requests to Worker with unique IDs',
        '- Cancels stale requests via incrementing `requestId`',
        '- Returns `{ html: Ref<string>, error: Ref<string> }`',
        '',
        '### Recommendations',
        '',
        '1. **Debounce rapid param changes** in `useCodeRender` to avoid Worker flooding',
        '2. **Cache rendered HTML** by content hash to skip redundant renders',
        '3. **Prioritize visible windows** — defer off-screen ToolWindow renders',
        '</task_result>',
      ].join('\n');
      return [
        { status: 'running', input: taskInput, output: taskOutput },
        { status: 'completed', delayMs: 420, input: taskInput, output: taskOutput },
      ];
    }
    case 'webfetch': {
      const webfetchInput = { url: 'https://opencode.ai/docs/server/', format: 'markdown', timeout: 30 };
      const webfetchOutput = [
        '# OpenCode Server API Reference',
        '',
        'The OpenCode server exposes session management APIs, real-time streaming events,',
        'tool execution endpoints, and configuration management.',
        '',
        '## Table of Contents',
        '',
        '- [Authentication](#authentication)',
        '- [Sessions](#sessions)',
        '- [Messages](#messages)',
        '- [Tools](#tools)',
        '- [Streaming](#streaming)',
        '- [Configuration](#configuration)',
        '- [Error Handling](#error-handling)',
        '',
        '## Authentication',
        '',
        'All API requests require a valid API key passed via the `Authorization` header.',
        '',
        '```',
        'Authorization: Bearer <your-api-key>',
        '```',
        '',
        '## Sessions',
        '',
        '### List Sessions',
        '',
        '```',
        'GET /api/sessions',
        '```',
        '',
        '**Query Parameters:**',
        '',
        '| Parameter | Type | Default | Description |',
        '|-----------|------|---------|-------------|',
        '| `limit` | number | 20 | Max sessions to return |',
        '| `offset` | number | 0 | Pagination offset |',
        '| `status` | string | all | Filter: active, archived, deleted |',
        '| `sort` | string | updated_at | Sort field |',
        '| `order` | string | desc | Sort order: asc, desc |',
        '',
        '**Response:**',
        '',
        '```json',
        '{',
        '  "sessions": [',
        '    {',
        '      "id": "ses_abc123",',
        '      "title": "Refactor auth module",',
        '      "created_at": "2026-01-15T10:30:00Z",',
        '      "updated_at": "2026-01-15T14:22:00Z",',
        '      "message_count": 42,',
        '      "status": "active",',
        '      "model": "claude-sonnet-4-20250514",',
        '      "agent": "build"',
        '    }',
        '  ],',
        '  "total": 156,',
        '  "has_more": true',
        '}',
        '```',
        '',
        '### Create Session',
        '',
        '```',
        'POST /api/sessions',
        '```',
        '',
        '**Request Body:**',
        '',
        '```json',
        '{',
        '  "title": "New feature implementation",',
        '  "model": "claude-sonnet-4-20250514",',
        '  "agent": "build",',
        '  "directory": "/home/user/project"',
        '}',
        '```',
        '',
        '### Get Session',
        '',
        '```',
        'GET /api/sessions/:id',
        '```',
        '',
        '### Delete Session',
        '',
        '```',
        'DELETE /api/sessions/:id',
        '```',
        '',
        '## Messages',
        '',
        '### Send Message',
        '',
        '```',
        'POST /api/sessions/:id/message',
        '```',
        '',
        '**Request Body:**',
        '',
        '```json',
        '{',
        '  "parts": [',
        '    { "type": "text", "text": "Fix the login bug in auth.ts" }',
        '  ],',
        '  "attachments": []',
        '}',
        '```',
        '',
        '### Stream Response',
        '',
        'Messages are streamed via Server-Sent Events (SSE):',
        '',
        '```',
        'GET /api/sessions/:id/events',
        '```',
        '',
        '**Event Types:**',
        '',
        '| Event | Description |',
        '|-------|-------------|',
        '| `messageCreated` | New message started |',
        '| `messagePartUpdated` | Part content updated |',
        '| `messageCompleted` | Message finished |',
        '| `toolCallStarted` | Tool execution began |',
        '| `toolCallCompleted` | Tool execution finished |',
        '| `error` | Error occurred |',
        '',
        '## Tools',
        '',
        '### List Available Tools',
        '',
        '```',
        'GET /api/tools',
        '```',
        '',
        '### Execute Tool',
        '',
        '```',
        'POST /api/tools/:name/execute',
        '```',
        '',
        '## Error Handling',
        '',
        'All errors follow the standard format:',
        '',
        '```json',
        '{',
        '  "error": {',
        '    "code": "INVALID_REQUEST",',
        '    "message": "Session not found",',
        '    "details": {}',
        '  }',
        '}',
        '```',
      ].join('\n');
      return [
        { status: 'running', input: webfetchInput, output: '' },
        { status: 'completed', delayMs: 420, input: webfetchInput, output: webfetchOutput },
      ];
    }
    case 'websearch': {
      const websearchInput = { query: 'vue 3 composable best practices 2026' };
      const websearchOutput = [
        '## Search Results (8 sources)',
        '',
        '### 1. Vue.js Official Documentation — Composables',
        '**Source:** https://vuejs.org/guide/reusability/composables.html',
        '',
        'A composable is a function that leverages Vue\'s Composition API to encapsulate',
        'and reuse stateful logic. Composables should:',
        '',
        '- Follow the `use` prefix naming convention (e.g., `useMouse`, `useFetch`)',
        '- Accept ref arguments for reactivity connections',
        '- Return plain refs instead of reactive objects for destructuring compatibility',
        '- Handle cleanup via `onUnmounted` or `watchEffect` auto-cleanup',
        '- Be side-effect free during SSR when possible',
        '',
        '### 2. VueUse — Collection of Essential Composables',
        '**Source:** https://vueuse.org/guide/best-practices.html',
        '',
        'Key patterns from the VueUse ecosystem (200+ composables):',
        '',
        '- **Flexible arguments**: Accept both refs and plain values via `toRef()`',
        '- **Return object, not array**: Unless the composable has ≤2 return values',
        '- **Configurable via options object**: Last parameter should be an options object',
        '- **Cleanup**: Always clean up event listeners, timers, and subscriptions',
        '- **SSR-safe**: Guard browser-only APIs with `typeof window !== "undefined"`',
        '',
        '```typescript',
        '// Good: Flexible input + cleanup',
        'export function useEventListener<E extends keyof WindowEventMap>(',
        '  target: MaybeRefOrGetter<EventTarget>,',
        '  event: E,',
        '  handler: (evt: WindowEventMap[E]) => void,',
        '  options?: AddEventListenerOptions,',
        ') {',
        '  const cleanup = () => { /* ... */ }',
        '  onScopeDispose(cleanup)',
        '  return cleanup',
        '}',
        '```',
        '',
        '### 3. Anthony Fu — Patterns for Composable Design',
        '**Source:** https://antfu.me/posts/composable-patterns',
        '',
        '- **Unref pattern**: Use `toValue()` (Vue 3.3+) to support both ref and getter inputs',
        '- **Shared state**: Use `createSharedComposable()` for singleton composables',
        '- **Lifecycle-less**: Design composables to work outside component setup when possible',
        '- **Async composables**: Return `{ data, error, isLoading }` pattern consistently',
        '- **MaybeRefOrGetter**: The universal input type for maximum flexibility',
        '',
        '### 4. Michael Thiessen — Advanced Composable Patterns',
        '**Source:** https://michaelthiessen.com/advanced-composable-patterns',
        '',
        'Four categories of composables:',
        '',
        '1. **State composables**: Manage reactive state (`useCounter`, `useToggle`)',
        '2. **Action composables**: Wrap side effects (`useFetch`, `useClipboard`)',
        '3. **UI composables**: Encapsulate UI logic (`useIntersectionObserver`, `useDraggable`)',
        '4. **Integration composables**: Bridge external libraries (`useAxios`, `usePinia`)',
        '',
        'Avoid these anti-patterns:',
        '- Composable doing too many things (violates SRP)',
        '- Deeply nested composable chains (hard to debug)',
        '- Tight coupling to specific component structure',
        '- Forgetting to handle the error state',
        '',
        '### 5. Vue RFC — Reactivity Transform (Deprecated)',
        '**Source:** https://github.com/vuejs/rfcs/discussions/369',
        '',
        'The `$ref()` / `$computed()` syntax sugar was officially deprecated in Vue 3.3.',
        'Stick with standard `ref()` and `computed()` APIs.',
        '',
        '### 6. Nuxt Documentation — Server Composables',
        '**Source:** https://nuxt.com/docs/guide/directory-structure/composables',
        '',
        '- Composables in `composables/` directory are auto-imported',
        '- Server-only composables should be placed in `server/utils/`',
        '- Use `useAsyncData` over raw `useFetch` for SSR hydration safety',
        '- Shared state must account for request isolation in SSR context',
        '',
        '### 7. Eduardo San Martin Morote — Pinia vs Composables',
        '**Source:** https://esm.dev/posts/pinia-vs-composables',
        '',
        'When to use Pinia store vs composable:',
        '',
        '| Use Case | Composable | Pinia |',
        '|----------|-----------|-------|',
        '| Component-scoped state | ✅ | ❌ |',
        '| Global singleton state | ⚠️ | ✅ |',
        '| DevTools inspection | ❌ | ✅ |',
        '| SSR state serialization | ❌ | ✅ |',
        '| Time-travel debugging | ❌ | ✅ |',
        '| Reusable, non-global logic | ✅ | ❌ |',
        '',
        '### 8. Vue 3.5 — New Composable Utilities',
        '**Source:** https://blog.vuejs.org/posts/vue-3-5',
        '',
        'New APIs relevant to composable design in Vue 3.5:',
        '',
        '- `useTemplateRef()` — Type-safe template ref access',
        '- `useId()` — SSR-stable unique ID generation',
        '- `onWatcherCleanup()` — Cleanup within watch callbacks',
        '- Reactive props destructure — Stable in 3.5, replaces `toRefs(props)`',
        '- Deferred teleport — Enables composables that manage teleported content',
      ].join('\n');
      return [
        { status: 'running', input: websearchInput, output: '' },
        { status: 'completed', delayMs: 430, input: websearchInput, output: websearchOutput },
      ];
    }
    case 'write': {
      const writeContent = [
        "import RenderWorker from '../workers/render-worker?worker';",
        '',
        'type RenderRequest = {',
        '  id: string;',
        '  code: string;',
        '  patch?: string;',
        '  after?: string;',
        '  lang: string;',
        '  theme: string;',
        "  gutterMode?: 'none' | 'single' | 'double';",
        '  gutterLines?: string[];',
        '  grepPattern?: string;',
        '  lineOffset?: number;',
        '  lineLimit?: number;',
        '};',
        '',
        'type RenderResponse =',
        '  | { id: string; ok: true; html: string }',
        '  | { id: string; ok: false; error: string };',
        '',
        'type PendingEntry = {',
        '  resolve: (value: string) => void;',
        '  reject: (reason: Error) => void;',
        '};',
        '',
        'let renderWorker: Worker | null = null;',
        'const pending = new Map<string, PendingEntry>();',
        '',
        'function getWorker() {',
        '  if (renderWorker) return renderWorker;',
        '  renderWorker = new RenderWorker();',
        '  renderWorker.onmessage = (event: MessageEvent<RenderResponse>) => {',
        '    const data = event.data;',
        '    const entry = pending.get(data.id);',
        '    if (!entry) return;',
        '    pending.delete(data.id);',
        '    if (data.ok) entry.resolve(data.html);',
        "    else entry.reject(new Error(data.error || 'Render failed'));",
        '  };',
        '  renderWorker.onerror = (error) => {',
        '    pending.forEach((entry) => entry.reject(new Error(String(error))));',
        '    pending.clear();',
        '  };',
        '  return renderWorker;',
        '}',
        '',
        'export function renderWorkerHtml(payload: RenderRequest) {',
        '  const id = payload.id;',
        '  return new Promise<string>((resolve, reject) => {',
        '    pending.set(id, { resolve, reject });',
        '    getWorker().postMessage(payload);',
        '  });',
        '}',
      ].join('\n');
      const writeInput = { filePath: sampleAltFile, content: writeContent };
      return [
        { status: 'running', input: writeInput, output: writeContent },
        { status: 'completed', delayMs: 360, input: writeInput, output: writeContent },
      ];
    }
    default:
      return null;
  }
}

function injectSyntheticEvent(part: Record<string, unknown>) {
  const eventSource = src.value;
  if (!eventSource) return;
  const payload = {
    type: 'messagePartUpdated',
    payload: {
      properties: {
        part,
      },
    },
  };
  const event = new MessageEvent('message', {
    data: JSON.stringify(payload),
  });
  eventSource.dispatchEvent(event);
}

function runDebugTool(tool: string) {
  const normalized = tool.trim().toLowerCase();
  if (!normalized || normalized === 'help') {
    const tools = Array.from(TOOL_WINDOW_SUPPORTED.values()).join(', ');
    return { ok: true, message: `Debug tools: ${tools}, all` };
  }

  const toolsToRun =
    normalized === 'all' ? Array.from(TOOL_WINDOW_SUPPORTED.values()) : [normalized];

  // Accumulate offset across all tools so events are staggered sequentially.
  const INTER_TOOL_GAP_MS = 800;
  let offset = 0;
  const sessionId = selectedSessionId.value || 'ses_debug';
  const timerId = Date.now();

  for (const toolName of toolsToRun) {
    const events = buildDebugToolEvents(toolName);
    if (!events) {
      return { ok: false, message: `Unknown debug tool: ${toolName}` };
    }
    const baseCallId = `debug:${toolName}:${timerId}:${Math.random().toString(36).slice(2, 8)}`;
    events.forEach((event, index) => {
      const delay = Math.max(0, event.delayMs ?? (index === 0 ? 0 : 350));
      offset += delay;
      const scheduleAt = offset;
      const effectiveToolName = event.toolName ?? toolName;
      const callId = event.callIdSuffix ? `${baseCallId}:${event.callIdSuffix}` : baseCallId;
      window.setTimeout(() => {
        injectSyntheticEvent({
          type: 'tool',
          tool: effectiveToolName,
          callID: callId,
          sessionID: sessionId,
          state: {
            status: event.status,
            input: event.input ?? {},
            output: event.output,
            metadata: event.metadata,
            error: event.error,
          },
        });
      }, scheduleAt);
    });
    // Add gap between tools when running multiple
    if (toolsToRun.length > 1) offset += INTER_TOOL_GAP_MS;
  }

  return {
    ok: true,
    message:
      normalized === 'all'
        ? `Queued debug events for ${TOOL_WINDOW_SUPPORTED.size} tools (total ${Math.ceil(offset / 1000)}s).`
        : `Queued debug events for ${normalized}.`,
  };
}

async function sendCommand(sessionId: string, command: CommandInfo, commandArgs: string) {
  const directory = activeDirectory.value.trim();
  await opencodeApi.sendCommand(OPENCODE_BASE_URL, sessionId, {
    directory: directory || undefined,
    command: command.name,
    arguments: commandArgs,
    agent: command.agent || selectedMode.value,
    model: command.model || selectedModel.value,
    variant: selectedThinking.value,
  });
}

async function sendMessage() {
  if (!canSend.value) return;
  const text = messageInput.value.trim();
  const hasText = text.length > 0;
  const hasAttachments = attachments.value.length > 0;
  let sessionId = selectedSessionId.value;
  if ((!hasText && !hasAttachments) || !sessionId) return;
  if (
    !filteredSessions.value.some((session) => session.id === sessionId)
  ) {
    const fallbackId = pickPreferredSessionId(filteredSessions.value);
    const fallback = fallbackId
      ? filteredSessions.value.find((session) => session.id === fallbackId)
      : filteredSessions.value[0];
    if (!fallback) {
      sendStatus.value = 'No session selected.';
      return;
    }
    selectedSessionId.value = fallback.id;
    sessionId = fallback.id;
  }
  const slash = hasText ? parseSlashCommand(text) : null;
  const commandMatch = slash ? findCommandByName(slash.name) : null;
  const selectedInfo = modelOptions.value.find((model) => model.id === selectedModel.value);
  if (hasText) {
    recentUserInputs.push({ text, time: Date.now() });
    while (recentUserInputs.length > 20) recentUserInputs.shift();
  }
  messageInput.value = '';
  resumeFollow();
  isSending.value = true;
  sendStatus.value = 'Sending...';
  try {
    if (slash && slash.name.toLowerCase() === 'shell') {
      await openShellFromInput(slash.arguments ?? '');
      sendStatus.value = 'Shell ready.';
      clearComposerDraftForCurrentContext();
      return;
    }
    if (slash && slash.name.toLowerCase() === 'debug') {
      const debugResult = runDebugTool(slash.arguments ?? 'list');
      sendStatus.value = debugResult.message;
      clearComposerDraftForCurrentContext();
      return;
    }
    if (slash && commandMatch) {
      await sendCommand(sessionId, commandMatch, slash.arguments ?? '');
      sendStatus.value = 'Sent.';
      clearComposerDraftForCurrentContext();
      return;
    }
    const directory = requireSelectedWorktree('send');
    if (!directory) return;
    const parts = [] as Array<Record<string, unknown>>;
    if (hasText) parts.push({ type: 'text', text });
    if (hasAttachments) {
      parts.push(
        ...attachments.value.map((item) => ({
          type: 'file',
          mime: item.mime,
          url: item.dataUrl,
          filename: item.filename,
        })),
      );
    }
    await opencodeApi.sendPromptAsync(OPENCODE_BASE_URL, sessionId, {
      directory,
      agent: selectedMode.value,
      model: {
        providerID: selectedInfo?.providerID,
        modelID: selectedModel.value,
      },
      variant: selectedThinking.value,
      parts,
    });
    sendStatus.value = 'Sent.';
    attachments.value = [];
    clearComposerDraftForCurrentContext();
  } catch (error) {
    sendStatus.value = `Send failed: ${toErrorMessage(error)}`;
  } finally {
    isSending.value = false;
  }
}

async function abortSession() {
  const sessionId = selectedSessionId.value;
  if (!sessionId || isAborting.value) return;
  isAborting.value = true;
  sendStatus.value = 'Stopping...';
  try {
    const directory = activeDirectory.value.trim();
    const busyDescendants = busyDescendantSessionIds.value;
    const abortPromises = [
      opencodeApi.abortSession(OPENCODE_BASE_URL, sessionId, directory || undefined),
      ...busyDescendants.map((sid) =>
        opencodeApi.abortSession(OPENCODE_BASE_URL, sid, directory || undefined).catch(() => {}),
      ),
    ];
    await Promise.all(abortPromises);
    sendStatus.value = 'Stopped.';
  } catch (error) {
    sendStatus.value = `Stop failed: ${toErrorMessage(error)}`;
  } finally {
    isAborting.value = false;
  }
}

watch(
  worktrees,
  (list) => {
    resolveWorktreeMetadata(Array.isArray(list) ? list : []);
  },
  { immediate: true },
);

watch(
  selectedProjectDirectory,
  (directory, previous) => {
    if (directory === previous) return;
    if (typeof previous === 'undefined') return;
    if (isBootstrapping.value) return;
    selectedWorktreeDir.value = '';
    selectedSessionId.value = '';
    selectedProjectId.value = '';
    worktrees.value = [];
    clearSessions();
    void fetchWorktrees(directory || undefined);
  },
  { immediate: true },
);

watch(
  worktrees,
  (list) => {
    if (isBootstrapping.value) return;
    if (list.length === 0) return;
    if (selectedWorktreeDir.value) return;
    selectedWorktreeDir.value = list[0] ?? '';
  },
  { immediate: true },
);


watch(
  selectedWorktreeDir,
  (value, previous) => {
    if (value === previous) return;
    if (typeof previous === 'undefined') return;
    if (isBootstrapping.value) return;
    selectedSessionId.value = '';
    selectedProjectId.value = '';
    clearSessions();
    if (!value) return;
    void fetchCommands(value);
    void refreshSessionsForDirectory(value);
    void fetchSessionStatus(value || undefined);
  },
  { immediate: true },
);

watch(
  filteredSessions,
  () => {
    if (isBootstrapping.value) return;
    if (filteredSessions.value.length === 0) return;
    const preferredId = pickPreferredSessionId(filteredSessions.value);
    if (!selectedSessionId.value) {
      if (preferredId) selectedSessionId.value = preferredId;
      return;
    }
    const isValid = filteredSessions.value.some(
      (session) => session.id === selectedSessionId.value,
    );
    if (!isValid) {
      if (preferredId) selectedSessionId.value = preferredId;
    }
  },
  { immediate: true },
);

function reloadSelectedSessionState() {
  const selected = sessions.value.find((session) => session.id === selectedSessionId.value);
  if (selected?.projectID) selectedProjectId.value = selected.projectID;
  disposeShellWindows({ preserve: true });
  queue.value = [];
  fileViewerQueue.value = [];
  messageIndexById.clear();
  toolIndexByCallId.clear();
  messageContentById.clear();
  messagePartsById.clear();
  messagePartOrderById.clear();
  messageSummaryTitleById.clear();
  messageDiffsByKey.clear();
  messageAttachmentsById.clear();
  reasoningTitleBySessionId.clear();
  activeReasoningMessageIdByKey.clear();
  finishedReasoningByKey.clear();
  subagentSessionExpiry.clear();
  retryStatus.value = null;
  todosBySessionId.value = {};
  todoLoadingBySessionId.value = {};
  todoErrorBySessionId.value = {};
  if (selectedSessionId.value) {
    void fetchHistory(selectedSessionId.value);
    void restoreShellSessions(selectedSessionId.value);
    void reloadTodosForAllowedSessions();
    void refreshSessionDiff();
    const directory = activeDirectory.value || undefined;
    void fetchPendingPermissions(directory);
    void fetchPendingQuestions(directory);
  }
}

watch(selectedSessionId, reloadSelectedSessionState, { immediate: true });

watch(
  [selectedProjectId, selectedSessionId],
  ([projectId, sessionId], previous) => {
    const [prevProjectId, prevSessionId] = previous ?? ['', ''];
    const contextKey = buildComposerContextKey(projectId, sessionId);
    const prevContextKey = buildComposerContextKey(prevProjectId ?? '', prevSessionId ?? '');
    if (contextKey === prevContextKey) return;
    clearComposerInputState();
    if (!contextKey) return;
    restoreComposerDraftForContext(contextKey);
  },
  { immediate: true },
);

watch(
  allowedSessionIds,
  () => {
    prunePermissionEntries();
    pruneQuestionEntries();
  },
  { immediate: true },
);

watch(
  [selectedProjectId, selectedSessionId],
  ([projectId, sessionId]) => {
    if (projectId && sessionId) {
      replaceQuerySelection(projectId, sessionId);
      return;
    }
    replaceQuerySelection('', '');
  },
  { immediate: true },
);

watch(
  isThinking,
  (active) => {
    if (active) return;
    if (!selectedSessionId.value) return;
    updateReasoningExpiry(selectedSessionId.value, 'idle');
  },
  { immediate: true },
);

watch(selectedModel, () => {
  const selectedInfo = modelOptions.value.find((model) => model.id === selectedModel.value);
  const nextThinkingOptions = buildThinkingOptions(selectedInfo?.variants);
  const sameThinking =
    nextThinkingOptions.length === thinkingOptions.value.length &&
    nextThinkingOptions.every((value, index) => value === thinkingOptions.value[index]);
  if (!sameThinking) thinkingOptions.value = nextThinkingOptions;
  if (selectedThinking.value === undefined || !nextThinkingOptions.includes(selectedThinking.value)) {
    selectedThinking.value = nextThinkingOptions[0];
  }
});

watch(activeDirectory, (directory) => {
  if (isBootstrapping.value) return;
  const activePath = directory || undefined;
  if (!activePath) {
    treeNodes.value = [];
    expandedTreePathSet.value = new Set();
    selectedTreePath.value = '';
    updateSessionDiffState([]);
    return;
  }
  if (selectedWorktreeDir.value && activePath !== selectedWorktreeDir.value) return;
  void fetchCommands(activePath);
  void reloadTodosForAllowedSessions();
  void loadTreePath('.');
  void refreshSessionDiff();
});

watch(sidePanelCollapsed, () => {
  persistSidePanelCollapsed(sidePanelCollapsed.value);
});

watch(sidePanelActiveTab, () => {
  persistSidePanelTab(sidePanelActiveTab.value);
});

watch(
  allowedSessionIds,
  () => {
    void reloadTodosForAllowedSessions();
  },
  { immediate: true },
);

function log(...args: any) {
  const formatted = args.map((value) => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
  console.log('[app]', ...formatted);
}

const shikiTheme = ref('github-dark');
setInterval(() => {
  const now = Date.now();
  messageIndexById.clear();
  toolIndexByCallId.clear();
  messageContentById.clear();
  const survivingParts = new Map<string, Map<string, string>>();
  const survivingPartOrder = new Map<string, string[]>();
  runningToolIds.clear();
  queue.value = queue.value.filter((entry) => {
    if (entry.isMessage) {
      if (entry.isReasoning) return entry.expiresAt > now;
      if (entry.isSubagentMessage) return entry.expiresAt > now;
      return true;
    }
    return entry.expiresAt > now;
  });
  queue.value.forEach((entry, index) => {
    if (entry.messageId) {
      const messageKey = buildMessageKey(entry.messageId, entry.sessionId);
      messageIndexById.set(messageKey, index);
      if (entry.isRound && entry.roundMessages) {
        entry.roundMessages.forEach((roundMessage) => {
          if (!roundMessage.messageId) return;
          const childKey = buildMessageKey(roundMessage.messageId, entry.sessionId);
          messageIndexById.set(childKey, index);
        });
      }
    }
    if (entry.callId) toolIndexByCallId.set(entry.callId, index);
    if (entry.isMessage && entry.messageId) {
      const messageKey = buildMessageKey(entry.messageId, entry.sessionId);
      messageContentById.set(messageKey, entry.content);
      const existingParts = messagePartsById.get(messageKey);
      const existingOrder = messagePartOrderById.get(messageKey);
      if (existingParts) survivingParts.set(messageKey, existingParts);
      if (existingOrder) survivingPartOrder.set(messageKey, existingOrder);
    }
    if (entry.callId && entry.toolStatus === 'running') runningToolIds.add(entry.callId);
  });
  messagePartsById.clear();
  messagePartOrderById.clear();
  survivingParts.forEach((parts, key) => messagePartsById.set(key, parts));
  survivingPartOrder.forEach((order, key) => messagePartOrderById.set(key, order));
}, 100);

watch(
  () => queue.value.filter((entry) => entry.isMessage && !entry.isSubagentMessage).length,
  () => {
    nextTick(() => {
      if (!isFollowing.value) return;
      scrollToBottom();
      updateFollowState();
    });
  },
);

const FILE_READ_EVENT_TYPES = new Set([
  'file.read',
  'file_read',
  'fileRead',
  'read_file',
  'readFile',
  'FileRead',
  'file:read',
  'session.diff',
  'session_diff',
  'sessionDiff',
  'SessionDiff',
  'session:diff',
]);

const FILE_WRITE_EVENT_TYPES = new Set([
  'file.write',
  'file_write',
  'fileWrite',
  'write_file',
  'writeFile',
  'FileWrite',
  'file:write',
  'session.write',
  'session_write',
  'sessionWrite',
  'session:write',
]);

const MESSAGE_EVENT_TYPES = new Set([
  'message',
  'session.message',
  'session_message',
  'sessionMessage',
  'message:delta',
  'message.delta',
  'message_delta',
  'message.updated',
  'message_updated',
  'messageUpdated',
  'message.part.updated',
  'message_part_updated',
  'messagePartUpdated',
]);

function parsePayload(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function resolveEventType(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return eventType;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  return (
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType
  );
}

function normalizeEventType(type: string) {
  return type.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSessionDeleteEvent(type?: string) {
  if (!type) return false;
  const normalized = normalizeEventType(type);
  return normalized === 'sessiondeleted' || normalized === 'sessiondelete';
}

function matchesSelectedProject(sessionInfo: SessionInfo) {
  const selectedProject = selectedProjectId.value;
  if (!selectedProject) return true;
  if (!sessionInfo.projectID) return true;
  return sessionInfo.projectID === selectedProject;
}

function matchesSelectedWorktree(sessionInfo: SessionInfo) {
  const directory = selectedWorktreeDir.value.trim() || selectedProjectDirectory.value.trim();
  if (!directory) return true;
  if (sessionInfo.directory && sessionInfo.directory !== directory) return false;
  return true;
}

const SESSION_ID_KEYS = new Set(['sessionID', 'sessionId', 'session_id']);

function extractSessionId(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined;
  const queue: Record<string, unknown>[] = [payload as Record<string, unknown>];
  const visited = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const [key, value] of Object.entries(current)) {
      if (SESSION_ID_KEYS.has(key) && typeof value === 'string' && value.startsWith('ses_')) {
        return value;
      }
      if (value && typeof value === 'object') {
        queue.push(value as Record<string, unknown>);
      }
    }
  }
  return undefined;
}

function formatToolValue(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractToolOutputText(output: unknown) {
  if (output === undefined) return undefined;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const outputRecord = output as Record<string, unknown>;
    const outputContent =
      (outputRecord.content as string | undefined) ??
      (outputRecord.text as string | undefined) ??
      (outputRecord.body as string | undefined) ??
      (outputRecord.result as string | undefined);
    if (typeof outputContent === 'string') return outputContent;
    const stdout = outputRecord.stdout;
    const stderr = outputRecord.stderr;
    const parts: string[] = [];
    if (typeof stdout === 'string' && stdout.length > 0) parts.push(stdout);
    if (typeof stderr === 'string' && stderr.length > 0) parts.push(stderr);
    if (parts.length > 0) return parts.join('\n');
  }
  return formatToolValue(output);
}

function parsePermissionRequest(value: unknown, fallbackSessionId?: string): PermissionRequest | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id =
    (typeof record.id === 'string' && record.id) ||
    (typeof record.permissionID === 'string' && record.permissionID) ||
    (typeof record.requestID === 'string' && record.requestID)
      ? String(record.id ?? record.permissionID ?? record.requestID)
      : undefined;
  const sessionID =
    (typeof record.sessionID === 'string' && record.sessionID) ||
    (typeof record.sessionId === 'string' && record.sessionId) ||
    (typeof record.session_id === 'string' && record.session_id) ||
    fallbackSessionId;
  const permission =
    (typeof record.permission === 'string' && record.permission) ||
    (typeof record.type === 'string' && record.type) ||
    (typeof record.title === 'string' && record.title)
      ? String(record.permission ?? record.type ?? record.title)
      : undefined;
  const patterns: string[] = [];
  if (Array.isArray(record.patterns)) {
    patterns.push(...record.patterns.filter((entry) => typeof entry === 'string'));
  }
  const patternValue = record.pattern;
  if (typeof patternValue === 'string') {
    patterns.push(patternValue);
  } else if (Array.isArray(patternValue)) {
    patterns.push(...patternValue.filter((entry) => typeof entry === 'string'));
  }
  const always = Array.isArray(record.always)
    ? record.always.filter((entry) => typeof entry === 'string')
    : [];
  const metadata =
    record.metadata && typeof record.metadata === 'object'
      ? (record.metadata as Record<string, unknown>)
      : {};
  const toolRaw =
    record.tool && typeof record.tool === 'object' ? (record.tool as Record<string, unknown>) : null;
  const toolMessageId =
    (typeof record.messageID === 'string' && record.messageID) ||
    (toolRaw && typeof toolRaw.messageID === 'string' ? toolRaw.messageID : undefined);
  const toolCallId =
    (typeof record.callID === 'string' && record.callID) ||
    (typeof record.callId === 'string' && record.callId) ||
    (toolRaw && typeof toolRaw.callID === 'string' ? toolRaw.callID : undefined);
  if (!id || !sessionID || !permission) return null;
  const tool = toolMessageId && toolCallId ? { messageID: toolMessageId, callID: toolCallId } : undefined;
  return {
    id,
    sessionID,
    permission,
    patterns,
    metadata,
    always,
    tool,
  };
}

function parseQuestionRequest(value: unknown, fallbackSessionId?: string): QuestionRequest | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id =
    (typeof record.id === 'string' && record.id) ||
    (typeof record.questionID === 'string' && record.questionID) ||
    (typeof record.requestID === 'string' && record.requestID)
      ? String(record.id ?? record.questionID ?? record.requestID)
      : undefined;
  const sessionID =
    (typeof record.sessionID === 'string' && record.sessionID) ||
    (typeof record.sessionId === 'string' && record.sessionId) ||
    (typeof record.session_id === 'string' && record.session_id) ||
    fallbackSessionId;
  const questionsRaw = Array.isArray(record.questions)
    ? record.questions
    : Array.isArray(record.items)
      ? record.items
      : [];
  const questions: QuestionInfo[] = questionsRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const info = item as Record<string, unknown>;
      const question = typeof info.question === 'string' ? info.question.trim() : '';
      const header = typeof info.header === 'string' ? info.header.trim() : '';
      const optionsRaw = Array.isArray(info.options) ? info.options : [];
      const options: QuestionOption[] = optionsRaw
        .map((option) => {
          if (!option || typeof option !== 'object') return null;
          const optionInfo = option as Record<string, unknown>;
          const label = typeof optionInfo.label === 'string' ? optionInfo.label.trim() : '';
          const description =
            typeof optionInfo.description === 'string' ? optionInfo.description.trim() : '';
          if (!label || !description) return null;
          return { label, description };
        })
        .filter((entry): entry is QuestionOption => Boolean(entry));
      if (!question || !header || options.length === 0) return null;
      return {
        question,
        header,
        options,
        multiple: info.multiple === true,
        custom: info.custom !== false,
      };
    })
    .filter((entry): entry is QuestionInfo => Boolean(entry));
  const toolRaw =
    record.tool && typeof record.tool === 'object' ? (record.tool as Record<string, unknown>) : null;
  const toolMessageId =
    (typeof record.messageID === 'string' && record.messageID) ||
    (toolRaw && typeof toolRaw.messageID === 'string' ? toolRaw.messageID : undefined);
  const toolCallId =
    (typeof record.callID === 'string' && record.callID) ||
    (typeof record.callId === 'string' && record.callId) ||
    (toolRaw && typeof toolRaw.callID === 'string' ? toolRaw.callID : undefined);
  if (!id || !sessionID || questions.length === 0) return null;
  const tool = toolMessageId && toolCallId ? { messageID: toolMessageId, callID: toolCallId } : undefined;
  return {
    id,
    sessionID,
    questions,
    tool,
  };
}

function extractFileBodyFromReadOutput(output: string) {
  const startTag = '<file>';
  const endTag = '</file>';
  const startIndex = output.indexOf(startTag);
  const endIndex = output.lastIndexOf(endTag);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return null;
  const body = output.slice(startIndex + startTag.length, endIndex);
  const lines = body.split('\n');
  const contentLines: string[] = [];
  for (const line of lines) {
    const match = line.match(/^(\d+)\|(.*)$/);
    if (!match) continue;
    contentLines.push(match[2] ?? '');
  }
  if (contentLines.length === 0) return null;
  return contentLines.join('\n');
}

function parseGrepOutputWithSourceLines(output: string) {
  const lines = output.split('\n');
  const contentLines: string[] = [];
  const gutterLines: string[] = [];
  let hasSourceLine = false;

  for (const line of lines) {
    const match = line.match(/^\s*Line\s+(\d+):\s?(.*)$/);
    if (match) {
      hasSourceLine = true;
      gutterLines.push(match[1] ?? '');
      contentLines.push(match[2] ?? '');
      continue;
    }
    gutterLines.push('');
    contentLines.push(line);
  }

  if (!hasSourceLine) return null;
  return {
    content: contentLines.join('\n'),
    gutterLines,
  };
}

function formatGlobToolTitle(input: Record<string, unknown> | undefined) {
  const pattern = typeof input?.pattern === 'string' ? input.pattern.trim() : '';
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  const include = typeof input?.include === 'string' ? input.include.trim() : '';
  const segments: string[] = [];
  if (pattern) segments.push(pattern);
  if (path) segments.push(`@ ${path}`);
  if (include) segments.push(`include ${include}`);
  const title = segments.join(' ');
  return title || undefined;
}

const TOOL_WINDOW_HIDDEN = new Set(['question', 'todoread', 'todowrite', 'lsp']);
const TOOL_WINDOW_SUPPORTED = new Set([
  'apply_patch',
  'bash',
  'codesearch',
  'edit',
  'glob',
  'grep',
  'list',
  'multiedit',
  'read',
  'task',
  'webfetch',
  'websearch',
  'write',
]);

function shouldRenderToolWindow(tool: string) {
  return !TOOL_WINDOW_HIDDEN.has(tool) && TOOL_WINDOW_SUPPORTED.has(tool);
}

function formatBashToolTitle(
  input: Record<string, unknown> | undefined,
  state: Record<string, unknown> | undefined,
) {
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (description) return description;
  const stateTitle = typeof state?.title === 'string' ? state.title.trim() : '';
  if (stateTitle) return stateTitle;
  const command = typeof input?.command === 'string' ? input.command.trim() : '';
  if (!command) return undefined;
  const firstLine = command.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
}

function formatListToolTitle(input: Record<string, unknown> | undefined) {
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  return path || undefined;
}

function formatReadLikeToolTitle(input: Record<string, unknown> | undefined) {
  const filePath = typeof input?.filePath === 'string' ? input.filePath.trim() : '';
  if (filePath) return filePath;
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  return path || undefined;
}

function resolveReadWritePath(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  state: Record<string, unknown> | undefined,
) {
  const filePath = typeof input?.filePath === 'string' ? input.filePath.trim() : '';
  if (filePath) return filePath;
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  if (path) return path;
  const metadataPath = typeof metadata?.filepath === 'string' ? metadata.filepath.trim() : '';
  if (metadataPath) return metadataPath;
  const title = typeof state?.title === 'string' ? state.title.trim() : '';
  return title || undefined;
}

function resolveReadRange(input: Record<string, unknown> | undefined) {
  const offsetValue = input?.offset;
  const limitValue = input?.limit;
  const offset =
    typeof offsetValue === 'number' && Number.isFinite(offsetValue) && offsetValue >= 0
      ? Math.floor(offsetValue)
      : undefined;
  const limit =
    typeof limitValue === 'number' && Number.isFinite(limitValue) && limitValue > 0
      ? Math.floor(limitValue)
      : undefined;
  return { offset, limit };
}

function isReadWithOffset(entry: { toolName?: string; readOffset?: number }) {
  return entry.toolName === 'read' && typeof entry.readOffset === 'number' && entry.readOffset > 0;
}

async function hydrateAndPopupRead(entry: {
  content: string;
  path?: string;
  isWrite: boolean;
  callId?: string;
  toolStatus?: string;
  toolName?: string;
  toolTitle?: string;
  lang?: string;
  grepPattern?: string;
  wrapMode?: FileReadEntry['toolWrapMode'];
  gutterMode?: FileReadEntry['toolGutterMode'];
  gutterLines?: string[];
  readOffset?: number;
  readLimit?: number;
}, eventType: string) {
  if (!entry.callId || !entry.path) return;
  if (typeof entry.readOffset !== 'number' || entry.readOffset <= 0) return;

  const directory = activeDirectory.value.trim();
  if (!directory) return;

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingReadFullCodeByCallId.set(entry.callId, requestId);

  try {
    const pathCandidates: string[] = [];
    if (entry.path.startsWith('/')) {
      const normalizedDirectory = normalizeDirectory(directory);
      if (entry.path === normalizedDirectory) {
        pathCandidates.push('.');
      } else if (entry.path.startsWith(`${normalizedDirectory}/`)) {
        pathCandidates.push(entry.path.slice(normalizedDirectory.length + 1));
      }
    }
    pathCandidates.push(entry.path);

    let data: FileContentResponse | null = null;
    for (const candidate of pathCandidates) {
      try {
        data = (await opencodeApi.readFileContent(OPENCODE_BASE_URL, {
          directory,
          path: candidate,
        })) as FileContentResponse;
        break;
      } catch {
        continue;
      }
    }

    if (!data) return;
    if (pendingReadFullCodeByCallId.get(entry.callId) !== requestId) return;
    const type = data?.type === 'binary' ? 'binary' : 'text';
    if (type !== 'text') return;
    const encoding = typeof data?.encoding === 'string' ? data.encoding : 'utf-8';
    const rawContent = typeof data?.content === 'string' ? data.content : '';
    const fullCode = encoding === 'base64' ? atob(rawContent) : rawContent;

    upsertToolEntry({
      ...entry,
      content: fullCode,
      toolStatus: 'completed',
    }, eventType);
  } catch {
    return;
  }
}

function formatWebfetchToolTitle(input: Record<string, unknown> | undefined) {
  const url = typeof input?.url === 'string' ? input.url.trim() : '';
  return url || undefined;
}

function formatQueryToolTitle(input: Record<string, unknown> | undefined) {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  return query || undefined;
}

function formatTaskToolOutput(output: string) {
  const taskIdMatch = output.match(/^task_id:\s*(.+)$/m);
  const bodyMatch = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/);
  const parts: string[] = [];
  if (taskIdMatch?.[1]) parts.push(`task_id: ${taskIdMatch[1].trim()}`);
  if (bodyMatch?.[1]) parts.push(bodyMatch[1].trim());
  if (parts.length > 0) return parts.join('\n\n');
  return output;
}


function formatBashToolContent(
  input: Record<string, unknown> | undefined,
  output: string,
  status?: string,
) {
  const command = typeof input?.command === 'string' ? input.command : '';
  const lines: string[] = [];
  if (command.trim()) {
    lines.push(`$ ${command}`);
  }
  if (output.trim()) {
    if (lines.length > 0) lines.push('');
    lines.push(output);
  }
  if (lines.length === 0 && status === 'running') return '$';
  return lines.join('\n');
}

function parsePatchTextBlocks(patchText: string) {
  const lines = patchText.split('\n');
  const blocks: Array<{ path?: string; content: string }> = [];
  let currentPath: string | undefined;
  let currentKind: 'update' | 'add' | 'delete' | undefined;
  let currentLines: string[] = [];

  const pushCurrent = () => {
    if (!currentPath || currentLines.length === 0) {
      currentPath = undefined;
      currentKind = undefined;
      currentLines = [];
      return;
    }
    blocks.push({
      path: currentPath,
      content: currentLines.join('\n').trim(),
    });
    currentPath = undefined;
    currentKind = undefined;
    currentLines = [];
  };

  const startFileBlock = (kind: 'update' | 'add' | 'delete', path: string) => {
    pushCurrent();
    currentPath = path.trim();
    currentKind = kind;
    currentLines = [`diff --git a/${currentPath} b/${currentPath}`];
    if (kind === 'add') {
      currentLines.push('--- /dev/null');
      currentLines.push(`+++ b/${currentPath}`);
    } else if (kind === 'delete') {
      currentLines.push(`--- a/${currentPath}`);
      currentLines.push('+++ /dev/null');
    } else {
      currentLines.push(`--- a/${currentPath}`);
      currentLines.push(`+++ b/${currentPath}`);
    }
  };

  for (const line of lines) {
    if (line.startsWith('*** Update File: ')) {
      startFileBlock('update', line.replace('*** Update File: ', ''));
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      startFileBlock('add', line.replace('*** Add File: ', ''));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      startFileBlock('delete', line.replace('*** Delete File: ', ''));
      continue;
    }
    if (line.startsWith('*** Move to: ') && currentPath && currentKind === 'update') {
      const moveTo = line.replace('*** Move to: ', '').trim();
      currentLines.push(`rename from ${currentPath}`);
      currentLines.push(`rename to ${moveTo}`);
      currentPath = moveTo;
      continue;
    }
    if (!currentPath) continue;
    if (
      line.startsWith('@@') ||
      line.startsWith('+') ||
      line.startsWith('-') ||
      line.startsWith(' ') ||
      line.startsWith('\\')
    ) {
      currentLines.push(line);
    }
  }

  pushCurrent();
  return blocks;
}

function normalizeTodoItem(value: unknown): TodoItem | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  const status = typeof record.status === 'string' ? record.status.trim() : '';
  const priority = typeof record.priority === 'string' ? record.priority.trim() : '';
  if (!id || !content) return null;
  return {
    id,
    content,
    status: status || 'pending',
    priority: priority || 'medium',
  };
}

function normalizeTodoItems(value: unknown) {
  if (!Array.isArray(value)) return [] as TodoItem[];
  return value.map((item) => normalizeTodoItem(item)).filter((item): item is TodoItem => Boolean(item));
}

async function reloadTodosForAllowedSessions() {
  const requestId = ++todoReloadRequestId;
  const sessionId = selectedSessionId.value;
  const sessionIds = sessionId ? Array.from(allowedSessionIds.value) : [];
  if (sessionIds.length === 0) {
    todosBySessionId.value = {};
    todoLoadingBySessionId.value = {};
    todoErrorBySessionId.value = {};
    return;
  }
  const directory = activeDirectory.value.trim() || undefined;
  const loading: Record<string, boolean> = {};
  sessionIds.forEach((id) => {
    loading[id] = true;
  });
  todoLoadingBySessionId.value = loading;
  const nextTodos: Record<string, TodoItem[]> = {};
  const nextErrors: Record<string, string> = {};
  await Promise.all(
    sessionIds.map(async (id) => {
      try {
        const data = await opencodeApi.getSessionTodos(OPENCODE_BASE_URL, id, directory);
        nextTodos[id] = normalizeTodoItems(data);
      } catch (error) {
        nextTodos[id] = [];
        nextErrors[id] = toErrorMessage(error);
      }
    }),
  );
  if (requestId !== todoReloadRequestId) return;
  todoLoadingBySessionId.value = {};
  todoErrorBySessionId.value = nextErrors;
  todosBySessionId.value = nextTodos;
}

function normalizeRelativePath(path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') return '.';
  const withoutPrefix = trimmed
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/^(\.\.\/)+/, '');
  const normalized = withoutPrefix.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized || '.';
}

function toRelativePath(path: string, directory: string) {
  const normalizedDirectory = normalizeDirectory(directory);
  const normalizedPath = normalizeDirectory(path);
  if (normalizedPath === normalizedDirectory) return '.';
  const prefix = `${normalizedDirectory}/`;
  if (normalizedPath.startsWith(prefix)) return normalizeRelativePath(normalizedPath.slice(prefix.length));
  return normalizeRelativePath(normalizedPath);
}

function normalizeFileNode(item: unknown, directory: string): FileNode | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const rawPath =
    (typeof record.path === 'string' && record.path) ||
    (typeof record.name === 'string' && record.name) ||
    undefined;
  if (!rawPath) return null;
  const path = toRelativePath(rawPath, directory);
  const name =
    (typeof record.name === 'string' && record.name) ||
    (path === '.' ? '.' : path.split('/').at(-1)) ||
    path;
  const rawType = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  const type = rawType.includes('dir') ? 'directory' : 'file';
  const ignored = Boolean(record.ignored);
  return { path, name, type, ignored };
}

function sortTreeNodes(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

function buildTreeNodes(items: unknown[], directory: string, parentPath: string) {
  const unique = new Map<string, TreeNode>();
  items.forEach((item) => {
    const node = normalizeFileNode(item, directory);
    if (!node) return;
    if (node.path === parentPath || node.path === '.') return;
    const relativeToParent =
      parentPath === '.'
        ? node.path
        : node.path.startsWith(`${parentPath}/`)
          ? node.path.slice(parentPath.length + 1)
          : node.path.includes('/')
            ? ''
            : node.path;
    if (!relativeToParent) return;
    const name = relativeToParent.split('/')[0];
    const path = parentPath === '.' ? name : `${parentPath}/${name}`;
    const isLeaf = !relativeToParent.includes('/');
    const existing = unique.get(path);
    if (existing) {
      if (existing.type === 'file' && !isLeaf) {
        existing.type = 'directory';
        existing.children = [];
      }
      if (node.ignored) existing.ignored = true;
      return;
    }
    unique.set(path, {
      name,
      path,
      type: isLeaf ? node.type ?? 'file' : 'directory',
      children: isLeaf && node.type !== 'directory' ? undefined : [],
      loaded: false,
      ignored: Boolean(node.ignored),
      synthetic: false,
    });
  });
  return sortTreeNodes(Array.from(unique.values()));
}

function updateTreeNodeChildren(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return {
        ...node,
        type: 'directory',
        children,
        loaded: true,
      };
    }
    if (node.children?.length) {
      return { ...node, children: updateTreeNodeChildren(node.children, targetPath, children) };
    }
    return node;
  });
}

function findTreeNodeByPath(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (!node.children?.length) continue;
    const child = findTreeNodeByPath(node.children, targetPath);
    if (child) return child;
  }
  return null;
}

function aggregateSessionStatuses() {
  const fileStatuses = sessionStatusByPath.value;
  const next: Record<string, 'added' | 'modified' | 'deleted'> = { ...fileStatuses };
  const priority = { added: 1, modified: 2, deleted: 3 } as const;
  Object.entries(fileStatuses).forEach(([path, status]) => {
    if (path === '.') return;
    const segments = path.split('/');
    while (segments.length > 1) {
      segments.pop();
      const parent = segments.join('/');
      const current = next[parent];
      if (!current || priority[status] > priority[current]) {
        next[parent] = status;
      }
    }
  });
  sessionStatusByPath.value = next;
}

async function loadTreePath(path: string) {
  const directory = activeDirectory.value.trim();
  if (!directory) {
    treeNodes.value = [];
    return;
  }
  const requestId = ++treeRequestId;
  if (path === '.') {
    treeLoading.value = true;
    treeError.value = '';
  }
  try {
    const data = await opencodeApi.listFiles(OPENCODE_BASE_URL, {
      directory,
      path,
    });
    if (requestId !== treeRequestId) return;
    const list = Array.isArray(data) ? data : [];
    const children = buildTreeNodes(list, directory, path);
    if (path === '.') {
      treeNodes.value = children;
    } else {
      treeNodes.value = updateTreeNodeChildren(treeNodes.value, path, children);
    }
  } catch (error) {
    if (requestId !== treeRequestId) return;
    treeError.value = `Tree load failed: ${toErrorMessage(error)}`;
  } finally {
    if (path === '.') treeLoading.value = false;
  }
}

function normalizeSessionDiffEntries(entries: unknown[]) {
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const file = typeof record.file === 'string' ? record.file : undefined;
      const status =
        typeof record.status === 'string'
          ? (record.status as 'added' | 'modified' | 'deleted')
          : undefined;
      const additions = typeof record.additions === 'number' ? record.additions : undefined;
      const deletions = typeof record.deletions === 'number' ? record.deletions : undefined;
      const before = typeof record.before === 'string' ? record.before : undefined;
      const after = typeof record.after === 'string' ? record.after : undefined;
      return { file, status, additions, deletions, before, after } as SessionDiffEntry;
    })
    .filter((entry): entry is SessionDiffEntry => Boolean(entry?.file));
}

function updateSessionDiffState(entries: SessionDiffEntry[]) {
  sessionDiffEntries.value = entries;
  const next: Record<string, 'added' | 'modified' | 'deleted'> = {};
  const nextByPath: Record<string, SessionDiffEntry> = {};
  const directory = activeDirectory.value.trim();
  entries.forEach((entry) => {
    if (!entry.file) return;
    const relativePath = toRelativePath(entry.file, directory);
    if (relativePath === '.') return;
    if (entry.status) next[relativePath] = entry.status;
    nextByPath[relativePath] = entry;
  });
  sessionStatusByPath.value = next;
  sessionDiffByPath.value = nextByPath;
  aggregateSessionStatuses();
}

async function refreshSessionDiff() {
  const requestId = ++sessionDiffRequestId;
  const sessionId = selectedSessionId.value;
  if (!sessionId) {
    updateSessionDiffState([]);
    return;
  }
  const directory = activeDirectory.value.trim();
  try {
    const data = await opencodeApi.getSessionDiff(OPENCODE_BASE_URL, {
      sessionID: sessionId,
      directory,
    });
    if (requestId !== sessionDiffRequestId) return;
    if (selectedSessionId.value !== sessionId) return;
    if (activeDirectory.value.trim() !== directory) return;
    const entries = Array.isArray(data) ? normalizeSessionDiffEntries(data) : [];
    updateSessionDiffState(entries);
  } catch {
    if (requestId !== sessionDiffRequestId) return;
    if (selectedSessionId.value !== sessionId) return;
    if (activeDirectory.value.trim() !== directory) return;
    updateSessionDiffState([]);
  }
}

function toggleTreeDirectory(path: string) {
  const next = new Set(expandedTreePathSet.value);
  if (next.has(path)) {
    next.delete(path);
    expandedTreePathSet.value = next;
    return;
  }
  next.add(path);
  expandedTreePathSet.value = next;
  const node = findTreeNodeByPath(treeNodes.value, path);
  if (node?.loaded) return;
  void loadTreePath(path);
}

function selectTreeFile(path: string) {
  selectedTreePath.value = path;
}

function toUint8ArrayFromBase64(input: string) {
  const decoded = atob(input);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

function toUint8ArrayFromText(input: string) {
  return new TextEncoder().encode(input);
}

function getFileViewerByPath(path: string) {
  return fileViewerQueue.value.find((entry) => entry.path === path);
}

function closeFileViewer(entry: FileReadEntry) {
  const index = fileViewerQueue.value.findIndex((item) => item.toolKey === entry.toolKey);
  if (index >= 0) fileViewerQueue.value.splice(index, 1);
}

function openSessionDiff(path: string) {
  const entry = sessionDiffByPath.value[path];
  if (!entry || !entry.file) return;
  const existing = fileViewerQueue.value.find((item) => item.toolKey === `session-diff:${path}`);
  if (existing) {
    bringToFront(existing);
    return;
  }
  const metrics = getCanvasMetrics();
  const x = metrics ? clamp(metrics.canvasRect.width * 0.16, 16, Math.max(16, metrics.canvasRect.width - FILE_VIEWER_WINDOW_WIDTH - 16)) : 24;
  const y = metrics ? clamp(metrics.toolAreaHeight * 0.1, 16, Math.max(16, metrics.toolAreaHeight - FILE_VIEWER_WINDOW_HEIGHT - 16)) : 24;
  const diffEntry: FileReadEntry = {
    time: Date.now(),
    expiresAt: Number.MAX_SAFE_INTEGER,
    x,
    y,
    header: '',
    path,
    content: '',
    scroll: false,
    scrollDistance: 0,
    scrollDuration: 0,
    html: '',
    isWrite: false,
    isMessage: false,
    toolName: 'diff',
    toolTitle: path,
    lang: guessLanguage(path),
    toolGutterMode: 'none',
    toolKey: `session-diff:${path}`,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    isBinary: false,
    isDiff: true,
    isLoading: true,
    diffCode: entry.before ?? '',
    diffAfter: entry.after,
  };
  bringToFront(diffEntry);
  fileViewerQueue.value.push(diffEntry);
}

function handleShowMessageDiff(payload: { messageKey: string; diffs: Array<MessageDiffEntry> }) {
  const { messageKey, diffs } = payload;
  if (!diffs || diffs.length === 0) return;
  const toolKey = `message-diff:${messageKey}`;
  const existing = fileViewerQueue.value.find((item) => item.toolKey === toolKey);
  if (existing) {
    bringToFront(existing);
    return;
  }
  // If diffs have before/after (from summary.diffs), use them for rich diff view
  const hasBeforeAfter = diffs.some((d) => typeof d.before === 'string' && typeof d.after === 'string');
  const combinedDiff = hasBeforeAfter ? '' : diffs.map((d) => d.diff).join('\n');
  const metrics = getCanvasMetrics();
  const x = metrics ? clamp(metrics.canvasRect.width * 0.16, 16, Math.max(16, metrics.canvasRect.width - FILE_VIEWER_WINDOW_WIDTH - 16)) : 24;
  const y = metrics ? clamp(metrics.toolAreaHeight * 0.1, 16, Math.max(16, metrics.toolAreaHeight - FILE_VIEWER_WINDOW_HEIGHT - 16)) : 24;
  const fileCount = diffs.length;
  const title = fileCount === 1 ? diffs[0].file : `${fileCount} files changed`;
  const firstFile = diffs[0]?.file ?? '';
  
  let diffTabs: Array<{ file: string; before: string; after: string }> | undefined;
  if (hasBeforeAfter && fileCount > 1) {
    diffTabs = diffs
      .filter((d) => typeof d.before === 'string' && typeof d.after === 'string')
      .map((d) => ({
        file: d.file,
        before: d.before!,
        after: d.after!,
      }));
  }

  const diffEntry: FileReadEntry = {
    time: Date.now(),
    expiresAt: Number.MAX_SAFE_INTEGER,
    x,
    y,
    header: '',
    path: firstFile,
    content: hasBeforeAfter ? '' : combinedDiff,
    scroll: false,
    scrollDistance: 0,
    scrollDuration: 0,
    html: '',
    isWrite: false,
    isMessage: false,
    toolName: 'diff',
    toolTitle: title,
    lang: fileCount === 1 ? guessLanguage(firstFile) : 'text',
    toolGutterMode: hasBeforeAfter ? 'double' : 'none',
    toolKey,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    isBinary: false,
    isDiff: true,
    isLoading: true,
    diffCode: hasBeforeAfter ? (diffs[0]?.before ?? '') : '',
    diffAfter: hasBeforeAfter ? (diffs[0]?.after ?? '') : undefined,
    diffTabs,
  };
  bringToFront(diffEntry);
  fileViewerQueue.value.push(diffEntry);
}

function handleShowMessageHistory(payload: { roundId: string; contents: string[] }) {
  const { roundId, contents } = payload;
  if (!contents || contents.length === 0) return;
  const toolKey = `message-history:${roundId}`;
  // Remove existing popup for this round (re-create to pick up new messages)
  const existingIndex = fileViewerQueue.value.findIndex((item) => item.toolKey === toolKey);
  if (existingIndex !== -1) {
    fileViewerQueue.value.splice(existingIndex, 1);
  }
  const combinedMarkdown = contents.join('\n\n---\n\n');
  const metrics = getCanvasMetrics();
  const x = metrics ? clamp(metrics.canvasRect.width * 0.16, 16, Math.max(16, metrics.canvasRect.width - FILE_VIEWER_WINDOW_WIDTH - 16)) : 24;
  const y = metrics ? clamp(metrics.toolAreaHeight * 0.1, 16, Math.max(16, metrics.toolAreaHeight - FILE_VIEWER_WINDOW_HEIGHT - 16)) : 24;
  const historyEntry: FileReadEntry = {
    time: Date.now(),
    expiresAt: Number.MAX_SAFE_INTEGER,
    x,
    y,
    header: '',
    content: combinedMarkdown,
    scroll: false,
    scrollDistance: 0,
    scrollDuration: 0,
    html: '',
    isWrite: false,
    isMessage: true,
    toolName: 'history',
    toolTitle: `Message History (${contents.length})`,
    lang: 'markdown',
    toolKey,
    toolWrapMode: 'soft',
    toolGutterMode: 'none',
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    contentKey: `history-${roundId}-${contents.length}`,
  };
  bringToFront(historyEntry);
  fileViewerQueue.value.push(historyEntry);
}

async function openFileViewer(path: string) {
  const existing = getFileViewerByPath(path);
  if (existing) {
    bringToFront(existing);
    return;
  }
  const metrics = getCanvasMetrics();
  const x = metrics ? clamp(metrics.canvasRect.width * 0.18, 16, Math.max(16, metrics.canvasRect.width - FILE_VIEWER_WINDOW_WIDTH - 16)) : 32;
  const y = metrics ? clamp(metrics.toolAreaHeight * 0.14, 16, Math.max(16, metrics.toolAreaHeight - FILE_VIEWER_WINDOW_HEIGHT - 16)) : 32;
  const entry: FileReadEntry = {
    time: Date.now(),
    expiresAt: Number.MAX_SAFE_INTEGER,
    x,
    y,
    header: '',
    path,
    content: '',
    scroll: false,
    scrollDistance: 0,
    scrollDuration: 0,
    html: '',
    isWrite: false,
    isMessage: false,
    toolName: 'read',
    toolTitle: path,
    lang: guessLanguage(path),
    toolGutterMode: 'default',
    toolKey: `file-viewer:${path}`,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    isBinary: false,
    isLoading: true,
  };
  bringToFront(entry);
  fileViewerQueue.value.push(entry);
  const viewerEntry = fileViewerQueue.value[fileViewerQueue.value.length - 1];
  if (!viewerEntry) return;

  const directory = activeDirectory.value.trim();
  if (!directory) {
    viewerEntry.html = 'No active directory selected.';
    viewerEntry.toolGutterMode = 'none';
    viewerEntry.isLoading = false;
    return;
  }

  try {
    const data = (await opencodeApi.readFileContent(OPENCODE_BASE_URL, {
      directory,
      path,
    })) as FileContentResponse;
    const type = data?.type === 'binary' ? 'binary' : 'text';
    const encoding = typeof data?.encoding === 'string' ? data.encoding : 'utf-8';
    const content = typeof data?.content === 'string' ? data.content : '';
    if (type === 'binary') {
      if (!content) {
        viewerEntry.html =
          'Binary content is not included in this API response.\nUnable to render hexdump for this file.';
        viewerEntry.toolGutterMode = 'none';
        viewerEntry.isBinary = false;
        viewerEntry.isLoading = false;
        return;
      }
      const bytes = encoding === 'base64' ? toUint8ArrayFromBase64(content) : toUint8ArrayFromText(content);
      const dump = hexdump(bytes, { color: 'html' });
      viewerEntry.html = `<pre class="shiki"><code>${dump}</code></pre>`;
      viewerEntry.toolGutterMode = 'none';
      viewerEntry.isBinary = true;
      viewerEntry.isLoading = false;
      return;
    }
    const lang = guessLanguage(path);
    const textContent = encoding === 'base64' ? atob(content) : content;
    viewerEntry.content = textContent;
    viewerEntry.lang = lang;
    viewerEntry.toolGutterMode = 'default';
    viewerEntry.isBinary = false;
    viewerEntry.isLoading = false;
  } catch (error) {
    viewerEntry.html = `File load failed: ${toErrorMessage(error)}`;
    viewerEntry.toolGutterMode = 'none';
    viewerEntry.isBinary = false;
    viewerEntry.isLoading = false;
  }
}

function extractTodoUpdated(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (normalized !== 'todoupdated') return null;
  const sessionID =
    (typeof properties?.sessionID === 'string' && properties.sessionID) ||
    (typeof properties?.sessionId === 'string' && properties.sessionId) ||
    extractSessionId(payload);
  if (!sessionID) return null;
  return {
    sessionID,
    todos: normalizeTodoItems(properties?.todos),
  };
}

function guessLanguage(path?: string, eventType?: string) {
  if (!path) {
    if (eventType && eventType.startsWith('session.diff')) return 'text';
    return 'text';
  }

  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'vue':
      return 'vue';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'diff':
    case 'patch':
      return 'diff';
    case 'sh':
      return 'shellscript';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'php':
      return 'php';
    case 'sql':
      return 'sql';
    default:
      return 'text';
  }
}

function detectDiffLike(content: string, path?: string) {
  if (path && path.includes('diff')) return true;
  return (
    /(^|\n)diff --git\s/m.test(content) ||
    /(^|\n)@@\s/m.test(content) ||
    /(^|\n)\+\+\+\s/m.test(content) ||
    /(^|\n)---\s/m.test(content)
  );
}


function countWrappedLines(text: string, columns: number) {
  if (columns <= 0) return text.split('\n').length;
  const lines = text.split('\n');
  return lines.reduce((total, line) => {
    if (line.length === 0) return total + 1;
    let width = 0;
    for (const char of line) {
      width += char.charCodeAt(0) > 0xff ? 2 : 1;
    }
    return total + Math.max(1, Math.ceil(width / columns));
  }, 0);
}

type DiffOp = { type: 'equal' | 'delete' | 'insert'; line: string };

function buildDiffOps(beforeLines: string[], afterLines: string[]) {
  const m = beforeLines.length;
  const n = afterLines.length;
  const dp = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (beforeLines[i] === afterLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ type: 'equal', line: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', line: beforeLines[i] });
      i += 1;
    } else {
      ops.push({ type: 'insert', line: afterLines[j] });
      j += 1;
    }
  }

  while (i < m) {
    ops.push({ type: 'delete', line: beforeLines[i] });
    i += 1;
  }
  while (j < n) {
    ops.push({ type: 'insert', line: afterLines[j] });
    j += 1;
  }

  return ops;
}

function buildUnifiedDiff(
  before: string,
  after: string,
  file: string,
  meta?: { status?: string; additions?: number; deletions?: number },
) {
  const beforeLines = before.length > 0 ? before.split('\n') : [];
  const afterLines = after.length > 0 ? after.split('\n') : [];
  const ops = buildDiffOps(beforeLines, afterLines);
  const hunks: string[] = [];
  const context = 3;

  const beforeAt: number[] = [1];
  const afterAt: number[] = [1];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    beforeAt[i + 1] = beforeAt[i] + (op.type !== 'insert' ? 1 : 0);
    afterAt[i + 1] = afterAt[i] + (op.type !== 'delete' ? 1 : 0);
  }

  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index].type === 'equal') index += 1;
    if (index >= ops.length) break;

    const hunkStart = Math.max(0, index - context);
    let hunkEnd = index;
    let lastChange = index;

    while (hunkEnd < ops.length) {
      if (ops[hunkEnd].type !== 'equal') lastChange = hunkEnd;
      if (hunkEnd - lastChange > context) break;
      hunkEnd += 1;
    }

    const startBefore = beforeAt[hunkStart];
    const startAfter = afterAt[hunkStart];
    const hunkOps = ops.slice(hunkStart, hunkEnd);
    const deleteCount = hunkOps.filter((op) => op.type !== 'insert').length;
    const insertCount = hunkOps.filter((op) => op.type !== 'delete').length;

    hunks.push(`@@ -${startBefore},${deleteCount} +${startAfter},${insertCount} @@`);
    hunkOps.forEach((op) => {
      if (op.type === 'equal') hunks.push(` ${op.line}`);
      if (op.type === 'delete') hunks.push(`-${op.line}`);
      if (op.type === 'insert') hunks.push(`+${op.line}`);
    });

    index = hunkEnd;
  }

  const summary =
    meta && (meta.status || meta.additions !== undefined || meta.deletions !== undefined)
      ? `# status: ${meta.status ?? 'modified'} (+${meta.additions ?? 0} -${meta.deletions ?? 0})`
      : undefined;

  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    ...(summary ? [summary] : []),
    ...hunks,
  ].join('\n');
}

function formatDiffEntries(entries: unknown[]) {
  const blocks = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    const file = typeof record.file === 'string' ? record.file : `file-${index + 1}`;
    const before = typeof record.before === 'string' ? record.before : '';
    const after = typeof record.after === 'string' ? record.after : '';
    const status = typeof record.status === 'string' ? record.status : undefined;
    const additions = typeof record.additions === 'number' ? record.additions : undefined;
    const deletions = typeof record.deletions === 'number' ? record.deletions : undefined;

    return buildUnifiedDiff(before, after, file, { status, additions, deletions });
  });

  return blocks.filter((block) => typeof block === 'string').join('\n\n');
}


function extractPatch(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const data =
    (record.data as Record<string, unknown> | undefined) ??
    nestedPayload ??
    (record.result as Record<string, unknown> | undefined);
  const messageObject =
    (properties?.message as Record<string, unknown> | undefined) ??
    (data?.message as Record<string, unknown> | undefined) ??
    (record.message as Record<string, unknown> | undefined);
  const part =
    (properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined) ??
    (data?.part && typeof data.part === 'object' ? (data.part as Record<string, unknown>) : undefined) ??
    (record.part && typeof record.part === 'object'
      ? (record.part as Record<string, unknown>)
      : undefined) ??
    (messageObject?.part && typeof messageObject.part === 'object'
      ? (messageObject.part as Record<string, unknown>)
      : undefined);

  if (part?.type !== 'tool' || part?.tool !== 'apply_patch') return null;

  const callId =
    (part?.callID as string | undefined) ??
    (part?.callId as string | undefined) ??
    (properties?.callID as string | undefined) ??
    (properties?.callId as string | undefined);
  const state =
    part?.state && typeof part.state === 'object'
      ? (part.state as Record<string, unknown>)
      : undefined;
  const status = typeof state?.status === 'string' ? state.status : undefined;
  if (!status || status === 'pending') return null;

  const input =
    state?.input && typeof state.input === 'object'
      ? (state.input as Record<string, unknown>)
      : undefined;
  const metadata =
    state?.metadata && typeof state.metadata === 'object'
      ? (state.metadata as Record<string, unknown>)
      : undefined;
  const output =
    state?.output ?? (state?.metadata as Record<string, unknown> | undefined)?.output;
  const outputText = output !== undefined ? extractToolOutputText(output) : '';
  const stateError = state?.error;
  const errorText =
    typeof stateError === 'string'
      ? stateError
      : stateError !== undefined
        ? formatToolValue(stateError)
        : '';

  const patchText = typeof input?.patchText === 'string' ? input.patchText : '';
  const parsedBlocks = patchText ? parsePatchTextBlocks(patchText) : [];

  if (status !== 'running') {
    if (parsedBlocks.length === 0) return null;
    const baseCallId = callId ?? 'apply_patch';
    const entries = parsedBlocks.map((block, index) => ({
      content: '',
      path: undefined,
      isWrite: true,
      callId: `${baseCallId}:${index}`,
      toolStatus: status,
      toolName: 'apply_patch',
      toolTitle: undefined,
      lang: guessLanguage(block.path),
      view: 'diff' as const,
    }));
    return entries;
  }

  const metadataFilesRaw = Array.isArray(metadata?.files) ? metadata.files : [];
  const metadataBlocks = metadataFilesRaw
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const relativePath =
        (typeof record.relativePath === 'string' && record.relativePath) ||
        (typeof record.filePath === 'string' && record.filePath) ||
        (typeof record.file === 'string' && record.file) ||
        undefined;
      const diff = typeof record.diff === 'string' ? record.diff : undefined;
      if (diff && diff.trim()) {
        return {
          path: relativePath,
          content: diff,
          index,
        };
      }
      const before = typeof record.before === 'string' ? record.before : undefined;
      const after = typeof record.after === 'string' ? record.after : undefined;
      if (before !== undefined || after !== undefined) {
        const fileName =
          relativePath ??
          (parsedBlocks[index]?.path || `patch-${index + 1}`);
        return {
          path: fileName,
          content: buildUnifiedDiff(before ?? '', after ?? '', fileName, {
            status: typeof record.type === 'string' ? record.type : undefined,
            additions: typeof record.additions === 'number' ? record.additions : undefined,
            deletions: typeof record.deletions === 'number' ? record.deletions : undefined,
          }),
          index,
        };
      }
      return null;
    })
    .filter((entry): entry is { path?: string; content: string; index: number } => Boolean(entry));

  const count = Math.max(parsedBlocks.length, metadataBlocks.length, status === 'error' ? 1 : 0);
  if (count === 0) return null;
  const baseCallId = callId ?? 'apply_patch';

  const entries = Array.from({ length: count }, (_, index) => {
    const parsedBlock = parsedBlocks[index];
    const metadataBlock = metadataBlocks[index];
    const path = metadataBlock?.path ?? parsedBlock?.path;
    const content =
      metadataBlock?.content ??
      parsedBlock?.content ??
      (status === 'error' ? errorText : outputText);
    const fallbackTitle = path ?? `patch-${index + 1}`;
    return {
      content,
      path: path ?? fallbackTitle,
      isWrite: true,
      callId: `${baseCallId}:${index}`,
      toolStatus: status,
      toolName: 'apply_patch',
      toolTitle: path ?? fallbackTitle,
      lang: guessLanguage(path),
      view: 'diff' as const,
    };
  }).filter((entry) => entry.content.trim().length > 0);

  return entries.length > 0 ? entries : null;
}

function extractFileRead(payload: unknown, eventType: string) {
  if (typeof payload === 'string') {
    if (FILE_READ_EVENT_TYPES.has(eventType) || FILE_WRITE_EVENT_TYPES.has(eventType)) {
      return { content: payload, path: undefined, isWrite: FILE_WRITE_EVENT_TYPES.has(eventType) };
    }
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const part =
    properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined;
  const tool = part?.tool;
  if (part?.type === 'tool' && typeof tool === 'string') {
    if (!shouldRenderToolWindow(tool) || tool === 'apply_patch') return null;
    const state =
      part?.state && typeof part.state === 'object'
        ? (part.state as Record<string, unknown>)
        : undefined;
    const status = typeof state?.status === 'string' ? state.status : undefined;
    if (!status || status === 'pending') return null;
    const input =
      state?.input && typeof state.input === 'object'
        ? (state.input as Record<string, unknown>)
        : undefined;
    const metadata =
      state?.metadata && typeof state.metadata === 'object'
        ? (state.metadata as Record<string, unknown>)
        : undefined;
    const output =
      state?.output ?? (state?.metadata as Record<string, unknown> | undefined)?.output;
    const callId =
      (part?.callID as string | undefined) ??
      (part?.callId as string | undefined) ??
      (properties?.callID as string | undefined) ??
      (properties?.callId as string | undefined);
    const outputText = output !== undefined ? extractToolOutputText(output) : undefined;
    const stateError = state?.error;
    const errorText =
      typeof stateError === 'string'
        ? stateError
        : stateError !== undefined
          ? formatToolValue(stateError)
          : undefined;

    let content = outputText ?? errorText ?? '';
    let path: string | undefined;
    let toolTitle: string | undefined;
    let lang: string | undefined;
    let grepPattern: string | undefined;
    let wrapMode: FileReadEntry['toolWrapMode'];
    let gutterMode: FileReadEntry['toolGutterMode'];
    let gutterLines: string[] | undefined;
    let readOffset: number | undefined;
    let readLimit: number | undefined;
    let view: FileReadEntry['view'];

    switch (tool) {
      case 'bash': {
        content = formatBashToolContent(input, outputText ?? errorText ?? '', status);
        path = undefined;
        toolTitle = formatBashToolTitle(input, state);
        lang = 'shellscript';
        wrapMode = 'soft';
        gutterMode = 'none';
        break;
      }
      case 'read': {
        if (status === 'running') return null;
        path = resolveReadWritePath(input, metadata, state);
        toolTitle = formatReadLikeToolTitle(input);
        if (outputText) content = extractFileBodyFromReadOutput(outputText) ?? outputText;
        lang = guessLanguage(path);
        const readRange = resolveReadRange(input);
        readOffset = readRange.offset;
        readLimit = readRange.limit;
        break;
      }
      case 'grep': {
        if (status === 'running') return null;
        path = typeof input?.path === 'string' ? input.path : undefined;
        grepPattern = typeof input?.pattern === 'string' ? input.pattern : undefined;
        toolTitle = formatGlobToolTitle(input);
        if (outputText) {
          const parsed = parseGrepOutputWithSourceLines(outputText);
          if (parsed) {
            content = parsed.content;
            gutterMode = 'grep-source';
            gutterLines = parsed.gutterLines;
          } else {
            content = outputText;
            gutterMode = 'default';
            gutterLines = undefined;
          }
        }
        lang = 'text';
        break;
      }
      case 'glob': {
        if (status === 'running') return null;
        path = typeof input?.path === 'string' ? input.path : undefined;
        toolTitle = formatGlobToolTitle(input);
        lang = 'text';
        gutterMode = 'none';
        break;
      }
      case 'list': {
        path = typeof input?.path === 'string' ? input.path : undefined;
        toolTitle = formatListToolTitle(input);
        lang = 'text';
        gutterMode = 'none';
        break;
      }
      case 'webfetch': {
        if (status === 'running') return null;
        path = undefined;
        toolTitle = formatWebfetchToolTitle(input);
        const format = typeof input?.format === 'string' ? input.format : 'markdown';
        lang = format === 'html' ? 'html' : format === 'text' ? 'text' : 'markdown';
        gutterMode = 'none';
        break;
      }
      case 'websearch':
      case 'codesearch': {
        if (status === 'running') return null;
        path = undefined;
        toolTitle = formatQueryToolTitle(input);
        lang = 'markdown';
        gutterMode = 'none';
        break;
      }
      case 'task': {
        path = undefined;
        toolTitle = typeof input?.description === 'string' ? input.description : undefined;
        content = formatTaskToolOutput(content);
        lang = 'markdown';
        gutterMode = 'none';
        break;
      }
      case 'batch': {
        path = undefined;
        toolTitle = 'Batch execution';
        lang = 'text';
        gutterMode = 'none';
        break;
      }
      case 'write': {
        path = resolveReadWritePath(input, metadata, state);
        toolTitle = formatReadLikeToolTitle(input);
        lang = guessLanguage(path);
        break;
      }
      case 'edit': {
        path = typeof input?.filePath === 'string' ? input.filePath : undefined;
        toolTitle = formatReadLikeToolTitle(input);
        const diff = typeof metadata?.diff === 'string' ? metadata.diff : '';
        if (diff.trim()) {
          content = diff;
          lang = guessLanguage(path);
          view = 'diff';
        } else {
          lang = 'text';
        }
        break;
      }
      case 'multiedit': {
        if (status === 'running') return null;
        path = typeof input?.filePath === 'string' ? input.filePath : undefined;
        toolTitle = formatReadLikeToolTitle(input);
        const results = Array.isArray(metadata?.results) ? metadata.results : [];
        const diffs = results
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const diff = (item as Record<string, unknown>).diff;
            return typeof diff === 'string' && diff.trim() ? diff : null;
          })
          .filter((item): item is string => Boolean(item));
        if (diffs.length > 1) {
          const baseTitle = toolTitle?.trim() ? toolTitle.trim() : undefined;
          return diffs.map((diff, index) => ({
            content: diff,
            path,
            isWrite: true,
            callId: callId ? `${callId}:${index}` : undefined,
            toolStatus: status,
            toolName: tool,
            toolTitle: baseTitle ? `${baseTitle} (${index + 1}/${diffs.length})` : undefined,
            lang: guessLanguage(path),
            view: 'diff' as const,
            grepPattern: undefined,
            wrapMode: undefined as FileReadEntry['toolWrapMode'],
            gutterMode: undefined as FileReadEntry['toolGutterMode'],
            gutterLines: undefined as string[] | undefined,
          }));
        }
        if (diffs.length === 1) {
          content = diffs[0];
          lang = guessLanguage(path);
          view = 'diff';
        } else {
          lang = 'text';
        }
        break;
      }
      case 'plan_enter':
      case 'plan_exit': {
        path = undefined;
        toolTitle = typeof state?.title === 'string' ? state.title : undefined;
        lang = 'text';
        gutterMode = 'none';
        break;
      }
      default:
        return null;
    }

    if (!content.trim() && status === 'running') {
      const allowEmptyRunning =
        tool === 'list' ||
        tool === 'task';
      if (!allowEmptyRunning) return null;
    }
    if (!content.trim() && status !== 'running') content = errorText ?? outputText ?? '';

    return {
      content,
      path,
      isWrite: tool === 'write' || tool === 'edit' || tool === 'multiedit',
      callId,
      toolStatus: status,
      toolName: tool,
      toolTitle: toolTitle?.trim() ? toolTitle.trim() : undefined,
      lang,
      view,
      grepPattern,
      wrapMode,
      gutterMode,
      gutterLines,
      readOffset,
      readLimit,
    };
  }
  const type =
    record.type ??
    record.event ??
    record.name ??
    record.command ??
    nestedPayload?.type ??
    eventType;

  if (
    typeof type === 'string' &&
    (FILE_READ_EVENT_TYPES.has(type) || FILE_WRITE_EVENT_TYPES.has(type))
  ) {
    const isWrite = FILE_WRITE_EVENT_TYPES.has(type);
    if (isWrite) return null;
    const isDiffEvent = type.startsWith('session.diff');
    if (isDiffEvent) return null;
    const data =
      (record.data as Record<string, unknown> | undefined) ??
      (record.payload as Record<string, unknown> | undefined) ??
      (record.result as Record<string, unknown> | undefined) ??
      (record.file as Record<string, unknown> | undefined) ??
      (record.params as Record<string, unknown> | undefined) ??
      (record.arguments as Record<string, unknown> | undefined);

    const dataProperties =
      data?.properties && typeof data.properties === 'object'
        ? (data.properties as Record<string, unknown>)
        : undefined;
    const nestedProperties =
      nestedPayload?.properties && typeof nestedPayload.properties === 'object'
        ? (nestedPayload.properties as Record<string, unknown>)
        : undefined;

    const diffEntries =
      (dataProperties?.diff as unknown[] | undefined) ??
      (nestedProperties?.diff as unknown[] | undefined) ??
      (data?.diff as unknown[] | undefined) ??
      undefined;

    if (isDiffEvent && Array.isArray(diffEntries) && diffEntries.length > 0) {
      const content = formatDiffEntries(diffEntries);
      const first = diffEntries[0];
      const path =
        first &&
        typeof first === 'object' &&
        typeof (first as Record<string, unknown>).file === 'string'
          ? ((first as Record<string, unknown>).file as string)
          : undefined;

      if (content) {
        return { content, path, isWrite: false };
      }
    }

    const content =
      (data?.content as string | undefined) ??
      (data?.text as string | undefined) ??
      (data?.body as string | undefined) ??
      (data?.fileContent as string | undefined) ??
      ((data?.file as Record<string, unknown> | undefined)?.content as string | undefined) ??
      (isDiffEvent
        ? ((data?.diff as string | undefined) ?? (data?.patch as string | undefined))
        : undefined);

    const path =
      (data?.path as string | undefined) ??
      (data?.filePath as string | undefined) ??
      (data?.name as string | undefined) ??
      ((data?.file as Record<string, unknown> | undefined)?.path as string | undefined);

    if (typeof content === 'string') {
      return { content, path, isWrite };
    }
  }

  return null;
}

function extractMessageTextFromParts(parts: unknown) {
  if (!Array.isArray(parts)) return undefined;
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : undefined;
    const text = typeof record.text === 'string' ? record.text : undefined;
    if (!text) continue;
    if (!type || type.includes('text')) texts.push(text);
  }
  if (texts.length === 0) return undefined;
  return texts.join('');
}

function extractMessageAttachments(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const info =
    properties?.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : undefined;
  const data =
    (record.data as Record<string, unknown> | undefined) ??
    nestedPayload ??
    (record.result as Record<string, unknown> | undefined);
  const messageObject =
    (properties?.message as Record<string, unknown> | undefined) ??
    (data?.message as Record<string, unknown> | undefined) ??
    (record.message as Record<string, unknown> | undefined);
  const part =
    (properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined) ??
    (data?.part && typeof data.part === 'object'
      ? (data.part as Record<string, unknown>)
      : undefined) ??
    (record.part && typeof record.part === 'object'
      ? (record.part as Record<string, unknown>)
      : undefined) ??
    (messageObject?.part && typeof messageObject.part === 'object'
      ? (messageObject.part as Record<string, unknown>)
      : undefined);
  const parts =
    (messageObject?.parts as unknown) ??
    (data?.parts as unknown) ??
    (record.parts as unknown);

  const attachments = normalizeAttachments([
    ...extractImageAttachmentsFromParts(parts),
    ...extractImageAttachmentsFromParts(part ? [part] : []),
  ]);

  if (attachments.length === 0) return null;

  const messageId =
    (part?.messageID as string | undefined) ??
    (messageObject?.id as string | undefined) ??
    (messageObject?.messageId as string | undefined) ??
    (info?.id as string | undefined) ??
    (properties?.messageId as string | undefined) ??
    (properties?.id as string | undefined) ??
    (data?.messageId as string | undefined) ??
    (data?.id as string | undefined) ??
    (record.messageId as string | undefined) ??
    (record.id as string | undefined);

  return { messageId, attachments };
}

function hasToolParts(
  parts?: Map<string, string>,
  partOrder?: string[],
  messageId?: string,
  sessionId?: string,
): boolean {
  if (!parts || !partOrder || parts.size === 0) return false;
  // If we can't inspect part types directly from the map (which only has content),
  // we might need to rely on the side-effect based diff collection or previous knowledge.
  // However, the `queue` tool entries are created separately.
  // Wait, `messagePartsById` maps partId -> content string. It doesn't store type.
  // But `extractMessage` sees the `partType` in the event.
  // We need a way to know if a message has tool parts.
  // Let's check `queue` for tool entries associated with this message?
  // Tool entries in queue have `callId`.
  // Assistant messages in queue don't "contain" the tools, they are separate entries.
  // But the prompt says "assistant side: classification signal for final_summary vs intermediate".
  // "use part composition (e.g. presence/absence of tool and text)".
  // If `extractMessage` receives a part with type `tool`, we know.
  // But we need to know the *composition* of the whole message.
  // A message might consist of multiple parts.
  // If ANY part is a tool, it's intermediate?
  // Let's track part types in a new map.
  return false; // placeholder, will implement with new map
}

const messagePartTypesById = new Map<string, Set<string>>();

function registerPartType(messageKey: string, partType?: string) {
  if (!partType || !messageKey) return;
  const set = messagePartTypesById.get(messageKey) ?? new Set();
  set.add(partType);
  messagePartTypesById.set(messageKey, set);
}

function classifyUserMessage(
  role: string | undefined,
  content: string,
  userMeta: UserMessageMeta | null,
): 'real_user' | 'system_injection' | 'unknown' {
  if (role !== 'user') return 'unknown';
  
  // 1. If we have explicit user metadata (agent/model config), it's likely a real user request
  // (or a very sophisticated injection simulating a user config, but we treat that as user-initiated).
  if (userMeta) return 'real_user';

  // 2. If the content matches something recently typed by the user in this session.
  const normalized = content.trim();
  const recentMatch = recentUserInputs.find((entry) => entry.text === normalized);
  if (recentMatch) return 'real_user';

  // 3. Fallback: If we can't confirm it's a real user, and it has no meta, 
  // we classify as unknown (or system_injection if we had a negative signal).
  // The prompt says "If real-user vs injected cannot be determined, classify as unknown".
  return 'unknown';
}

function extractPartType(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const part =
    properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined;
  const partType = typeof part?.type === 'string' ? part.type : undefined;
  
  if (!partType) return null;

  const messageId =
    (part?.messageID as string | undefined) ??
    (properties?.messageId as string | undefined);
  
  const sessionId =
    (typeof part?.sessionID === 'string' ? (part.sessionID as string) : undefined) ??
    extractSessionId(payload);

  if (!messageId) return null;

  return { partType, messageId, sessionId };
}

function extractMessage(payload: unknown, eventType: string) {
  if (!payload) return null;

  if (typeof payload === 'string') {
    if (MESSAGE_EVENT_TYPES.has(eventType)) {
      return { id: 'message:default', content: payload };
    }
    return null;
  }

  if (typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const info =
    properties?.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : undefined;
  const part =
    properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined;
  const data =
    (record.data as Record<string, unknown> | undefined) ??
    nestedPayload ??
    (record.result as Record<string, unknown> | undefined);

  const messageObject =
    (properties?.message as Record<string, unknown> | undefined) ??
    (data?.message as Record<string, unknown> | undefined) ??
    (record.message as Record<string, unknown> | undefined);
  const partType =
    (part?.type as string | undefined) ??
    (properties?.type as string | undefined) ??
    (data?.type as string | undefined) ??
    (messageObject?.type as string | undefined);
  const partText = typeof part?.text === 'string' ? (part.text as string) : undefined;
  const messageFromPart =
    partText && (!partType || partType.includes('text') || partType === 'reasoning')
      ? partText
      : undefined;
  const partId = typeof part?.id === 'string' ? (part.id as string) : undefined;
  const messageFromObject =
    (messageObject &&
      (typeof messageObject.content === 'string'
        ? messageObject.content
        : typeof messageObject.text === 'string'
          ? messageObject.text
          : undefined)) ??
    (messageObject && extractMessageTextFromParts(messageObject.parts));

  const message = messageFromPart ?? messageFromObject;

  if (typeof message !== 'string') return null;

  if (partType && (partType.startsWith('input') || partType.startsWith('step-'))) return null;

  const role =
    (part?.role as string | undefined) ??
    (messageObject?.role as string | undefined) ??
    (info?.role as string | undefined) ??
    (properties?.role as string | undefined) ??
    (data?.role as string | undefined) ??
    (record.role as string | undefined);
  let resolvedRole = role as 'user' | 'assistant' | undefined;
  if (!resolvedRole) {
    const normalized = message.trim();
    const recentMatch = recentUserInputs.find((entry) => entry.text === normalized);
    if (recentMatch) resolvedRole = 'user';
  }

  const userMeta =
    parseUserMessageMeta(info) ??
    parseUserMessageMeta(messageObject as Record<string, unknown> | undefined);
  const messageTime =
    extractMessageTime(info) ??
    extractMessageTime(messageObject as Record<string, unknown> | undefined);

  const messageId =
    (part?.messageID as string | undefined) ??
    (messageObject?.id as string | undefined) ??
    (messageObject?.messageId as string | undefined) ??
    (info?.id as string | undefined) ??
    (properties?.messageId as string | undefined) ??
    (properties?.id as string | undefined) ??
    (data?.messageId as string | undefined) ??
    (data?.id as string | undefined) ??
    (record.messageId as string | undefined) ??
    (record.id as string | undefined) ??
    (properties?.sessionID as string | undefined);
  const id = (part?.id as string | undefined) ?? messageId ?? 'message:default';

  if (userMeta) {
    storeUserMessageMeta(messageId ?? id, userMeta);
  }
  if (typeof messageTime === 'number') {
    storeUserMessageTime(messageId ?? id, messageTime);
  }

  return {
    id,
    messageId,
    content: message,
    bodyContent: messageFromObject,
    role: resolvedRole,
    partId,
    partType,
    isPartUpdatedEvent: normalizeEventType(eventType) === 'messagepartupdated',
    userMeta,
    messageTime,
  };
}

function extractStepFinish(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  if (!MESSAGE_EVENT_TYPES.has(eventType)) return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const part =
    properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined;
  const partType = typeof part?.type === 'string' ? part.type : undefined;
  if (partType !== 'step-finish') return null;
  const reason = typeof part?.reason === 'string' ? (part.reason as string) : undefined;
  const sessionId = typeof part?.sessionID === 'string' ? (part.sessionID as string) : undefined;
  const messageId = typeof part?.messageID === 'string' ? (part.messageID as string) : undefined;
  return { reason, sessionId, messageId };
}

function extractMessageFinish(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const info =
    (properties?.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : undefined) ??
    (record.info && typeof record.info === 'object' ? (record.info as Record<string, unknown>) : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type || !type.toLowerCase().includes('message.updated')) return null;
  const finish =
    (typeof info?.finish === 'string' ? (info.finish as string) : undefined) ??
    (typeof record.finish === 'string' ? (record.finish as string) : undefined);
  const error = extractMessageError(info);
  if (!finish && !error) return null;
  const sessionId =
    typeof info?.sessionID === 'string'
      ? (info.sessionID as string)
      : typeof (record.sessionID as string | undefined) === 'string'
        ? (record.sessionID as string)
        : undefined;
  const messageId =
    typeof info?.id === 'string'
      ? (info.id as string)
      : typeof (info?.messageId as string | undefined) === 'string'
        ? (info.messageId as string)
        : undefined;
  const parentID =
    typeof info?.parentID === 'string' ? (info.parentID as string) : undefined;
  return { finish, sessionId, messageId, parentID, error };
}

function extractMessageError(info: Record<string, unknown> | undefined): { name: string; message: string } | null {
  const error = info?.error;
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : undefined;
  const message = typeof data?.message === 'string' ? data.message : (typeof record.message === 'string' ? record.message : '');
  if (!name) return null;
  return { name, message };
}

function extractSummaryDiffs(info: Record<string, unknown> | undefined): Array<MessageDiffEntry> {
  const summary = info?.summary && typeof info.summary === 'object'
    ? (info.summary as Record<string, unknown>)
    : undefined;
  const diffs = Array.isArray(summary?.diffs) ? summary.diffs : [];
  const result: Array<MessageDiffEntry> = [];
  for (const d of diffs) {
    if (!d || typeof d !== 'object') continue;
    const rec = d as Record<string, unknown>;
    const file = typeof rec.file === 'string' ? rec.file : '';
    const before = typeof rec.before === 'string' ? rec.before : undefined;
    const after = typeof rec.after === 'string' ? rec.after : undefined;
    if (!file) continue;
    result.push({ file, diff: '', before, after });
  }
  return result;
}

function upsertPrimaryAssistantIntoRound(
  sessionId: string,
  messageId: string,
  content: string,
  meta?: {
    agent?: string;
    model?: string;
    providerId?: string;
    modelId?: string;
    variant?: string;
    time?: number;
    usage?: MessageUsage;
    attachments?: Array<{ name: string; url: string; mediaType?: string }>;
  },
) {
  // Find the last round for this session
  let targetRoundIndex = -1;
  let targetRound: (typeof queue.value)[number] | undefined;
  for (let i = queue.value.length - 1; i >= 0; i--) {
    const entry = queue.value[i];
    if (entry?.isRound && entry.sessionId === sessionId) {
      targetRoundIndex = i;
      targetRound = entry;
      break;
    }
  }
  if (!targetRound || targetRoundIndex < 0) return;

  const roundId = targetRound.roundId ?? targetRound.messageId;
  if (!roundId) return;
  const roundMessageKey = buildMessageKey(roundId, sessionId);
  const assistantMessageKey = buildMessageKey(messageId, sessionId);

  // Inherit agent/model from the round's user message as fallback
  const roundAgent = targetRound.messageAgent;
  const roundModel = targetRound.messageModel;
  const roundProviderId = targetRound.messageProviderId;
  const roundModelId = targetRound.messageModelId;
  const roundVariant = targetRound.messageVariant;

  const existingRoundMessages = targetRound.roundMessages ?? [];
  const exactIndex = existingRoundMessages.findIndex((e) => e.messageId === messageId);
  const currentEntry = exactIndex >= 0 ? existingRoundMessages[exactIndex] : undefined;

  const roundMessage: RoundMessage = {
    messageId,
    role: 'assistant',
    content,
    attachments: meta?.attachments ?? currentEntry?.attachments,
    agent: meta?.agent ?? currentEntry?.agent ?? roundAgent,
    model: meta?.model ?? currentEntry?.model ?? roundModel,
    providerId: meta?.providerId ?? currentEntry?.providerId ?? roundProviderId,
    modelId: meta?.modelId ?? currentEntry?.modelId ?? roundModelId,
    variant: meta?.variant ?? currentEntry?.variant ?? roundVariant,
    time: meta?.time ?? currentEntry?.time,
    usage: meta?.usage ?? currentEntry?.usage,
  };

  const nextRoundMessages = [...existingRoundMessages];
  if (exactIndex >= 0) {
    // Same messageId — update in place (streaming content update)
    nextRoundMessages.splice(exactIndex, 1, roundMessage);
  } else {
    // New messageId — replace last assistant entry (fade transition)
    let lastAssistantIdx = -1;
    for (let i = nextRoundMessages.length - 1; i >= 0; i--) {
      if (nextRoundMessages[i]?.role === 'assistant') { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx >= 0) {
      nextRoundMessages.splice(lastAssistantIdx, 1, roundMessage);
    } else {
      nextRoundMessages.push(roundMessage);
    }
  }

  queue.value.splice(targetRoundIndex, 1, {
    ...targetRound,
    time: Date.now(),
    roundMessages: nextRoundMessages,
  });
  messageIndexById.set(roundMessageKey, targetRoundIndex);
  messageIndexById.set(assistantMessageKey, targetRoundIndex);
  messageContentById.set(assistantMessageKey, content);
  if (meta?.attachments && meta.attachments.length > 0) {
    messageAttachmentsById.set(assistantMessageKey, meta.attachments);
  }
  scheduleFollowScroll();
}

function applyMessageErrorToRound(
  sessionId: string | undefined,
  error: { name: string; message: string },
) {
  if (!sessionId) return;
  // Find the last round entry for this session and set the error
  for (let i = queue.value.length - 1; i >= 0; i--) {
    const entry = queue.value[i];
    if (entry?.isRound && entry.sessionId === sessionId) {
      queue.value.splice(i, 1, {
        ...entry,
        messageError: error,
      });
      return;
    }
  }
}

function promoteFinalAnswerToOutputPanel(
  messageFinish: { finish: string; sessionId?: string; messageId?: string; parentID?: string },
  fallbackSessionId?: string,
) {
  const resolvedSessionId = messageFinish.sessionId ?? fallbackSessionId;
  if (!resolvedSessionId) return;
  // Only promote for the primary (selected) session — subagent sessions use floating windows
  if (resolvedSessionId !== selectedSessionId.value) return;
  const sessionWindowId = `session:${resolvedSessionId}`;
  const sessionWindowKey = buildMessageKey(sessionWindowId, resolvedSessionId);
  const finalMessageId = messageFinish.messageId ?? sessionWindowId;
  const finalMessageKey = buildMessageKey(finalMessageId, resolvedSessionId);
  const content = messageContentById.get(finalMessageKey) ?? messageContentById.get(sessionWindowKey);
  if (!content || !content.trim()) return;

  // Build a stable key for this final answer using the actual message ID
  // Avoid duplicates — if this final answer is already in the OutputPanel, skip
  if (messageIndexById.has(finalMessageKey)) return;
  const roundId = messageFinish.parentID ?? finalMessageId;
  const roundMessageKey = buildMessageKey(roundId, resolvedSessionId);

  const existingUsage = messageUsageByKey.get(sessionWindowKey) ?? messageUsageByKey.get(finalMessageKey);
  const time = Date.now();
  const header = '';
  const text = `${header}${content}`;
  const messageColumns = 52;
  const visibleLines = 12;
  const lines = countWrappedLines(text, messageColumns);
  const overflowLines = Math.max(0, lines - visibleLines);
  const lineHeight = 16;
  const scrollDistance = Math.max(0, overflowLines * lineHeight);
  const scrollDuration =
    overflowLines > 0 ? Math.min(0.25, Math.max(0.08, overflowLines * 0.01)) : 0;
  const attachments = messageAttachmentsById.get(sessionWindowKey) ?? messageAttachmentsById.get(finalMessageKey);

  // Inherit agent/model display from an existing transient entry if it exists
  const sessionWindowIndex = messageIndexById.get(sessionWindowKey);
  const finalMessageIndex = messageIndexById.get(finalMessageKey);
  const sessionWindowEntry =
    finalMessageIndex !== undefined
      ? queue.value[finalMessageIndex]
      : sessionWindowIndex !== undefined
        ? queue.value[sessionWindowIndex]
        : undefined;
  const newSubMessage: RoundMessage = {
    messageId: finalMessageId,
    role: 'assistant',
    content,
    attachments,
    agent: sessionWindowEntry?.messageAgent,
    model: sessionWindowEntry?.messageModel,
    providerId: sessionWindowEntry?.messageProviderId,
    modelId: sessionWindowEntry?.messageModelId,
    variant: sessionWindowEntry?.messageVariant,
    usage: existingUsage,
  };

  const targetRoundIndex = queue.value.findIndex(
    (entry) =>
      entry.isRound &&
      entry.roundId === roundId &&
      entry.sessionId === resolvedSessionId,
  );
  if (targetRoundIndex >= 0) {
    const round = queue.value[targetRoundIndex];
    if (round) {
      const existingRoundMessages = round.roundMessages ?? [];
      if (existingRoundMessages.some((entry) => entry.messageId === finalMessageId)) return;
      round.roundMessages = [...existingRoundMessages, newSubMessage];
      messageIndexById.set(finalMessageKey, targetRoundIndex);
      messageContentById.set(finalMessageKey, content);
       if (existingUsage) messageUsageByKey.set(finalMessageKey, existingUsage);
       if (attachments && attachments.length > 0) {
         messageAttachmentsById.set(finalMessageKey, attachments);
       }
       scheduleFollowScroll();
      return;
    }
  }

  queue.value.push({
    time,
    expiresAt: time + 1000 * 60 * 30,
    x: 0,
    y: 0,
    header,
    content,
    role: 'assistant',
    messageAgent: sessionWindowEntry?.messageAgent,
    messageModel: sessionWindowEntry?.messageModel,
    messageProviderId: sessionWindowEntry?.messageProviderId,
    messageModelId: sessionWindowEntry?.messageModelId,
    messageUsage: existingUsage,
    messageVariant: sessionWindowEntry?.messageVariant,
    messageTime: undefined,
    scroll: overflowLines > 0,
    scrollDistance,
    scrollDuration,
     html: '',
     attachments,
     isWrite: false,
     isMessage: true,
     isSubagentMessage: false,
     isRound: true,
    roundId,
    roundMessages: [newSubMessage],
    roundDiffs: [],
    messageId: roundId,
    messageKey: roundMessageKey,
    sessionId: resolvedSessionId,
  });
  const createdRoundIndex = queue.value.length - 1;
  messageIndexById.set(roundMessageKey, createdRoundIndex);
  messageIndexById.set(finalMessageKey, createdRoundIndex);
  messageContentById.set(roundMessageKey, content);
  messageContentById.set(finalMessageKey, content);
  if (existingUsage) {
    messageUsageByKey.set(roundMessageKey, existingUsage);
    messageUsageByKey.set(finalMessageKey, existingUsage);
  }
  if (attachments && attachments.length > 0) {
    messageAttachmentsById.set(roundMessageKey, attachments);
    messageAttachmentsById.set(finalMessageKey, attachments);
  }

   scheduleFollowScroll();
}

function formatRetryTime(timestamp: number): string {
  const nextDate = new Date(timestamp);
  const now = Date.now();
  const diffMs = timestamp - now;

  const absolute = nextDate.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3/$1/$2');

  const diffSec = Math.max(0, Math.ceil(diffMs / 1000));
  const diffMin = Math.ceil(diffSec / 60);
  const diffHour = Math.ceil(diffMin / 60);

  let relative: string;
  if (diffHour > 1) {
    relative = `in ${diffHour} hours`;
  } else if (diffMin > 1) {
    relative = `in ${diffMin} minutes`;
  } else {
    relative = `in ${diffSec} seconds`;
  }

  return `${absolute} (${relative})`;
}

function extractSessionStatus(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);

  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;

  const normalized = normalizeEventType(type);
  if (normalized === 'sessionidle') {
    return { status: 'idle' as const };
  }
  if (!type.toLowerCase().includes('session.status')) return null;

  const status =
    (properties?.status as Record<string, unknown> | undefined) ??
    (record.status as Record<string, unknown> | undefined);
  const statusType = typeof status?.type === 'string' ? status.type : undefined;

  if (statusType === 'retry') {
    const message = typeof status?.message === 'string' ? status.message : 'Retrying...';
    const next = typeof status?.next === 'number' ? status.next : Date.now() + 60000;
    const attempt = typeof status?.attempt === 'number' ? status.attempt : 1;
    return { status: statusType, message, next, attempt };
  }

  return statusType ? { status: statusType } : null;
}

function applySessionStatusEvent(payload: unknown, eventType: string) {
  const sessionStatus = extractSessionStatus(payload, eventType);
  if (!sessionStatus) return;

  const sessionId = extractSessionId(payload);
  if (!sessionId || !allowedSessionIds.value.has(sessionId)) return;

  const projectId = selectedProjectId.value;
  if (!projectId) return;

  const isSelectedSession = sessionId === selectedSessionId.value;

  if (sessionStatus.status === 'busy' || sessionStatus.status === 'idle') {
    const nextStatus = sessionStatus.status as SessionStatusType;
    setSessionStatus(sessionId, nextStatus, projectId);
    if (isSelectedSession) retryStatus.value = null;
    updateSubagentExpiry(sessionId, nextStatus);
    updateReasoningExpiry(sessionId, nextStatus);
    return;
  }

  if (sessionStatus.status !== 'retry') return;

  setSessionStatus(sessionId, 'retry', projectId);
  if (!isSelectedSession) return;

  updateReasoningExpiry(sessionId, 'busy');
  if (sessionStatus.message && typeof sessionStatus.next === 'number') {
    retryStatus.value = {
      message: sessionStatus.message,
      next: sessionStatus.next,
      attempt: sessionStatus.attempt || 1,
    };
  }
}

function extractPtyEvent(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (!normalized.startsWith('pty')) return null;
  const infoRaw = properties?.info && typeof properties.info === 'object' ? properties.info : undefined;
  const info = parsePtyInfo(infoRaw);
  const id =
    (properties?.id as string | undefined) ??
    (info?.id as string | undefined) ??
    (record.id as string | undefined);
  const exitCode =
    typeof properties?.exitCode === 'number'
      ? properties.exitCode
      : typeof (properties as Record<string, unknown>)?.exitCode === 'string'
        ? Number(properties?.exitCode)
        : undefined;
  return { type, normalized, info, id, exitCode };
}

function extractPermissionAsked(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const data =
    (record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : undefined) ??
    (record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>) : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (
    normalized !== 'permissionasked' &&
    normalized !== 'permissionupdated' &&
    normalized !== 'permissionupdate'
  )
    return null;
  const request = properties ?? data;
  return parsePermissionRequest(request, extractSessionId(payload));
}

function extractPermissionReplied(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (normalized !== 'permissionreplied') return null;
  const requestID =
    (properties?.permissionID as string | undefined) ??
    (properties?.permissionId as string | undefined) ??
    (properties?.requestID as string | undefined) ??
    (properties?.id as string | undefined) ??
    (record.permissionID as string | undefined) ??
    (record.id as string | undefined);
  const replyCandidate =
    (properties?.response as string | undefined) ?? (properties?.reply as string | undefined);
  const reply =
    replyCandidate === 'once' || replyCandidate === 'always' || replyCandidate === 'reject'
      ? (replyCandidate as PermissionReply)
      : undefined;
  const sessionID =
    (properties?.sessionID as string | undefined) ??
    (properties?.sessionId as string | undefined) ??
    (properties?.session_id as string | undefined) ??
    extractSessionId(payload);
  if (!requestID) return null;
  return { requestID, reply, sessionID };
}

function extractQuestionAsked(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const data =
    (record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : undefined) ??
    (record.result && typeof record.result === 'object' ? (record.result as Record<string, unknown>) : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (
    normalized !== 'questionasked' &&
    normalized !== 'questionupdated' &&
    normalized !== 'questionupdate'
  )
    return null;
  const request = properties ?? data;
  return parseQuestionRequest(request, extractSessionId(payload));
}

function extractQuestionReplied(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (normalized !== 'questionreplied') return null;
  const requestID =
    (properties?.questionID as string | undefined) ??
    (properties?.questionId as string | undefined) ??
    (properties?.requestID as string | undefined) ??
    (properties?.id as string | undefined) ??
    (record.questionID as string | undefined) ??
    (record.id as string | undefined);
  if (!requestID) return null;
  return { requestID };
}

function extractQuestionRejected(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (normalized !== 'questionrejected') return null;
  const requestID =
    (properties?.questionID as string | undefined) ??
    (properties?.questionId as string | undefined) ??
    (properties?.requestID as string | undefined) ??
    (properties?.id as string | undefined) ??
    (record.questionID as string | undefined) ??
    (record.id as string | undefined);
  if (!requestID) return null;
  return { requestID };
}

function handlePtyEvent(event: {
  type: string;
  normalized: string;
  info: PtyInfo | null;
  id?: string;
  exitCode?: number;
}) {
  const sessionId = selectedSessionId.value;
  if (!sessionId) return;
  const tracked = getShellPtyIds(sessionId);
  const ptyId = event.id ?? event.info?.id;
  if (!ptyId || !tracked.has(ptyId)) return;
  if (event.normalized === 'ptyexited' || event.normalized === 'ptydeleted') {
    removeShellWindow(ptyId);
    return;
  }
  if (event.info) {
    const existing = shellSessionsByPtyId.get(event.info.id);
    if (existing) {
      existing.pty = event.info;
      existing.entry.shellTitle = event.info.title || existing.entry.shellTitle;
    }
    if (event.info.status === 'exited') {
      removeShellWindow(event.info.id);
    }
  }
}

function buildPermissionEntry(request: PermissionRequest): FileReadEntry {
  const time = Date.now();
  const width = PERMISSION_WINDOW_WIDTH;
  const height = PERMISSION_WINDOW_HEIGHT;
  const randomPosition = getRandomWindowPosition({ width, height });
  return {
    time,
    expiresAt: Number.MAX_SAFE_INTEGER,
    x: randomPosition.x,
    y: randomPosition.y,
    header: '',
    path: undefined,
    content: '',
    scroll: false,
    scrollDistance: 0,
    scrollDuration: 0,
    html: '',
    isWrite: false,
    isMessage: false,
    isPermission: true,
    permissionId: request.id,
    permissionRequest: request,
    sessionId: request.sessionID,
    width,
    height,
    zIndex: nextWindowZ(),
  };
}

function upsertPermissionEntry(request: PermissionRequest) {
  const existingIndex = queue.value.findIndex(
    (entry) => entry.isPermission && entry.permissionId === request.id,
  );
  if (existingIndex >= 0) {
    const existing = queue.value[existingIndex];
    if (!existing) return;
    queue.value.splice(existingIndex, 1, {
      ...existing,
      permissionId: request.id,
      permissionRequest: request,
      sessionId: request.sessionID,
      expiresAt: Number.MAX_SAFE_INTEGER,
      isPermission: true,
    });
    return;
  }
  queue.value.push(buildPermissionEntry(request));
}

function removePermissionEntry(requestId: string) {
  const existingIndex = queue.value.findIndex(
    (entry) => entry.isPermission && entry.permissionId === requestId,
  );
  if (existingIndex < 0) return;
  queue.value.splice(existingIndex, 1);
  clearPermissionSending(requestId);
  clearPermissionError(requestId);
}

function setPermissionSending(requestId: string, value: boolean) {
  const next = { ...permissionSendingById.value };
  if (value) next[requestId] = true;
  else delete next[requestId];
  permissionSendingById.value = next;
}

function clearPermissionSending(requestId: string) {
  setPermissionSending(requestId, false);
}

function setPermissionError(requestId: string, message: string) {
  const next = { ...permissionErrorById.value };
  if (message) next[requestId] = message;
  else delete next[requestId];
  permissionErrorById.value = next;
}

function clearPermissionError(requestId: string) {
  setPermissionError(requestId, '');
}

function isPermissionSubmitting(requestId: string) {
  return Boolean(permissionSendingById.value[requestId]);
}

function getPermissionError(requestId: string) {
  return permissionErrorById.value[requestId] ?? '';
}

function isPermissionSessionAllowed(request: PermissionRequest) {
  const allowed = allowedSessionIds.value;
  if (!request.sessionID) return false;
  if (allowed.size === 0) return false;
  return allowed.has(request.sessionID);
}

function prunePermissionEntries() {
  const allowed = allowedSessionIds.value;
  const toRemove = new Set<string>();
  queue.value.forEach((entry) => {
    if (!entry.isPermission || !entry.permissionRequest) return;
    if (!allowed.has(entry.permissionRequest.sessionID)) {
      toRemove.add(entry.permissionRequest.id);
    }
  });
  toRemove.forEach((requestId) => removePermissionEntry(requestId));
}

async function sendPermissionReply(requestId: string, reply: PermissionReply) {
  const directory = activeDirectory.value.trim();
  await opencodeApi.replyPermission(OPENCODE_BASE_URL, requestId, {
    directory: directory || undefined,
    reply,
  });
}

async function handlePermissionReply(payload: { requestId: string; reply: PermissionReply }) {
  const { requestId, reply } = payload;
  if (isPermissionSubmitting(requestId)) return;
  clearPermissionError(requestId);
  setPermissionSending(requestId, true);
  try {
    await sendPermissionReply(requestId, reply);
    removePermissionEntry(requestId);
  } catch (error) {
    setPermissionError(requestId, toErrorMessage(error));
  } finally {
    clearPermissionSending(requestId);
  }
}

function buildQuestionEntry(request: QuestionRequest): FileReadEntry {
  const time = Date.now();
  const width = QUESTION_WINDOW_WIDTH;
  const height = QUESTION_WINDOW_HEIGHT;
  const randomPosition = getRandomWindowPosition({ width, height });
  return {
    time,
    expiresAt: Number.MAX_SAFE_INTEGER,
    x: randomPosition.x,
    y: randomPosition.y,
    header: '',
    path: undefined,
    content: '',
    scroll: false,
    scrollDistance: 0,
    scrollDuration: 0,
    html: '',
    isWrite: false,
    isMessage: false,
    isQuestion: true,
    questionId: request.id,
    questionRequest: request,
    sessionId: request.sessionID,
    width,
    height,
    zIndex: nextWindowZ(),
  };
}

function upsertQuestionEntry(request: QuestionRequest) {
  const existingIndex = queue.value.findIndex((entry) => entry.isQuestion && entry.questionId === request.id);
  if (existingIndex >= 0) {
    const existing = queue.value[existingIndex];
    if (!existing) return;
    queue.value.splice(existingIndex, 1, {
      ...existing,
      questionId: request.id,
      questionRequest: request,
      sessionId: request.sessionID,
      expiresAt: Number.MAX_SAFE_INTEGER,
      isQuestion: true,
    });
    return;
  }
  queue.value.push(buildQuestionEntry(request));
}

function removeQuestionEntry(requestId: string) {
  const existingIndex = queue.value.findIndex((entry) => entry.isQuestion && entry.questionId === requestId);
  if (existingIndex < 0) return;
  queue.value.splice(existingIndex, 1);
  clearQuestionSending(requestId);
  clearQuestionError(requestId);
}

function setQuestionSending(requestId: string, value: boolean) {
  const next = { ...questionSendingById.value };
  if (value) next[requestId] = true;
  else delete next[requestId];
  questionSendingById.value = next;
}

function clearQuestionSending(requestId: string) {
  setQuestionSending(requestId, false);
}

function setQuestionError(requestId: string, message: string) {
  const next = { ...questionErrorById.value };
  if (message) next[requestId] = message;
  else delete next[requestId];
  questionErrorById.value = next;
}

function clearQuestionError(requestId: string) {
  setQuestionError(requestId, '');
}

function isQuestionSubmitting(requestId: string) {
  return Boolean(questionSendingById.value[requestId]);
}

function getQuestionError(requestId: string) {
  return questionErrorById.value[requestId] ?? '';
}

function isQuestionSessionAllowed(request: QuestionRequest) {
  const allowed = allowedSessionIds.value;
  if (!request.sessionID) return false;
  if (allowed.size === 0) return false;
  return allowed.has(request.sessionID);
}

function pruneQuestionEntries() {
  const allowed = allowedSessionIds.value;
  const toRemove = new Set<string>();
  queue.value.forEach((entry) => {
    if (!entry.isQuestion || !entry.questionRequest) return;
    if (!allowed.has(entry.questionRequest.sessionID)) {
      toRemove.add(entry.questionRequest.id);
    }
  });
  toRemove.forEach((requestId) => removeQuestionEntry(requestId));
}

function normalizeQuestionAnswers(answers: QuestionAnswer[]) {
  return answers.map((answer) => {
    if (!Array.isArray(answer)) return [];
    const cleaned = answer
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);
    return Array.from(new Set(cleaned));
  });
}

async function sendQuestionReply(requestId: string, answers: QuestionAnswer[]) {
  const directory = activeDirectory.value.trim();
  await opencodeApi.replyQuestion(OPENCODE_BASE_URL, requestId, {
    directory: directory || undefined,
    answers: normalizeQuestionAnswers(answers),
  });
}

async function sendQuestionReject(requestId: string) {
  const directory = activeDirectory.value.trim();
  await opencodeApi.rejectQuestion(OPENCODE_BASE_URL, requestId, directory || undefined);
}

async function handleQuestionReply(payload: { requestId: string; answers: QuestionAnswer[] }) {
  const { requestId, answers } = payload;
  if (isQuestionSubmitting(requestId)) return;
  clearQuestionError(requestId);
  setQuestionSending(requestId, true);
  try {
    await sendQuestionReply(requestId, answers);
    removeQuestionEntry(requestId);
  } catch (error) {
    setQuestionError(requestId, toErrorMessage(error));
  } finally {
    clearQuestionSending(requestId);
  }
}

async function handleQuestionReject(requestId: string) {
  if (isQuestionSubmitting(requestId)) return;
  clearQuestionError(requestId);
  setQuestionSending(requestId, true);
  try {
    await sendQuestionReject(requestId);
    removeQuestionEntry(requestId);
  } catch (error) {
    setQuestionError(requestId, toErrorMessage(error));
  } finally {
    clearQuestionSending(requestId);
  }
}

function registerMessageMeta(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined;
  const info =
    properties?.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : undefined;

  const id =
    (info?.id as string | undefined) ??
    (properties?.id as string | undefined) ??
    (record.id as string | undefined);
  const role =
    (info?.role as string | undefined) ??
    (properties?.role as string | undefined) ??
    (record.role as string | undefined);
  const meta = parseUserMessageMeta(info);
  const messageTime = extractMessageTime(info);

  if (id && role === 'user') {
    userMessageIds.add(id);
  }
  if (id && meta) {
    storeUserMessageMeta(id, meta);
    applyUserMessageMetaToQueue(id, meta);
  }
  if (id && typeof messageTime === 'number') {
    storeUserMessageTime(id, messageTime);
    applyUserMessageTimeToQueue(id, messageTime);
  }
}

function registerMessageSummary(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const info =
    properties?.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : undefined;
  const summary =
    (info?.summary && typeof info.summary === 'object'
      ? (info.summary as Record<string, unknown>)
      : undefined) ??
    (properties?.summary && typeof properties.summary === 'object'
      ? (properties.summary as Record<string, unknown>)
      : undefined) ??
    (record.summary && typeof record.summary === 'object'
      ? (record.summary as Record<string, unknown>)
      : undefined);
  const id =
    (info?.id as string | undefined) ??
    (properties?.id as string | undefined) ??
    (record.id as string | undefined);
  const title = typeof summary?.title === 'string' ? summary.title : undefined;
  if (id && title) messageSummaryTitleById.set(id, title);

  if (id && summary) {
    const diffs = extractSummaryDiffs({ summary } as Record<string, unknown>);
    const roundIndex = queue.value.findIndex(
      (entry) => entry.isRound && entry.roundId === id,
    );
     if (roundIndex >= 0) {
       const roundEntry = queue.value[roundIndex];
       if (roundEntry) {
         roundEntry.roundDiffs = diffs;
         const messageKey = buildMessageKey(roundEntry.roundId ?? id, roundEntry.sessionId);
         messageDiffsByKey.set(messageKey, diffs);
       }
       return;
     }
  }
}

function collectDiffsFromToolPart(
  tool: string,
  metadata: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Array<{ file: string; diff: string }> {
  const collected: Array<{ file: string; diff: string }> = [];
  if (tool === 'edit') {
    const diff = typeof metadata?.diff === 'string' ? metadata.diff : '';
    const filePath = typeof input?.filePath === 'string' ? input.filePath : '';
    if (diff.trim() && filePath) {
      collected.push({ file: resolveWorktreeRelativePath(filePath) || filePath, diff });
    }
  } else if (tool === 'multiedit') {
    const results = Array.isArray(metadata?.results) ? metadata.results : [];
    const filePath = typeof input?.filePath === 'string' ? input.filePath : '';
    results.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const diff = (item as Record<string, unknown>).diff;
      if (typeof diff === 'string' && diff.trim() && filePath) {
        collected.push({ file: resolveWorktreeRelativePath(filePath) || filePath, diff });
      }
    });
  } else if (tool === 'apply_patch') {
    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    files.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const rec = item as Record<string, unknown>;
      const diff = typeof rec.diff === 'string' ? rec.diff : '';
      const filePath = typeof rec.file === 'string' ? rec.file : '';
      if (diff.trim() && filePath) {
        collected.push({ file: resolveWorktreeRelativePath(filePath) || filePath, diff });
      }
    });
  }
  return collected;
}

function extractMessageDiffsFromParts(parts: unknown[], messageId: string, sessionId: string) {
  const messageKey = buildMessageKey(messageId, sessionId);
  const collected: Array<{ file: string; diff: string }> = [];
  parts.forEach((part) => {
    if (!part || typeof part !== 'object') return;
    const p = part as Record<string, unknown>;
    if (p.type !== 'tool') return;
    const tool = typeof p.tool === 'string' ? p.tool : '';
    registerPartType(messageKey, 'tool');
    const state =
      p.state && typeof p.state === 'object'
        ? (p.state as Record<string, unknown>)
        : undefined;
    if (!state) return;
    const metadata =
      state.metadata && typeof state.metadata === 'object'
        ? (state.metadata as Record<string, unknown>)
        : undefined;
    const input =
      state.input && typeof state.input === 'object'
        ? (state.input as Record<string, unknown>)
        : undefined;
    collected.push(...collectDiffsFromToolPart(tool, metadata, input));
  });
  if (collected.length > 0) {
    messageDiffsByKey.set(messageKey, collected);
  }
}

function registerMessageDiff(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const part =
    properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined;
  if (!part || part.type !== 'tool') return;
  const tool = typeof part.tool === 'string' ? part.tool : '';
  const state =
    part.state && typeof part.state === 'object'
      ? (part.state as Record<string, unknown>)
      : undefined;
  if (!state) return;
  const metadata =
    state.metadata && typeof state.metadata === 'object'
      ? (state.metadata as Record<string, unknown>)
      : undefined;
  const input =
    state.input && typeof state.input === 'object'
      ? (state.input as Record<string, unknown>)
      : undefined;
  const messageId =
    (part.messageID as string | undefined) ??
    (part.messageId as string | undefined);
  const sessionId =
    (typeof part.sessionID === 'string' ? (part.sessionID as string) : undefined) ??
    extractSessionId(payload);
  if (!messageId) return;
  const messageKey = buildMessageKey(messageId, sessionId);
  registerPartType(messageKey, 'tool');
  const collected = collectDiffsFromToolPart(tool, metadata, input);
  if (collected.length > 0) {
    const existing = messageDiffsByKey.get(messageKey) ?? [];
    messageDiffsByKey.set(messageKey, [...existing, ...collected]);
  }
}

function extractSessionInfo(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (typeof type !== 'string' || !type.startsWith('session.')) return null;
  const info =
    properties?.info && typeof properties.info === 'object'
      ? (properties.info as Record<string, unknown>)
      : undefined;
  if (!info || typeof info.id !== 'string') return null;
  const sessionInfo: SessionInfo = { id: info.id as string };
  if (typeof info.projectID === 'string') sessionInfo.projectID = info.projectID as string;
  if (typeof info.parentID === 'string') sessionInfo.parentID = info.parentID as string;
  if (typeof info.title === 'string') sessionInfo.title = info.title as string;
  if (typeof info.slug === 'string') sessionInfo.slug = info.slug as string;
  if (typeof info.directory === 'string') sessionInfo.directory = info.directory as string;
  return sessionInfo;
}

function extractWorktreeReady(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (normalized !== 'worktreeready') return null;
  const directory =
    (typeof record.directory === 'string' && record.directory) ||
    (typeof nestedPayload?.directory === 'string' && nestedPayload.directory) ||
    (typeof properties?.directory === 'string' && properties.directory)
      ? String(record.directory ?? nestedPayload?.directory ?? properties?.directory)
      : undefined;
  if (!directory) return null;
  const branch = typeof properties?.branch === 'string' ? properties.branch : undefined;
  return { directory, branch };
}

function extractProjectUpdated(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type) return null;
  const normalized = normalizeEventType(type);
  if (normalized !== 'projectupdated' && normalized !== 'projectupdate') return null;
  const id =
    (typeof properties?.id === 'string' && properties.id) ||
    (typeof record.id === 'string' && record.id) ||
    undefined;
  if (!id) return null;
  const worktree = typeof properties?.worktree === 'string' ? properties.worktree : undefined;
  const sandboxes = Array.isArray(properties?.sandboxes)
    ? properties.sandboxes.filter((entry) => typeof entry === 'string')
    : undefined;
  return { id, worktree, sandboxes } as ProjectInfo;
}

function upsertToolEntry(
  entry: {
    content: string;
    path?: string;
    isWrite: boolean;
    callId?: string;
    toolStatus?: string;
    toolName?: string;
    toolTitle?: string;
    lang?: string;
    view?: FileReadEntry['view'];
    grepPattern?: string;
    wrapMode?: FileReadEntry['toolWrapMode'];
    gutterMode?: FileReadEntry['toolGutterMode'];
    gutterLines?: string[];
    readOffset?: number;
    readLimit?: number;
  },
  eventType: string,
) {
  if (entry.toolStatus === 'pending') return;

  if (entry.callId && entry.toolStatus) {
    if (entry.toolStatus === 'running') runningToolIds.add(entry.callId);
    else runningToolIds.delete(entry.callId);
  }

  if (!entry.content.trim() && entry.toolStatus !== 'running') {
    if (!entry.callId || !toolIndexByCallId.has(entry.callId)) return;
  }

  const resolveExpiry = (status: string | undefined, time: number, fallback: number) => {
    if (status === 'running') return Number.MAX_SAFE_INTEGER;
    if (status === 'completed' || status === 'error') {
      return Math.max(fallback, time + TOOL_COMPLETE_TTL_MS);
    }
    if (status === 'pending') return Math.max(fallback, time + TOOL_PENDING_TTL_MS);
    return fallback;
  };

  const isBashTool = entry.toolName === 'bash';
  const displayPath = resolveWorktreeRelativePath(entry.path);
  const hideHeader = Boolean(entry.toolName);
  const header = isBashTool || hideHeader
    ? ''
    : displayPath
      ? `# ${displayPath}\n\n`
      : eventType !== 'message'
        ? `# ${eventType}\n\n`
        : '';
  const time = Date.now();
  const scrollDistance = 0;
  const scrollDuration = 0;
  const defaultExpiry = time + Math.ceil((scrollDuration || 0) * 1000 + TOOL_SCROLL_HOLD_MS);
  const expiresAt = resolveExpiry(entry.toolStatus, time, defaultExpiry);
  const autoDetectedDiff = !entry.view && detectDiffLike(entry.content, entry.path);
  const lang = entry.lang ?? guessLanguage(entry.path, eventType);
  const view: FileReadEntry['view'] = entry.view ?? (autoDetectedDiff ? 'diff' : undefined);

  if (entry.callId) {
    const existingIndex = toolIndexByCallId.get(entry.callId);
    if (existingIndex !== undefined) {
      const existing = queue.value[existingIndex];
      if (existing) {
         // Lightweight status-only update: when the incoming event carries no
         // new visual content we just patch metadata in-place to avoid a full
         // reactive splice (which would re-trigger enter animations / scrolls).
         // Covers:
         //   - completed/error arriving after content was already set (e.g. edit
         //     diff shown during running, then same diff on completed)
         //   - running→completed where entry.content is empty (apply_patch
         //     completed events carry content:'')
         const incomingHasContent = entry.content.trim().length > 0;
         const existingHasContent = existing.content.trim().length > 0;
         const isStatusOnlyUpdate =
           entry.toolStatus &&
           entry.toolStatus !== 'running' &&
           entry.toolStatus !== 'pending' &&
           existingHasContent &&
           (
             // Case 1: existing is NOT running (duplicate completed/error)
             existing.toolStatus !== 'running' ||
             // Case 2: existing IS running but incoming has no new content
             !incomingHasContent ||
             // Case 3: existing IS running and incoming content is identical
             entry.content.trim() === existing.content.trim()
           );
        if (isStatusOnlyUpdate) {
          const nextExpiresAt = resolveExpiry(entry.toolStatus, time, defaultExpiry);
          existing.time = time;
          existing.expiresAt = nextExpiresAt;
          existing.toolStatus = entry.toolStatus;
          existing.toolTitle = entry.toolTitle ?? existing.toolTitle;
          return;
        }
        const nextPath = entry.path ?? existing.path;
        const nextDisplayPath = resolveWorktreeRelativePath(nextPath);
        const nextHeader = isBashTool || hideHeader
          ? ''
          : nextDisplayPath
            ? `# ${nextDisplayPath}\n\n`
            : eventType !== 'message'
              ? `# ${eventType}\n\n`
              : '';
        const nextContent = entry.content.trim().length > 0
          ? entry.content
          : existing.content;
        const nextWrapMode = entry.wrapMode ?? existing.toolWrapMode;
        const nextGutterMode = entry.gutterMode ?? existing.toolGutterMode;
        const nextGutterLines = entry.gutterLines ?? existing.toolGutterLines;
        const nextGrepPattern = entry.grepPattern ?? existing.grepPattern;
        const nextAutoDetectedDiff = !entry.view && !existing.view && detectDiffLike(nextContent, nextPath);
        const nextLang =
          entry.lang ??
          existing.lang ??
          guessLanguage(nextPath, eventType);
        const nextView: FileReadEntry['view'] = entry.view ?? existing.view ?? (nextAutoDetectedDiff ? 'diff' : undefined);
        const toolKey =
          existing.toolKey ?? entry.callId ?? `${nextPath ?? entry.toolName ?? 'tool'}:${time}`;
        const nextExpiresAt = resolveExpiry(entry.toolStatus, time, defaultExpiry);
        queue.value.splice(existingIndex, 1, {
          ...existing,
          time,
          expiresAt: nextExpiresAt,
          header: nextHeader,
          path: nextPath,
          toolKey,
          content: nextContent,
          scroll: false,
          scrollDistance,
          scrollDuration,
    scrollDelay: 0.15,
          html: '',
          isWrite: entry.isWrite,
          isMessage: false,
          callId: entry.callId,
          toolStatus: entry.toolStatus,
          toolName: entry.toolName,
          toolTitle: entry.toolTitle ?? existing.toolTitle,
          lang: nextLang,
          view: nextView,
          grepPattern: nextGrepPattern,
          toolWrapMode: nextWrapMode,
          toolGutterMode: nextGutterMode,
          toolGutterLines: nextGutterLines,
          readLineOffset: entry.readOffset ?? existing.readLineOffset,
          readLineLimit: entry.readLimit ?? existing.readLineLimit,
        });
        toolIndexByCallId.set(entry.callId, existingIndex);
        scheduleToolScrollAnimation(toolKey);
        return;
      }
    }
  }

  const toolKey = entry.callId ?? `${entry.path ?? entry.toolName ?? 'tool'}:${time}`;
  const randomPosition = getRandomWindowPosition();
  queue.value.push({
    time,
    expiresAt,
    x: randomPosition.x,
    y: randomPosition.y,
    header,
    path: entry.path,
    toolKey,
    content: entry.content,
    scroll: false,
    scrollDistance,
    scrollDuration,
    scrollDelay: 0,
    html: '',
    isWrite: entry.isWrite,
    isMessage: false,
    callId: entry.callId,
    toolStatus: entry.toolStatus,
    toolName: entry.toolName,
    toolTitle: entry.toolTitle,
    lang,
    view,
    grepPattern: entry.grepPattern,
    toolWrapMode: entry.wrapMode,
    toolGutterMode: entry.gutterMode,
    toolGutterLines: entry.gutterLines,
    readLineOffset: entry.readOffset,
    readLineLimit: entry.readLimit,
    zIndex: nextWindowZ(),
  });
  if (entry.callId) toolIndexByCallId.set(entry.callId, queue.value.length - 1);
  scheduleToolScrollAnimation(toolKey);
}

function registerGlobalEventHook(
  handler: (payload: unknown, eventType: string) => void,
) {
  globalEventHooks.add(handler);
  return () => globalEventHooks.delete(handler);
}

function notifyGlobalEventHooks(payload: unknown, eventType: string) {
  globalEventHooks.forEach((handler) => {
    try {
      handler(payload, eventType);
    } catch (error) {
      log('global event hook failed', error);
    }
  });
}

function extractEventDirectory(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const nestedPayload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : undefined;
  const properties =
    (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
      ? (nestedPayload.properties as Record<string, unknown>)
      : undefined) ??
    (record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : undefined);
  const value =
    (typeof record.directory === 'string' ? record.directory : undefined) ??
    (typeof nestedPayload?.directory === 'string' ? nestedPayload.directory : undefined) ??
    (typeof properties?.directory === 'string' ? properties.directory : undefined);
  return value?.trim() ?? '';
}


const src = shallowRef<EventSource>();
function connect() {
  if (src.value) return;

  log('connecting...');
  src.value = new EventSource(`${OPENCODE_BASE_URL}/global/event`);

  src.value.addEventListener('open', (e) => {
    log('connected.');
  });
  const handleEvent = (e: MessageEvent) => {
    const payload = parsePayload(e.data);
    const payloadText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    log(payloadText);

    const resolvedEventType = resolveEventType(payload, e.type);
    notifyGlobalEventHooks(payload, resolvedEventType);

    const permissionReplied = extractPermissionReplied(payload, resolvedEventType);
    if (permissionReplied) {
      removePermissionEntry(permissionReplied.requestID);
      return;
    }
    const questionReplied = extractQuestionReplied(payload, resolvedEventType);
    if (questionReplied) {
      removeQuestionEntry(questionReplied.requestID);
      return;
    }
    const questionRejected = extractQuestionRejected(payload, resolvedEventType);
    if (questionRejected) {
      removeQuestionEntry(questionRejected.requestID);
      return;
    }
    const permissionAsked = extractPermissionAsked(payload, resolvedEventType);
    if (permissionAsked) {
      if (isPermissionSessionAllowed(permissionAsked)) {
        upsertPermissionEntry(permissionAsked);
      }
      return;
    }
    const questionAsked = extractQuestionAsked(payload, resolvedEventType);
    if (questionAsked) {
      if (isQuestionSessionAllowed(questionAsked)) {
        upsertQuestionEntry(questionAsked);
      }
      return;
    }

    const worktreeReady = extractWorktreeReady(payload, resolvedEventType);
    if (worktreeReady) {
      void handleWorktreeReady(worktreeReady);
    }

    const projectUpdated = extractProjectUpdated(payload, resolvedEventType);
    if (projectUpdated) {
      upsertProject(projectUpdated);
      if (selectedProjectId.value && projectUpdated.id === selectedProjectId.value) {
        const list = projectSessionDirectories(projectUpdated);
        if (list.length === 0) {
          return;
        }
        const current = selectedWorktreeDir.value;
        if (current && !list.includes(current)) list.unshift(current);
        const baseDir = projectBaseDirectory(projectUpdated);
        if (baseDir && !list.includes(baseDir)) list.unshift(baseDir);
        worktrees.value = list;
      }
    }

    const sessionInfo = extractSessionInfo(payload, resolvedEventType);
    if (sessionInfo) {
      if (matchesSelectedProject(sessionInfo)) {
        const matchesWorktree = matchesSelectedWorktree(sessionInfo);
        if (isSessionDeleteEvent(resolvedEventType)) {
          removeSessionFromGraph(sessionInfo.id);
          deleteSessionStatus(sessionInfo.id, sessionInfo.projectID);
          if (matchesWorktree) {
            sessions.value = sessions.value.filter((session) => session.id !== sessionInfo.id);
          }
          if (selectedSessionId.value === sessionInfo.id) selectedSessionId.value = '';
        } else {
          upsertSessionGraph(sessionInfo);
          if (matchesWorktree) {
            upsertSessionFromEvent(sessionInfo);
          }
          if (
            sessionInfo.directory &&
            sessionInfo.projectID &&
            selectedProjectId.value &&
            sessionInfo.projectID === selectedProjectId.value
          ) {
            appendWorktreeDirectory(sessionInfo.directory);
          }
          if (sessionInfo.parentID) {
            subagentSessionExpiry.set(sessionInfo.id, Date.now() + SUBAGENT_ACTIVE_TTL_MS);
          }
        }
      }
    }

    const sessionId = extractSessionId(payload);
    if (sessionId && selectedSessionId.value && !allowedSessionIds.value.has(sessionId)) return;

    if (resolvedEventType && resolvedEventType.startsWith('session.diff')) {
      const selectedId = selectedSessionId.value;
      if (!selectedId) {
        updateSessionDiffState([]);
        return;
      }
      const directory = activeDirectory.value.trim();
      if (!directory) {
        updateSessionDiffState([]);
        return;
      }
      if (sessionId && sessionId !== selectedId) return;
      const eventDirectory = extractEventDirectory(payload);
      if (eventDirectory && normalizeDirectory(eventDirectory) !== normalizeDirectory(directory)) return;
      const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
      const payloadObj =
        record?.payload && typeof record.payload === 'object'
          ? (record.payload as Record<string, unknown>)
          : undefined;
      const properties =
        payloadObj?.properties && typeof payloadObj.properties === 'object'
          ? (payloadObj.properties as Record<string, unknown>)
          : undefined;
      const diffEntries =
        (properties?.diff as unknown[] | undefined) ?? (payloadObj?.diff as unknown[] | undefined);
      if (Array.isArray(diffEntries)) {
        const entries = normalizeSessionDiffEntries(diffEntries);
        updateSessionDiffState(entries);
      } else {
        void refreshSessionDiff();
      }
      return;
    }

    const canRenderSession = Boolean(selectedSessionId.value);
    if (!canRenderSession) return;

    const todoUpdate = extractTodoUpdated(payload, resolvedEventType);
    if (todoUpdate && allowedSessionIds.value.has(todoUpdate.sessionID)) {
      todosBySessionId.value = {
        ...todosBySessionId.value,
        [todoUpdate.sessionID]: todoUpdate.todos,
      };
      if (todoErrorBySessionId.value[todoUpdate.sessionID]) {
        const nextErrors = { ...todoErrorBySessionId.value };
        delete nextErrors[todoUpdate.sessionID];
        todoErrorBySessionId.value = nextErrors;
      }
    }

    const ptyEvent = extractPtyEvent(payload, resolvedEventType);
    if (ptyEvent) handlePtyEvent(ptyEvent);

    registerMessageMeta(payload);
    registerMessageSummary(payload);
    registerMessageDiff(payload);

    const attachmentUpdate = extractMessageAttachments(payload);
    if (attachmentUpdate?.messageId) {
      const attachmentKey = buildMessageKey(attachmentUpdate.messageId, sessionId);
      const mergedAttachments = normalizeAttachments([
        ...(messageAttachmentsById.get(attachmentKey) ?? []),
        ...attachmentUpdate.attachments,
      ]);
      messageAttachmentsById.set(attachmentKey, mergedAttachments);
      const existingAttachmentIndex = messageIndexById.get(attachmentKey);
      if (existingAttachmentIndex !== undefined) {
        const existing = queue.value[existingAttachmentIndex];
        if (existing) {
          queue.value.splice(existingAttachmentIndex, 1, {
            ...existing,
            attachments: mergedAttachments,
          });
        }
      }
    }

      const stepFinish = extractStepFinish(payload, resolvedEventType);
      if (stepFinish) {
        if (markReasoningFinished(stepFinish.sessionId ?? sessionId, stepFinish.messageId)) {
          scheduleReasoningClose(stepFinish.sessionId ?? sessionId);
        }
      }

    const usageUpdate = extractUsageUpdate(payload, resolvedEventType);
    if (usageUpdate) {
      applyMessageUsageToQueue(
        usageUpdate.messageId,
        usageUpdate.sessionId ?? sessionId,
        usageUpdate.usage,
      );
    }

    const messageFinish = extractMessageFinish(payload, resolvedEventType);
    if (messageFinish) {
      if (markReasoningFinished(messageFinish.sessionId ?? sessionId, messageFinish.messageId)) {
        scheduleReasoningClose(messageFinish.sessionId ?? sessionId);
      }
      if (messageFinish.error) {
        applyMessageErrorToRound(messageFinish.sessionId ?? sessionId, messageFinish.error);
      }
      if (messageFinish.finish === 'stop') {
        promoteFinalAnswerToOutputPanel(messageFinish, sessionId);
        // After a full response completes for the selected session,
        // sync statuses with the API to recover from any missed SSE events.
        const finishSessionId = messageFinish.sessionId ?? sessionId;
        if (finishSessionId === selectedSessionId.value) {
          void fetchSessionStatus(activeDirectory.value || undefined);
        }
      }
    }

    const patchEvents = extractPatch(payload);
    if (patchEvents) {
      patchEvents.forEach((patchEvent) => {
        upsertToolEntry(patchEvent, e.type);
      });
      return;
    }

    const fileReadResult = extractFileRead(payload, resolvedEventType);
    const fileReads = fileReadResult
      ? Array.isArray(fileReadResult) ? fileReadResult : [fileReadResult]
      : null;
    if (!fileReads) {
      const message = extractMessage(payload, resolvedEventType);
      if (!message) {
        if (attachmentUpdate?.messageId && attachmentUpdate.attachments.length > 0) {
          const attachmentKey = buildMessageKey(attachmentUpdate.messageId, sessionId);
          if (!messageIndexById.has(attachmentKey)) {
            const isSubagentMessage = Boolean(
              sessionId && selectedSessionId.value && sessionId !== selectedSessionId.value,
            );
            const header = '';
            const time = Date.now();
            const text = '';
            const messageColumns = 52;
            const visibleLines = 12;
            const lines = countWrappedLines(text, messageColumns);
            const overflowLines = Math.max(0, lines - visibleLines);
            const lineHeight = 16;
            const scrollDistance = Math.max(0, overflowLines * lineHeight);
            const scrollDuration =
              overflowLines > 0 ? Math.min(0.25, Math.max(0.08, overflowLines * 0.01)) : 0;
            const attachments = messageAttachmentsById.get(attachmentKey) ?? [];
            const isUserMessage = userMessageIds.has(attachmentUpdate.messageId);
            const randomPosition = isSubagentMessage ? getRandomWindowPosition() : { x: 0, y: 0 };
            queue.value.push({
              time,
              expiresAt: isSubagentMessage ? getSubagentExpiry(sessionId) : time + 1000 * 60 * 30,
              x: randomPosition.x,
              y: randomPosition.y,
              header,
              content: '',
              role: isUserMessage ? 'user' : 'assistant',
              scroll: !isSubagentMessage && overflowLines > 0,
              scrollDistance: isSubagentMessage ? 0 : scrollDistance,
              scrollDuration: isSubagentMessage ? 0 : scrollDuration,
              html: '',
              attachments,
              isWrite: false,
              isMessage: true,
              isSubagentMessage,
              messageId: attachmentUpdate.messageId,
              messageKey: attachmentKey,
              follow: isSubagentMessage ? true : undefined,
              sessionId,
              messageUsage: messageUsageByKey.get(attachmentKey),
              zIndex: isSubagentMessage ? nextWindowZ() : undefined,
            });
            messageIndexById.set(attachmentKey, queue.value.length - 1);
            messageContentById.set(attachmentKey, '');
            if (!isSubagentMessage) scheduleFollowScroll();
          }
        }
        return;
      }
      const isReasoning = message.partType === 'reasoning';
      const reasoningKey = getReasoningKey(sessionId);
      const isUserMessage =
        message.role === 'user' ||
        userMessageIds.has(message.id) ||
        (message.messageId ? userMessageIds.has(message.messageId) : false);
      const messageParentId = (() => {
        if (!payload || typeof payload !== 'object') return undefined;
        const record = payload as Record<string, unknown>;
        const nestedPayload =
          record.payload && typeof record.payload === 'object'
            ? (record.payload as Record<string, unknown>)
            : undefined;
        const properties =
          (nestedPayload?.properties && typeof nestedPayload.properties === 'object'
            ? (nestedPayload.properties as Record<string, unknown>)
            : undefined) ??
          (record.properties && typeof record.properties === 'object'
            ? (record.properties as Record<string, unknown>)
            : undefined);
        const info =
          properties?.info && typeof properties.info === 'object'
            ? (properties.info as Record<string, unknown>)
            : undefined;
        return typeof info?.parentID === 'string' ? (info.parentID as string) : undefined;
      })();
      const isPrimarySession = Boolean(
        sessionId && selectedSessionId.value && sessionId === selectedSessionId.value,
      );
      const isSessionWindow = !isReasoning && !isUserMessage;
      const isPrimarySessionWindow = isSessionWindow && isPrimarySession;
      const stableMessageId = isReasoning
        ? `reasoning:${reasoningKey}`
        : isSessionWindow
          ? `session:${sessionId ?? selectedSessionId.value ?? 'unknown'}`
          : (message.messageId ?? message.id);
      const messageKey = buildMessageKey(stableMessageId, sessionId);
      const isSubagentMessage =
        isReasoning ||
        isSessionWindow ||
        Boolean(sessionId && selectedSessionId.value && sessionId !== selectedSessionId.value);
      const isFloatingMessage = isReasoning || isSubagentMessage;
      if (isReasoning) {
        const summaryTitle = message.messageId
          ? messageSummaryTitleById.get(message.messageId)
          : undefined;
        const resolvedSessionId = sessionId ?? selectedSessionId.value ?? undefined;
        clearReasoningCloseTimerForSession(resolvedSessionId);
        const sessionTitle = getSessionTitle(resolvedSessionId);
        const isMain = resolvedSessionId && resolvedSessionId === selectedSessionId.value;
        const existingTitle = resolvedSessionId
          ? reasoningTitleBySessionId.get(resolvedSessionId)
          : undefined;
        const nextTitle =
          existingTitle ??
          (isMain ? MAIN_REASONING_TITLE : (summaryTitle ?? sessionTitle ?? 'Reasoning'));
        if (resolvedSessionId) reasoningTitleBySessionId.set(resolvedSessionId, nextTitle);
      }
      const reasoningMessageId = isReasoning
        ? (message.messageId ?? (message.id?.startsWith('msg_') ? message.id : undefined))
        : undefined;
      if (isReasoning && reasoningMessageId) {
        activeReasoningMessageIdByKey.set(reasoningKey, reasoningMessageId);
        const finished = finishedReasoningByKey.get(reasoningKey);
        if (finished && finished.id !== reasoningMessageId) finishedReasoningByKey.delete(reasoningKey);
      }
      const lastReasoningMessageId = isReasoning
        ? lastReasoningMessageIdByKey.get(messageKey)
        : undefined;
      const isNewReasoningMessage =
        Boolean(isReasoning && reasoningMessageId && lastReasoningMessageId !== reasoningMessageId);
      if (isReasoning && reasoningMessageId && lastReasoningMessageId !== reasoningMessageId) {
        lastReasoningMessageIdByKey.set(messageKey, reasoningMessageId);
        messagePartsById.delete(messageKey);
        messagePartOrderById.delete(messageKey);
      } else if (isReasoning && reasoningMessageId && !lastReasoningMessageId) {
        lastReasoningMessageIdByKey.set(messageKey, reasoningMessageId);
      }
      let mergedContent = message.content;
      let contentKey: string | undefined;
      if (isSessionWindow && message.messageId) {
        const partMap = messagePartsById.get(messageKey) ?? new Map<string, string>();
        partMap.set(message.messageId, message.content);
        messagePartsById.set(messageKey, partMap);
        const order = messagePartOrderById.get(messageKey) ?? [];
        if (!order.includes(message.messageId)) order.push(message.messageId);
        messagePartOrderById.set(messageKey, order);
        const lastKey = order[order.length - 1];
        mergedContent = lastKey ? (partMap.get(lastKey) ?? '') : '';
        contentKey = lastKey;
      } else if (message.partId && message.messageId) {
        const partMap = messagePartsById.get(messageKey) ?? new Map<string, string>();
        partMap.set(message.partId, message.content);
        messagePartsById.set(messageKey, partMap);
        const order = messagePartOrderById.get(messageKey) ?? [];
        if (!order.includes(message.partId)) order.push(message.partId);
        messagePartOrderById.set(messageKey, order);
        mergedContent = order.map((key) => partMap.get(key) ?? '').join('');
      }
      if (
        message.isPartUpdatedEvent &&
        !isReasoning &&
        !isSubagentMessage &&
        !messageIndexById.has(messageKey) &&
        typeof message.bodyContent === 'string' &&
        message.bodyContent.trim().length > 0
      ) {
        mergedContent = message.bodyContent;
      }
      if (!mergedContent || mergedContent.trim().length === 0) {
        if (!isSessionWindow) {
          const emptyIndex = messageIndexById.get(messageKey);
          if (emptyIndex !== undefined) queue.value.splice(emptyIndex, 1);
        }
        return;
      }

      const resolvedMeta = resolveUserMessageMetaForMessage(
        message.messageId,
        message.id,
        message.userMeta ?? null,
      );
      const resolvedTime = resolveUserMessageTimeForMessage(
        message.messageId,
        message.id,
        message.messageTime,
      );
      const displayMeta = resolveUserMessageDisplay(resolvedMeta);

      const header = '';
      const time = Date.now();
      const text = `${header}${mergedContent}`;
      const messageColumns = 52;
      const visibleLines = 12;
      const lines = countWrappedLines(text, messageColumns);
      const overflowLines = Math.max(0, lines - visibleLines);
      const lineHeight = 16;
      const scrollDistance = Math.max(0, overflowLines * lineHeight);
      const scrollDuration =
        overflowLines > 0 ? Math.min(0.25, Math.max(0.08, overflowLines * 0.01)) : 0;
      const reasoningFinish = isReasoning ? getReasoningFinish(reasoningKey, reasoningMessageId) : null;
      const expiresAt = isReasoning
        ? reasoningFinish
          ? reasoningFinish.time + REASONING_CLOSE_DELAY_MS
          : Number.MAX_SAFE_INTEGER
        : isSubagentMessage
          ? getSubagentExpiry(sessionId)
          : time + 1000 * 60 * 30;
      const attachments = messageAttachmentsById.get(messageKey);

      // Primary session assistant → route to round in real time (not floating window)
      if (isPrimarySessionWindow && sessionId) {
        const resolvedMessageId = contentKey ?? message.messageId ?? stableMessageId;
        upsertPrimaryAssistantIntoRound(sessionId, resolvedMessageId, mergedContent, {
          agent: displayMeta?.agent,
          model: displayMeta?.model,
          providerId: resolvedMeta?.providerId,
          modelId: resolvedMeta?.modelId,
          variant: displayMeta?.variant,
          time: resolvedTime,
          usage: messageUsageByKey.get(messageKey),
          attachments: attachments ? [...attachments] : undefined,
        });
        messageContentById.set(messageKey, mergedContent);
        return;
      }

      if (
        isUserMessage &&
        !isReasoning &&
        !isSubagentMessage &&
        !messageParentId &&
        message.messageId &&
        sessionId === selectedSessionId.value
      ) {
        const roundId = message.messageId;
        const roundMessageKey = buildMessageKey(roundId, sessionId);
        const existingRoundIndex = queue.value.findIndex(
          (entry) => entry.isRound && entry.roundId === roundId && entry.sessionId === sessionId,
        );
        const roundRootMessage: RoundMessage = {
          messageId: roundId,
          role: 'user',
          content: mergedContent,
          attachments,
          agent: displayMeta?.agent,
          model: displayMeta?.model,
          providerId: resolvedMeta?.providerId,
          modelId: resolvedMeta?.modelId,
          variant: displayMeta?.variant,
          time: resolvedTime,
          usage: messageUsageByKey.get(messageKey),
        };
        if (existingRoundIndex >= 0) {
          const existingRound = queue.value[existingRoundIndex];
          if (existingRound) {
            const existingRoundMessages = existingRound.roundMessages ?? [];
            const roundMessageIndex = existingRoundMessages.findIndex((entry) => entry.messageId === roundId);
            const nextRoundMessages = [...existingRoundMessages];
            if (roundMessageIndex >= 0) nextRoundMessages.splice(roundMessageIndex, 1, roundRootMessage);
            else nextRoundMessages.unshift(roundRootMessage);
            existingRound.roundMessages = nextRoundMessages;
            queue.value.splice(existingRoundIndex, 1, {
              ...existingRound,
              time,
              expiresAt,
              content: mergedContent,
              role: 'user',
              messageAgent: displayMeta?.agent,
              messageModel: displayMeta?.model,
              messageProviderId: resolvedMeta?.providerId,
              messageModelId: resolvedMeta?.modelId,
              messageUsage: messageUsageByKey.get(messageKey),
              messageVariant: displayMeta?.variant,
              messageTime: resolvedTime,
              attachments,
              isRound: true,
              roundId,
              roundDiffs: existingRound.roundDiffs ?? [],
              messageId: roundId,
              messageKey: roundMessageKey,
              sessionId,
            });
            messageIndexById.set(roundMessageKey, existingRoundIndex);
          }
        } else {
          queue.value.push({
            time,
            expiresAt,
            x: 0,
            y: 0,
            header,
            content: mergedContent,
            role: 'user',
            messageAgent: displayMeta?.agent,
            messageModel: displayMeta?.model,
            messageProviderId: resolvedMeta?.providerId,
            messageModelId: resolvedMeta?.modelId,
            messageUsage: messageUsageByKey.get(messageKey),
            messageVariant: displayMeta?.variant,
            messageTime: resolvedTime,
            scroll: false,
            scrollDistance: 0,
            scrollDuration: 0,
            html: '',
            attachments,
             isWrite: false,
             isMessage: true,
             isSubagentMessage: false,
             isRound: true,
            roundId,
            roundMessages: [roundRootMessage],
            roundDiffs: [],
            messageId: roundId,
            messageKey: roundMessageKey,
            sessionId,
          });
          messageIndexById.set(roundMessageKey, queue.value.length - 1);
        }
        messageContentById.set(roundMessageKey, mergedContent);
        if (attachments && attachments.length > 0) {
          messageAttachmentsById.set(roundMessageKey, attachments);
        }
        if (!isSubagentMessage) scheduleFollowScroll();
        return;
      }

      let existingIndex = messageIndexById.get(messageKey);
      if (existingIndex === undefined) {
        existingIndex = queue.value.findIndex(
          (entry) => entry.messageId === stableMessageId && entry.sessionId === sessionId,
        );
        if (existingIndex >= 0) messageIndexById.set(messageKey, existingIndex);
        else existingIndex = undefined;
      }
      if (existingIndex !== undefined) {
        const existing = queue.value[existingIndex];
        const priorContent = existing?.content ?? '';
        const nextContent = isReasoning
          ? mergeReasoningContent(messageContentById.get(messageKey) ?? priorContent, mergedContent, {
              ensureTrailingNewline: isNewReasoningMessage,
            })
          : mergedContent;
        if (existing) {
          const nextText = `${header}${nextContent}`;
          const nextLines = countWrappedLines(nextText, messageColumns);
          const nextOverflowLines = Math.max(0, nextLines - visibleLines);
          const nextScrollDistance = Math.max(0, nextOverflowLines * lineHeight);
          const nextScrollDuration =
            nextOverflowLines > 0 ? Math.min(0.25, Math.max(0.08, nextOverflowLines * 0.01)) : 0;
          const nextMessageAgent = displayMeta?.agent ?? existing.messageAgent;
          const nextMessageModel = displayMeta?.model ?? existing.messageModel;
          const nextMessageProviderId = resolvedMeta?.providerId ?? existing.messageProviderId;
          const nextMessageModelId = resolvedMeta?.modelId ?? existing.messageModelId;
          const nextMessageUsage = existing.messageUsage ?? messageUsageByKey.get(messageKey);
          const nextMessageVariant = displayMeta?.variant ?? existing.messageVariant;
          const nextMessageTime = resolvedTime ?? existing.messageTime;
          const nextAttachments =
            attachments && attachments.length > 0
              ? attachments
              : existing.attachments;
          queue.value.splice(existingIndex, 1, {
            ...existing,
            time,
            expiresAt,
            header,
            content: nextContent,
            role: isUserMessage ? 'user' : existing.role,
            messageAgent: nextMessageAgent,
            messageModel: nextMessageModel,
            messageProviderId: nextMessageProviderId,
            messageModelId: nextMessageModelId,
            messageUsage: nextMessageUsage,
            messageVariant: nextMessageVariant,
            message,
            messageTime: nextMessageTime,
            scroll: !isFloatingMessage && nextOverflowLines > 0,
            scrollDistance: isFloatingMessage ? 0 : nextScrollDistance,
            scrollDuration: isFloatingMessage ? 0 : nextScrollDuration,
            html: '',
            attachments: nextAttachments,
            isReasoning,
            messageKey,
            follow: existing.follow ?? (isFloatingMessage ? true : undefined),
            contentKey: contentKey ?? existing.contentKey,
          });
          messageIndexById.set(messageKey, existingIndex);
        }
        messageContentById.set(messageKey, nextContent);
        if (isFloatingMessage) scheduleReasoningScroll(messageKey);
        if (!isSubagentMessage) scheduleFollowScroll();
        return;
      }

      messageContentById.set(messageKey, mergedContent);
      const randomPosition = isSubagentMessage ? getRandomWindowPosition() : { x: 0, y: 0 };
      queue.value.push({
        time,
        expiresAt,
        x: randomPosition.x,
        y: randomPosition.y,
        header,
        content: mergedContent,
        role: isUserMessage ? 'user' : 'assistant',
        messageAgent: displayMeta?.agent,
        messageModel: displayMeta?.model,
        messageProviderId: resolvedMeta?.providerId,
        messageModelId: resolvedMeta?.modelId,
        messageUsage: messageUsageByKey.get(messageKey),
        messageVariant: displayMeta?.variant,
        messageTime: resolvedTime,
        scroll: !isFloatingMessage && overflowLines > 0,
        scrollDistance: isFloatingMessage ? 0 : scrollDistance,
        scrollDuration: isFloatingMessage ? 0 : scrollDuration,
        html: '',
        attachments,
        isWrite: false,
        isMessage: true,
        isSubagentMessage,
        isReasoning,
        messageId: stableMessageId,
        messageKey,
        contentKey,
        follow: isFloatingMessage ? true : undefined,
        sessionId,
        zIndex: isFloatingMessage ? nextWindowZ() : undefined,
      });
      messageIndexById.set(messageKey, queue.value.length - 1);
      if (isFloatingMessage) scheduleReasoningScroll(messageKey);
      if (!isSubagentMessage) scheduleFollowScroll();
      return;
    }

    fileReads.forEach((entry) => {
      if (isReadWithOffset(entry) && entry.callId) {
        if (entry.toolStatus === 'running') {
          pendingReadInfoByCallId.set(entry.callId, {
            path: entry.path!,
            readOffset: entry.readOffset!,
            readLimit: entry.readLimit,
            lang: entry.lang,
            toolTitle: entry.toolTitle,
            eventType: e.type,
          });
        } else if (entry.toolStatus === 'error') {
          pendingReadInfoByCallId.delete(entry.callId);
          upsertToolEntry(entry, e.type);
        } else {
          const saved = pendingReadInfoByCallId.get(entry.callId);
          pendingReadInfoByCallId.delete(entry.callId);
          if (saved) {
            void hydrateAndPopupRead({
              ...entry,
              path: saved.path,
              readOffset: saved.readOffset,
              readLimit: saved.readLimit,
              lang: saved.lang ?? entry.lang,
              toolTitle: saved.toolTitle ?? entry.toolTitle,
            }, saved.eventType);
          } else {
            void hydrateAndPopupRead(entry, e.type);
          }
        }
      } else {
        upsertToolEntry(entry, e.type);
      }
    });
  };

  src.value.addEventListener('message', handleEvent);
  FILE_READ_EVENT_TYPES.forEach((eventType) => {
    src.value?.addEventListener(eventType, handleEvent);
  });
  FILE_WRITE_EVENT_TYPES.forEach((eventType) => {
    src.value?.addEventListener(eventType, handleEvent);
  });
  MESSAGE_EVENT_TYPES.forEach((eventType) => {
    src.value?.addEventListener(eventType, handleEvent);
  });
  src.value.addEventListener('error', (e) => {
    src.value!.close();
    src.value = undefined;
    setTimeout(connect, 1000);
  });
}

onMounted(() => {
  handleWindowResize();
  if (typeof document !== 'undefined' && 'fonts' in document) {
    void document.fonts.ready.then(() => {
      handleWindowResize();
    });
  }
  hydrateShellPtyStorage();
  void fetchHomePath().then(() => bootstrapSelections());
  fetchProviders();
  fetchAgents();
  if (activeDirectory.value) {
    fetchSessionStatus(activeDirectory.value || undefined);
  }
  fetchCommands(activeDirectory.value || undefined);
  if (activeDirectory.value) {
    void loadTreePath('.');
    void refreshSessionDiff();
  }
  const directory = activeDirectory.value || undefined;
  fetchPendingPermissions(directory);
  fetchPendingQuestions(directory);
  const availableThemes = getBundledThemeNames();
  const chosenTheme = pickShikiTheme(availableThemes);
  if (chosenTheme) shikiTheme.value = chosenTheme;
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('storage', handleComposerDraftStorage);
  unregisterSessionStatusGlobalHook?.();
  unregisterSessionStatusGlobalHook = registerGlobalEventHook((payload, eventType) => {
    const normalized = normalizeEventType(eventType);
    if (normalized === 'serverconnected') {
      void fetchSessionStatus(activeDirectory.value || undefined);
      return;
    }
    applySessionStatusEvent(payload, eventType);
  });
  connect();
});
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', handlePointerUp);
  window.removeEventListener('resize', handleWindowResize);
  window.removeEventListener('storage', handleComposerDraftStorage);
  pendingToolScrollFrames.forEach((frame) => {
    cancelAnimationFrame(frame);
  });
  pendingToolScrollFrames.clear();
  unregisterSessionStatusGlobalHook?.();
  unregisterSessionStatusGlobalHook = null;
  src.value?.close();
  disposeShellWindows({ preserve: true });
});
</script>

<style scoped>
.app {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 12px;
  box-sizing: border-box;
}

.app-header {
  flex: 0 0 auto;
  position: relative;
  z-index: 30;
}

.app-output {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  z-index: 10;
  isolation: isolate;
}

.app-input {
  flex: 0 0 auto;
  position: relative;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-height: 0;
  min-height: 200px;
}

.input-resizer {
  position: absolute;
  top: -8px;
  left: 8px;
  right: 8px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  z-index: 40;
  touch-action: none;
}

.input-resizer::before {
  content: '';
  width: 44px;
  height: 3px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.6);
  box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.6);
}

.input-resizer:hover::before {
  background: rgba(226, 232, 240, 0.7);
}

.output-workspace {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: visible;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.tool-window-layer {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  box-sizing: border-box;
  --todo-panel-gap: 10px;
  --todo-panel-open-width: clamp(220px, 24vw, 320px);
  --todo-panel-collapsed-width: 30px;
  --todo-panel-width: var(--todo-panel-open-width);
}

.tool-window-layer.todo-collapsed {
  --todo-panel-width: var(--todo-panel-collapsed-width);
}

.output-split {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: stretch;
  gap: var(--todo-panel-gap);
  width: 100%;
  height: 100%;
  min-height: 0;
}

.todo-panel {
  flex: 0 0 var(--todo-panel-width);
  width: var(--todo-panel-width);
  min-height: 0;
}

.tool-window-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
  z-index: 20;
  --dock-reserved: 0px;
  --tool-top-offset: 0px;
  --tool-area-height: 100%;
  --term-font-family:
    'Iosevka Term', 'Iosevka Fixed', 'JetBrains Mono', 'Cascadia Mono', 'SFMono-Regular', Menlo,
    Consolas, 'Liberation Mono', monospace;
  --term-font-size: 13px;
  --term-line-height: 1.1;
  --term-width: 670px;
  --term-height: 386px;
}

.output-panel {
  flex: 1 1 auto;
  width: auto;
  height: 100%;
  min-height: 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: all 0.15s ease-in;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: scaleX(150%) scaleY(0%);
}
</style>
