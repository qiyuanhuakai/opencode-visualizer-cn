<template>
  <div ref="appEl" class="app">
    <template v-if="uiInitState === 'ready'">
      <header class="app-header">
        <TopPanel
          :tree-data="topPanelTreeData"
          :notification-sessions="notificationSessions"
          :project-directory="projectDirectory"
          :active-directory="activeDirectory"
          :selected-session-id="selectedSessionId"
          :home-path="homePath"
          @select-notification="handleNotificationSessionSelect"
          @create-worktree-from="createWorktreeFromWorktree"
          @new-session="createNewSession"
          @new-session-in="handleNewSessionInSandbox"
          @open-shell="openShellFromInput('')"
          @delete-active-directory="deleteWorktree"
          @delete-session="deleteSession"
          @archive-session="archiveSession"
          @select-session="handleTopPanelSessionSelect"
          @open-directory="openProjectPicker"
          @open-settings="isSettingsOpen = true"
          @logout="handleLogout"
        />
      </header>
      <main ref="outputEl" class="app-output">
        <div class="output-workspace">
          <div class="tool-window-layer" :class="{ 'todo-collapsed': sidePanelCollapsed }">
            <div class="output-split" :class="{ 'todo-collapsed': sidePanelCollapsed }">
              <OutputPanel
                ref="outputPanelRef"
                :key="selectedSessionId"
                class="output-panel"
                :is-following="isFollowing"
                :status-text="statusText"
                :is-status-error="isStatusError"
                :is-thinking="isThinking"
                :is-retry-status="!!retryStatus"
                :busy-descendant-count="busyDescendantSessionIds.length"
                :theme="shikiTheme"
                :resolve-agent-color="resolveAgentColorForName"
                :compute-context-percent="computeContextPercent"
                @message-rendered="handleOutputPanelMessageRendered"
                @resume-follow="handleOutputPanelResumeFollow"
                @fork-message="handleForkMessage"
                @revert-message="handleRevertMessage"
                @show-message-diff="handleShowMessageDiff"
                @open-history-tool="handleOpenHistoryTool"
                @close-history-tools="handleCloseHistoryTools"
                @edit-message="handleEditMessage"
                @open-image="handleOpenImage"
                @content-resized="handleOutputPanelContentResized"
                @initial-render-complete="handleOutputPanelInitialRenderComplete"
              />
              <SidePanel
                class="todo-panel"
                :class="{ 'is-disabled': !hasSession }"
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
              <TransitionGroup appear name="scale">
                <FloatingWindow
                  v-for="entry in fw.entries.value"
                  :key="entry.key"
                  :entry="entry"
                  :manager="fw"
                  @focus="fw.bringToFront(entry.key)"
                  @close="handleFloatingWindowClose(entry.key)"
                />
              </TransitionGroup>
            </div>
          </div>
        </div>
      </main>
      <footer
        ref="inputEl"
        class="app-input"
        :class="{ 'is-disabled': !hasSession }"
        :style="inputHeight !== null ? { height: `${inputHeight}px` } : undefined"
      >
        <div class="input-resizer" @pointerdown="startInputResize"></div>
        <InputPanel
          ref="inputPanelRef"
          :disabled="connectionState !== 'ready'"
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
          @open-image="handleOpenImage"
        />
      </footer>
    </template>
    <div v-else class="app-loading-view" role="status" aria-live="polite">
      <div class="app-loading-card">
        <div v-if="uiInitState === 'login'" class="app-login-form">
          <p class="app-loading-title">Connect to OpenCode Server</p>
          <div class="app-login-fields">
            <input
              v-model="loginUsername"
              type="text"
              class="app-login-input"
              placeholder="Username"
              name="username"
              :disabled="!loginRequiresAuth"
              @keydown.enter="handleLogin"
            />
            <input
              v-model="loginPassword"
              type="password"
              class="app-login-input"
              placeholder="Password"
              :disabled="!loginRequiresAuth"
              @keydown.enter="handleLogin"
            />
            <label class="app-login-checkbox">
              <input v-model="loginRequiresAuth" type="checkbox" />
              The server requires authentication
            </label>
            <input
              v-model="loginUrl"
              type="text"
              class="app-login-input"
              placeholder="http://localhost:4096"
              name="url"
              @keydown.enter="handleLogin"
            />
          </div>
          <p v-if="initErrorMessage" class="app-loading-message app-error-message">{{ initErrorMessage }}</p>
          <button
            type="button"
            class="app-loading-retry bg-indigo-500!"
            @click="handleLogin"
          >
            Connect
          </button>

          <Welcome :theme="shikiTheme" class="mt-8" />
        </div>
        <div v-else>
          <div class="app-loading-spinner" aria-hidden="true"></div>
          <p class="app-loading-title">Loading OpenCode session data...</p>
          <p class="app-loading-message">{{ uiInitState === 'error' ? initErrorMessage : initLoadingMessage }}</p>
          <div class="app-loading-actions">
            <button
              v-if="uiInitState === 'error'"
              type="button"
              class="app-loading-retry"
              @click="startInitialization"
            >
              Retry
            </button>
            <button
              v-if="uiInitState === 'loading'"
              type="button"
              class="app-loading-retry app-loading-abort"
              @click="handleAbortInit"
            >
              Abort
            </button>
          </div>
        </div>
      </div>
    </div>
    <ProjectPicker
      :open="isProjectPickerOpen"
      :base-url="credentials.baseUrl.value"
      :initial-directory="projectDirectory"
      :authorization="credentials.authHeader.value"
      @close="isProjectPickerOpen = false"
      @select="handleProjectDirectorySelect"
    />
    <SettingsModal
      :open="isSettingsOpen"
      @close="isSettingsOpen = false"
    />
  </div>
</template>

<script lang="ts" setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { bundledThemes } from 'shiki/bundle/web';
import { Terminal } from '@xterm/xterm';
import InputPanel from './components/InputPanel.vue';
import ImageViewer from './components/ImageViewer.vue';
import OutputPanel from './components/OutputPanel.vue';
import ProjectPicker from './components/ProjectPicker.vue';
import hexdump from '@kikuchan/hexdump';
import FloatingWindow from './components/FloatingWindow.vue';
import BashContent from './components/ToolWindow/Bash.vue';
import GlobContent from './components/ToolWindow/Glob.vue';
import GrepContent from './components/ToolWindow/Grep.vue';
import ReasoningContent from './components/ToolWindow/Reasoning.vue';
import SubagentContent from './components/ToolWindow/Subagent.vue';
import WebContent from './components/ToolWindow/Web.vue';
import SidePanel from './components/SidePanel.vue';
import Welcome from './components/Welcome.vue';
import TopPanel, { type TopPanelNotificationSession, type TopPanelWorktree } from './components/TopPanel.vue';
import SettingsModal from './components/SettingsModal.vue';
import PermissionContent from './components/ToolWindow/Permission.vue';
import QuestionContent from './components/ToolWindow/Question.vue';
import FileViewerContent from './components/FileViewer.vue';
import ShellContent from './components/ToolWindow/Shell.vue';
import {
  formatGlobToolTitle,
  resolveReadWritePath,
  resolveReadRange,
  guessLanguageFromPath,
  formatListToolTitle,
  formatWebfetchToolTitle,
  formatQueryToolTitle,
  toolColor,
} from './components/ToolWindow/utils';
import { useAutoScroller, type ScrollMode } from './composables/useAutoScroller';
import { useFloatingWindows } from './composables/useFloatingWindows';
import { useDeltaAccumulator } from './composables/useDeltaAccumulator';
import { useGlobalEvents } from './composables/useGlobalEvents';
import { useMessages } from './composables/useMessages';
import { useReasoningWindows, type ReasoningFinish } from './composables/useReasoningWindows';
import { useSubagentWindows } from './composables/useSubagentWindows';
import { renderWorkerHtml } from './utils/workerRenderer';
import type { MessageInfo, MessagePart, ToolPart } from './types/sse';
import { extractFileRead as extractToolFileRead, extractPatch as extractToolPatch } from './utils/toolRenderers';
import * as opencodeApi from './utils/opencode';
import { opencodeTheme, resolveTheme, resolveAgentColor } from './utils/theme';
import { createSessionGraphStore } from './utils/sessionGraph';
import { useCredentials } from './composables/useCredentials';
import {
  StorageKeys,
  storageGet,
  storageKey,
  storageRemove,
  storageSet,
  storageSetJSON,
} from './utils/storageKeys';

const credentials = useCredentials();
const FOLLOW_THRESHOLD_PX = 24;
const TOOL_PENDING_TTL_MS = 60_000;
const TOOL_COMPLETE_TTL_MS = 2_000;

const CHILD_SESSION_PRUNE_TTL_MS = 20 * 60 * 1000;
const ROOT_SESSION_BOOTSTRAP_LIMIT = 100_000;
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
const SUBAGENT_CLOSE_DELAY_MS = 3000;
const ATTACHMENT_MIME_ALLOWLIST = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);



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
  error: string | undefined;
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
  terminal: Terminal;
  socket?: WebSocket;
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

const fw = useFloatingWindows();
const appEl = ref<HTMLDivElement | null>(null);
const outputEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLElement | null>(null);
const toolWindowCanvasEl = ref<HTMLDivElement | null>(null);
const outputPanelRef = ref<{ panelEl: HTMLDivElement | null; isHistoryOpen: boolean; closeHistory: () => void } | null>(null);
const inputPanelRef = ref<{ focus: () => void; reset: () => void } | null>(null);
const outputPanelContainerEl = computed(() => outputPanelRef.value?.panelEl ?? undefined);
const outputPanelScrollMode = computed<ScrollMode>(() => 'follow');
const {
  isFollowing,
  enableFollow,
  resetFollow,
  resumeFollow,
  scrollToBottom: scrollOutputPanelToBottom,
  notifyContentChange,
} = useAutoScroller(outputPanelContainerEl, outputPanelScrollMode, {
  bottomThresholdPx: FOLLOW_THRESHOLD_PX,
  observeDelayMs: 0,
  smoothEngine: 'native',
  smoothOnInitialFollow: false,
});

function handleOutputPanelInitialRenderComplete() {
  nextTick(() => {
    scrollOutputPanelToBottom(false);
    syncFloatingExtent();
  });
}

function handleOutputPanelResumeFollow() {
  resumeFollow();
}

function handleOutputPanelMessageRendered() {
  notifyContentChange();
}

function handleOutputPanelContentResized() {
  notifyContentChange();
}

const runningToolIds = reactive(new Set<string>());

const messageSummaryTitleByMessageId = ref<Record<string, string>>({});
type MessageDiffEntry = { file: string; diff: string; before?: string; after?: string };
type SessionStatusType = 'busy' | 'idle' | 'retry';

const userMessageIdsById = ref<Record<string, true>>({});
const userMessageMetaById = ref<Record<string, UserMessageMeta>>({});
const userMessageTimeById = ref<Record<string, number>>({});
const globalEventUnsubscribers: Array<() => void> = [];

const inputResizeState = ref<{
  startY: number;
  startHeight: number;
  minHeight: number;
  maxHeight: number;
} | null>(null);
const inputHeight = ref<number | null>(null);
let sessionStatusRequestId = 0;
let primaryHistoryRequestId = 0;
const recentUserInputs: { text: string; time: number }[] = [];
const composerDraftRevisionByContext = new Map<string, number>();
const composerDraftTabId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const shellSessionsByPtyId = new Map<string, ShellSession>();
const pendingShellFits = new Set<string>();
const ptyMetaDecoder = new TextDecoder();
let floatingExtentResizeObserver: ResizeObserver | null = null;
let floatingExtentObservedEl: HTMLDivElement | null = null;
const permissionSendingById = ref<Record<string, boolean>>({});
const permissionErrorById = ref<Record<string, string>>({});
const questionSendingById = ref<Record<string, boolean>>({});
const questionErrorById = ref<Record<string, string>>({});
const pendingNotificationsBySessionId = ref(new Map<string, Set<string>>());
const notificationSessionOrder = ref<string[]>([]);
const notificationPermissionRequested = ref(false);

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

type ProjectInfo = {
  id: string;
  worktree?: string;
  sandboxes?: string[];
  color?: string;
  icon?: { color?: string };
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
    archived?: number;
  };
};

type TopPanelTreeSession = {
  id: string;
  title?: string;
  slug?: string;
  status: 'busy' | 'idle' | 'retry' | 'unknown';
  timeUpdated?: number;
};

type TopPanelTreeSandbox = {
  directory: string;
  branch?: string;
  sessions: TopPanelTreeSession[];
};

type TopPanelTreeWorktree = {
  directory: string;
  label: string;
  name?: string;
  projectColor?: string;
  sandboxes: TopPanelTreeSandbox[];
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

const projects = computed<ProjectInfo[]>(() => {
  void sessionGraphVersion.value;
  return sessionGraphStore.getProjects() as ProjectInfo[];
});
const worktrees = computed<string[]>(() => {
  void sessionGraphVersion.value;
  const pd = projectDirectory.value?.trim();
  if (!pd) return [];
  return sessionGraphStore.getWorktrees(pd);
});
const worktreeMetaByDir = computed<Record<string, VcsInfo>>(() => {
  void sessionGraphVersion.value;
  const result: Record<string, VcsInfo> = {};
  worktrees.value.forEach((dir) => {
    const info = sessionGraphStore.getVcsInfo(dir);
    if (info) result[dir] = info;
  });
  return result;
});
const worktreeMetaRequestIdByDir = new Map<string, number>();
let worktreeMetaRequestId = 0;
const sessionGraphStore = createSessionGraphStore();
const sessionGraphVersion = ref(0);
const bootstrapReady = ref(false);
const pendingChildFetchKeys = new Set<string>();
const providers = ref<ProviderInfo[]>([]);
const agents = ref<AgentInfo[]>([]);
const commands = ref<CommandInfo[]>([]);
const modelOptions = ref<
  Array<{
    id: string;
    modelID: string;
    label: string;
    displayName: string;
    providerID?: string;
    providerLabel?: string;
    variants?: Record<string, unknown>;
    attachmentCapable?: boolean;
  }>
>([]);
const agentOptions = ref<
  Array<{ id: string; label: string; description?: string; color?: string }>
>([]);
const thinkingOptions = ref<Array<string | undefined>>([]);
const providersLoaded = ref(false);
const providersLoading = ref(false);
const providersFetchCount = ref(0);
const agentsLoading = ref(false);
const commandsLoading = ref(false);
const selectedProjectId = computed(() => {
  void sessionGraphVersion.value;
  const sandbox = sessionGraphStore.getSandbox(projectDirectory.value, activeDirectory.value);
  return sandbox?.projectID ?? '';
});
const activeDirectory = ref('');
const selectedSessionId = ref('');

const reasoning = useReasoningWindows({
  selectedSessionId,
  fw,
  reasoningComponent: ReasoningContent,
  theme: () => 'github-dark',
  reasoningCloseDelayMs: REASONING_CLOSE_DELAY_MS,
  resolveModelName: (providerID, modelID) => {
    const key = `${providerID}/${modelID}`;
    return modelOptions.value.find((m) => m.id === key)?.displayName;
  },
});
const {
  updateReasoningExpiry,
} = reasoning;

const subagentWindows = useSubagentWindows({
  selectedSessionId,
  fw,
  subagentComponent: SubagentContent,
  theme: () => 'github-dark',
  closeDelayMs: SUBAGENT_CLOSE_DELAY_MS,
  resolveModelName: (providerID, modelID) => {
    const key = `${providerID}/${modelID}`;
    return modelOptions.value.find((m) => m.id === key)?.displayName;
  },
});

const projectDirectory = ref('');
const homePath = ref('');
const serverWorktreePath = ref('');
const worktreeNameByDirectory = ref<Record<string, string>>({});
const projectColorById = ref<Record<string, string>>({});
const loadingWorktreeNameDirectories = new Set<string>();
const initialQuery = readQuerySelection();
const isProjectPickerOpen = ref(false);
const isSettingsOpen = ref(false);
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
const uiInitState = ref<'loading' | 'ready' | 'error' | 'login'>('loading');
const initLoadingMessage = ref('Connecting to server...');
const initErrorMessage = ref('');
const connectionState = ref<'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error'>(
  'connecting',
);
const reconnectingMessage = ref('');
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectInFlight = false;
let initializationInFlight = false;
const loginUrl = ref('http://localhost:4096');
const loginUsername = ref('');
const loginPassword = ref('');
const loginRequiresAuth = ref(false);
const retryStatus = ref<{
  message: string;
  next: number;
  attempt: number;
} | null>(null);

const statusText = computed(() => {
  if (connectionState.value === 'reconnecting') {
    return reconnectingMessage.value || 'Reconnecting...';
  }
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

const allWorktreeDirectories = computed(() => {
  void sessionGraphVersion.value;
  return sessionGraphStore.getWorktreeList();
});

const allSandboxDirectories = computed(() => {
  void sessionGraphVersion.value;
  const dirs: string[] = [];
  for (const wt of sessionGraphStore.getWorktreeList()) {
    dirs.push(...sessionGraphStore.getSandboxList(wt));
  }
  return dirs;
});

const sessions = computed(() => {
  void sessionGraphVersion.value;
  const directory = activeDirectory.value.trim();
  const projectID = selectedProjectId.value.trim();
  return sessionGraphStore.getRootSessions({
    projectID: projectID || undefined,
    directory: directory || undefined,
  }) as SessionInfo[];
});

const sessionParentById = computed(() => {
  void sessionGraphVersion.value;
  const directory = activeDirectory.value.trim();
  return sessionGraphStore.getParentMap(directory || undefined);
});

const sessionParentRecord = reactive<Record<string, string | undefined>>({});
watch(
  sessionParentById,
  (parentMap) => {
    const nextSessionIds = new Set(parentMap.keys());
    Object.keys(sessionParentRecord).forEach((sessionId) => {
      if (!nextSessionIds.has(sessionId)) {
        delete sessionParentRecord[sessionId];
      }
    });
    parentMap.forEach((parentId, sessionId) => {
      sessionParentRecord[sessionId] = parentId;
    });
  },
  { immediate: true },
);

const filteredSessions = computed(() =>
  sessions.value.filter((session) => {
    if (session.parentID) return false;
    const directory = activeDirectory.value;
    if (directory && session.directory && session.directory !== directory) return false;
    return true;
  }),
);

const topPanelTreeData = computed<TopPanelWorktree[]>(() => {
  void sessionGraphVersion.value;

  const worktreeEntries = allWorktreeDirectories.value
    .map((worktreeDirectory) => {
      const sandboxEntries = sessionGraphStore
        .getSandboxList(worktreeDirectory)
        .map((sandboxDirectory) => {
          const roots = sessionGraphStore.getRootSessions({ directory: sandboxDirectory }) as SessionInfo[];
          const sessionsForSandbox = roots
            .map((session) => ({
              id: session.id,
              title: session.title,
              slug: session.slug,
              status: (sessionGraphStore.getStatus(session.id, session.projectID) ??
                'unknown') as 'busy' | 'idle' | 'retry' | 'unknown',
              timeUpdated: session.time?.updated ?? session.time?.created,
              archivedAt: session.time?.archived,
            }))
            .sort((a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0));

          const branch = sessionGraphStore.getVcsInfo(sandboxDirectory)?.branch;
          const latestUpdated = sessionsForSandbox[0]?.timeUpdated ?? 0;

          return {
            directory: sandboxDirectory,
            branch,
            sessions: sessionsForSandbox,
            latestUpdated,
          };
        })
        .sort((a, b) => b.latestUpdated - a.latestUpdated);

      const latestSandboxUpdated = sandboxEntries
        .flatMap((sandbox) => sandbox.sessions)
        .reduce((max, session) => Math.max(max, session.timeUpdated ?? 0), 0);

      const name = worktreeNameByDirectory.value[worktreeDirectory]?.trim() || undefined;
      const projectId = sessionGraphStore.resolveProjectIDForDirectory(worktreeDirectory);
      const projectColor = projectId ? projectColorById.value[projectId] : undefined;
      return {
        directory: worktreeDirectory,
        label: replaceHomePrefix(worktreeDirectory),
        name,
        projectColor,
        sandboxes: sandboxEntries,
        latestUpdated: latestSandboxUpdated,
      };
    })
    .sort((a, b) => b.latestUpdated - a.latestUpdated);

  return worktreeEntries;
});

/** Resolve package.json name for a worktree directory (fire-and-forget). */
async function resolveWorktreeName(dir: string) {
  if (worktreeNameByDirectory.value[dir] !== undefined) return;
  if (loadingWorktreeNameDirectories.has(dir)) return;
  loadingWorktreeNameDirectories.add(dir);
  try {
    const result = (await opencodeApi.readFileContent(credentials.baseUrl.value, {
      directory: dir,
      path: 'package.json',
    })) as FileContentResponse | string;
    const content = typeof result === 'string' ? result : result?.content;
    if (!content) {
      worktreeNameByDirectory.value[dir] = '';
      return;
    }
    const isBase64 = typeof result !== 'string' && result?.encoding === 'base64';
    const decoded =
      typeof content === 'string' && isBase64
        ? decodeApiTextContent(result as FileContentResponse)
        : content;
    const parsed = JSON.parse(decoded);
    worktreeNameByDirectory.value[dir] = parsed?.name ?? '';
  } catch {
    worktreeNameByDirectory.value[dir] = '';
  } finally {
    loadingWorktreeNameDirectories.delete(dir);
  }
}

/** Resolve VCS branch for a sandbox directory via /vcs (fire-and-forget). */
function resolveVcsBranch(dir: string) {
  if (sessionGraphStore.getVcsInfo(dir)) return;
  void fetchWorktreeMeta(dir);
}

/** Resolve all metadata for a worktree directory: package.json name + /vcs branch. */
function resolveWorktreeDirectory(dir: string) {
  void resolveWorktreeName(dir);
  resolveVcsBranch(dir);
}

watch(
  [allWorktreeDirectories, allSandboxDirectories],
  ([worktreeDirs, sandboxDirs]) => {
    const worktreeSet = new Set(worktreeDirs);
    // Worktree directories: package.json name + /vcs branch
    for (const dir of worktreeDirs) {
      resolveWorktreeDirectory(dir);
    }
    // Sandbox directories: /vcs branch only (skip those already handled as worktrees)
    for (const dir of sandboxDirs) {
      if (worktreeSet.has(dir)) continue;
      resolveVcsBranch(dir);
    }
  },
  { immediate: true },
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

const notificationSessions = computed<TopPanelNotificationSession[]>(() =>
  notificationSessionOrder.value
    .filter((sessionId) => pendingNotificationsBySessionId.value.has(sessionId))
    .map((sessionId) => ({
      sessionId,
      count: pendingNotificationsBySessionId.value.get(sessionId)?.size ?? 0,
    }))
    .filter((item) => item.count > 0),
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

const hasSession = computed(() => Boolean(selectedSessionId.value));

const canSend = computed(() =>
  Boolean(
    uiInitState.value === 'ready' &&
      connectionState.value === 'ready' &&
    selectedSessionId.value &&
    !isSending.value &&
    (messageInput.value.trim().length > 0 || attachments.value.length > 0),
  ),
);

const busyDescendantSessionIds = computed(() => {
  const allowed = allowedSessionIds.value;
  const selected = selectedSessionId.value;
  void sessionGraphVersion.value;
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
  void sessionGraphVersion.value;
  const ownStatus = selected ? getSessionStatus(selected) : undefined;
  return Boolean(
    ownStatus === 'busy' ||
    ownStatus === 'retry' ||
    busyDescendantSessionIds.value.length > 0 ||
    runningToolIds.size > 0,
  );
});
const canAbort = computed(() =>
  Boolean(
    uiInitState.value === 'ready' &&
      connectionState.value === 'ready' &&
      selectedSessionId.value &&
      isThinking.value &&
      !isAborting.value,
  ),
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
      description: 'Debug utilities. Use /debug help for subcommands.',
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

function normalizeRelativePathNoParent(value: string) {
  const segments = value.replace(/\\/g, '/').split('/');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') continue;
    cleaned.push(segment);
  }
  return cleaned.join('/');
}

function normalizeAbsolutePathNoParent(value: string) {
  const segments = value.replace(/\\/g, '/').split('/');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (cleaned.length > 0) cleaned.pop();
      continue;
    }
    cleaned.push(segment);
  }
  return `/${cleaned.join('/')}`;
}

function splitFileContentDirectoryAndPath(targetPath: string, sandboxDirectory: string) {
  const sandbox = normalizeAbsolutePathNoParent(normalizeDirectory(sandboxDirectory));
  const source = targetPath.replace(/\\/g, '/').trim();

  if (!source) {
    return {
      directory: sandbox,
      path: '.',
    };
  }

  if (!source.startsWith('/')) {
    const relative = normalizeRelativePathNoParent(source);
    return {
      directory: sandbox,
      path: relative || '.',
    };
  }

  const absolute = normalizeAbsolutePathNoParent(source);
  if (absolute === sandbox) {
    return {
      directory: sandbox,
      path: '.',
    };
  }
  const sandboxPrefix = `${sandbox}/`;
  if (absolute.startsWith(sandboxPrefix)) {
    const relative = absolute.slice(sandboxPrefix.length);
    return {
      directory: sandbox,
      path: relative || '.',
    };
  }

  const slashIndex = absolute.lastIndexOf('/');
  const directory = slashIndex > 0 ? absolute.slice(0, slashIndex) : '/';
  const relative = slashIndex >= 0 ? absolute.slice(slashIndex + 1) : absolute;
  return {
    directory,
    path: relative || '.',
  };
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
  return activeDirectory.value.trim();
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

function ensureConnectionReady(action: string) {
  if (connectionState.value === 'ready' && uiInitState.value === 'ready') return true;
  if (connectionState.value === 'reconnecting') {
    sendStatus.value = `Reconnecting... ${action} is temporarily disabled.`;
  } else if (uiInitState.value === 'loading') {
    sendStatus.value = `Still loading. ${action} is temporarily disabled.`;
  } else {
    sendStatus.value = `Not connected. ${action} is unavailable.`;
  }
  return false;
}

function sessionSortKey(session: SessionInfo) {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function pickPreferredSessionId(list: SessionInfo[]) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const sorted = list
    .filter((session) => !session.parentID && !session.time?.archived)
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

function buildProviderModelKey(providerID?: string, modelID?: string) {
  const normalizedProvider = providerID?.trim() ?? '';
  const normalizedModel = modelID?.trim() ?? '';
  if (!normalizedProvider || !normalizedModel) return '';
  return `${normalizedProvider}/${normalizedModel}`;
}

function parseProviderModelKey(value: string) {
  const normalized = value.trim();
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return { providerID: '', modelID: '' };
  }
  const providerID = normalized.slice(0, slashIndex).trim();
  const modelID = normalized.slice(slashIndex + 1).trim();
  if (!providerID || !modelID) return { providerID: '', modelID: '' };
  return { providerID, modelID };
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
  const raw = storageGet(StorageKeys.drafts.composer);
  return parseComposerDraftStore(raw);
}

function writeComposerDraftStore(store: Record<string, ComposerDraft>) {
  storageSetJSON(StorageKeys.drafts.composer, store);
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
  const raw = storageGet(StorageKeys.state.sidePanelCollapsed);
  return raw === '1';
}

function persistSidePanelCollapsed(value: boolean) {
  storageSet(StorageKeys.state.sidePanelCollapsed, value ? '1' : '0');
}

function readSidePanelTab(): 'todo' | 'tree' {
  const raw = storageGet(StorageKeys.state.sidePanelTab);
  return raw === 'tree' ? 'tree' : 'todo';
}

function persistSidePanelTab(value: 'todo' | 'tree') {
  storageSet(StorageKeys.state.sidePanelTab, value);
}

function toggleSidePanelCollapsed() {
  sidePanelCollapsed.value = !sidePanelCollapsed.value;
  persistSidePanelCollapsed(sidePanelCollapsed.value);
  nextTick(() => {
    syncFloatingExtent();
    scheduleShellFitAll();
  });
}

function setSidePanelTab(value: 'todo' | 'tree') {
  if (sidePanelActiveTab.value === value) return;
  sidePanelActiveTab.value = value;
  persistSidePanelTab(value);
}

function resolveProjectIdForSession(sessionId: string) {
  return sessionGraphStore.getProjectIDForSession(sessionId, selectedProjectId.value || undefined);
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
  
  // Bootstrap guard: if options not loaded yet, apply draft values as-is
  if (agentOptions.value.length === 0 || modelOptions.value.length === 0) {
    if (draft.agent) selectedMode.value = draft.agent;
    if (draft.model) selectedModel.value = draft.model;
    selectedThinking.value = draft.variant;
    return;
  }
  
  // Validate and apply agent
  let agentToApply = draft.agent;
  if (draft.agent && !agentOptions.value.some((o) => o.id === draft.agent)) {
    // Agent not found, fall back to defaults
    const defaults = resolveDefaultAgentModel();
    agentToApply = defaults.agent;
  } else if (draft.agent) {
    agentToApply = draft.agent;
    selectedMode.value = agentToApply;
  }
  
  // Apply agent defaults to get correct model and variant
  if (agentToApply) {
    selectedMode.value = agentToApply;
    applyAgentDefaults(agentToApply);
  }
  
  // Validate and apply model
  if (draft.model && modelOptions.value.some((m) => m.id === draft.model)) {
    // Model is valid, use it
    selectedModel.value = draft.model;
  } else if (draft.model) {
    // Model not found, fall back to agent's default or first available
    if (!selectedModel.value && modelOptions.value.length > 0) {
      selectedModel.value = modelOptions.value[0].id;
    }
  }
  
  // Validate and apply variant
  if (draft.variant && thinkingOptions.value.includes(draft.variant)) {
    selectedThinking.value = draft.variant;
  } else if (draft.variant) {
    // Variant not found, use first available
    selectedThinking.value = thinkingOptions.value[0];
  }
}

function hasRestorableComposerContent(draft: ComposerDraft) {
  return draft.messageInput.trim().length > 0 || draft.attachments.length > 0;
}

function restoreComposerDraftForContext(contextKey: string): boolean {
  if (!contextKey) return false;
  const draft = readComposerDraft(contextKey);
  if (!draft) return false;
  applyComposerDraftToComposerState(draft, contextKey);
  return true;
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
  messageInput.value = '';
  attachments.value = [];
  persistComposerDraftForCurrentContext();
}

function pruneOrphanedComposerDrafts() {
  // Disabled: session graph may be incomplete, causing false-positive draft deletion.
  // Re-enable after session graph construction is fully reliable.
  return;
  if (!bootstrapReady.value) return;
  const store = readComposerDraftStore();
  const knownSessionIDs = sessionGraphStore.getKnownSessionIDs();
  if (knownSessionIDs.size === 0) return;
  const currentContextKey = draftKeyForSelectedContext();
  const cleaned: Record<string, ComposerDraft> = {};

  Object.entries(store).forEach(([key, draft]) => {
    // Always keep the currently active session's draft
    if (key === currentContextKey) {
      cleaned[key] = draft;
      return;
    }

    // Parse the key format: projectId:sessionId
    const parts = key.split(':');
    if (parts.length !== 2) {
      // Invalid key format, skip it
      return;
    }

    const sessionId = parts[1];
    // Keep draft if session exists in the graph
    if (knownSessionIDs.has(sessionId)) {
      cleaned[key] = draft;
    }
    // Otherwise, it's orphaned and will be removed (not added to cleaned)
  });

  writeComposerDraftStore(cleaned);
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
      (m) => m.modelID === defaultModel.modelID && m.providerID === defaultModel.providerID,
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

function resolveDefaultAgentModel(): { agent: string; model: string; variant: string | undefined } {
  // Determine the default agent: prefer 'build' if it exists, otherwise use first available
  const defaultAgent = agentOptions.value.find((o) => o.id === 'build')?.id ?? agentOptions.value[0]?.id ?? '';
  
  // Set the agent and apply its defaults (model + variant)
  selectedMode.value = defaultAgent;
  applyAgentDefaults(defaultAgent);
  
  // If model is still empty after applyAgentDefaults, fall back to provider default or first model
  if (!selectedModel.value && modelOptions.value.length > 0) {
    // Try to find a model from provider defaults
    const providers_data = providers.value;
    const defaults = providers_data.length > 0 ? (providers_data[0] as any)?.default ?? {} : {};
    const preferredModelId = Object.entries(defaults)
      .map(([providerID, modelID]) => {
        const match = modelOptions.value.find(
          (m) => m.providerID === providerID && m.modelID === modelID,
        );
        return match?.id;
      })
      .find((id) => Boolean(id));
    
    selectedModel.value = preferredModelId || modelOptions.value[0]?.id || '';
  }
  
  return {
    agent: selectedMode.value,
    model: selectedModel.value,
    variant: selectedThinking.value,
  };
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
  if (event.key !== storageKey(StorageKeys.drafts.composer)) return;
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
  const message = msg.get(payload.messageId);
  const messageInput = (message ? msg.getTextContent(payload.messageId) : '') || '';
  const sourceAttachments =
    (message ? msg.getImageAttachments(payload.messageId) : undefined) ?? [];
  const attachmentsForDraft: Attachment[] = sourceAttachments.map((item) => ({
    id: item.id,
    filename: item.filename,
    mime: item.mime,
    dataUrl: item.url,
  }));
  const meta = userMessageMetaById.value[payload.messageId];
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

function getSessionStatus(sessionId: string, projectId?: string) {
  if (!sessionId) return undefined;
  return sessionGraphStore.getStatus(sessionId, projectId);
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
  void sessionGraphVersion.value;
  const next: Record<string, SessionStatusType> = {};
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
  sessionGraphStore.setStatus(sessionId, status, projectId);
  markSessionGraphChanged();
}

function deleteSessionStatus(sessionId: string, projectId?: string) {
  if (!sessionId) return;
  sessionGraphStore.setStatus(sessionId, 'idle', projectId);
  markSessionGraphChanged();
}

function syncSessionStatuses(entries: [string, SessionStatusType][], projectId?: string) {
  if (!projectId) return;
  sessionGraphStore.syncStatusesForProject(projectId, entries);
  markSessionGraphChanged();
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
  syncFloatingExtent();
  scheduleShellFitAll();
}

function syncFloatingExtent() {
  const canvas = toolWindowCanvasEl.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  fw.setExtent(rect.width, rect.height);
}

function updateFloatingExtentObserver() {
  if (typeof ResizeObserver === 'undefined') return;
  if (!floatingExtentResizeObserver) {
    floatingExtentResizeObserver = new ResizeObserver(() => {
      syncFloatingExtent();
    });
  }
  const nextEl = toolWindowCanvasEl.value;
  if (floatingExtentObservedEl && floatingExtentObservedEl !== nextEl) {
    floatingExtentResizeObserver.unobserve(floatingExtentObservedEl);
  }
  if (nextEl && nextEl !== floatingExtentObservedEl) {
    floatingExtentResizeObserver.observe(nextEl);
  }
  floatingExtentObservedEl = nextEl ?? null;
  if (nextEl) syncFloatingExtent();
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

function parseImageAttachmentsFromParts(parts: unknown) {
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

function handlePointerMove(event: PointerEvent) {
  if (inputResizeState.value) {
    const { startY, startHeight, minHeight, maxHeight } = inputResizeState.value;
    const dy = event.clientY - startY;
    inputHeight.value = clamp(startHeight - dy, minHeight, maxHeight);
    syncFloatingExtent();
    scheduleShellFitAll();
    return;
  }
}

function handlePointerUp() {
  if (inputResizeState.value) scheduleShellFitAll();
  inputResizeState.value = null;
}

function markSessionGraphChanged() {
  sessionGraphVersion.value = sessionGraphStore.getVersion();
  pruneOrphanedComposerDrafts();
}

function resolveProjectIdForDirectory(directory?: string) {
  const normalized = directory?.trim() || '';
  if (!normalized) return '';
  return sessionGraphStore.resolveProjectIDForDirectory(normalized);
}

function setSessions(list: SessionInfo[], directoryContext?: string) {
  const next = Array.isArray(list) ? list : [];
  const contextDirectory = (directoryContext ?? activeDirectory.value ?? '').trim();
  const projectIDHint =
    selectedProjectId.value ||
    sessionGraphStore.resolveProjectIDForDirectory(contextDirectory || undefined);
  next.forEach((session) => {
    const directory = session.directory?.trim() || contextDirectory;
    if (session.projectID && directory) {
      sessionGraphStore.setSandboxProjectID(directory, session.projectID);
    }
    sessionGraphStore.upsertSession(session, {
      projectIDHint: session.projectID || projectIDHint || undefined,
      directoryHint: directory || undefined,
      retention: session.parentID ? 'ephemeral' : 'persistent',
    });
  });
  markSessionGraphChanged();
}

function clearSessions() {
  selectedSessionId.value = '';
}

function upsertSessionGraph(info: SessionInfo) {
  sessionGraphStore.upsertSession(info, {
    projectIDHint: selectedProjectId.value || undefined,
    directoryHint: activeDirectory.value || undefined,
    retention: info.parentID ? 'ephemeral' : 'persistent',
  });
  markSessionGraphChanged();
}

function removeSessionFromGraph(sessionId: string) {
  sessionGraphStore.removeSession(sessionId, selectedProjectId.value || undefined);
  markSessionGraphChanged();
}

/**
 * Fetch all descendant sessions for the given root session via the
 * `/session/{sessionID}/children` API and register them into
 * `sessionParentById` so that `allowedSessionIds` includes them.
 * This is the primary fix for child sessions not being recognised
 * after initial page load (the `GET /session?directory=…` endpoint
 * only returns sessions whose directory matches, so sub-agent
 * sessions with a different—or missing—directory are omitted).
 */
async function fetchSessionChildren(rootSessionId: string, directory?: string, projectID?: string) {
  const instanceDirectory = (directory || activeDirectory.value || '').trim();
  const fetchKey = `${instanceDirectory}:${rootSessionId}`;
  if (pendingChildFetchKeys.has(fetchKey)) return;
  pendingChildFetchKeys.add(fetchKey);
  try {
    const data = (await opencodeApi.getSessionChildren(
      credentials.baseUrl.value,
      rootSessionId,
      undefined,
      { instanceDirectory: instanceDirectory || undefined },
    )) as SessionInfo[];
    if (!Array.isArray(data) || data.length === 0) return;
    const resolvedProjectID =
      projectID ||
      resolveProjectIdForSession(rootSessionId) ||
      resolveProjectIdForDirectory(instanceDirectory || undefined);
    for (const child of data) {
      if (!child || typeof child.id !== 'string') continue;
      const parentId = typeof child.parentID === 'string' ? child.parentID : rootSessionId;
      sessionGraphStore.upsertSession({ ...child, parentID: parentId }, {
        projectIDHint: resolvedProjectID || undefined,
        directoryHint: instanceDirectory || undefined,
        retention: 'ephemeral',
      });
    }
    markSessionGraphChanged();
  } catch (error) {
    // Non-critical: child list unavailable. SSE events will
    // register children as they arrive.
    log('fetchSessionChildren failed', error);
  } finally {
    pendingChildFetchKeys.delete(fetchKey);
  }
}

async function fetchHomePath() {
  try {
    const data = (await opencodeApi.getPathInfo(credentials.baseUrl.value)) as {
      home?: string;
      worktree?: string;
    };
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
    const data = (await opencodeApi.listProjects(credentials.baseUrl.value, directory)) as ProjectInfo[];
    const list = Array.isArray(data) ? data : [];
    list.forEach((project) => {
      const color = project.color ?? project.icon?.color;
      if (typeof color === 'string' && color.trim()) {
        projectColorById.value[project.id] = color.trim();
      }
      const worktree = typeof project.worktree === 'string' ? project.worktree : '';
      const sandboxes = Array.isArray(project.sandboxes)
        ? project.sandboxes.filter((entry): entry is string => typeof entry === 'string')
        : [];
      sessionGraphStore.syncSandboxes(worktree, sandboxes);
      if (worktree && project.id) {
        sessionGraphStore.setProjectRoot(project.id, worktree);
      }
    });
    markSessionGraphChanged();
  } catch (error) {
    projectError.value = `Project load failed: ${toErrorMessage(error)}`;
  }
}

function upsertProject(next: ProjectInfo) {
  const color = next.color ?? next.icon?.color;
  if (typeof color === 'string' && color.trim()) {
    projectColorById.value[next.id] = color.trim();
  }
  const worktree = typeof next.worktree === 'string' ? next.worktree : '';
  const sandboxes = Array.isArray(next.sandboxes)
    ? next.sandboxes.filter((entry): entry is string => typeof entry === 'string')
    : [];
  sessionGraphStore.syncSandboxes(worktree, sandboxes);
  if (worktree && next.id) {
    sessionGraphStore.setProjectRoot(next.id, worktree);
  }
  markSessionGraphChanged();
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

async function fetchSessions(
  options: {
    directory?: string;
    instanceDirectory?: string;
    roots?: boolean;
    search?: string;
    limit?: number;
  } = {},
) {
  const contextDirectory = options.instanceDirectory ?? options.directory ?? activeDirectory.value;
  const list = await listSessionsByDirectory(options);
  if (options.instanceDirectory && activeDirectory.value) {
    if (normalizeDirectory(options.instanceDirectory) !== normalizeDirectory(activeDirectory.value)) {
      return;
    }
  }
  if (options.directory && activeDirectory.value && options.directory !== activeDirectory.value) {
    return;
  }
  setSessions(list, contextDirectory);
}

async function listSessionsByDirectory(
  options: {
    directory?: string;
    instanceDirectory?: string;
    roots?: boolean;
    search?: string;
    limit?: number;
  } = {},
) {
  sessionError.value = '';
  try {
    const data = (await opencodeApi.listSessions(credentials.baseUrl.value, options)) as SessionInfo[];
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
  return fetchSessions({
    directory,
    instanceDirectory: directory,
    roots: true,
    limit: ROOT_SESSION_BOOTSTRAP_LIMIT,
  });
}

async function fetchWorktrees(directory?: string) {
  worktreeError.value = '';
  if (!directory) return;
  try {
    const baseDir = directory.trim();
    const data = await opencodeApi.listWorktrees(credentials.baseUrl.value, baseDir);
    const list = Array.isArray(data)
      ? data.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (directory !== projectDirectory.value) return;
    if (baseDir && !list.includes(baseDir)) list.unshift(baseDir);
    const current = activeDirectory.value;
    if (current && !list.includes(current)) list.unshift(current);
    sessionGraphStore.syncSandboxes(baseDir, list);
    markSessionGraphChanged();
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
    const data = (await opencodeApi.getVcsInfo(credentials.baseUrl.value, trimmed)) as VcsInfo;
    if (!data || typeof data.branch !== 'string') return;
    if (worktreeMetaRequestIdByDir.get(normalized) !== requestId) return;
    sessionGraphStore.setSandboxBranch(normalized, data.branch);
    markSessionGraphChanged();
  } catch {
    return;
  }
}

function hasWorktreeDirectory(directory: string) {
  const normalized = normalizeDirectory(directory);
  return worktrees.value.some((entry) => normalizeDirectory(entry) === normalized);
}

function appendWorktreeDirectory(directory: string) {
  const trimmed = directory.trim();
  if (!trimmed) return;
  const pd = projectDirectory.value?.trim();
  if (!pd) return;
  sessionGraphStore.ensureSandbox(pd, trimmed);
  markSessionGraphChanged();
}

function storePendingWorktreeMeta(directory: string, branch?: string) {
  if (!branch) return;
  const normalized = normalizeDirectory(directory);
  sessionGraphStore.setSandboxBranch(normalized, branch);
}

async function handleWorktreeReady(event: { directory: string; branch?: string }) {
  const directory = event.directory.trim();
  if (!directory) return;
  const worktreeForDirectory = projectDirectory.value?.trim() || directory;
  if (event.branch) {
    sessionGraphStore.setSandboxBranch(directory, event.branch);
  }
  sessionGraphStore.ensureSandbox(worktreeForDirectory, directory);
  markSessionGraphChanged();
}

async function createWorktree() {
  if (!ensureConnectionReady('Creating worktree')) return;
  worktreeError.value = '';
  if (!projectDirectory.value) {
    worktreeError.value = 'Worktree base directory not set.';
    return;
  }
  try {
    const data = (await opencodeApi.createWorktree(
      credentials.baseUrl.value,
      projectDirectory.value,
    )) as WorktreeInfo;
    if (data && typeof data.directory === 'string') {
      sessionGraphStore.ensureSandbox(projectDirectory.value, data.directory);
      markSessionGraphChanged();
      activeDirectory.value = data.directory;
    }
    void fetchWorktrees(projectDirectory.value || undefined);
  } catch (error) {
    worktreeError.value = `Worktree create failed: ${toErrorMessage(error)}`;
  }
}

async function createWorktreeFromWorktree(worktree: string) {
  if (!ensureConnectionReady('Creating worktree')) return;
  worktreeError.value = '';
  if (!worktree) {
    worktreeError.value = 'Worktree base directory not set.';
    return;
  }
  try {
    const data = (await opencodeApi.createWorktree(
      credentials.baseUrl.value,
      worktree,
    )) as WorktreeInfo;
    if (data && typeof data.directory === 'string') {
      sessionGraphStore.ensureSandbox(worktree, data.directory);
      markSessionGraphChanged();
      projectDirectory.value = worktree;
      activeDirectory.value = data.directory;

      try {
        const session = (await opencodeApi.createSession(
          credentials.baseUrl.value,
          data.directory,
        )) as SessionInfo;
        if (session && typeof session.id === 'string') {
          upsertSessionGraph(session);
          selectedSessionId.value = session.id;
          if (session.projectID) {
            sessionGraphStore.setSandboxProjectID(data.directory, session.projectID);
            markSessionGraphChanged();
          }
        }
      } catch (sessionCreateError) {
        sessionError.value = `Session create failed: ${toErrorMessage(sessionCreateError)}`;
      }
    }
    void fetchWorktrees(worktree || undefined);
  } catch (error) {
    worktreeError.value = `Worktree create failed: ${toErrorMessage(error)}`;
  }
}

async function deleteWorktree(directory: string) {
  if (!ensureConnectionReady('Deleting worktree')) return;
  worktreeError.value = '';
  if (!directory) return;
  if (!projectDirectory.value) {
    worktreeError.value = 'Worktree base directory not set.';
    return;
  }
  const baseDir = projectDirectory.value.replace(/\/+$/, '');
  const targetDir = directory.replace(/\/+$/, '');
  if (baseDir && targetDir === baseDir) return;
  try {
    await opencodeApi.deleteWorktree(credentials.baseUrl.value, projectDirectory.value, targetDir);
    if (normalizeDirectory(activeDirectory.value) === targetDir) activeDirectory.value = '';
    void fetchWorktrees(projectDirectory.value || undefined);
  } catch (error) {
    worktreeError.value = `Worktree delete failed: ${toErrorMessage(error)}`;
  }
}

function openProjectPicker() {
  isProjectPickerOpen.value = true;
}

async function createNewSession() {
  if (!ensureConnectionReady('Creating session')) return;
  sessionError.value = '';
  try {
    const data = (await opencodeApi.createSession(
      credentials.baseUrl.value,
      activeDirectory.value || undefined,
    )) as SessionInfo;
    if (data && typeof data.id === 'string') {
      const matchesDirectory =
        !data.directory ||
        data.directory === activeDirectory.value ||
        !activeDirectory.value;
      if (matchesDirectory) {
        upsertSessionGraph(data);
      }
      selectedSessionId.value = data.id;
      if (data.projectID) {
        sessionGraphStore.setSandboxProjectID(activeDirectory.value || data.directory || '', data.projectID);
        markSessionGraphChanged();
      }
      if (data.directory) activeDirectory.value = data.directory;
    }
    void refreshSessionsForDirectory(activeDirectory.value || undefined);
  } catch (error) {
    sessionError.value = `Session create failed: ${toErrorMessage(error)}`;
  }
}

let globalSessionFallbackInFlight = false;

async function fallbackToGlobalSession() {
  if (globalSessionFallbackInFlight) return;
  if (!ensureConnectionReady('Fallback session')) return;
  globalSessionFallbackInFlight = true;
  try {
    const list = await listSessionsByDirectory({
      directory: '/',
      instanceDirectory: '/',
      roots: true,
      limit: ROOT_SESSION_BOOTSTRAP_LIMIT,
    });
    setSessions(list, '/');

    const rootSessions = list.filter((s) => !s.parentID && !s.time?.archived);
    const preferred = pickPreferredSessionId(rootSessions);

    projectDirectory.value = '/';
    activeDirectory.value = '/';

    if (preferred) {
      selectedSessionId.value = preferred;
    } else {
      await createNewSession();
    }
  } finally {
    globalSessionFallbackInFlight = false;
  }
}

async function handleNewSessionInSandbox(payload: { worktree: string; directory: string }) {
  projectDirectory.value = payload.worktree;
  activeDirectory.value = payload.directory;
  await createNewSession();
}

function handleTopPanelSessionSelect(payload: {
  worktree: string;
  directory: string;
  sessionId: string;
}) {
  if (
    selectedSessionId.value === payload.sessionId &&
    activeDirectory.value === payload.directory &&
    projectDirectory.value === payload.worktree
  ) {
    return;
  }
  projectDirectory.value = payload.worktree;
  activeDirectory.value = payload.directory;
  selectedSessionId.value = payload.sessionId;
  removePendingNotification(`idle:${payload.sessionId}`);
}

function selectSessionById(sessionId: string) {
  let targetSessionId = sessionId;
  const parentMap = sessionParentById.value;
  while (parentMap.get(targetSessionId)) {
    targetSessionId = parentMap.get(targetSessionId) ?? targetSessionId;
  }
  const worktreeEntry = topPanelTreeData.value.find((worktree) =>
    worktree.sandboxes.some((sandbox) => sandbox.sessions.some((session) => session.id === targetSessionId)),
  );
  if (!worktreeEntry) return;
  const sandboxEntry = worktreeEntry.sandboxes.find((sandbox) =>
    sandbox.sessions.some((session) => session.id === targetSessionId),
  );
  if (!sandboxEntry) return;
  handleTopPanelSessionSelect({
    worktree: worktreeEntry.directory,
    directory: sandboxEntry.directory,
    sessionId: targetSessionId,
  });
}

function handleNotificationSessionSelect() {
  const queue = notificationSessionOrder.value.filter((sessionId) =>
    pendingNotificationsBySessionId.value.has(sessionId),
  );
  if (queue.length === 0) return;
  const nextSessionId = queue.find((sessionId) => sessionId !== selectedSessionId.value) ?? queue[0];
  if (!nextSessionId) return;
  selectSessionById(nextSessionId);
}

async function deleteSession(sessionId: string) {
  if (!ensureConnectionReady('Deleting session')) return;
  sessionError.value = '';
  if (!sessionId) return;
  try {
    const directory = activeDirectory.value.trim();
    await opencodeApi.deleteSession(credentials.baseUrl.value, sessionId, directory || undefined);
    if (selectedSessionId.value === sessionId) selectedSessionId.value = '';
    clearNotificationSession(sessionId);
    removeSessionFromGraph(sessionId);
    deleteSessionStatus(sessionId, selectedProjectId.value);
    void refreshSessionsForDirectory(activeDirectory.value || undefined);
    if (!selectedSessionId.value && pickPreferredSessionId(filteredSessions.value) === '') {
      await createNewSession();
    }
  } catch (error) {
    sessionError.value = `Session delete failed: ${toErrorMessage(error)}`;
  }
}

async function archiveSession(sessionId: string) {
  if (!ensureConnectionReady('Archiving session')) return;
  sessionError.value = '';
  if (!sessionId) return;
  try {
    const directory = activeDirectory.value.trim();
    const data = (await opencodeApi.updateSession(
      credentials.baseUrl.value,
      sessionId,
      { time: { archived: Date.now() } },
      directory || undefined,
    )) as SessionInfo;
    if (data && typeof data.id === 'string') {
      upsertSessionGraph(data);
    }
    if (selectedSessionId.value === sessionId) selectedSessionId.value = '';
    void refreshSessionsForDirectory(activeDirectory.value || undefined);
    if (!selectedSessionId.value && pickPreferredSessionId(filteredSessions.value) === '') {
      await createNewSession();
    }
  } catch (error) {
    sessionError.value = `Session archive failed: ${toErrorMessage(error)}`;
  }
}

async function handleForkMessage(payload: { sessionId: string; messageId: string }) {
  if (!ensureConnectionReady('Fork')) return;
  sessionError.value = '';
  try {
    sendStatus.value = 'Forking...';
    const data = (await opencodeApi.forkSession(
      credentials.baseUrl.value,
      payload.sessionId,
      payload.messageId,
      activeDirectory.value.trim() || undefined,
    )) as SessionInfo;
    if (data && typeof data.id === 'string') {
      upsertSessionGraph(data);
      seedForkedSessionComposerDraft(payload, data);
      if (data.projectID) {
        sessionGraphStore.setSandboxProjectID(activeDirectory.value || data.directory || '', data.projectID);
        markSessionGraphChanged();
      }
      if (data.directory) activeDirectory.value = data.directory;
      selectedSessionId.value = data.id;
      void refreshSessionsForDirectory(data.directory || activeDirectory.value || undefined);
    }
    sendStatus.value = 'Forked.';
  } catch (error) {
    sessionError.value = `Session fork failed: ${toErrorMessage(error)}`;
  }
}

async function handleRevertMessage(payload: { sessionId: string; messageId: string }) {
  if (!ensureConnectionReady('Revert')) return;
  sessionError.value = '';
  try {
    sendStatus.value = 'Reverting...';
    await opencodeApi.revertSession(
      credentials.baseUrl.value,
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
  projectDirectory.value = directory;
  activeDirectory.value = directory;
  // Auto-create a session when the opened directory has none
  const list = await listSessionsByDirectory({
    directory,
    instanceDirectory: directory,
    roots: true,
    limit: ROOT_SESSION_BOOTSTRAP_LIMIT,
  });
  if (!list.some((s) => !s.parentID)) {
    await createNewSession();
  }
}

function collectKnownSandboxDirectories() {
  const set = new Set<string>();
  sessionGraphStore.getWorktreeList().forEach((worktreeDirectory) => {
    const normalizedWorktree = worktreeDirectory.trim();
    if (normalizedWorktree) set.add(normalizedWorktree);
    sessionGraphStore.getSandboxList(worktreeDirectory).forEach((sandboxDirectory) => {
      const normalizedSandbox = sandboxDirectory.trim();
      if (normalizedSandbox) set.add(normalizedSandbox);
    });
  });
  const active = activeDirectory.value.trim();
  if (active) set.add(active);
  const projectRoot = projectDirectory.value.trim();
  if (projectRoot) set.add(projectRoot);
  return Array.from(set);
}

async function bootstrapSessionGraph() {
  const directories = collectKnownSandboxDirectories();
  const uniqueDirectories = Array.from(new Set(directories.map((dir) => dir.trim()).filter(Boolean)));
  await Promise.all(
    uniqueDirectories.map(async (directory) => {
      const roots = await listSessionsByDirectory({
        directory,
        instanceDirectory: directory,
        roots: true,
        limit: ROOT_SESSION_BOOTSTRAP_LIMIT,
      });
      setSessions(roots, directory);
      const statusMap = (await opencodeApi.getSessionStatusMap(credentials.baseUrl.value, undefined, {
        instanceDirectory: directory,
      })) as Record<string, { type?: string }>;
      const statusEntries: [string, SessionStatusType][] = [];
      Object.entries(statusMap ?? {}).forEach(([sessionId, status]) => {
        const type = typeof status?.type === 'string' ? status.type : '';
        if (type === 'busy' || type === 'idle' || type === 'retry') {
          statusEntries.push([sessionId, type]);
        }
      });
      const resolvedProjectId = sessionGraphStore.resolveProjectIDForDirectory(directory);
      if (resolvedProjectId) {
        syncSessionStatuses(statusEntries, resolvedProjectId);
      }
    }),
  );
  markSessionGraphChanged();
}

function finalizeSelectionAfterBootstrap() {
  const initialProjectId = initialQuery.projectId.trim();
  const initialSessionId = initialQuery.sessionId.trim();
  if (initialProjectId && initialSessionId) {
    const initialSession = sessionGraphStore.getSession(initialSessionId, initialProjectId);
    const rootDirectory = sessionGraphStore.getProjectRootForProject(initialProjectId);
    if (rootDirectory) projectDirectory.value = rootDirectory;
    if (initialSession) {
      const targetDirectory = initialSession.directory?.trim();
      if (targetDirectory) {
        activeDirectory.value = targetDirectory;
      } else if (rootDirectory) {
        activeDirectory.value = rootDirectory;
      }
      selectedSessionId.value = initialSessionId;
      markSessionGraphChanged();
      return;
    }
    if (rootDirectory) {
      activeDirectory.value = rootDirectory;
      markSessionGraphChanged();
      return;
    }
  }

  const defaultRootDirectory = projectDirectory.value || baseWorktreeOptions.value[0] || '';
  if (defaultRootDirectory) {
    projectDirectory.value = defaultRootDirectory;
    if (!activeDirectory.value) activeDirectory.value = defaultRootDirectory;
  }

  markSessionGraphChanged();
  const preferredId = pickPreferredSessionId(filteredSessions.value);
  if (!selectedSessionId.value && preferredId) selectedSessionId.value = preferredId;
}

async function reconcileSessionGraphFromScopes() {
  const directories = collectKnownSandboxDirectories();
  await Promise.all(
    directories.map(async (directory) => {
      const statusMap = (await opencodeApi.getSessionStatusMap(credentials.baseUrl.value, undefined, {
        instanceDirectory: directory,
      })) as Record<string, { type?: string }>;
      const statusEntries: [string, SessionStatusType][] = [];
      Object.entries(statusMap ?? {}).forEach(([sessionId, status]) => {
        const type = typeof status?.type === 'string' ? status.type : '';
        if (type === 'busy' || type === 'idle' || type === 'retry') {
          statusEntries.push([sessionId, type]);
        }
      });
      const projectID = resolveProjectIdForDirectory(directory);
      if (!projectID) return;
      syncSessionStatuses(statusEntries, projectID);
    }),
  );
  pruneIdleEphemeralSessions();
  markSessionGraphChanged();
  void fetchChildrenForActiveSessions();
}

async function bootstrapSelections() {
  if (isBootstrapping.value) return;
  isBootstrapping.value = true;
  bootstrapReady.value = false;
  try {
    await fetchProjects();
    await bootstrapSessionGraph();
    finalizeSelectionAfterBootstrap();
    if (projectDirectory.value) {
      await fetchWorktrees(projectDirectory.value);
    }
    if (!activeDirectory.value && worktrees.value.length > 0) {
      activeDirectory.value = worktrees.value[0] ?? '';
    }
    if (activeDirectory.value) {
      await fetchCommands(activeDirectory.value);
      await refreshSessionsForDirectory(activeDirectory.value);
    }
    bootstrapReady.value = true;
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

async function fetchProviders(force = false) {
  if (providersLoading.value || (!force && providersLoaded.value)) return;
  providersLoading.value = true;
  providersFetchCount.value += 1;
  log('providers fetch start', providersFetchCount.value);
  try {
    const data = (await opencodeApi.listProviders(credentials.baseUrl.value)) as ProviderResponse;
    providers.value = Array.isArray(data.providers) ? data.providers : [];
    const models: Array<{
      id: string;
      modelID: string;
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
        const id = buildProviderModelKey(providerID, model.id);
        if (!id) return;
        models.push({
          id,
          modelID: model.id,
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
      const preferredModelId = Object.entries(defaults)
        .map(([providerID, modelID]) => buildProviderModelKey(providerID, modelID))
        .find((value) => Boolean(value));
      const firstModel = modelOptions.value[0]?.id;
      selectedModel.value = preferredModelId || firstModel || '';
    }
    const selectedInfo = modelOptions.value.find((model) => model.id === selectedModel.value);
    const nextThinkingOptions = buildThinkingOptions(selectedInfo?.variants);
    const sameThinking =
      nextThinkingOptions.length === thinkingOptions.value.length &&
      nextThinkingOptions.every((value, index) => value === thinkingOptions.value[index]);
    if (!sameThinking) thinkingOptions.value = nextThinkingOptions;
    if (
      selectedThinking.value === undefined ||
      !nextThinkingOptions.includes(selectedThinking.value)
    ) {
      selectedThinking.value = thinkingOptions.value[0];
      log('providers thinking set', selectedThinking.value);
    }
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
    const data = (await opencodeApi.listAgents(credentials.baseUrl.value)) as AgentInfo[];
    agents.value = Array.isArray(data) ? data : [];
    const options = agents.value
      .filter((agent) => agent.mode === 'primary' || agent.mode === 'all')
      .filter((agent) => !agent.hidden)
      .map((agent) => ({
        id: agent.name,
        label: agent.name
          ? `${agent.name.charAt(0).toUpperCase()}${agent.name.slice(1)}`
          : agent.name,
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
    const data = (await opencodeApi.listCommands(credentials.baseUrl.value, directory)) as CommandInfo[];
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
    const data = (await opencodeApi.getSessionStatusMap(credentials.baseUrl.value, undefined, {
      instanceDirectory: directoryAtRequest || undefined,
    })) as Record<string, { type?: string }>;
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
    const resolvedProjectId =
      resolveProjectIdForDirectory(directoryAtRequest || undefined)
      || selectedProjectId.value;
    if (resolvedProjectId) {
      syncSessionStatuses(nextEntries, resolvedProjectId);
    }
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
    const data = await opencodeApi.listPendingPermissions(credentials.baseUrl.value, directory);
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
    const data = await opencodeApi.listPendingQuestions(credentials.baseUrl.value, directory);
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

function clearNotificationSession(sessionId: string) {
  if (!sessionId || !pendingNotificationsBySessionId.value.has(sessionId)) return;
  const next = new Map(pendingNotificationsBySessionId.value);
  next.delete(sessionId);
  pendingNotificationsBySessionId.value = next;
  notificationSessionOrder.value = notificationSessionOrder.value.filter((id) => id !== sessionId);
}

function ensureBrowserNotificationPermission() {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  if (notificationPermissionRequested.value) return;
  notificationPermissionRequested.value = true;
  void Notification.requestPermission();
}

function showBrowserNotification(sessionId: string, type: 'permission' | 'question' | 'idle') {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof Notification === 'undefined') return;
  if (!document.hidden) return;
  if (Notification.permission !== 'granted') return;
  const session = sessions.value.find((entry) => entry.id === sessionId);
  const kind = type === 'permission' ? 'Permission' : type === 'question' ? 'Question' : 'Session idle';
  const body =
    type === 'idle'
      ? session ? `${sessionLabel(session)} is now idle.` : `Session ${sessionId} is now idle.`
      : session ? `${sessionLabel(session)} requires your response.` : `Session ${sessionId} requires your response.`;
  const notification = new Notification(`${kind}`, {
    body,
    tag: `vis-${type}-${sessionId}`,
  });
  notification.onclick = () => {
    window.focus();
    selectSessionById(sessionId);
    notification.close();
  };
}

function addPendingNotification(sessionId: string, requestId: string, type: 'permission' | 'question' | 'idle') {
  if (!sessionId || !requestId) return;
  ensureBrowserNotificationPermission();
  const next = new Map(pendingNotificationsBySessionId.value);
  const requestSet = new Set(next.get(sessionId) ?? []);
  const wasPresent = requestSet.has(requestId);
  requestSet.add(requestId);
  next.set(sessionId, requestSet);
  pendingNotificationsBySessionId.value = next;
  if (!notificationSessionOrder.value.includes(sessionId)) {
    notificationSessionOrder.value = [...notificationSessionOrder.value, sessionId];
  }
  if (!wasPresent) {
    showBrowserNotification(sessionId, type);
  }
}

function removePendingNotification(requestId: string) {
  if (!requestId) return;
  const next = new Map(pendingNotificationsBySessionId.value);
  for (const [sessionId, requestSet] of next.entries()) {
    if (!requestSet.has(requestId)) continue;
    const updatedSet = new Set(requestSet);
    updatedSet.delete(requestId);
    if (updatedSet.size === 0) {
      next.delete(sessionId);
      notificationSessionOrder.value = notificationSessionOrder.value.filter((id) => id !== sessionId);
    } else {
      next.set(sessionId, updatedSet);
    }
    pendingNotificationsBySessionId.value = next;
    return;
  }
}

function reconcilePendingNotifications() {
  notificationSessionOrder.value = notificationSessionOrder.value.filter((sessionId) =>
    pendingNotificationsBySessionId.value.has(sessionId),
  );
}

async function fetchAllPendingNotifications(directory?: string) {
  try {
    const permissionData = await opencodeApi.listPendingPermissions(credentials.baseUrl.value, directory);
    if (Array.isArray(permissionData)) {
      permissionData
        .map((entry) => parsePermissionRequest(entry))
        .filter((entry): entry is PermissionRequest => Boolean(entry))
        .forEach((entry) => {
          addPendingNotification(entry.sessionID, entry.id, 'permission');
        });
    }
  } catch (error) {
    log('Pending permission notifications failed', error);
  }
  try {
    const questionData = await opencodeApi.listPendingQuestions(credentials.baseUrl.value, directory);
    if (Array.isArray(questionData)) {
      questionData
        .map((entry) => parseQuestionRequest(entry))
        .filter((entry): entry is QuestionRequest => Boolean(entry))
        .forEach((entry) => {
          addPendingNotification(entry.sessionID, entry.id, 'question');
        });
    }
  } catch (error) {
    log('Pending question notifications failed', error);
  }
  reconcilePendingNotifications();
}

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

function parseMessageTime(info?: Record<string, unknown>): number | undefined {
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
  const total = tokens.total ?? (tokens.input + tokens.output + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0));
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((total / contextLimit) * 100);
}

function parseMessageTokens(value: unknown): MessageTokens | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const input = typeof record.input === 'number' ? record.input : 0;
  const output = typeof record.output === 'number' ? record.output : 0;
  const reasoning = typeof record.reasoning === 'number' ? record.reasoning : 0;
  const cache =
    record.cache && typeof record.cache === 'object'
      ? (record.cache as Record<string, unknown>)
      : null;
  const cacheRead = cache && typeof cache.read === 'number' ? cache.read : 0;
  const cacheWrite = cache && typeof cache.write === 'number' ? cache.write : 0;
  if (!Number.isFinite(input) && !Number.isFinite(output) && !Number.isFinite(reasoning))
    return null;
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
  if (!TOOL_RENDERER_MESSAGE_EVENTS.has(eventType)) return null;
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

function parseUsageUpdate(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  if (!TOOL_RENDERER_MESSAGE_EVENTS.has(eventType)) return null;
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
    parseSessionId(payload);
  if (!messageId) return null;
  return { messageId, sessionId, usage };
}

function storeUserMessageMeta(messageId: string | undefined, meta: UserMessageMeta | null) {
  if (!messageId || !meta) return;
  userMessageMetaById.value = { ...userMessageMetaById.value, [messageId]: meta };
}

function storeUserMessageTime(messageId: string | undefined, messageTime?: number) {
  if (!messageId || typeof messageTime !== 'number') return;
  userMessageTimeById.value = { ...userMessageTimeById.value, [messageId]: messageTime };
}

function resolveUserMessageMetaForMessage(
  messageId?: string,
  fallbackId?: string,
  meta?: UserMessageMeta | null,
): UserMessageMeta | null {
  if (meta) return meta;
  if (messageId && userMessageMetaById.value[messageId]) return userMessageMetaById.value[messageId];
  if (fallbackId && userMessageMetaById.value[fallbackId]) return userMessageMetaById.value[fallbackId];
  return null;
}

function resolveUserMessageTimeForMessage(
  messageId?: string,
  fallbackId?: string,
  messageTime?: number,
): number | undefined {
  if (typeof messageTime === 'number') return messageTime;
  if (messageId && userMessageTimeById.value[messageId] !== undefined) return userMessageTimeById.value[messageId];
  if (fallbackId && userMessageTimeById.value[fallbackId] !== undefined) return userMessageTimeById.value[fallbackId];
  return undefined;
}

async function fetchHistory(sessionId: string, isSubagentMessage = false) {
  if (!sessionId) return;
  const requestId = !isSubagentMessage ? ++primaryHistoryRequestId : 0;
  const requestedDirectory = !isSubagentMessage ? getSelectedWorktreeDirectory() : '';
  try {
    const directory = getSelectedWorktreeDirectory();
    const data = (await opencodeApi.listSessionMessages(credentials.baseUrl.value, sessionId, {
      directory: directory || undefined,
    })) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return;
    if (!isSubagentMessage) {
      if (requestId !== primaryHistoryRequestId) return;
      if (selectedSessionId.value !== sessionId) return;
      if (getSelectedWorktreeDirectory() !== requestedDirectory) return;
    }
    msg.loadHistory(data);

    data.forEach((message) => {
      const info = message.info as Record<string, unknown> | undefined;
      const id = typeof info?.id === 'string' ? info.id : undefined;
      if (!id) return;
      const meta = parseUserMessageMeta(info);
      const messageTime = parseMessageTime(info);
      storeUserMessageMeta(id, meta);
      storeUserMessageTime(id, messageTime);
    });

    if (!isSubagentMessage) {
      notifyContentChange(false);
    }
  } catch (error) {
    log('History load failed', error);
  }
}

function buildPtyWsUrl(path: string, directory?: string) {
  return opencodeApi.createWsUrl(credentials.baseUrl.value, path, { directory });
}

function parsePtyInfo(value: unknown): PtyInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const title = typeof record.title === 'string' ? record.title : '';
  const command = typeof record.command === 'string' ? record.command : '';
  const args = Array.isArray(record.args) ? record.args.map((arg) => String(arg)) : [];
  const cwd = typeof record.cwd === 'string' ? record.cwd : '';
  const status =
    record.status === 'running' || record.status === 'exited' ? record.status : 'running';
  const pid = typeof record.pid === 'number' ? record.pid : 0;
  if (!id) return null;
  return { id, title, command, args, cwd, status, pid };
}

async function fetchPtyList(directory?: string) {
  const data = await opencodeApi.listPtys(credentials.baseUrl.value, directory);
  if (!Array.isArray(data)) return [] as PtyInfo[];
  return data.map(parsePtyInfo).filter((pty): pty is PtyInfo => Boolean(pty));
}

async function createPtySession(command?: string, args?: string[]) {
  const directory = activeDirectory.value || undefined;
  const data = await opencodeApi.createPty(credentials.baseUrl.value, {
    directory,
    command,
    args,
    cwd: directory,
    title: 'Shell',
  });
  return parsePtyInfo(data);
}

async function updatePtySize(ptyId: string, rows: number, cols: number, directory?: string) {
  const data = await opencodeApi.updatePtySize(credentials.baseUrl.value, ptyId, {
    directory,
    rows,
    cols,
  });
  return parsePtyInfo(data);
}

function ensureShellWindow(pty: PtyInfo) {
  if (shellSessionsByPtyId.has(pty.id)) return;
  const key = `shell:${pty.id}`;
  const { width, height } = getTerminalWindowSize();
  const randomPosition = getRandomWindowPosition({ width, height });
  fw.open(key, {
    component: ShellContent,
    props: { shellId: pty.id },
    closable: true,
    resizable: true,
    scroll: 'none',
    color: '#a855f7',
    title: pty.title || 'Shell',
    width,
    height,
    x: randomPosition.x,
    y: randomPosition.y,
    expiry: Infinity,
    onResize: () => scheduleShellFit(pty.id),
  });
  const terminal = new Terminal({
    cols: TERM_COLUMNS,
    rows: TERM_ROWS,
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
  shellSessionsByPtyId.set(pty.id, {
    pty,
    terminal,
  });
  nextTick(() => {
    const host = toolWindowCanvasEl.value?.querySelector(
      `[data-shell-id="${pty.id}"]`,
    ) as HTMLElement | null;
    if (!host) return;
    terminal.open(host);
    connectShellSocket(pty.id);
    // Wait for first paint so xterm has rendered cell dimensions
    requestAnimationFrame(() => {
      resizeWindowToFitTerminal(key, terminal, host);
    });
  });
}

function resizeWindowToFitTerminal(key: string, terminal: Terminal, _host: HTMLElement) {
  const cell = getTerminalCellSize(terminal);
  if (!cell) return;

  // Measure scrollbar width
  const viewport = terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null;
  const scrollbarWidth = viewport ? viewport.offsetWidth - viewport.clientWidth : 0;

  // Terminal content area needed
  const contentWidth = terminal.cols * cell.width + scrollbarWidth;
  const contentHeight = terminal.rows * cell.height;

  // Window chrome from known CSS values (constant-based, not dynamic measurement):
  //   .floating-window         border: 1px * 2 sides = 2px each direction
  //   .floating-window-titlebar height: 22px + border-bottom: 1px = 23px
  //   .floating-window-body    padding: 2px 4px → 4px V, 8px H
  const chromeX = TERM_WINDOW_BORDER_PX + 2 * TERM_INNER_PADDING_X_PX; // 2 + 8 = 10
  const chromeY = TERM_WINDOW_BORDER_PX + TERM_TITLEBAR_HEIGHT_PX + 1 + TERM_INNER_PADDING_Y_PX; // 2 + 22 + 1 + 4 = 29

  const newWidth = Math.ceil(contentWidth + chromeX);
  const newHeight = Math.ceil(contentHeight + chromeY);

  fw.updateOptions(key, { width: newWidth, height: newHeight });

  // Notify server of terminal dimensions
  const session = shellSessionsByPtyId.get(key.replace('shell:', ''));
  if (session) notifyPtySize(session);
}

  function scheduleShellFitAll() {
  shellSessionsByPtyId.forEach((_, ptyId) => {
    scheduleShellFit(ptyId);
  });
}

function getTerminalCellSize(terminal: Terminal): { width: number; height: number } | null {
  // Prefer measuring from rendered screen (most accurate)
  const termEl = terminal.element;
  if (termEl && terminal.cols > 0 && terminal.rows > 0) {
    const screen = termEl.querySelector('.xterm-screen');
    if (screen) {
      const rect = screen.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { width: rect.width / terminal.cols, height: rect.height / terminal.rows };
      }
    }
  }
  // Fallback: xterm's internal renderer dimensions
  const core = (terminal as any)._core;
  const dims = core?._renderService?.dimensions?.css?.cell;
  if (dims?.width > 0 && dims?.height > 0) {
    return { width: dims.width, height: dims.height };
  }
  return null;
}

function fitTerminalToContainer(session: ShellSession): boolean {
  const termEl = session.terminal.element;
  if (!termEl?.isConnected) return false;
  const parent = termEl.parentElement;
  if (!parent) return false;
  const parentRect = parent.getBoundingClientRect();
  if (parentRect.width <= 0 || parentRect.height <= 0) return false;

  const cell = getTerminalCellSize(session.terminal);
  if (!cell) return false;

  // Subtract scrollbar width from available horizontal space
  const viewport = termEl.querySelector('.xterm-viewport') as HTMLElement | null;
  const scrollbarWidth = viewport ? viewport.offsetWidth - viewport.clientWidth : 0;

  const cols = Math.max(2, Math.floor((parentRect.width - scrollbarWidth) / cell.width));
  const rows = Math.max(1, Math.floor(parentRect.height / cell.height));
  if (cols !== session.terminal.cols || rows !== session.terminal.rows) {
    session.terminal.resize(cols, rows);
  }
  return true;
}

function notifyPtySize(session: ShellSession) {
  const { rows, cols } = session.terminal;
  if (rows > 0 && cols > 0) {
    const directory = session.pty.cwd || activeDirectory.value || undefined;
    updatePtySize(session.pty.id, rows, cols, directory).catch((error) => {
      log('PTY resize failed', error);
    });
  }
}

function scheduleShellFit(ptyId: string) {
  if (pendingShellFits.has(ptyId)) return;
  pendingShellFits.add(ptyId);
  nextTick(() => {
    pendingShellFits.delete(ptyId);
    const session = shellSessionsByPtyId.get(ptyId);
    if (!session) return;

    let prevCols = -1;
    let prevRows = -1;
    let attempts = 0;

    function tick() {
      if (attempts >= 30 || !session.terminal.element?.isConnected) {
        notifyPtySize(session);
        return;
      }
      attempts++;
      fitTerminalToContainer(session);
      const { cols, rows } = session.terminal;
      if (cols === prevCols && rows === prevRows) {
        notifyPtySize(session);
        return;
      }
      prevCols = cols;
      prevRows = rows;
      requestAnimationFrame(tick);
    }

    tick();
  });
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
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      if (bytes.length > 0 && bytes[0] === 0) {
        const json = ptyMetaDecoder.decode(bytes.subarray(1));
        try {
          const meta = JSON.parse(json) as { cursor?: unknown };
          if (typeof meta.cursor === 'number' && Number.isSafeInteger(meta.cursor) && meta.cursor >= 0) {
            return;
          }
        } catch {
          return;
        }
        return;
      }
      session.terminal.write(bytes);
      return;
    }
    if (typeof event.data === 'string') {
      const trimmed = event.data.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const meta = JSON.parse(trimmed) as { cursor?: unknown } & Record<string, unknown>;
          const keys = Object.keys(meta);
          if (
            keys.length === 1
            && keys[0] === 'cursor'
            && typeof meta.cursor === 'number'
            && Number.isSafeInteger(meta.cursor)
            && meta.cursor >= 0
          ) {
            return;
          }
        } catch {
          // fall through to terminal output
        }
      }
      session.terminal.write(event.data);
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

function removeShellWindow(ptyId: string, options?: { kill?: boolean }) {
  const session = shellSessionsByPtyId.get(ptyId);
  if (!session) return;
  pendingShellFits.delete(ptyId);
  session.socket?.close();
  session.terminal.dispose();
  shellSessionsByPtyId.delete(ptyId);
  fw.close(`shell:${ptyId}`);
  if (options?.kill) {
    const directory = session.pty.cwd || activeDirectory.value || undefined;
    opencodeApi.deletePty(credentials.baseUrl.value, ptyId, directory).catch((error) => {
      log('PTY delete failed', error);
    });
  }
}

function handleFloatingWindowClose(key: string) {
  if (key.startsWith('shell:')) {
    const ptyId = key.slice('shell:'.length);
    removeShellWindow(ptyId, { kill: true });
    return;
  }
  void fw.close(key);
}

function disposeShellWindows() {
  const ids = Array.from(shellSessionsByPtyId.keys());
  ids.forEach((ptyId) => removeShellWindow(ptyId));
}

let shellDirectory = '';

async function restoreShellSessions() {
  const directory = activeDirectory.value || '';
  const sandboxChanged = directory !== shellDirectory;
  shellDirectory = directory;
  if (sandboxChanged) {
    disposeShellWindows();
  }
  try {
    const ptys = await fetchPtyList(directory || undefined);
    ptys.forEach((pty) => {
      if (pty.status === 'exited') return;
      ensureShellWindow(pty);
    });
  } catch (error) {
    log('PTY restore failed', error);
  }
}

async function openShellFromInput(input: string) {
  const { command, args } = parseShellArgs(input);
  const pty = await createPtySession(command, args);
  if (pty) ensureShellWindow(pty);
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

const DEBUG_SUBCOMMANDS: Record<string, string> = {
  session: 'Show session graph tree',
  notification: 'Dump pending notification state',
};

function formatSessionGraphDump(): string {
  const data = sessionGraphStore.dump();
  const lines: string[] = [];

  lines.push(`Session Graph  (version ${data.version})`);
  lines.push(`  nodes: ${data.nodeCount}  sessions(unique): ${data.sessionCount}`);
  lines.push('');

  // Index nodes by directory
  const nodesByDir = new Map<string, typeof data.nodes>();
  for (const node of data.nodes) {
    const dir = node.directory || '';
    const group = nodesByDir.get(dir) ?? [];
    group.push(node);
    nodesByDir.set(dir, group);
  }

  function fmtTime(ts?: number) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  }

  function fmtStatus(s: string) {
    if (s === 'busy') return '[BUSY]';
    if (s === 'retry') return '[RETRY]';
    if (s === 'idle') return '[idle]';
    return `[${s}]`;
  }

  function printSession(node: (typeof data.nodes)[0], childrenOf: Map<string, typeof data.nodes>, prefix: string, isLast: boolean) {
    const connector = isLast ? '└── ' : '├── ';
    const status = fmtStatus(node.status);
    const retention = node.retention === 'ephemeral' ? ' (ephemeral)' : '';
    const title = node.title ? `  "${node.title}"` : '';
    const slug = node.slug ? `  slug=${node.slug}` : '';
    lines.push(`${prefix}${connector}${node.sessionID}  ${status}${retention}${title}${slug}`);

    const detail = `${prefix}${isLast ? '    ' : '│   '}`;
    lines.push(`${detail}created: ${fmtTime(node.timeCreated)}  updated: ${fmtTime(node.timeUpdated)}`);

    const children = childrenOf.get(node.sessionID) ?? [];
    children.sort((a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0));
    for (let i = 0; i < children.length; i++) {
      printSession(children[i], childrenOf, `${prefix}${isLast ? '    ' : '│   '}`, i === children.length - 1);
    }
  }

  // Walk tree: worktree -> sandbox -> sessions
  const worktrees = Object.keys(data.tree).sort();
  for (const worktree of worktrees) {
    lines.push(`WORKTREE  ${worktree}`);
    const sandboxes = data.tree[worktree];
    const sandboxKeys = Object.keys(sandboxes).sort();

    for (let si = 0; si < sandboxKeys.length; si++) {
      const sandbox = sandboxKeys[si];
      const info = sandboxes[sandbox];
      const isLastSandbox = si === sandboxKeys.length - 1;
      const sConnector = isLastSandbox ? '└── ' : '├── ';
      const sPrefix = isLastSandbox ? '    ' : '│   ';

      const meta: string[] = [];
      if (info.projectID) meta.push(`project: ${info.projectID}`);
      if (info.branch) meta.push(`branch: ${info.branch}`);
      const metaStr = meta.length > 0 ? `  (${meta.join(', ')})` : '';
      lines.push(`${sConnector}${sandbox}${metaStr}`);

      // Sessions in this sandbox
      const nodes = nodesByDir.get(sandbox) ?? [];
      const childrenOf = new Map<string, typeof data.nodes>();
      const roots: typeof data.nodes = [];
      for (const node of nodes) {
        if (!node.parentID) {
          roots.push(node);
        } else {
          const siblings = childrenOf.get(node.parentID) ?? [];
          siblings.push(node);
          childrenOf.set(node.parentID, siblings);
        }
      }
      roots.sort((a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0));

      if (roots.length === 0 && info.sessionCount === 0) {
        lines.push(`${sPrefix}(no sessions)`);
      }
      for (let i = 0; i < roots.length; i++) {
        printSession(roots[i], childrenOf, sPrefix, i === roots.length - 1);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

function openDebugSessionViewer() {
  const key = 'debug:session-graph';
  const content = formatSessionGraphDump();
  const pos = getFileViewerPosition(0.12, 0.08);
  if (fw.has(key)) fw.close(key);
  fw.open(key, {
    component: FileViewerContent,
    props: {
      fileContent: content,
      lang: 'text',
      gutterMode: 'none',
      theme: shikiTheme.value,
    },
    closable: true,
    resizable: true,
    scroll: 'manual',
    title: 'Debug: Session Graph',
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });
}

function formatNotificationDump(): string {
  const lines: string[] = [];
  const map = pendingNotificationsBySessionId.value;
  const order = notificationSessionOrder.value;
  const parentMap = sessionParentById.value;

  lines.push(`Notification State`);
  lines.push(`  pendingNotificationsBySessionId: ${map.size} session(s)`);
  lines.push(`  notificationSessionOrder: [${order.length}] ${order.join(', ') || '(empty)'}`);
  lines.push(`  selectedSessionId: ${selectedSessionId.value || '(none)'}`);
  lines.push(`  allowedSessionIds: [${allowedSessionIds.value.size}]`);
  lines.push('');

  // Computed notificationSessions (what TopPanel sees)
  const computed = notificationSessions.value;
  lines.push(`Computed notificationSessions (TopPanel badge): ${computed.length} entry(s), total count = ${computed.reduce((s, e) => s + e.count, 0)}`);
  for (const entry of computed) {
    const session = sessions.value.find((s) => s.id === entry.sessionId);
    const label = session ? sessionLabel(session) : '(unknown session)';
    const parentId = parentMap.get(entry.sessionId);
    const parentInfo = parentId ? ` parent=${parentId}` : ' (root)';
    lines.push(`  ${entry.sessionId}  count=${entry.count}  "${label}"${parentInfo}`);
  }
  lines.push('');

  // Full map dump
  lines.push(`Full pendingNotificationsBySessionId:`);
  if (map.size === 0) {
    lines.push('  (empty)');
  }
  for (const [sessionId, requestIds] of map.entries()) {
    const session = sessions.value.find((s) => s.id === sessionId);
    const label = session ? sessionLabel(session) : '(unknown session)';
    const parentId = parentMap.get(sessionId);
    const parentInfo = parentId ? ` parent=${parentId}` : ' (root)';
    const isAllowed = allowedSessionIds.value.has(sessionId);
    const isSelected = sessionId === selectedSessionId.value;
    const flags: string[] = [];
    if (isSelected) flags.push('SELECTED');
    if (isAllowed) flags.push('ALLOWED');
    if (parentId) flags.push('CHILD');
    const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
    lines.push(`  ${sessionId}  "${label}"${parentInfo}${flagStr}`);
    for (const requestId of requestIds) {
      const isIdle = requestId.startsWith('idle:');
      const type = isIdle ? 'idle' : 'permission/question';
      lines.push(`    - ${requestId}  (${type})`);
    }
  }
  lines.push('');

  // Order vs Map consistency check
  const orphanedInOrder = order.filter((id) => !map.has(id));
  const missingFromOrder = Array.from(map.keys()).filter((id) => !order.includes(id));
  if (orphanedInOrder.length > 0 || missingFromOrder.length > 0) {
    lines.push(`Consistency Issues:`);
    if (orphanedInOrder.length > 0) {
      lines.push(`  In notificationSessionOrder but NOT in map: ${orphanedInOrder.join(', ')}`);
    }
    if (missingFromOrder.length > 0) {
      lines.push(`  In map but NOT in notificationSessionOrder: ${missingFromOrder.join(', ')}`);
    }
    lines.push('');
  }

  // Pending permissions & questions currently shown as floating windows
  const permissionEntries = fw.entries.value.filter((e) => e.key.startsWith('permission:'));
  const questionEntries = fw.entries.value.filter((e) => e.key.startsWith('question:'));
  lines.push(`Active Floating Windows:`);
  lines.push(`  Permission windows: ${permissionEntries.length}`);
  for (const entry of permissionEntries) {
    const req = entry.props?.request as { id?: string; sessionID?: string } | undefined;
    lines.push(`    - ${entry.key}  session=${req?.sessionID ?? '?'}  request=${req?.id ?? '?'}`);
  }
  lines.push(`  Question windows: ${questionEntries.length}`);
  for (const entry of questionEntries) {
    const req = entry.props?.request as { id?: string; sessionID?: string } | undefined;
    lines.push(`    - ${entry.key}  session=${req?.sessionID ?? '?'}  request=${req?.id ?? '?'}`);
  }

  return lines.join('\n');
}

function openDebugNotificationViewer() {
  const key = 'debug:notification';
  const content = formatNotificationDump();
  const pos = getFileViewerPosition(0.15, 0.1);
  if (fw.has(key)) fw.close(key);
  fw.open(key, {
    component: FileViewerContent,
    props: {
      fileContent: content,
      lang: 'text',
      gutterMode: 'none',
      theme: shikiTheme.value,
    },
    closable: true,
    resizable: true,
    scroll: 'manual',
    title: 'Debug: Notifications',
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });
}

function runDebugCommand(args: string): { ok: boolean; message: string } {
  const sub = args.trim().toLowerCase();
  if (!sub || sub === 'help') {
    const lines = ['Available /debug subcommands:'];
    for (const [name, desc] of Object.entries(DEBUG_SUBCOMMANDS)) {
      lines.push(`  ${name} — ${desc}`);
    }
    return { ok: true, message: lines.join('\n') };
  }
  if (sub === 'session' || sub === 'sessions') {
    openDebugSessionViewer();
    return { ok: true, message: 'Session graph opened.' };
  }
  if (sub === 'notification' || sub === 'notifications') {
    openDebugNotificationViewer();
    return { ok: true, message: 'Notification dump opened.' };
  }
  return { ok: false, message: `Unknown debug subcommand: ${sub}. Type /debug help for a list.` };
}



async function sendCommand(sessionId: string, command: CommandInfo, commandArgs: string) {
  if (!ensureConnectionReady('Sending commands')) return;
  const directory = activeDirectory.value.trim();
  await opencodeApi.sendCommand(credentials.baseUrl.value, sessionId, {
    directory: directory || undefined,
    command: command.name,
    arguments: commandArgs,
    agent: command.agent || selectedMode.value,
    model: command.model || selectedModel.value,
    variant: selectedThinking.value,
  });
}

async function sendMessage() {
  if (!ensureConnectionReady('Sending')) return;
  if (!canSend.value) return;
  const text = messageInput.value.trim();
  const hasText = text.length > 0;
  const hasAttachments = attachments.value.length > 0;
  let sessionId = selectedSessionId.value;
  if ((!hasText && !hasAttachments) || !sessionId) return;
  if (!filteredSessions.value.some((session) => session.id === sessionId)) {
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
  const selectedModelIDs = parseProviderModelKey(selectedModel.value);
  const providerID = selectedInfo?.providerID ?? (selectedModelIDs.providerID || undefined);
  const modelID = selectedInfo?.modelID ?? (selectedModelIDs.modelID || undefined);
  if (hasText) {
    recentUserInputs.push({ text, time: Date.now() });
    while (recentUserInputs.length > 20) recentUserInputs.shift();
  }
  messageInput.value = '';
  enableFollow();
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
      const debugResult = runDebugCommand(slash.arguments ?? '');
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
    await opencodeApi.sendPromptAsync(credentials.baseUrl.value, sessionId, {
      directory,
      agent: selectedMode.value,
      model: {
        providerID,
        modelID: modelID || '',
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

let lastEscTime = 0;
const DOUBLE_ESC_THRESHOLD = 500;

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;

  // Priority 1: Close any open modal / overlay
  if (isSettingsOpen.value) {
    isSettingsOpen.value = false;
    lastEscTime = 0;
    return;
  }
  if (isProjectPickerOpen.value) {
    isProjectPickerOpen.value = false;
    lastEscTime = 0;
    return;
  }
  if (outputPanelRef.value?.isHistoryOpen) {
    outputPanelRef.value.closeHistory();
    lastEscTime = 0;
    return;
  }

  // Priority 2: Double-ESC to abort
  const now = Date.now();
  if (now - lastEscTime < DOUBLE_ESC_THRESHOLD) {
    lastEscTime = 0;
    if (canAbort.value) {
      abortSession();
    }
  } else {
    lastEscTime = now;
  }
}

async function abortSession() {
  if (!ensureConnectionReady('Stopping')) return;
  const sessionId = selectedSessionId.value;
  if (!sessionId || isAborting.value) return;
  isAborting.value = true;
  sendStatus.value = 'Stopping...';
  try {
    const directory = activeDirectory.value.trim();
    const busyDescendants = busyDescendantSessionIds.value;
    const abortPromises = [
      opencodeApi.abortSession(credentials.baseUrl.value, sessionId, directory || undefined),
      ...busyDescendants.map((sid) =>
        opencodeApi.abortSession(credentials.baseUrl.value, sid, directory || undefined).catch(() => {}),
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
  () => toolWindowCanvasEl.value,
  () => {
    updateFloatingExtentObserver();
  },
  { immediate: true },
);

watch(
  [projectDirectory, activeDirectory, selectedSessionId],
  ([pd, ad, sid], [prevPd, prevAd, prevSid] = ['', '', '']) => {
    if (isBootstrapping.value) return;

    const pdChanged = pd !== prevPd && typeof prevPd !== 'undefined';
    const adChanged = ad !== prevAd && typeof prevAd !== 'undefined';
    const sidChanged = sid !== prevSid && typeof prevSid !== 'undefined';

    // pd/ad が変わっていなければ何もしない（sid だけの変更は意図的なセッション切り替え）
    if (!pdChanged && !adChanged) return;

    // pd/ad が変わったが sid も同時に変わった場合 = 意図的な一括選択 → クリアしない
    // pd/ad だけ変わった場合 = ディレクトリ切り替え → sid をクリア
    if (!sidChanged) {
      selectedSessionId.value = '';
    }

    markSessionGraphChanged();

    if (pdChanged) {
      void fetchWorktrees(pd || undefined);
    }

    const directoryToRefresh = ad || pd || undefined;
    void refreshSessionsForDirectory(directoryToRefresh);

    if (adChanged && ad) {
      void fetchCommands(ad);
      void fetchSessionStatus(ad || undefined);
    }
  },
  { immediate: true },
);

watch(
  worktrees,
  (list) => {
    // Auto-select activeDirectory if current is not in list
    if (isBootstrapping.value) return;
    if (list.length === 0) return;
    if (activeDirectory.value && list.includes(activeDirectory.value)) return;
    activeDirectory.value = list[0] ?? '';
  },
  { immediate: true },
);

watch(
  filteredSessions,
  () => {
    if (!bootstrapReady.value && !isBootstrapping.value) return;
    if (isBootstrapping.value) return;
    if (filteredSessions.value.length === 0) {
      if (!selectedSessionId.value) {
        void fallbackToGlobalSession();
      }
      return;
    }
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

watch(
  sessions,
  () => {
    reconcilePendingNotifications();
  },
  { immediate: true },
);

watch(
  uiInitState,
  (state) => {
    if (state !== 'ready') return;
    nextTick(() => {
      syncFloatingExtent();
      inputPanelRef.value?.focus();
      void restoreShellSessions();
    });
  },
  { immediate: true },
);

async function reloadSelectedSessionState() {
  if (selectedSessionId.value && isBootstrapping.value && !activeDirectory.value) {
    return;
  }
  followDebug('reloadSelectedSessionState:start', {
    selectedSessionId: selectedSessionId.value,
  });
  const selected = sessions.value.find((session) => session.id === selectedSessionId.value);
  if (selected?.projectID) {
    const directory = selected.directory || activeDirectory.value || projectDirectory.value;
    if (directory && sessionGraphStore.setSandboxProjectID(directory, selected.projectID)) {
      markSessionGraphChanged();
    }
  }
  fw.closeAll({ exclude: (key) => key.startsWith('shell:') });
  msg.reset();
  resetFollow();
  reasoning.reset();
  subagentWindows.reset();
  retryStatus.value = null;
  todosBySessionId.value = {};
  todoLoadingBySessionId.value = {};
  todoErrorBySessionId.value = {};
  if (selectedSessionId.value) {
    await fetchHistory(selectedSessionId.value);
    if (msg.roots.value.length === 0) {
      scrollOutputPanelToBottom(false);
    }
    if (uiInitState.value === 'ready') {
      await restoreShellSessions();
    }
    void reloadTodosForAllowedSessions();
    void refreshSessionDiff();
    void loadTreePath('.');
    const directory = activeDirectory.value || undefined;
    void fetchPendingPermissions(directory);
    void fetchPendingQuestions(directory);
    // Fetch child sessions so allowedSessionIds includes them.
    // When sessionParentById updates, the watch on allowedSessionIds
    // will automatically re-trigger reloadTodosForAllowedSessions.
    void fetchSessionChildren(selectedSessionId.value, directory, selectedProjectId.value || undefined);
  }
  nextTick(() => inputPanelRef.value?.focus());
}

async function fetchChildrenForActiveSessions() {
  const activeSessions = sessionGraphStore.listActiveSessions();
  await Promise.all(
    activeSessions.map(async (session) => {
      const directory = session.directory?.trim();
      if (!directory) return;
      await fetchSessionChildren(session.id, directory, session.projectID);
    }),
  );
}

function pruneIdleEphemeralSessions() {
  const keep = new Set<string>(allowedSessionIds.value);
  const changed = sessionGraphStore.pruneEphemeralChildren(CHILD_SESSION_PRUNE_TTL_MS, keep);
  if (changed) markSessionGraphChanged();
}

watch(
  [selectedProjectId, selectedSessionId],
  ([projectId, sessionId], previous) => {
    const [prevProjectId, prevSessionId] = previous ?? ['', ''];
    const contextKey = buildComposerContextKey(projectId, sessionId);
  const prevContextKey = buildComposerContextKey(prevProjectId ?? '', prevSessionId ?? '');
  if (contextKey === prevContextKey) return;
  clearComposerInputState();
  nextTick(() => {
    inputPanelRef.value?.reset();
  });
  if (!contextKey) return;
  const hadDraft = restoreComposerDraftForContext(contextKey);
  if (!hadDraft) resolveDefaultAgentModel();
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
  if (
    selectedThinking.value === undefined ||
    !nextThinkingOptions.includes(selectedThinking.value)
  ) {
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
  if (activeDirectory.value && activePath !== activeDirectory.value) return;
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

function log(..._args: unknown[]) {}

function followDebug(event: string, detail?: Record<string, unknown>) {
  const t = typeof performance !== 'undefined' ? Number(performance.now().toFixed(1)) : 0;
  if (detail) {
    console.debug(`[app-follow] ${event}`, { t, ...detail });
    return;
  }
  console.debug(`[app-follow] ${event}`, { t });
}

const shikiTheme = ref('github-dark');

setInterval(() => {
  pruneIdleEphemeralSessions();
  void fetchChildrenForActiveSessions();
}, 15_000);



const TOOL_RENDERER_READ_EVENT_TYPES = new Set(['session.diff', 'file.edited']);

const TOOL_RENDERER_WRITE_EVENT_TYPES = new Set<string>([]);

const TOOL_RENDERER_MESSAGE_EVENTS = new Set([
  'message.updated',
  'message.part.updated',
  'message.removed',
  'message.part.removed',
]);

const toolRendererReadTypesKey = `FILE_${'READ'}_EVENT_TYPES`;
const toolRendererWriteTypesKey = `FILE_${'WRITE'}_EVENT_TYPES`;
const toolRendererMessageTypesKey = `MESSAGE_${'EVENT_TYPES'}`;

const toolRendererHelpers = {
  [toolRendererReadTypesKey]: TOOL_RENDERER_READ_EVENT_TYPES,
  [toolRendererWriteTypesKey]: TOOL_RENDERER_WRITE_EVENT_TYPES,
  [toolRendererMessageTypesKey]: TOOL_RENDERER_MESSAGE_EVENTS,
  parsePatchTextBlocks,
  guessLanguage,
  shouldRenderToolWindow,
  extractToolOutputText: parseToolOutputText,
  formatToolValue,
  renderWorkerHtml,
  renderReadHtmlFromApi,
  resolveReadWritePath,
  guessLanguageFromPath,
  resolveReadRange,
  renderEditDiffHtml,
  formatGlobToolTitle,
  formatListToolTitle,
  formatWebfetchToolTitle,
  formatQueryToolTitle,
  formatTaskToolOutput,
  GrepContent,
  GlobContent,
  WebContent,
};

const ge = useGlobalEvents(credentials.baseUrl.value);
const deltaAccumulator = useDeltaAccumulator();
deltaAccumulator.listen(ge);
const sessionScope = ge.session(selectedSessionId, sessionParentRecord);
const mainSessionScope = ge.mainSession(selectedSessionId);
const msg = useMessages();
msg.bindScope(mainSessionScope);
reasoning.bindScope(sessionScope);
subagentWindows.bindScope(sessionScope);

watch(selectedSessionId, reloadSelectedSessionState, { immediate: true });

watch(() => credentials.authHeader.value, (authHeader) => {
  opencodeApi.setDefaultAuthorization(authHeader);
}, { immediate: true });

function matchesSelectedProject(sessionInfo: SessionInfo) {
  if (!sessionInfo.directory) return true;
  const sessionDirectory = normalizeDirectory(sessionInfo.directory);
  const pd = normalizeDirectory(projectDirectory.value || '');
  const ad = normalizeDirectory(activeDirectory.value || '');
  return sessionDirectory === ad || sessionDirectory === pd;
}

function matchesSelectedWorktree(sessionInfo: SessionInfo) {
  const directory = activeDirectory.value.trim();
  if (!directory) return true;
  if (sessionInfo.directory && sessionInfo.directory !== directory) return false;
  return true;
}

const SESSION_ID_KEYS = new Set(['sessionID', 'sessionId', 'session_id']);

function parseSessionId(payload: unknown) {
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

function parseToolOutputText(output: unknown) {
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

function formatTaskToolOutput(value: string) {
  return value
    .split('\n')
    .filter((line) => !/^task_id:\s*/i.test(line.trim()))
    .join('\n')
    .replace(/<\/?task_result>/gi, '')
    .trim();
}

function decodeApiTextContent(data: FileContentResponse) {
  const encoding = typeof data?.encoding === 'string' ? data.encoding : 'utf-8';
  const content = typeof data?.content === 'string' ? data.content : '';
  if (!content) return '';
  if (encoding !== 'base64') return content;

  const bytes = toUint8ArrayFromBase64(content);
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return atob(content);
  }
}

async function renderReadHtmlFromApi(params: {
  callId?: string;
  path?: string;
  lang: string;
  lineOffset?: number;
  lineLimit?: number;
  fallbackText?: string;
}): Promise<string> {
  const renderText = (text: string, gutterMode: 'none' | 'single' = 'none') =>
    renderWorkerHtml({
      id: `read-${params.callId ?? 'unknown'}-${Date.now().toString(36)}`,
      code: text,
      lang: 'text',
      theme: 'github-dark',
      gutterMode,
    });

  const directory = activeDirectory.value.trim();
  if (!directory) return renderText('No active directory selected for READ window.');
  if (!params.path) return renderText('READ path is missing in tool payload.');

  const requestPath = splitFileContentDirectoryAndPath(params.path, directory);

  try {
    const listData = await opencodeApi.listFiles(credentials.baseUrl.value, {
      directory: requestPath.directory,
      path: requestPath.path,
    });
    if (Array.isArray(listData) && listData.length > 0) {
      const entries = listData
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const record = item as FileNode;
          const name = record.name ?? record.path?.split('/').pop();
          if (!name) return null;
          return record.type === 'directory' ? `${name}/` : name;
        })
        .filter((entry): entry is string => Boolean(entry));
      const code = entries.length > 0 ? entries.join('\n') : '(empty directory)';
      return renderText(code, 'none');
    }
  } catch {
    // Not a directory, or listing failed — proceed to read as file content.
  }

  try {
    const data = (await opencodeApi.readFileContent(credentials.baseUrl.value, {
      directory: requestPath.directory,
      path: requestPath.path,
    })) as FileContentResponse;
    const type = data?.type === 'binary' ? 'binary' : 'text';

    if (type === 'binary') {
      return renderText(`Binary file: ${params.path}\nPreview is not available.`, 'none');
    }

    const code = decodeApiTextContent(data);
    return renderWorkerHtml({
      id: `read-${params.callId ?? 'unknown'}-${Date.now().toString(36)}`,
      code,
      lang: params.lang,
      theme: 'github-dark',
      gutterMode: 'single',
      lineOffset: params.lineOffset,
      lineLimit: params.lineLimit,
    });
  } catch (error) {
    if (params.fallbackText) {
      return renderWorkerHtml({
        id: `read-${params.callId ?? 'unknown'}-${Date.now().toString(36)}`,
        code: params.fallbackText,
        lang: params.lang,
        theme: 'github-dark',
        gutterMode: 'single',
        lineOffset: params.lineOffset,
        lineLimit: params.lineLimit,
      });
    }
    return renderText(`Failed to load: ${params.path ?? 'unknown file'}`);
  }
}

function renderEditDiffHtml(params: {
  diff: string;
  code?: string;
  after?: string;
  lang: string;
}): () => Promise<string> {
  return () => renderWorkerHtml({
    id: `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    code: params.code ?? '',
    after: params.after,
    patch: params.diff,
    lang: params.lang,
    theme: 'github-dark',
    gutterMode: 'double',
  });
}

function parsePermissionRequest(
  value: unknown,
  fallbackSessionId?: string,
): PermissionRequest | null {
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
    record.tool && typeof record.tool === 'object'
      ? (record.tool as Record<string, unknown>)
      : null;
  const toolMessageId =
    (typeof record.messageID === 'string' && record.messageID) ||
    (toolRaw && typeof toolRaw.messageID === 'string' ? toolRaw.messageID : undefined);
  const toolCallId =
    (typeof record.callID === 'string' && record.callID) ||
    (typeof record.callId === 'string' && record.callId) ||
    (toolRaw && typeof toolRaw.callID === 'string' ? toolRaw.callID : undefined);
  if (!id || !sessionID || !permission) return null;
  const tool =
    toolMessageId && toolCallId ? { messageID: toolMessageId, callID: toolCallId } : undefined;
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
  const questions: QuestionInfo[] = [];
  questionsRaw.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const info = item as Record<string, unknown>;
    const question = typeof info.question === 'string' ? info.question.trim() : '';
    const header = typeof info.header === 'string' ? info.header.trim() : '';
    const optionsRaw = Array.isArray(info.options) ? info.options : [];
    const options: QuestionOption[] = [];
    optionsRaw.forEach((option) => {
      if (!option || typeof option !== 'object') return;
      const optionInfo = option as Record<string, unknown>;
      const label = typeof optionInfo.label === 'string' ? optionInfo.label.trim() : '';
      const description =
        typeof optionInfo.description === 'string' ? optionInfo.description.trim() : '';
      if (!label || !description) return;
      options.push({ label, description });
    });
    if (!question || !header || options.length === 0) return;
    questions.push({
      question,
      header,
      options,
      multiple: info.multiple === true,
      custom: info.custom !== false,
    });
  });
  const toolRaw =
    record.tool && typeof record.tool === 'object'
      ? (record.tool as Record<string, unknown>)
      : null;
  const toolMessageId =
    (typeof record.messageID === 'string' && record.messageID) ||
    (toolRaw && typeof toolRaw.messageID === 'string' ? toolRaw.messageID : undefined);
  const toolCallId =
    (typeof record.callID === 'string' && record.callID) ||
    (typeof record.callId === 'string' && record.callId) ||
    (toolRaw && typeof toolRaw.callID === 'string' ? toolRaw.callID : undefined);
  if (!id || !sessionID || questions.length === 0) return null;
  const tool =
    toolMessageId && toolCallId ? { messageID: toolMessageId, callID: toolCallId } : undefined;
  return {
    id,
    sessionID,
    questions,
    tool,
  };
}

const TOOL_WINDOW_HIDDEN = new Set([
  'question',
  'todoread',
  'todowrite',
  'lsp',
  'plan_enter',
  'plan_exit',
  'task',
]);
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
  return value
    .map((item) => normalizeTodoItem(item))
    .filter((item): item is TodoItem => Boolean(item));
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
        const data = await opencodeApi.getSessionTodos(credentials.baseUrl.value, id, directory);
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
  if (normalizedPath.startsWith(prefix))
    return normalizeRelativePath(normalizedPath.slice(prefix.length));
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
    const normalizedType: TreeNode['type'] = node.type === 'directory' ? 'directory' : 'file';
    unique.set(path, {
      name,
      path,
      type: isLeaf ? normalizedType : 'directory',
      children: isLeaf && normalizedType !== 'directory' ? undefined : [],
      loaded: false,
      ignored: Boolean(node.ignored),
      synthetic: false,
    });
  });
  return sortTreeNodes(Array.from(unique.values()));
}

function updateTreeNodeChildren(
  nodes: TreeNode[],
  targetPath: string,
  children: TreeNode[],
): TreeNode[] {
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
    const data = await opencodeApi.listFiles(credentials.baseUrl.value, {
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
    const data = await opencodeApi.getSessionDiff(credentials.baseUrl.value, {
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

function getFileViewerPosition(factorX = 0.16, factorY = 0.1) {
  const metrics = getCanvasMetrics();
  const x = metrics
    ? clamp(
        metrics.canvasRect.width * factorX,
        16,
        Math.max(16, metrics.canvasRect.width - FILE_VIEWER_WINDOW_WIDTH - 16),
      )
    : 24;
  const y = metrics
    ? clamp(
        metrics.toolAreaHeight * factorY,
        16,
        Math.max(16, metrics.toolAreaHeight - FILE_VIEWER_WINDOW_HEIGHT - 16),
      )
    : 24;
  return { x, y };
}

function openSessionDiff(path: string) {
  const entry = sessionDiffByPath.value[path];
  if (!entry || !entry.file) return;
  const key = `session-diff:${path}`;
  if (fw.has(key)) {
    fw.bringToFront(key);
    return;
  }
  const pos = getFileViewerPosition();
  fw.open(key, {
    component: FileViewerContent,
    props: {
      path,
      isDiff: true,
      diffCode: entry.before ?? '',
      diffAfter: entry.after,
      gutterMode: 'none',
      lang: guessLanguage(path),
      theme: shikiTheme.value,
    },
    closable: true,
    resizable: true,
    scroll: 'manual',
    title: path,
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });
}

function handleShowMessageDiff(payload: { messageKey: string; diffs: Array<MessageDiffEntry> }) {
  const { messageKey, diffs } = payload;
  if (!diffs || diffs.length === 0) return;
  const key = `message-diff:${messageKey}`;
  if (fw.has(key)) {
    fw.bringToFront(key);
    return;
  }
  const hasBeforeAfter = diffs.some(
    (d) => typeof d.before === 'string' && typeof d.after === 'string',
  );
  const combinedDiff = hasBeforeAfter ? '' : diffs.map((d) => d.diff).join('\n');
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

  const pos = getFileViewerPosition();
  fw.open(key, {
    component: FileViewerContent,
    props: {
      path: firstFile,
      isDiff: true,
      diffCode: hasBeforeAfter ? (diffs[0]?.before ?? '') : '',
      diffAfter: hasBeforeAfter ? (diffs[0]?.after ?? '') : undefined,
      diffPatch: hasBeforeAfter ? undefined : combinedDiff,
      diffTabs,
      gutterMode: hasBeforeAfter ? 'double' : 'none',
      lang: fileCount === 1 ? guessLanguage(firstFile) : 'text',
      theme: shikiTheme.value,
    },
    closable: true,
    resizable: true,
    scroll: 'manual',
    title,
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });
}


function openToolPartAsWindow(
  toolPart: ToolPart,
  overrides?: Record<string, unknown>,
  keyPrefix?: string,
): string[] {
  const openedKeys: string[] = [];
  const payload = {
    type: 'message.part.updated',
    payload: {
      type: 'message.part.updated',
      properties: { part: toolPart },
    },
  };

  const patchEvents = extractToolPatch(payload, toolRendererHelpers as any);
  if (patchEvents) {
    patchEvents.forEach((patchEvent: any, index: number) => {
      const rawId = patchEvent.callId ?? `apply_patch:${index}`;
      const key = keyPrefix ? `${keyPrefix}${rawId}` : rawId;
      const patchLang = patchEvent.lang ?? 'text';
      fw.open(key, {
        content: renderEditDiffHtml({
          diff: patchEvent.content,
          code: patchEvent.code,
          after: patchEvent.after,
          lang: patchLang,
        }),
        variant: 'diff',
        status:
          patchEvent.toolStatus === 'running' ||
          patchEvent.toolStatus === 'completed' ||
          patchEvent.toolStatus === 'error'
            ? patchEvent.toolStatus
            : undefined,
        title: patchEvent.title,
        color: toolColor(patchEvent.toolName),
        ...overrides,
      });
      openedKeys.push(key);
    });
    return openedKeys;
  }

  const fileReadResult = extractToolFileRead(
    payload,
    'message.part.updated',
    toolRendererHelpers as any,
  );
  const fileReads = fileReadResult
    ? Array.isArray(fileReadResult)
      ? fileReadResult
      : [fileReadResult]
    : null;
  if (!fileReads) return openedKeys;
  fileReads.forEach((entry: any) => {
    if (entry.callId) {
      const { callId, toolName, toolStatus, ...rest } = entry;
      const key = keyPrefix ? `${keyPrefix}${callId}` : callId;
      fw.open(key, {
        ...rest,
        status:
          toolStatus === 'running' || toolStatus === 'completed' || toolStatus === 'error'
            ? toolStatus
            : undefined,
        color: toolColor(toolName),
        ...overrides,
      });
      openedKeys.push(key);
    }
  });
  return openedKeys;
}

const historyToolWindowKeys = new Set<string>();

function closeHistoryToolWindows() {
  for (const key of historyToolWindowKeys) {
    fw.close(key);
  }
  historyToolWindowKeys.clear();
}

function handleOpenHistoryTool(payload: { part: ToolPart }) {
  closeHistoryToolWindows();
  const { width, height } = fw.getExtent();
  const winW = 600;
  const winH = 400;
  const x = Math.max(0, Math.round((width - winW) / 2));
  const y = Math.max(0, Math.round((height - winH) / 2));
  const keys = openToolPartAsWindow(payload.part, {
    closable: true,
    resizable: true,
    expiry: Infinity,
    scroll: 'manual',
    x,
    y,
  }, 'history-tool:');
  for (const key of keys) historyToolWindowKeys.add(key);
}

function handleCloseHistoryTools() {
  closeHistoryToolWindows();
}

function handleOpenImage(payload: { url: string; filename: string }) {
  const { url, filename } = payload;
  const key = `image-viewer:${url}`;
  if (fw.has(key)) {
    fw.bringToFront(key);
    return;
  }
  const pos = getFileViewerPosition();
  fw.open(key, {
    component: ImageViewer,
    props: {
      src: url,
      alt: filename,
    },
    closable: true,
    resizable: true,
    scroll: 'manual',
    title: filename || 'Image',
    x: pos.x,
    y: pos.y,
    width: 800,
    height: 600,
    expiry: Infinity,
  });
}

async function handleEditMessage(payload: { sessionId: string; part: MessagePart }) {
  const directory = activeDirectory.value.trim();
  if (payload.part.type !== 'text') return;
  const nextText = window.prompt('Edit message', payload.part.text);
  if (nextText === null) return;
  const trimmed = nextText.trimEnd();
  if (!trimmed) return;
  if (trimmed === payload.part.text) return;
  try {
    const part = { ...payload.part, text: trimmed };
    await opencodeApi.patchMessagePart(credentials.baseUrl.value, {
      sessionID: payload.sessionId,
      messageID: part.messageID,
      partID: part.id,
      part,
      directory: directory || undefined,
    });
  } catch (error) {
    console.error('Failed to update message part', error);
  }
}

async function openFileViewer(path: string) {
   const key = `file-viewer:${path}`;
   if (fw.has(key)) {
     fw.bringToFront(key);
     return;
   }
   const pos = getFileViewerPosition(0.18, 0.14);
   const lang = guessLanguage(path);
   fw.open(key, {
     component: FileViewerContent,
     props: {
       path,
       lang,
       gutterMode: 'default',
       theme: shikiTheme.value,
     },
     closable: true,
     resizable: true,
     scroll: 'manual',
     title: resolveWorktreeRelativePath(path) || path,
     x: pos.x,
     y: pos.y,
     width: FILE_VIEWER_WINDOW_WIDTH,
     height: FILE_VIEWER_WINDOW_HEIGHT,
     expiry: Infinity,
   });

   const directory = activeDirectory.value.trim();
   if (!directory) {
     fw.updateOptions(key, {
       props: {
         path,
         rawHtml: 'No active directory selected.',
         gutterMode: 'none',
         theme: shikiTheme.value,
       },
     });
     return;
   }

   try {
      const requestPath = splitFileContentDirectoryAndPath(path, directory);

      const data = (await opencodeApi.readFileContent(credentials.baseUrl.value, {
        directory: requestPath.directory,
        path: requestPath.path,
      })) as FileContentResponse;
    const type = data?.type === 'binary' ? 'binary' : 'text';
    const encoding = typeof data?.encoding === 'string' ? data.encoding : 'utf-8';
    const content = typeof data?.content === 'string' ? data.content : '';
    if (type === 'binary') {
      if (!content) {
        fw.updateOptions(key, {
          props: {
            path,
            rawHtml:
              'Binary content is not included in this API response.\nUnable to render hexdump for this file.',
            gutterMode: 'none',
            isBinary: false,
            theme: shikiTheme.value,
          },
        });
        return;
      }
      const bytes =
        encoding === 'base64' ? toUint8ArrayFromBase64(content) : toUint8ArrayFromText(content);
      const dump = hexdump(bytes, { color: 'html' });
      fw.updateOptions(key, {
        props: {
          path,
          rawHtml: `<pre class="shiki"><code>${dump}</code></pre>`,
          gutterMode: 'none',
          isBinary: true,
          theme: shikiTheme.value,
        },
      });
      return;
    }
    const resolvedLang = guessLanguage(path);
    const textContent = encoding === 'base64' ? atob(content) : content;
    fw.updateOptions(key, {
      props: {
        path,
        fileContent: textContent,
        lang: resolvedLang,
        gutterMode: 'default',
        isBinary: false,
        theme: shikiTheme.value,
      },
    });
  } catch (error) {
    fw.updateOptions(key, {
      props: {
        path,
        rawHtml: `File load failed: ${toErrorMessage(error)}`,
        gutterMode: 'none',
        isBinary: false,
        theme: shikiTheme.value,
      },
    });
  }
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


function parseMessageTextFromParts(parts: unknown) {
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

function parseMessageAttachments(payload: unknown) {
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
    (messageObject?.parts as unknown) ?? (data?.parts as unknown) ?? (record.parts as unknown);

  const attachments = normalizeAttachments([
    ...parseImageAttachmentsFromParts(parts),
    ...parseImageAttachmentsFromParts(part ? [part] : []),
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
  return false;
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

function parsePartType(payload: unknown, eventType: string) {
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
    (part?.messageID as string | undefined) ?? (properties?.messageId as string | undefined);

  const sessionId =
    (typeof part?.sessionID === 'string' ? (part.sessionID as string) : undefined) ??
    parseSessionId(payload);

  if (!messageId) return null;

  return { partType, messageId, sessionId };
}

function parseMessage(payload: unknown, eventType: string) {
  if (!payload) return null;

  if (typeof payload === 'string') {
  if (TOOL_RENDERER_MESSAGE_EVENTS.has(eventType)) {
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
    (messageObject && parseMessageTextFromParts(messageObject.parts));

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
    parseMessageTime(info) ??
    parseMessageTime(messageObject as Record<string, unknown> | undefined);

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
    isPartUpdatedEvent: eventType === 'message.part.updated',
    userMeta,
    messageTime,
  };
}

function parseStepFinish(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  if (!TOOL_RENDERER_MESSAGE_EVENTS.has(eventType)) return null;
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

function parseMessageFinish(payload: unknown, eventType: string) {
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
    (record.info && typeof record.info === 'object'
      ? (record.info as Record<string, unknown>)
      : undefined);
  const type =
    (record.type as string | undefined) ??
    (record.event as string | undefined) ??
    (nestedPayload?.type as string | undefined) ??
    eventType;
  if (!type || !type.toLowerCase().includes('message.updated')) return null;
  const finish =
    (typeof info?.finish === 'string' ? (info.finish as string) : undefined) ??
    (typeof record.finish === 'string' ? (record.finish as string) : undefined);
  const error = parseMessageError(info);
  if (!finish && !error) return null;
  const sessionId =
    typeof info?.sessionID === 'string'
      ? (info.sessionID as string)
      : typeof (record.sessionID as string | undefined) === 'string'
        ? (record.sessionID as string)
        : undefined;
  const infoMessageId = typeof info?.messageId === 'string' ? info.messageId : undefined;
  const messageId = typeof info?.id === 'string' ? (info.id as string) : infoMessageId;
  const parentID = typeof info?.parentID === 'string' ? (info.parentID as string) : undefined;
  return { finish, sessionId, messageId, parentID, error };
}

function parseMessageError(
  info: Record<string, unknown> | undefined,
): { name: string; message: string } | null {
  const error = info?.error;
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  const data =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : undefined;
  const message =
    typeof data?.message === 'string'
      ? data.message
      : typeof record.message === 'string'
        ? record.message
        : '';
  if (!name) return null;
  return { name, message };
}

function parseSummaryDiffs(info: Record<string, unknown> | undefined): Array<MessageDiffEntry> {
  const summary =
    info?.summary && typeof info.summary === 'object'
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


function formatRetryTime(timestamp: number): string {
  const nextDate = new Date(timestamp);
  const now = Date.now();
  const diffMs = timestamp - now;

  const absolute = nextDate
    .toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .replace(/(\d+)\/(\d+)\/(\d+),/, '$3/$1/$2');

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

function applySessionStatusEvent(
  sessionId: string,
  status: { type: 'busy' | 'idle' | 'retry'; message?: string; next?: number; attempt?: number },
) {
  const projectId = resolveProjectIdForSession(sessionId) || selectedProjectId.value;
  if (!projectId) return;

  const isAllowedSession = allowedSessionIds.value.has(sessionId);
  const isSelectedSession = sessionId === selectedSessionId.value;

  if (status.type === 'busy' || status.type === 'idle') {
    const nextStatus: 'busy' | 'idle' = status.type;
    setSessionStatus(sessionId, nextStatus, projectId);
    if (isAllowedSession) {
      if (isSelectedSession) retryStatus.value = null;
      updateReasoningExpiry(sessionId, nextStatus);
    }
    if (nextStatus === 'busy') {
      const session = sessionGraphStore.getSession(sessionId, projectId);
      void fetchSessionChildren(sessionId, session?.directory || activeDirectory.value || undefined, projectId);
      removePendingNotification(`idle:${sessionId}`);
    }
    if (nextStatus === 'idle') {
      if (!isSelectedSession && sessions.value.some((s) => s.id === sessionId)) {
        addPendingNotification(sessionId, `idle:${sessionId}`, 'idle');
      }
    }
    pruneIdleEphemeralSessions();
    return;
  }

  if (status.type !== 'retry') return;

  setSessionStatus(sessionId, 'retry', projectId);
  const session = sessionGraphStore.getSession(sessionId, projectId);
  void fetchSessionChildren(sessionId, session?.directory || activeDirectory.value || undefined, projectId);
  if (!isSelectedSession || !isAllowedSession) return;

  updateReasoningExpiry(sessionId, 'busy');
  if (status.message && typeof status.next === 'number') {
    retryStatus.value = {
      message: status.message,
      next: status.next,
      attempt: status.attempt || 1,
    };
  }
}

function handlePtyEvent(event: {
  type: 'pty.created' | 'pty.updated' | 'pty.exited';
  info: PtyInfo | null;
  id?: string;
}) {
  const ptyId = event.id ?? event.info?.id;
  if (!ptyId) return;
  if (!shellSessionsByPtyId.has(ptyId)) return;
  if (event.type === 'pty.exited') {
    removeShellWindow(ptyId);
    return;
  }
  if (event.info) {
    const existing = shellSessionsByPtyId.get(event.info.id);
    if (existing) {
      existing.pty = event.info;
      if (event.info.title) {
        fw.setTitle(`shell:${event.info.id}`, event.info.title);
      }
    }
    if (event.info.status === 'exited') {
      removeShellWindow(event.info.id);
    }
  }
}

function upsertPermissionEntry(request: PermissionRequest) {
  const key = `permission:${request.id}`;
  fw.open(key, {
    component: PermissionContent,
    props: {
      request,
      isSubmitting: isPermissionSubmitting(request.id),
      error: getPermissionError(request.id),
      onReply: handlePermissionReply,
    },
    closable: false,
    resizable: false,
    scroll: 'manual',
    color: '#f59e0b',
    title: `Permission: ${request.permission || 'request'}`,
    width: PERMISSION_WINDOW_WIDTH,
    height: PERMISSION_WINDOW_HEIGHT,
    expiry: Infinity,
  });
}

function refreshPermissionWindow(requestId: string) {
  const key = `permission:${requestId}`;
  const entry = fw.get(key);
  if (!entry) return;
  fw.updateOptions(key, {
    props: {
      ...entry.props,
      isSubmitting: isPermissionSubmitting(requestId),
      error: getPermissionError(requestId),
    },
  });
}

function removePermissionEntry(requestId: string) {
  fw.close(`permission:${requestId}`);
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
  for (const entry of fw.entries.value) {
    if (!entry.key.startsWith('permission:')) continue;
    const request = entry.props?.request as PermissionRequest | undefined;
    if (!request) continue;
    if (!allowed.has(request.sessionID)) {
      removePermissionEntry(request.id);
    }
  }
}

async function sendPermissionReply(requestId: string, reply: PermissionReply) {
  if (!ensureConnectionReady('Permission reply')) return;
  const directory = activeDirectory.value.trim();
  await opencodeApi.replyPermission(credentials.baseUrl.value, requestId, {
    directory: directory || undefined,
    reply,
  });
}

async function handlePermissionReply(payload: { requestId: string; reply: PermissionReply }) {
  if (!ensureConnectionReady('Permission reply')) return;
  const { requestId, reply } = payload;
  if (isPermissionSubmitting(requestId)) return;
  clearPermissionError(requestId);
  setPermissionSending(requestId, true);
  refreshPermissionWindow(requestId);
  try {
    await sendPermissionReply(requestId, reply);
    removePermissionEntry(requestId);
  } catch (error) {
    setPermissionError(requestId, toErrorMessage(error));
    refreshPermissionWindow(requestId);
  } finally {
    clearPermissionSending(requestId);
    refreshPermissionWindow(requestId);
  }
}

function upsertQuestionEntry(request: QuestionRequest) {
  const key = `question:${request.id}`;
  fw.open(key, {
    component: QuestionContent,
    props: {
      request,
      isSubmitting: isQuestionSubmitting(request.id),
      error: getQuestionError(request.id),
      onReply: handleQuestionReply,
      onReject: handleQuestionReject,
    },
    closable: false,
    resizable: false,
    scroll: 'manual',
    color: '#34d399',
    title: `Question: ${request.questions?.[0]?.header || 'request'}`,
    width: QUESTION_WINDOW_WIDTH,
    height: QUESTION_WINDOW_HEIGHT,
    expiry: Infinity,
  });
}

function refreshQuestionWindow(requestId: string) {
  const key = `question:${requestId}`;
  const entry = fw.get(key);
  if (!entry) return;
  fw.updateOptions(key, {
    props: {
      ...entry.props,
      isSubmitting: isQuestionSubmitting(requestId),
      error: getQuestionError(requestId),
    },
  });
}

function removeQuestionEntry(requestId: string) {
  fw.close(`question:${requestId}`);
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
  for (const entry of fw.entries.value) {
    if (!entry.key.startsWith('question:')) continue;
    const request = entry.props?.request as QuestionRequest | undefined;
    if (!request) continue;
    if (!allowed.has(request.sessionID)) {
      removeQuestionEntry(request.id);
    }
  }
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
  if (!ensureConnectionReady('Question reply')) return;
  const directory = activeDirectory.value.trim();
  await opencodeApi.replyQuestion(credentials.baseUrl.value, requestId, {
    directory: directory || undefined,
    answers: normalizeQuestionAnswers(answers),
  });
}

async function sendQuestionReject(requestId: string) {
  if (!ensureConnectionReady('Question reject')) return;
  const directory = activeDirectory.value.trim();
  await opencodeApi.rejectQuestion(credentials.baseUrl.value, requestId, directory || undefined);
}

async function handleQuestionReply(payload: { requestId: string; answers: QuestionAnswer[] }) {
  if (!ensureConnectionReady('Question reply')) return;
  const { requestId, answers } = payload;
  if (isQuestionSubmitting(requestId)) return;
  clearQuestionError(requestId);
  setQuestionSending(requestId, true);
  refreshQuestionWindow(requestId);
  try {
    await sendQuestionReply(requestId, answers);
    removeQuestionEntry(requestId);
  } catch (error) {
    setQuestionError(requestId, toErrorMessage(error));
    refreshQuestionWindow(requestId);
  } finally {
    clearQuestionSending(requestId);
    refreshQuestionWindow(requestId);
  }
}

async function handleQuestionReject(requestId: string) {
  if (!ensureConnectionReady('Question reject')) return;
  if (isQuestionSubmitting(requestId)) return;
  clearQuestionError(requestId);
  setQuestionSending(requestId, true);
  refreshQuestionWindow(requestId);
  try {
    await sendQuestionReject(requestId);
    removeQuestionEntry(requestId);
  } catch (error) {
    setQuestionError(requestId, toErrorMessage(error));
    refreshQuestionWindow(requestId);
  } finally {
    clearQuestionSending(requestId);
    refreshQuestionWindow(requestId);
  }
}

async function reconnectAndReconcile() {
  if (reconnectInFlight) return;
  reconnectInFlight = true;
  try {
    await ge.connect({ baseUrl: credentials.baseUrl.value, failFast: true, timeoutMs: 5000, authorization: credentials.authHeader.value });
    await reconcileSessionGraphFromScopes();
    await fetchProviders(true);
    connectionState.value = 'ready';
    reconnectingMessage.value = '';
    sendStatus.value = 'Ready';
  } catch (error) {
    reconnectingMessage.value = `Reconnecting... ${toErrorMessage(error)}`;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void reconnectAndReconcile();
      }, 1000);
    }
  } finally {
    reconnectInFlight = false;
  }
}

async function startInitialization() {
  if (initializationInFlight) return;
  initializationInFlight = true;
  uiInitState.value = 'loading';
  initErrorMessage.value = '';
  reconnectingMessage.value = '';
  try {
    connectionState.value = 'connecting';
    initLoadingMessage.value = 'Connecting to SSE stream...';
    await ge.connect({ baseUrl: credentials.baseUrl.value, failFast: true, timeoutMs: 5000, authorization: credentials.authHeader.value });
    connectionState.value = 'bootstrapping';
    initLoadingMessage.value = 'Loading server path...';
    await fetchHomePath();
    initLoadingMessage.value = 'Loading projects and sessions...';
    await bootstrapSelections();
    if (selectedSessionId.value) {
      initLoadingMessage.value = 'Loading session history...';
      await reloadSelectedSessionState();
    }
    if (activeDirectory.value) {
      initLoadingMessage.value = 'Loading worktree state...';
      await fetchSessionStatus(activeDirectory.value || undefined);
      await fetchCommands(activeDirectory.value || undefined);
      const directory = activeDirectory.value || undefined;
      await fetchPendingPermissions(directory);
      await fetchPendingQuestions(directory);
      await fetchAllPendingNotifications(directory);
      void loadTreePath('.');
      void refreshSessionDiff();
    }
    connectionState.value = 'ready';
    uiInitState.value = 'ready';
    await fetchProviders();
    await fetchAgents();
  } catch (error) {
    const msg = toErrorMessage(error);
    connectionState.value = 'error';
    if (/\(40[13]\)/.test(msg)) {
      storageSet(StorageKeys.state.lastAuthError, msg);
      credentials.clear();
      initErrorMessage.value = msg;
      uiInitState.value = 'login';
    } else {
      initErrorMessage.value = msg;
      uiInitState.value = 'error';
    }
  } finally {
    initializationInFlight = false;
  }
}

function handleLogin() {
  const u = loginRequiresAuth.value ? loginUsername.value : '';
  const p = loginRequiresAuth.value ? loginPassword.value : '';
  credentials.save(loginUrl.value, u, p);
  void startInitialization();
}

function handleAbortInit() {
  ge.disconnect();
  initializationInFlight = false;
  connectionState.value = 'connecting';
  uiInitState.value = 'login';
  initErrorMessage.value = '';
}

function handleLogout() {
  credentials.clear();
  ge.disconnect();
  disposeShellWindows();
  uiInitState.value = 'login';
  initErrorMessage.value = '';
  connectionState.value = 'connecting';
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown);
  handleWindowResize();
  if (typeof document !== 'undefined' && 'fonts' in document) {
    void document.fonts.ready.then(() => {
      handleWindowResize();
    });
  }
  credentials.load();
  
  if (credentials.isConfigured.value) {
    loginUrl.value = credentials.url.value;
    loginUsername.value = credentials.username.value;
    loginPassword.value = credentials.password.value;
    loginRequiresAuth.value = !!(credentials.username.value || credentials.password.value);
    void startInitialization();
  } else {
    uiInitState.value = 'login';
    const savedError = storageGet(StorageKeys.state.lastAuthError);
    if (savedError) {
      initErrorMessage.value = savedError;
      storageRemove(StorageKeys.state.lastAuthError);
    }
  }
  const availableThemes = getBundledThemeNames();
  const chosenTheme = pickShikiTheme(availableThemes);
  if (chosenTheme) shikiTheme.value = chosenTheme;
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('storage', handleComposerDraftStorage);
  updateFloatingExtentObserver();
  globalEventUnsubscribers.push(
    ge.on('connection.open', () => {
      if (connectionState.value === 'reconnecting' || connectionState.value === 'error') {
        connectionState.value = 'ready';
        reconnectingMessage.value = '';
        sendStatus.value = 'Ready';
      }
      if (bootstrapReady.value) {
        void reconcileSessionGraphFromScopes();
        void fetchAllPendingNotifications(activeDirectory.value || undefined);
        return;
      }
      void fetchSessionStatus(activeDirectory.value || undefined);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('connection.reconnected', () => {
      connectionState.value = 'ready';
      reconnectingMessage.value = '';
      sendStatus.value = 'Ready';
      void reconcileSessionGraphFromScopes();
      void fetchProviders(true);
      void fetchAllPendingNotifications(activeDirectory.value || undefined);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('connection.error', (payload) => {
      if (payload.statusCode === 401 || payload.statusCode === 403) {
        const msg = `${payload.message} (HTTP ${payload.statusCode})`;
        storageSet(StorageKeys.state.lastAuthError, msg);
        credentials.clear();
        uiInitState.value = 'login';
        initErrorMessage.value = msg;
        connectionState.value = 'error';
        return;
      }
      if (uiInitState.value === 'loading') {
        connectionState.value = 'error';
        initErrorMessage.value = 'Failed to connect to SSE stream.';
        uiInitState.value = 'error';
        return;
      }
      connectionState.value = 'reconnecting';
      reconnectingMessage.value = 'Reconnecting...';
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('permission.asked', (packet) => {
      const request = packet as PermissionRequest;
      upsertPermissionEntry(request);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('permission.asked', (packet) => {
      const request = packet as PermissionRequest;
      addPendingNotification(request.sessionID, request.id, 'permission');
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('permission.replied', ({ requestID }) => {
      removePermissionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('permission.replied', ({ requestID }) => {
      removePendingNotification(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('question.asked', (packet) => {
      const request = packet as QuestionRequest;
      upsertQuestionEntry(request);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('question.asked', (packet) => {
      const request = packet as QuestionRequest;
      addPendingNotification(request.sessionID, request.id, 'question');
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('question.replied', ({ requestID }) => {
      removeQuestionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('question.replied', ({ requestID }) => {
      removePendingNotification(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('question.rejected', ({ requestID }) => {
      removeQuestionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('question.rejected', ({ requestID }) => {
      removePendingNotification(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('worktree.ready', (packet) => {
      const directory =
        typeof (packet as Record<string, unknown>).directory === 'string'
          ? String((packet as Record<string, unknown>).directory)
          : activeDirectory.value || projectDirectory.value || '';
      if (!directory) return;
      const branch = typeof packet.branch === 'string' ? packet.branch : undefined;
      void handleWorktreeReady({ directory, branch });
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('project.updated', (projectUpdated) => {
      const worktree = typeof projectUpdated.worktree === 'string' ? projectUpdated.worktree : '';
      const sandboxDirs = Array.isArray(projectUpdated.sandboxes)
        ? projectUpdated.sandboxes.filter((entry): entry is string => typeof entry === 'string')
        : [];
      sessionGraphStore.syncSandboxes(worktree, sandboxDirs);
      markSessionGraphChanged();
    }),
  );
  const applySessionInfoUpdate = (sessionInfo: SessionInfo, isDelete: boolean) => {
    if (sessionInfo.projectID && sessionInfo.directory) {
      sessionGraphStore.setSandboxProjectID(sessionInfo.directory, sessionInfo.projectID);
    }
    const resolvedProjectId = sessionInfo.projectID || resolveProjectIdForSession(sessionInfo.id);
    if (isDelete) {
      sessionGraphStore.removeSession(sessionInfo.id, resolvedProjectId || undefined);
      clearNotificationSession(sessionInfo.id);
      if (selectedSessionId.value === sessionInfo.id) selectedSessionId.value = '';
    } else {
      upsertSessionGraph(sessionInfo);
    }
    markSessionGraphChanged();

    if (matchesSelectedProject(sessionInfo)) {
      if (isDelete) {
        deleteSessionStatus(sessionInfo.id, resolvedProjectId);
      } else if (sessionInfo.directory) {
        appendWorktreeDirectory(sessionInfo.directory);
      }
    }
  };
  globalEventUnsubscribers.push(
    ge.on('session.created', ({ info }) => {
      applySessionInfoUpdate(info as SessionInfo, false);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('session.updated', ({ info }) => {
      applySessionInfoUpdate(info as SessionInfo, false);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('session.deleted', ({ info }) => {
      applySessionInfoUpdate(info as SessionInfo, true);
    }),
  );
  globalEventUnsubscribers.push(
    mainSessionScope.on('session.diff', ({ diff }) => {
      const directory = activeDirectory.value.trim();
      if (!directory) {
        updateSessionDiffState([]);
        return;
      }
      if (Array.isArray(diff)) {
        const entries = normalizeSessionDiffEntries(diff);
        const hadAdded = entries.some((entry) => entry.status === 'added');
        updateSessionDiffState(entries);
        if (hadAdded) void loadTreePath('.');
        return;
      }
      void refreshSessionDiff();
      void loadTreePath('.');
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('session.status', ({ sessionID, status }) => {
      applySessionStatusEvent(sessionID, status);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('todo.updated', ({ sessionID, todos }) => {
      todosBySessionId.value = {
        ...todosBySessionId.value,
        [sessionID]: todos,
      };
      if (todoErrorBySessionId.value[sessionID]) {
        const nextErrors = { ...todoErrorBySessionId.value };
        delete nextErrors[sessionID];
        todoErrorBySessionId.value = nextErrors;
      }
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('pty.created', ({ info }) => {
      handlePtyEvent({ type: 'pty.created', info: info as PtyInfo });
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('pty.updated', ({ info }) => {
      handlePtyEvent({ type: 'pty.updated', info: info as PtyInfo });
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('pty.exited', ({ id }) => {
      handlePtyEvent({ type: 'pty.exited', info: null, id });
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('pty.deleted', ({ id }) => {
      removeShellWindow(id);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('message.part.updated', ({ part }) => {
      if (part.type !== 'tool') return;
      openToolPartAsWindow(part);
    }),
  );
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', handlePointerUp);
  window.removeEventListener('resize', handleWindowResize);
  window.removeEventListener('storage', handleComposerDraftStorage);
  floatingExtentResizeObserver?.disconnect();
  floatingExtentResizeObserver = null;
  floatingExtentObservedEl = null;
  while (globalEventUnsubscribers.length > 0) {
    const dispose = globalEventUnsubscribers.pop();
    dispose?.();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  mainSessionScope.dispose();
  sessionScope.dispose();
  ge.disconnect();
  disposeShellWindows();
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

.app-loading-view {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
}

.app-loading-card {
  width: min(420px, 92vw);
  border: 1px solid #334155;
  background: rgba(15, 23, 42, 0.92);
  border-radius: 14px;
  padding: 20px;
  box-shadow: 0 14px 34px rgba(2, 6, 23, 0.5);
  text-align: center;
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

.app-loading-title {
  margin: 0;
  color: #e2e8f0;
  font-size: 14px;
  font-weight: 600;
}

.app-loading-message {
  margin: 8px 0 0;
  color: #94a3b8;
  font-size: 12px;
}

.app-loading-retry {
  margin-top: 14px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #e2e8f0;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.app-loading-retry:hover {
  background: #334155;
}

.app-loading-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.app-loading-abort {
  background: transparent;
  border-color: #475569;
  color: #94a3b8;
}

.app-loading-abort:hover {
  background: #1e293b;
  color: #e2e8f0;
}

.app-login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: stretch;
}

.app-login-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.app-login-input {
  width: 100%;
  padding: 8px 12px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 13px;
  box-sizing: border-box;
}

.app-login-input::placeholder {
  color: #64748b;
}

.app-login-input:focus {
  outline: none;
  border-color: #475569;
  background: #0f172a;
}

.app-login-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.app-login-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.app-error-message {
  color: #f87171;
}

@keyframes app-loading-spin {
  to {
    transform: rotate(360deg);
  }
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

.is-disabled {
  opacity: 0.4;
  pointer-events: none;
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
  min-width: 0;
  height: 100%;
  min-height: 0;
}

:deep(.scale-enter-active),
:deep(.scale-leave-active) {
  transition: transform 0.15s ease-in, opacity 0.15s ease-in;
}

:deep(.scale-enter-from),
:deep(.scale-leave-to) {
  opacity: 0;
  --win-scale-x: 1.5;
  --win-scale-y: 0;
}
</style>
