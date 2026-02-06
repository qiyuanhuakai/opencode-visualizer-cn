<template>
  <div ref="appEl" class="app">
    <header class="app-header">
      <TopPanel
        :projects="projects"
        :worktrees="worktrees"
        :worktree-meta="worktreeMetaByDir"
        :sessions="filteredSessions"
        :worktree-base="selectedProjectDirectory"
        v-model:selected-project-id="selectedProjectId"
        v-model:selected-worktree-dir="selectedWorktreeDir"
        v-model:selected-session-id="selectedSessionId"
        @new-project="openProjectPicker"
        @new-worktree="createWorktree"
        @new-session="createNewSession"
        @delete-worktree="deleteWorktree"
        @delete-session="deleteSession"
      />
    </header>
    <main ref="outputEl" class="app-output">
      <div class="output-stage">
        <div class="output-stack">
          <OutputDock
            ref="outputDock"
            class="output-dock"
            :queue="queue"
            :is-following="isFollowing"
            :status-text="statusText"
            :is-status-error="isStatusError"
            :is-thinking="isThinking"
            :is-retry-status="!!retryStatus"
            @scroll="handleMessageDockScroll"
            @wheel="handleMessageDockWheel"
            @touchmove="handleMessageDockScroll"
            @resume-follow="resumeFollow"
          />
          <div ref="canvasEl" class="canvas">
            <TransitionGroup appear name="fade">
              <div
                v-for="q in queue.filter((entry) => !entry.isMessage || entry.isSubagentMessage)"
                :key="q.permissionId ?? q.callId ?? q.messageId ?? q.time"
                class="term"
                :data-tool-key="q.toolKey ?? q.callId ?? undefined"
                :data-message-key="q.messageId ? buildMessageKey(q.messageId, q.sessionId) : undefined"
                :class="{
                  'is-write': q.isWrite,
                  'is-message': q.isSubagentMessage,
                  'is-apply-patch': q.toolName === 'apply_patch',
                  'is-reasoning': q.isReasoning || q.isSubagentMessage,
                  'is-shell': q.isShell,
                  'is-permission': q.isPermission,
                  'is-tasklist': q.isTaskList,
                }"
                :style="{
                  left: `${q.x ?? 0}px`,
                  top: `calc(var(--tool-top-offset) + ${q.y ?? 0}px)`,
                  '--term-width': q.width ? `${q.width}px` : undefined,
                  '--term-height': q.height ? `${q.height}px` : undefined,
                  zIndex: q.zIndex ?? undefined,
                }"
              >
                <div class="term-titlebar" @pointerdown="startTermDrag(q, $event)">
                  {{ getEntryTitle(q) }}
                </div>
                <div
                  class="term-inner"
                  :class="{ 'is-scrolling': q.scroll }"
                  :style="{
                    '--scroll-distance': `${q.scrollDistance}px`,
                    '--scroll-duration': `${q.scrollDuration}s`,
                  }"
                  @scroll="handleFloatingScroll(q, $event)"
                  @wheel="handleFloatingWheel(q, $event)"
                >
                  <div v-if="q.isShell" class="xterm-host" :data-shell-id="q.shellId"></div>
                  <PermissionWindow
                    v-else-if="q.isPermission && q.permissionRequest"
                    :request="q.permissionRequest"
                    :is-submitting="isPermissionSubmitting(q.permissionRequest.id)"
                    :error="getPermissionError(q.permissionRequest.id)"
                    @reply="handlePermissionReply"
                  />
                  <div
                    v-else
                    class="shiki-host"
                    :class="{ 'is-message': q.isSubagentMessage }"
                    v-html="q.html"
                  ></div>
                </div>
                <div
                  v-if="
                    q.isReasoning ||
                    q.isSubagentMessage ||
                    q.isShell ||
                    q.isPermission ||
                    q.isTaskList
                  "
                  class="term-resizer"
                  @pointerdown="startTermResize(q, $event)"
                ></div>
              </div>
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
      <ControlPanel
        :can-send="canSend"
        :agent-options="agentOptions"
        :has-agent-options="hasAgentOptions"
        :model-options="modelOptions"
        :thinking-options="thinkingOptions"
        :has-model-options="hasModelOptions"
        :has-thinking-options="hasThinkingOptions"
        :is-thinking="isThinking"
        :can-abort="canAbort"
        :commands="commandOptions"
        :attachments="attachments"
        v-model:message-input="messageInput"
        v-model:selected-mode="selectedMode"
        v-model:selected-model="selectedModel"
        v-model:selected-thinking="selectedThinking"
        @send="sendMessage"
        @abort="abortSession"
        @add-attachments="handleAddAttachments"
        @remove-attachment="removeAttachment"
      />
    </footer>
    <ProjectPicker
      :open="isProjectPickerOpen"
      :base-url="OPENCODE_BASE_URL"
      :initial-directory="selectedProjectDirectory"
      @close="isProjectPickerOpen = false"
      @select="handleProjectDirectorySelect"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { bundledLanguages, bundledThemes, createHighlighter } from 'shiki/bundle/web';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import ControlPanel from './ControlPanel.vue';
import TopPanel from './TopPanel.vue';
import OutputDock from './OutputDock.vue';
import ProjectPicker from './ProjectPicker.vue';
import PermissionWindow from './PermissionWindow.vue';

const OPENCODE_BASE_URL = 'http://localhost:4096';
const HISTORY_LIMIT = 60;
const FOLLOW_THRESHOLD_PX = 24;
const FLOATING_FOLLOW_THRESHOLD_PX = 2;
const TOOL_PENDING_TTL_MS = 60_000;
const TOOL_RUNNING_TTL_MS = 5_000;
const TOOL_COMPLETE_TTL_MS = 3_000;
const TOOL_SCROLL_SPEED_PX_S = 2000;
const TOOL_SCROLL_HOLD_MS = 250;
const TOOL_SCROLL_MAX_DURATION_S = 3;
const SUBAGENT_ACTIVE_TTL_MS = 60 * 60 * 1000;
const TASK_WINDOW_WIDTH = 360;
const TASK_WINDOW_HEIGHT = 240;
const TASK_LIST_TOOL_KEY = 'task:list';
const MAIN_REASONING_TITLE = 'Reasoning';
const REASONING_CLOSE_DELAY_MS = 3000;
const SHELL_PTY_STORAGE_KEY = 'opencode.shellPtys';
const SHIKI_LANGS = [
  'text',
  'diff',
  'json',
  'markdown',
  'html',
  'css',
  'scss',
  'yaml',
  'shellscript',
  'sql',
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'vue',
  'python',
  'java',
  'php',
];

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
  html: string;
  attachments?: MessageAttachment[];
  isWrite: boolean;
  isMessage: boolean;
  isSubagentMessage?: boolean;
  isReasoning?: boolean;
  isShell?: boolean;
  isPermission?: boolean;
  isTaskList?: boolean;
  sessionId?: string;
  toolKey?: string;
  role?: 'user' | 'assistant';
  toolStatus?: string;
  toolName?: string;
  toolTitle?: string;
  messageId?: string;
  messageKey?: string;
  messageAgent?: string;
  messageModel?: string;
  messageVariant?: string;
  messageTime?: number;
  callId?: string;
  permissionId?: string;
  follow?: boolean;
  zIndex?: number;
  width?: number;
  height?: number;
  shellId?: string;
  shellTitle?: string;
  permissionRequest?: PermissionRequest;
};

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

type TaskSource = 'subtask' | 'tool';

type TaskItem = {
  id: string;
  sessionId: string;
  messageId?: string;
  callId?: string;
  content: string;
  status: TaskStatus;
  source: TaskSource;
  updatedAt: number;
  subSessionId?: string;
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

const queue = ref<FileReadEntry[]>([]);
const appEl = ref<HTMLDivElement | null>(null);
const outputEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLDivElement | null>(null);
const outputDock = ref<{ dockEl: HTMLDivElement | null } | null>(null);
const isFollowing = ref(true);
const runningToolIds = new Set<string>();
const subagentSessionExpiry = new Map<string, number>();
const messageSummaryTitleById = new Map<string, string>();
const reasoningTitleBySessionId = new Map<string, string>();
const sessionStatusById = new Map<string, 'busy' | 'idle'>();
const reasoningCloseTimers = new Map<string, number>();
const lastReasoningMessageIdByKey = new Map<string, string>();
const messageAttachmentsById = new Map<string, MessageAttachment[]>();
const activeReasoningMessageIdByKey = new Map<string, string>();
const finishedReasoningByKey = new Map<string, ReasoningFinish>();
const globalEventHooks = new Set<(payload: unknown, eventType: string) => void>();
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
const selectedSessionStatus = ref<'busy' | 'idle' | ''>('');
const messageIndexById = new Map<string, number>();
const toolIndexByCallId = new Map<string, number>();
const userMessageIds = new Set<string>();
const userMessageMetaById = new Map<string, UserMessageMeta>();
const userMessageTimeById = new Map<string, number>();
const messageContentById = new Map<string, string>();
const messagePartsById = new Map<string, Map<string, string>>();
const messagePartOrderById = new Map<string, string[]>();
const recentUserInputs: { text: string; time: number }[] = [];
const shellSessionsByPtyId = new Map<string, ShellSession>();
const shellPtyIdsBySessionId = new Map<string, Set<string>>();
const pendingShellFits = new Map<string, number>();
const permissionSendingById = ref<Record<string, boolean>>({});
const permissionErrorById = ref<Record<string, string>>({});
const pendingWorktreeMetaByDir = new Map<string, VcsInfo>();
const tasksById = new Map<string, TaskItem>();
const taskIdByMessageKey = new Map<string, string>();
const taskIdByCallId = new Map<string, string>();

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
  Array<{ id: string; label: string; providerID?: string; variants?: Record<string, unknown> }>
>([]);
const agentOptions = ref<Array<{ id: string; label: string }>>([]);
const thinkingOptions = ref<string[]>([]);
const providersLoaded = ref(false);
const providersLoading = ref(false);
const providersFetchCount = ref(0);
const agentsLoading = ref(false);
const commandsLoading = ref(false);
const selectedProjectId = ref('');
const selectedWorktreeDir = ref('');
const selectedSessionId = ref('');
const selectedProjectDirectory = ref('');
const initialQuery = readQuerySelection();
if (initialQuery.projectId) selectedProjectId.value = initialQuery.projectId;
if (initialQuery.sessionId) selectedSessionId.value = initialQuery.sessionId;
const isProjectPickerOpen = ref(false);
const selectedMode = ref('build');
const selectedModel = ref('');
const selectedThinking = ref('');
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

const canSend = computed(() =>
  Boolean(
    selectedSessionId.value &&
      !isSending.value &&
      (messageInput.value.trim().length > 0 || attachments.value.length > 0),
  ),
);

const isThinking = computed(() =>
  Boolean(
    selectedSessionStatus.value === 'busy' ||
    runningToolIds.size > 0 ||
    isSending.value ||
    isAborting.value,
  ),
);
const canAbort = computed(() =>
  Boolean(selectedSessionId.value && isThinking.value && !isAborting.value),
);
const hasAgentOptions = computed(() => agentOptions.value.length > 0);
const hasModelOptions = computed(() => modelOptions.value.length > 0);
const hasThinkingOptions = computed(() => thinkingOptions.value.length > 0);
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

function sessionLabel(session: SessionInfo) {
  const base = session.title || session.slug || session.id;
  return `${base} (${session.id.slice(0, 6)})`;
}

function getSelectedWorktreeDirectory() {
  return selectedWorktreeDir.value.trim();
}

function resolveWorktreeRelativePath(path?: string) {
  if (!path) return undefined;
  const normalizedPath = normalizeDirectory(path);
  const base = normalizeDirectory(getSelectedWorktreeDirectory());
  if (!base) return normalizedPath;
  if (!normalizedPath.startsWith('/')) return normalizedPath;
  if (normalizedPath === base) return '.';
  const prefix = `${base}/`;
  if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length);
  return normalizedPath;
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

function nextWindowZ() {
  syncNextWindowZIndex();
  nextWindowZIndex += 1;
  return nextWindowZIndex;
}

function bringToFront(entry: FileReadEntry) {
  entry.zIndex = nextWindowZ();
}

function getCanvasMetrics() {
  const canvas = canvasEl.value;
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
  } catch (error) {
    sendStatus.value = `Attachment failed: ${toErrorMessage(error)}`;
  }
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((item) => item.id !== id);
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

function resolveShikiLanguage(requested: string, loaded: string[]) {
  if (requested === 'shellscript') {
    if (loaded.includes('bash')) return 'bash';
    if (loaded.includes('shell')) return 'shell';
    if (loaded.includes('sh')) return 'sh';
  }
  if (requested === 'bash' && loaded.includes('shellscript')) return 'shellscript';
  if (loaded.includes(requested)) return requested;
  return loaded.includes('text') ? 'text' : (loaded[0] ?? 'text');
}

function isDarkThemeName(name: string) {
  return /dark|night|nord|dracula|monokai|dimmed/i.test(name);
}

function getEntryTitle(entry: FileReadEntry) {
  if (entry.isPermission) {
    const permission = entry.permissionRequest?.permission;
    return permission ? `Permission: ${permission}` : 'Permission request';
  }
  if (entry.isShell) return entry.shellTitle ?? 'Shell';
  if (entry.isReasoning) {
    const sessionTitle = getSessionTitle(entry.sessionId);
    const reasoningTitle = entry.sessionId
      ? reasoningTitleBySessionId.get(entry.sessionId)
      : undefined;
    return reasoningTitle ?? sessionTitle ?? 'Reasoning';
  }
  if (entry.isSubagentMessage) {
    const sessionTitle = getSessionTitle(entry.sessionId);
    if (sessionTitle) return sessionTitle;
  }
  const displayPath = resolveWorktreeRelativePath(entry.path);
  if (
    displayPath &&
    (entry.toolName === 'read' || entry.toolName === 'grep' || entry.toolName === 'apply_patch')
  )
    return displayPath;
  if (entry.toolTitle) return entry.toolTitle;
  if (entry.toolName) return entry.toolName;
  if (displayPath) return displayPath;
  if (entry.header) {
    const cleaned = entry.header.trim().replace(/^#\s*/, '').trim();
    if (cleaned) return cleaned;
  }
  return 'tool';
}

function getSubagentExpiry(sessionId?: string) {
  const now = Date.now();
  if (!sessionId) return now + SUBAGENT_ACTIVE_TTL_MS;
  const stored = subagentSessionExpiry.get(sessionId);
  if (stored !== undefined) return stored;
  const status = sessionStatusById.get(sessionId);
  if (status === 'busy') return Number.MAX_SAFE_INTEGER;
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
  bringToFront(entry);
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
  bringToFront(entry);
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
  const minWidth = 320;
  const minHeight = 220;
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

function handlePointerMove(event: PointerEvent) {
  if (inputResizeState.value) {
    const { startY, startHeight, minHeight, maxHeight } = inputResizeState.value;
    const dy = event.clientY - startY;
    inputHeight.value = clamp(startHeight - dy, minHeight, maxHeight);
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
      const canvas = canvasEl.value;
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

function scheduleToolScrollAnimation(toolKey: string) {
  nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const canvas = canvasEl.value;
        if (!canvas) return;
        const term = canvas.querySelector(
          `[data-tool-key="${toolKey}"] .term-inner`,
        ) as HTMLElement | null;
        if (!term) return;
        const host = term.querySelector('.shiki-host') as HTMLElement | null;
        const lineNodes = host?.querySelectorAll('.line') ?? [];
        const lineCount = lineNodes.length || 0;
        const lineSample = lineNodes.length > 0 ? (lineNodes[0] as HTMLElement) : null;
        const sampleHeight = lineSample?.getBoundingClientRect().height ?? 0;
        const fontSize = Number.parseFloat(getComputedStyle(term).fontSize) || 14;
        const lineHeight = sampleHeight > 0 ? sampleHeight : fontSize;
        const visibleLines = Math.max(1, Math.floor(term.clientHeight / lineHeight));
        const totalLines = lineCount > 0 ? lineCount : (term.textContent ?? '').split('\n').length;
        const distance = Math.max(0, (totalLines - visibleLines) * lineHeight);
        if (distance <= 0) return;
        const index = queue.value.findIndex((entry) => entry.toolKey === toolKey);
        if (index < 0) return;
        const entry = queue.value[index];
        const baseDuration = distance / TOOL_SCROLL_SPEED_PX_S;
        const duration =
          entry.toolName === 'read'
            ? Math.min(baseDuration, TOOL_SCROLL_MAX_DURATION_S)
            : baseDuration;
        const now = Date.now();
        const baseExpiry = now + Math.ceil(duration * 1000 + TOOL_SCROLL_HOLD_MS);
        const nextExpiresAt =
          entry.toolStatus === 'pending' || entry.toolStatus === 'running'
            ? entry.expiresAt
            : Math.max(entry.expiresAt, baseExpiry);
        queue.value.splice(index, 1, {
          ...entry,
          expiresAt: nextExpiresAt,
          scroll: true,
          scrollDistance: distance,
          scrollDuration: duration,
        });
      });
    });
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

async function fetchProjects(directory?: string) {
  projectError.value = '';
  try {
    const params = new URLSearchParams();
    if (directory) params.set('directory', directory);
    const query = params.toString();
    const url = `${OPENCODE_BASE_URL}/project${query ? `?${query}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Project request failed (${response.status})`);
    const data = (await response.json()) as ProjectInfo[];
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
    const params = new URLSearchParams();
    if (directory) params.set('directory', directory);
    const query = params.toString();
    const response = await fetch(
      `${OPENCODE_BASE_URL}/project/current${query ? `?${query}` : ''}`,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as ProjectInfo;
    return data && typeof data.id === 'string' ? data : null;
  } catch {
    return null;
  }
}

async function fetchSessionById(sessionId: string, directory?: string) {
  if (!sessionId || !directory) return null;
  try {
    const params = new URLSearchParams();
    params.set('directory', directory);
    const query = params.toString();
    const response = await fetch(
      `${OPENCODE_BASE_URL}/session/${sessionId}${query ? `?${query}` : ''}`,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as SessionInfo;
    return data && typeof data.id === 'string' ? data : null;
  } catch {
    return null;
  }
}

function projectSessionDirectories(project?: ProjectInfo) {
  if (!project) return [] as string[];
  const candidates = [] as string[];
  if (project.worktree) candidates.push(project.worktree);
  if (Array.isArray(project.sandboxes)) candidates.push(...project.sandboxes);
  return Array.from(
    new Set(candidates.map((directory) => directory.trim()).filter((directory) => directory)),
  );
}

async function resolveSessionDirectory(sessionId: string, directories: string[]) {
  if (!sessionId) return '';
  for (const directory of directories) {
    const session = await fetchSessionById(sessionId, directory);
    if (session?.id === sessionId) return session.directory || directory;
  }
  return '';
}

async function fetchSessions(options: {
  directory?: string;
  roots?: boolean;
  search?: string;
  limit?: number;
} = {}) {
  sessionError.value = '';
  try {
    const params = new URLSearchParams();
    if (options.directory) params.set('directory', options.directory);
    if (options.roots) params.set('roots', 'true');
    if (options.search) params.set('search', options.search);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    const url = `${OPENCODE_BASE_URL}/session${query ? `?${query}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Session request failed (${response.status})`);
    const data = (await response.json()) as SessionInfo[];
    const list = Array.isArray(data) ? data : [];
    if (options.directory && selectedWorktreeDir.value && options.directory !== selectedWorktreeDir.value) {
      return;
    }
    setSessions(list);
  } catch (error) {
    const message = `Session load failed: ${toErrorMessage(error)}`;
    sessionError.value = message;
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
    const params = new URLSearchParams();
    params.set('directory', directory);
    const query = params.toString();
    const response = await fetch(
      `${OPENCODE_BASE_URL}/experimental/worktree${query ? `?${query}` : ''}`,
    );
    if (!response.ok) throw new Error(`Worktree request failed (${response.status})`);
    const data = (await response.json()) as string[];
    const baseDir = directory?.trim() ?? '';
    const list = Array.isArray(data) ? data.slice() : [];
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
    const params = new URLSearchParams({ directory: trimmed });
    const response = await fetch(`${OPENCODE_BASE_URL}/vcs?${params.toString()}`);
    if (!response.ok) return;
    const data = (await response.json()) as VcsInfo;
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
    const params = new URLSearchParams();
    params.set('directory', selectedProjectDirectory.value);
    const query = params.toString();
    const response = await fetch(
      `${OPENCODE_BASE_URL}/experimental/worktree${query ? `?${query}` : ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    if (!response.ok) throw new Error(`Worktree create failed (${response.status})`);
    const data = (await response.json()) as WorktreeInfo;
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
    const params = new URLSearchParams();
    params.set('directory', selectedProjectDirectory.value);
    const query = params.toString();
    const response = await fetch(
      `${OPENCODE_BASE_URL}/experimental/worktree${query ? `?${query}` : ''}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory }),
      },
    );
    if (!response.ok) throw new Error(`Worktree delete failed (${response.status})`);
    if (selectedWorktreeDir.value === directory) selectedWorktreeDir.value = '';
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
    const params = new URLSearchParams();
    if (activeDirectory.value) params.set('directory', activeDirectory.value);
    const query = params.toString();
    const response = await fetch(`${OPENCODE_BASE_URL}/session${query ? `?${query}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(`Session create failed (${response.status})`);
    const data = (await response.json()) as SessionInfo;
    if (data && typeof data.id === 'string') {
      const matchesDirectory =
        !data.directory || data.directory === selectedWorktreeDir.value || !selectedWorktreeDir.value;
      if (matchesDirectory) {
        const existing = sessions.value.find((session) => session.id === data.id);
        if (!existing) sessions.value.unshift(data);
        upsertSessionGraph(data);
      }
      selectedSessionId.value = data.id;
      if (data.projectID && !selectedProjectId.value) selectedProjectId.value = data.projectID;
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
    const response = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(`Session delete failed (${response.status})`);
    if (selectedSessionId.value === sessionId) selectedSessionId.value = '';
    removeSessionFromGraph(sessionId);
    sessions.value = sessions.value.filter((session) => session.id !== sessionId);
    void refreshSessionsForDirectory(activeDirectory.value || undefined);
  } catch (error) {
    sessionError.value = `Session delete failed: ${toErrorMessage(error)}`;
  }
}

async function handleProjectDirectorySelect(directory: string) {
  isProjectPickerOpen.value = false;
  if (!directory) return;
  selectedProjectDirectory.value = directory;
  selectedWorktreeDir.value = '';
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
}

async function bootstrapSelections() {
  if (isBootstrapping.value) return;
  isBootstrapping.value = true;
  try {
    const current = await fetchCurrentProject();
    await fetchProjects();
    if (current) upsertProject(current);

    let resolvedProjectId = selectedProjectId.value;
    if (!resolvedProjectId) {
      resolvedProjectId =
        current?.id ??
        projects.value.find((project) => project.id !== 'global')?.id ??
        projects.value[0]?.id ??
        '';
    }
    if (resolvedProjectId) selectedProjectId.value = resolvedProjectId;

    const selectedProject = projects.value.find((item) => item.id === resolvedProjectId);
    const sessionCandidates = projectSessionDirectories(selectedProject);
    let sessionDirectory = '';
    if (selectedSessionId.value && sessionCandidates.length > 0) {
      sessionDirectory = await resolveSessionDirectory(selectedSessionId.value, sessionCandidates);
      if (sessionDirectory) selectedWorktreeDir.value = sessionDirectory;
    }
    if (!selectedSessionId.value && selectedProject?.worktree) {
      selectedWorktreeDir.value = selectedProject.worktree;
    }

    if (!selectedProjectDirectory.value) {
      if (selectedProject) {
        const baseDir = projectBaseDirectory(selectedProject);
        if (baseDir) selectedProjectDirectory.value = baseDir;
      }
    }

    if (selectedProjectDirectory.value) {
      await fetchWorktrees(selectedProjectDirectory.value);
    } else {
      worktrees.value = [];
    }

    if (sessionDirectory && !worktrees.value.includes(sessionDirectory)) {
      worktrees.value = [sessionDirectory, ...worktrees.value];
    }

    if (!selectedWorktreeDir.value) {
      if (worktrees.value.length > 0) selectedWorktreeDir.value = worktrees.value[0] ?? '';
    }

    const directory = selectedWorktreeDir.value || selectedProjectDirectory.value || undefined;
    if (directory) {
      await fetchCommands(directory);
      await refreshSessionsForDirectory(directory);
    } else {
      clearSessions();
    }
  } finally {
    isBootstrapping.value = false;
  }
}


async function fetchProviders() {
  if (providersLoading.value || providersLoaded.value) return;
  providersLoading.value = true;
  providersFetchCount.value += 1;
  log('providers fetch start', providersFetchCount.value);
  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/config/providers`);
    if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
    const data = (await response.json()) as ProviderResponse;
    providers.value = Array.isArray(data.providers) ? data.providers : [];
    const models: Array<{
      id: string;
      label: string;
      providerID?: string;
      variants?: Record<string, unknown>;
    }> = [];
    providers.value.forEach((provider) => {
      Object.values(provider.models ?? {}).forEach((model) => {
        const label = model.name ? `${model.name} (${model.id})` : model.id;
        models.push({
          id: model.id,
          label,
          providerID: model.providerID ?? provider.id,
          variants: model.variants,
        });
      });
    });
    models.sort((a, b) => a.label.localeCompare(b.label));
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
    const variants = selectedInfo?.variants ?? {};
    const keys = Object.keys(variants).sort();
    const nextThinkingOptions = keys.length > 0 ? keys : ['default'];
    const sameThinking =
      nextThinkingOptions.length === thinkingOptions.value.length &&
      nextThinkingOptions.every((value, index) => value === thinkingOptions.value[index]);
    if (!sameThinking) thinkingOptions.value = nextThinkingOptions;
    if (!selectedThinking.value || !nextThinkingOptions.includes(selectedThinking.value)) {
      selectedThinking.value = thinkingOptions.value[0] ?? '';
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
    const response = await fetch(`${OPENCODE_BASE_URL}/agent`);
    if (!response.ok) throw new Error(`Agent request failed (${response.status})`);
    const data = (await response.json()) as AgentInfo[];
    agents.value = Array.isArray(data) ? data : [];
    const options = agents.value
      .filter((agent) => agent.mode === 'primary')
      .filter((agent) => !agent.hidden)
      .map((agent) => ({ id: agent.name, label: agent.name }));
    options.sort((a, b) => a.label.localeCompare(b.label));
    agentOptions.value = options;
    if (!selectedMode.value || !options.some((option) => option.id === selectedMode.value)) {
      const preferred = options.find((option) => option.id === 'build')?.id ?? options[0]?.id;
      if (preferred) selectedMode.value = preferred;
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
    const params = new URLSearchParams();
    if (directory) params.set('directory', directory);
    const query = params.toString();
    const url = `${OPENCODE_BASE_URL}/command${query ? `?${query}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Command request failed (${response.status})`);
    const data = (await response.json()) as CommandInfo[];
    const list = Array.isArray(data) ? data : [];
    list.sort((a, b) => a.name.localeCompare(b.name));
    commands.value = list;
  } catch (error) {
    log('Command load failed', error);
  } finally {
    commandsLoading.value = false;
  }
}

async function fetchSessionStatus(directory?: string) {
  try {
    const params = new URLSearchParams();
    if (directory) params.set('directory', directory);
    const query = params.toString();
    const response = await fetch(
      `${OPENCODE_BASE_URL}/session/status${query ? `?${query}` : ''}`,
    );
    if (!response.ok) throw new Error(`Session status request failed (${response.status})`);
    const data = (await response.json()) as Record<string, { type?: string }>;
    sessionStatusById.clear();
    Object.entries(data ?? {}).forEach(([sessionId, status]) => {
      const type = typeof status?.type === 'string' ? status.type : '';
      if (type === 'busy' || type === 'idle') {
        sessionStatusById.set(sessionId, type);
      } else if (type === 'retry') {
        sessionStatusById.set(sessionId, 'busy');
      }
    });
    if (selectedSessionId.value) {
      const nextStatus = sessionStatusById.get(selectedSessionId.value);
      if (nextStatus) selectedSessionStatus.value = nextStatus;
    }
  } catch (error) {
    log('Session status load failed', error);
  }
}

async function fetchPendingPermissions() {
  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/permission`);
    if (!response.ok) throw new Error(`Permission list failed (${response.status})`);
    const data = (await response.json()) as unknown;
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

function extractMessageTime(info?: Record<string, unknown>): number | undefined {
  if (!info) return undefined;
  const time = info.time as Record<string, unknown> | undefined;
  if (!time || typeof time !== 'object') return undefined;
  const created = time.created;
  return typeof created === 'number' ? created : undefined;
}

function parseUserMessageMeta(info?: Record<string, unknown>): UserMessageMeta | null {
  if (!info) return null;
  const role = typeof info.role === 'string' ? info.role : '';
  if (role !== 'user') return null;
  const agent = typeof info.agent === 'string' ? info.agent.trim() : '';
  const model = (info.model as Record<string, unknown> | undefined) ?? undefined;
  const providerId = typeof model?.providerID === 'string' ? model.providerID.trim() : '';
  const modelId = typeof model?.modelID === 'string' ? String(model.modelID).trim() : '';
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

function resolveUserMessageDisplay(meta: UserMessageMeta | null): UserMessageDisplay | null {
  if (!meta) return null;
  const model = formatUserMessageModel(meta);
  const hasAny = Boolean(meta.agent || model || meta.variant);
  if (!hasAny) return null;
  const variant = meta.variant ?? (meta.agent || model ? 'default' : undefined);
  return {
    agent: meta.agent,
    model,
    variant,
  };
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
    if (!entry.isMessage || entry.messageId !== messageId) return;
    if (entry.role !== 'user') return;
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
    if (!entry.isMessage || entry.messageId !== messageId) return;
    if (entry.role !== 'user') return;
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

async function fetchHistory(sessionId: string, isSubagentMessage = false) {
  if (!sessionId) return;
  try {
    const directory = getSelectedWorktreeDirectory();
    const params = new URLSearchParams();
    if (directory) params.set('directory', directory);
    const query = params.toString();
    const response = await fetch(
      `${OPENCODE_BASE_URL}/session/${sessionId}/message${query ? `?${query}` : ''}`,
    );
    if (!response.ok) throw new Error(`History request failed (${response.status})`);
    const data = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return;
    if (!isSubagentMessage) {
      const selection = pickLastUserSelection(data);
      if (selection) {
        if (selection.agent) selectedMode.value = selection.agent;
        if (selection.modelId) selectedModel.value = selection.modelId;
        if (selection.variant) {
          selectedThinking.value = selection.variant;
        } else if (selection.agent || selection.modelId) {
          selectedThinking.value = 'default';
        }
      }
    }
    const history = data
      .map((message) => {
        const info = message.info as Record<string, unknown> | undefined;
        const parts = message.parts as unknown;
        const text = extractMessageTextFromParts(parts) ?? '';
        const attachments = extractImageAttachmentsFromParts(parts);
        if (!text.trim() && attachments.length === 0) return null;
        const id = typeof info?.id === 'string' ? info.id : undefined;
        const role = typeof info?.role === 'string' ? info.role : undefined;
        const meta = parseUserMessageMeta(info);
        const messageTime = extractMessageTime(info);
        if (!id) return null;
        return { id, role, text, attachments, meta, messageTime };
      })
      .filter(
        (entry): entry is {
          id: string;
          role?: string;
          text: string;
          attachments: MessageAttachment[];
          meta: UserMessageMeta | null;
          messageTime?: number;
        } => Boolean(entry),
      );

    history.slice(-HISTORY_LIMIT).forEach((entry) => {
      const messageKey = buildMessageKey(entry.id, sessionId);
      if (messageIndexById.has(messageKey)) return;
      storeUserMessageMeta(entry.id, entry.meta);
      const resolvedMeta = resolveUserMessageMetaForMessage(entry.id, undefined, entry.meta);
      const displayMeta = resolveUserMessageDisplay(resolvedMeta);
      storeUserMessageTime(entry.id, entry.messageTime);
      const resolvedTime = resolveUserMessageTimeForMessage(entry.id, undefined, entry.messageTime);
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
      const expiresAt = isSubagentMessage ? getSubagentExpiry(sessionId) : time + 1000 * 60 * 30;
      const html = buildHtml(text, 'markdown');
      const randomPosition = isSubagentMessage ? getRandomWindowPosition() : { x: 0, y: 0 };
      queue.value.push({
        time,
        expiresAt,
        x: randomPosition.x,
        y: randomPosition.y,
        header,
        content: entry.text,
        role: entry.role === 'user' ? 'user' : 'assistant',
        messageAgent: displayMeta?.agent,
        messageModel: displayMeta?.model,
        messageVariant: displayMeta?.variant,
        messageTime: resolvedTime,
        scroll: overflowLines > 0,
        scrollDistance,
        scrollDuration,
        html,
        attachments: entry.attachments,
        isWrite: false,
        isMessage: true,
        isSubagentMessage,
        messageId: entry.id,
        messageKey,
        follow: isSubagentMessage ? true : undefined,
        sessionId,
        zIndex: isSubagentMessage ? nextWindowZ() : undefined,
      });
      if (entry.attachments.length > 0) {
        messageAttachmentsById.set(messageKey, entry.attachments);
      }
      messageIndexById.set(messageKey, queue.value.length - 1);
      messageContentById.set(messageKey, entry.text);
    });
    if (!isSubagentMessage) scheduleFollowScroll();
  } catch (error) {
    log('History load failed', error);
  }
}

function buildPtyUrl(path: string, directory?: string) {
  const params = new URLSearchParams();
  if (directory) params.set('directory', directory);
  const query = params.toString();
  return `${OPENCODE_BASE_URL}${path}${query ? `?${query}` : ''}`;
}

function buildPtyWsUrl(path: string, directory?: string) {
  const base = OPENCODE_BASE_URL.replace(/^http/, 'ws');
  const params = new URLSearchParams();
  if (directory) params.set('directory', directory);
  const query = params.toString();
  return `${base}${path}${query ? `?${query}` : ''}`;
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
  const url = buildPtyUrl('/pty', directory);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PTY list failed (${response.status})`);
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) return [] as PtyInfo[];
  return data.map(parsePtyInfo).filter((pty): pty is PtyInfo => Boolean(pty));
}

async function createPtySession(sessionId: string, command?: string, args?: string[]) {
  const directory = activeDirectory.value || undefined;
  const url = buildPtyUrl('/pty', directory);
  const body = {
    command,
    args,
    cwd: directory,
    title: `Shell (${sessionId.slice(0, 6)})`,
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`PTY create failed (${response.status})`);
  const data = (await response.json()) as unknown;
  return parsePtyInfo(data);
}

async function updatePtySize(ptyId: string, rows: number, cols: number, directory?: string) {
  const url = buildPtyUrl(`/pty/${ptyId}`, directory);
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: { rows, cols } }),
  });
  if (!response.ok) throw new Error(`PTY resize failed (${response.status})`);
  const data = (await response.json()) as unknown;
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
    zIndex: nextWindowZ(),
  };
  queue.value.push(entry);
  if (!options.preserve) addShellPtyId(sessionId, pty.id);
  const terminal = new Terminal({
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: 13,
    lineHeight: 1.1,
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
    const host = canvasEl.value?.querySelector(
      `[data-shell-id="${pty.id}"]`,
    ) as HTMLElement | null;
    if (!host) return;
    terminal.open(host);
    scheduleShellFit(pty.id);
    connectShellSocket(pty.id);
  });
}

function scheduleShellFit(ptyId: string) {
  const existing = pendingShellFits.get(ptyId);
  if (existing) cancelAnimationFrame(existing);
  const handle = requestAnimationFrame(() => {
    pendingShellFits.delete(ptyId);
    const session = shellSessionsByPtyId.get(ptyId);
    if (!session) return;
    session.fitAddon.fit();
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

async function sendCommand(sessionId: string, command: CommandInfo, commandArgs: string) {
  const response = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      command: command.name,
      arguments: commandArgs,
      agent: command.agent || selectedMode.value,
      model: command.model || selectedModel.value,
      variant: selectedThinking.value !== 'default' ? selectedThinking.value : undefined,
    }),
  });
  if (!response.ok) throw new Error(`Command failed (${response.status})`);
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
  isSending.value = true;
  sendStatus.value = 'Sending...';
  try {
    if (slash && slash.name.toLowerCase() === 'shell') {
      await openShellFromInput(slash.arguments ?? '');
      sendStatus.value = 'Shell ready.';
      return;
    }
    if (slash && commandMatch) {
      await sendCommand(sessionId, commandMatch, slash.arguments ?? '');
      sendStatus.value = 'Sent.';
      return;
    }
    const directory = requireSelectedWorktree('send');
    if (!directory) return;
    const params = new URLSearchParams({ directory });
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
    const response = await fetch(
      `${OPENCODE_BASE_URL}/session/${sessionId}/prompt_async?${params.toString()}`,
      {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent: selectedMode.value,
        model: {
          providerID: selectedInfo?.providerID,
          modelID: selectedModel.value,
        },
        variant: selectedThinking.value !== 'default' ? selectedThinking.value : undefined,
        parts,
      }),
      },
    );
    if (!response.ok) throw new Error(`Send failed (${response.status})`);
    sendStatus.value = 'Sent.';
    attachments.value = [];
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
    const params = directory ? `?${new URLSearchParams({ directory }).toString()}` : '';
    const response = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}/abort${params}`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error(`Abort failed (${response.status})`);
    sendStatus.value = 'Stopped.';
  } catch (error) {
    sendStatus.value = `Stop failed: ${toErrorMessage(error)}`;
  } finally {
    isAborting.value = false;
  }
}

watch(
  projects,
  (nextProjects) => {
    if (selectedProjectId.value) return;
    const preferred = nextProjects.find((project) => project.id !== 'global') ?? nextProjects[0];
    if (preferred) selectedProjectId.value = preferred.id;
  },
  { immediate: true },
);

watch(
  worktrees,
  (list) => {
    resolveWorktreeMetadata(Array.isArray(list) ? list : []);
  },
  { immediate: true },
);

watch(
  projects,
  (nextProjects) => {
    if (!selectedProjectId.value) return;
    if (selectedProjectDirectory.value) return;
    const project = nextProjects.find((item) => item.id === selectedProjectId.value);
    if (!project) return;
    const baseDir = projectBaseDirectory(project);
    if (baseDir) selectedProjectDirectory.value = baseDir;
  },
  { immediate: true },
);

watch(
  selectedProjectId,
  (value, previous) => {
    if (value === previous) return;
    if (typeof previous === 'undefined') return;
    if (isBootstrapping.value) return;
    selectedProjectDirectory.value = '';
    selectedWorktreeDir.value = '';
    selectedSessionId.value = '';
    worktrees.value = [];
    clearSessions();
    const project = projects.value.find((item) => item.id === value);
    if (project) {
      const baseDir = projectBaseDirectory(project);
      if (baseDir) {
        selectedProjectDirectory.value = baseDir;
        void fetchWorktrees(baseDir);
      }
    }
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
    clearSessions();
    if (!value) return;
    void fetchCommands(value);
    void refreshSessionsForDirectory(value);
  },
  { immediate: true },
);

watch(
  filteredSessions,
  () => {
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

watch(selectedSessionId, () => {
  disposeShellWindows({ preserve: true });
  queue.value = [];
  messageIndexById.clear();
  toolIndexByCallId.clear();
  messageContentById.clear();
  messagePartsById.clear();
  messagePartOrderById.clear();
  messageSummaryTitleById.clear();
  messageAttachmentsById.clear();
  reasoningTitleBySessionId.clear();
  activeReasoningMessageIdByKey.clear();
  finishedReasoningByKey.clear();
  subagentSessionExpiry.clear();
  selectedSessionStatus.value = '';
  if (selectedSessionId.value) {
    void fetchHistory(selectedSessionId.value);
    void restoreShellSessions(selectedSessionId.value);
  }
  void fetchSessionStatus(activeDirectory.value || undefined);
},
{ immediate: true });

watch(
  allowedSessionIds,
  () => {
    prunePermissionEntries();
  },
  { immediate: true },
);

watch(
  [selectedProjectId, selectedSessionId],
  ([projectId, sessionId]) => {
    replaceQuerySelection(projectId, sessionId);
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
  const variants = selectedInfo?.variants ?? {};
  const keys = Object.keys(variants).sort();
  const nextThinkingOptions = keys.length > 0 ? keys : ['default'];
  const sameThinking =
    nextThinkingOptions.length === thinkingOptions.value.length &&
    nextThinkingOptions.every((value, index) => value === thinkingOptions.value[index]);
  if (!sameThinking) thinkingOptions.value = nextThinkingOptions;
  if (!selectedThinking.value || !nextThinkingOptions.includes(selectedThinking.value)) {
    selectedThinking.value = nextThinkingOptions[0] ?? '';
  }
});

watch(activeDirectory, (directory) => {
  if (isBootstrapping.value) return;
  const activePath = directory || undefined;
  if (!activePath) return;
  if (selectedWorktreeDir.value && activePath !== selectedWorktreeDir.value) return;
  void fetchCommands(activePath);
});

watch(
  allowedSessionIds,
  () => {
    pruneTasksForAllowedSessions();
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
const highlighter = shallowRef<Awaited<ReturnType<typeof createHighlighter>> | null>(null);
setInterval(() => {
  const now = Date.now();
  messageIndexById.clear();
  toolIndexByCallId.clear();
  messageContentById.clear();
  messagePartsById.clear();
  messagePartOrderById.clear();
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
    }
    if (entry.callId) toolIndexByCallId.set(entry.callId, index);
    if (entry.isMessage && entry.messageId) {
      const messageKey = buildMessageKey(entry.messageId, entry.sessionId);
      messageContentById.set(messageKey, entry.content);
    }
    if (entry.callId && entry.toolStatus === 'running') runningToolIds.add(entry.callId);
  });
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'Running',
  completed: 'Done',
  cancelled: 'Failed',
};

const TASK_STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
};

type TaskUpdate =
  | {
      kind: 'subtask';
      sessionId: string;
      messageId?: string;
      taskId?: string;
      content: string;
    }
  | {
      kind: 'tool';
      sessionId: string;
      messageId?: string;
      callId?: string;
      content: string;
      status: TaskStatus;
      subSessionId?: string;
    };

function normalizeTaskStatus(status?: string): TaskStatus {
  switch (status) {
    case 'running':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'error':
      return 'cancelled';
    case 'pending':
    default:
      return 'pending';
  }
}

function buildTaskListHtml(tasks: TaskItem[]) {
  const header = tasks.length === 1 ? '1 task' : `${tasks.length} tasks`;
  const items = tasks
    .map((task) => {
      const displayContent = (task.content || '').trim() || 'Task';
      const statusLabel = TASK_STATUS_LABELS[task.status] ?? task.status;
      const statusClass = task.status === 'in_progress' ? 'is-running' : 'is-pending';
      const subSessionLabel =
        task.subSessionId && task.subSessionId !== task.sessionId
          ? getSessionTitle(task.subSessionId) ?? task.subSessionId
          : undefined;
      const sessionLabel =
        subSessionLabel ??
        (task.sessionId !== selectedSessionId.value
          ? getSessionTitle(task.sessionId) ?? task.sessionId
          : undefined);
      const sessionHtml = sessionLabel
        ? `<span class="tasklist-session">${escapeHtml(sessionLabel)}</span>`
        : '';
      return `<li class="tasklist-item ${statusClass}"><span class="tasklist-status">${escapeHtml(
        statusLabel,
      )}</span><span class="tasklist-text">${escapeHtml(displayContent)}</span>${sessionHtml}</li>`;
    })
    .join('');
  return `<div class="tasklist"><div class="tasklist-header">${escapeHtml(
    header,
  )}</div><ul class="tasklist-items">${items}</ul></div>`;
}

function updateTaskListWindow() {
  if (!selectedSessionId.value) {
    const existingIndex = queue.value.findIndex((entry) => entry.isTaskList);
    if (existingIndex >= 0) queue.value.splice(existingIndex, 1);
    return;
  }
  const allowed = allowedSessionIds.value;
  const tasks = Array.from(tasksById.values()).filter((task) => allowed.has(task.sessionId));
  if (tasks.length === 0) {
    const existingIndex = queue.value.findIndex((entry) => entry.isTaskList);
    if (existingIndex >= 0) queue.value.splice(existingIndex, 1);
    return;
  }
  tasks.sort((a, b) => {
    const orderDiff = TASK_STATUS_ORDER[a.status] - TASK_STATUS_ORDER[b.status];
    if (orderDiff !== 0) return orderDiff;
    return b.updatedAt - a.updatedAt;
  });
  const html = buildTaskListHtml(tasks);
  const content = tasks
    .map((task) => {
      const displayContent = (task.content || '').trim() || 'Task';
      return `${task.status}: ${displayContent}`;
    })
    .join('\n');
  const time = Date.now();
  const existingIndex = queue.value.findIndex((entry) => entry.isTaskList);
  if (existingIndex >= 0) {
    const existing = queue.value[existingIndex];
    if (!existing) return;
    queue.value.splice(existingIndex, 1, {
      ...existing,
      time,
      expiresAt: Number.MAX_SAFE_INTEGER,
      content,
      html,
      toolTitle: existing.toolTitle ?? 'Tasks',
    });
    return;
  }
  const randomPosition = getRandomWindowPosition({
    width: TASK_WINDOW_WIDTH,
    height: TASK_WINDOW_HEIGHT,
  });
  queue.value.push({
    time,
    expiresAt: Number.MAX_SAFE_INTEGER,
    x: randomPosition.x,
    y: randomPosition.y,
    header: '',
    content,
    scroll: false,
    scrollDistance: 0,
    scrollDuration: 0,
    html,
    isWrite: false,
    isMessage: false,
    isTaskList: true,
    toolKey: TASK_LIST_TOOL_KEY,
    toolTitle: 'Tasks',
    width: TASK_WINDOW_WIDTH,
    height: TASK_WINDOW_HEIGHT,
    zIndex: nextWindowZ(),
  });
}

function pruneTasksForAllowedSessions() {
  const allowed = allowedSessionIds.value;
  if (!selectedSessionId.value || allowed.size === 0) {
    tasksById.clear();
    taskIdByMessageKey.clear();
    taskIdByCallId.clear();
    updateTaskListWindow();
    return;
  }
  let didChange = false;
  tasksById.forEach((task, id) => {
    if (!allowed.has(task.sessionId)) {
      removeTaskEntry(id);
      didChange = true;
    }
  });
  if (didChange || allowed.size > 0) updateTaskListWindow();
}

function removeTaskEntry(taskId: string) {
  const existing = tasksById.get(taskId);
  if (!existing) return;
  tasksById.delete(taskId);
  if (existing.messageId) {
    const messageKey = buildMessageKey(existing.messageId, existing.sessionId);
    if (taskIdByMessageKey.get(messageKey) === taskId) taskIdByMessageKey.delete(messageKey);
  }
  if (existing.callId && taskIdByCallId.get(existing.callId) === taskId) {
    taskIdByCallId.delete(existing.callId);
  }
}

function upsertTaskFromSubtask(update: Extract<TaskUpdate, { kind: 'subtask' }>) {
  const messageKey = update.messageId ? buildMessageKey(update.messageId, update.sessionId) : undefined;
  const existingId = messageKey ? taskIdByMessageKey.get(messageKey) : undefined;
  const taskId = existingId ?? update.taskId ?? `subtask:${update.sessionId}:${Date.now()}`;
  const existing = tasksById.get(taskId);
  const content = update.content || existing?.content || '';
  const next: TaskItem = {
    id: taskId,
    sessionId: update.sessionId,
    messageId: update.messageId ?? existing?.messageId,
    content,
    status: existing?.status ?? 'pending',
    source: existing?.source ?? 'subtask',
    updatedAt: Date.now(),
    subSessionId: existing?.subSessionId,
  };
  tasksById.set(taskId, next);
  if (messageKey) taskIdByMessageKey.set(messageKey, taskId);
}

function upsertTaskFromTool(update: Extract<TaskUpdate, { kind: 'tool' }>) {
  const messageKey = update.messageId ? buildMessageKey(update.messageId, update.sessionId) : undefined;
  const existingId =
    (messageKey ? taskIdByMessageKey.get(messageKey) : undefined) ??
    (update.callId ? taskIdByCallId.get(update.callId) : undefined);
  const taskId = existingId ?? update.callId ?? `task:${update.sessionId}:${Date.now()}`;
  const existing = tasksById.get(taskId);
  const content = update.content || existing?.content || '';
  if (update.status === 'completed' || update.status === 'cancelled') {
    removeTaskEntry(taskId);
    return;
  }
  const next: TaskItem = {
    id: taskId,
    sessionId: update.sessionId,
    messageId: update.messageId ?? existing?.messageId,
    callId: update.callId ?? existing?.callId,
    content,
    status: update.status,
    source: existing?.source ?? 'tool',
    updatedAt: Date.now(),
    subSessionId: update.subSessionId ?? existing?.subSessionId,
  };
  tasksById.set(taskId, next);
  if (messageKey) taskIdByMessageKey.set(messageKey, taskId);
  if (update.callId) taskIdByCallId.set(update.callId, taskId);
}

function extractMessagePart(payload: unknown, eventType: string) {
  if (!payload || typeof payload !== 'object') return null;
  const normalized = normalizeEventType(eventType);
  if (normalized !== 'messagepartupdated') return null;
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
  return part ?? null;
}

function extractTaskUpdate(payload: unknown, eventType: string, fallbackSessionId?: string): TaskUpdate | null {
  const part = extractMessagePart(payload, eventType);
  if (!part) return null;
  const type = typeof part.type === 'string' ? part.type : undefined;
  const sessionId =
    (typeof part.sessionID === 'string' && part.sessionID) ||
    (typeof part.sessionId === 'string' && part.sessionId) ||
    fallbackSessionId;
  if (!sessionId) return null;
  const messageId =
    (typeof part.messageID === 'string' && part.messageID) ||
    (typeof part.messageId === 'string' && part.messageId) ||
    undefined;
  if (type === 'subtask') {
    const content =
      (typeof part.description === 'string' && part.description) ||
      (typeof part.prompt === 'string' && part.prompt) ||
      '';
    const taskId = typeof part.id === 'string' ? part.id : undefined;
    return {
      kind: 'subtask',
      sessionId,
      messageId,
      taskId,
      content: content.trim(),
    };
  }
  if (type === 'tool') {
    const tool = typeof part.tool === 'string' ? part.tool : undefined;
    if (tool !== 'task') return null;
    const callId =
      (typeof part.callID === 'string' && part.callID) ||
      (typeof part.callId === 'string' && part.callId) ||
      undefined;
    const state = part.state && typeof part.state === 'object' ? (part.state as Record<string, unknown>) : null;
    const status = normalizeTaskStatus(typeof state?.status === 'string' ? (state.status as string) : undefined);
    const input = state?.input && typeof state.input === 'object' ? (state.input as Record<string, unknown>) : null;
    const content =
      (typeof input?.description === 'string' && input.description) ||
      (typeof input?.prompt === 'string' && input.prompt) ||
      '';
    const metadata =
      part.metadata && typeof part.metadata === 'object'
        ? (part.metadata as Record<string, unknown>)
        : null;
    const subSessionId =
      metadata && typeof metadata.sessionId === 'string' ? (metadata.sessionId as string) : undefined;
    return {
      kind: 'tool',
      sessionId,
      messageId,
      callId,
      content: content.trim(),
      status,
      subSessionId,
    };
  }
  return null;
}

function applyTaskUpdate(update: TaskUpdate) {
  if (update.kind === 'subtask') {
    upsertTaskFromSubtask(update);
  } else {
    upsertTaskFromTool(update);
  }
  updateTaskListWindow();
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

function renderDiffHtml(source: string) {
  const lines = source.split('\n');
  const htmlLines = lines
    .map((line) => {
      const isHeader =
        line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('***');
      const isHunk = line.startsWith('@@');
      const isAdded = line.startsWith('+') && !line.startsWith('+++');
      const isRemoved = line.startsWith('-') && !line.startsWith('---');
      const className = isHeader
        ? 'line line-header'
        : isHunk
          ? 'line line-hunk'
          : isAdded
            ? 'line line-added'
            : isRemoved
              ? 'line line-removed'
              : 'line';
      return `<span class="${className}">${escapeHtml(line)}</span>`;
    })
    .join('\n');
  return `<pre class="shiki"><code>${htmlLines}</code></pre>`;
}

function decorateDiffHtml(html: string, source: string) {
  const sourceLines = source.split('\n');
  const htmlLines = html.split('\n');
  let lineIndex = 0;
  return htmlLines
    .map((line) => {
      if (!line.includes('class="line"')) return line;
      const sourceLine = sourceLines[lineIndex] ?? '';
      lineIndex += 1;
      const isHeader =
        sourceLine.startsWith('diff ') ||
        sourceLine.startsWith('index ') ||
        sourceLine.startsWith('---') ||
        sourceLine.startsWith('+++') ||
        sourceLine.startsWith('***');
      const isHunk = sourceLine.startsWith('@@');
      const isAdded = sourceLine.startsWith('+') && !sourceLine.startsWith('+++');
      const isRemoved = sourceLine.startsWith('-') && !sourceLine.startsWith('---');
      const className = isHeader
        ? 'line line-header'
        : isHunk
          ? 'line line-hunk'
          : isAdded
            ? 'line line-added'
            : isRemoved
              ? 'line line-removed'
              : 'line';
      return line.replace('class="line"', `class="${className}"`);
    })
    .join('\n');
}

function buildHtml(text: string, lang: string) {
  if (highlighter.value) {
    const highlighterInstance = highlighter.value;
    const loadedLanguages =
      typeof highlighterInstance.getLoadedLanguages === 'function'
        ? highlighterInstance.getLoadedLanguages()
        : [];
    const resolvedLang = resolveShikiLanguage(lang, loadedLanguages);
    if (!isDarkThemeName(shikiTheme.value) && lang !== 'diff') {
      return `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`;
    }
    try {
      if (lang === 'diff' && loadedLanguages.includes('diff')) {
        const html = highlighterInstance.codeToHtml(text, {
          lang: 'diff',
          theme: shikiTheme.value,
        });
        return decorateDiffHtml(html, text);
      }
      if (lang === 'diff') return renderDiffHtml(text);
      const html = highlighterInstance.codeToHtml(text, {
        lang: resolvedLang,
        theme: shikiTheme.value,
      });
      return html;
    } catch (error) {
      log('shiki render failed', { lang: resolvedLang, error: String(error) });
      return `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`;
    }
  }

  if (lang === 'diff') return renderDiffHtml(text);
  return `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`;
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

function formatPatchText(patchText: string) {
  const lines = patchText.split('\n');
  const output: string[] = [];
  let currentFile: string | undefined;

  for (const line of lines) {
    if (line.startsWith('*** Update File: ')) {
      currentFile = line.replace('*** Update File: ', '').trim();
      output.push(`diff --git a/${currentFile} b/${currentFile}`);
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      currentFile = line.replace('*** Add File: ', '').trim();
      output.push(`diff --git a/${currentFile} b/${currentFile}`);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      currentFile = line.replace('*** Delete File: ', '').trim();
      output.push(`diff --git a/${currentFile} b/${currentFile}`);
      continue;
    }
    if (line.startsWith('@@')) {
      output.push(line);
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      output.push(line);
      continue;
    }
  }

  return {
    content: output.join('\n').trim(),
    path: currentFile,
  };
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
  if (status && status !== 'running') {
    return {
      content: '',
      path: 'tool:apply_patch',
      isWrite: true,
      callId,
      toolStatus: status,
      toolName: 'apply_patch',
    };
  }
  const input =
    state?.input && typeof state.input === 'object'
      ? (state.input as Record<string, unknown>)
      : undefined;
  const patchText = input?.patchText;

  if (status === 'running' && typeof patchText === 'string') {
    const formatted = formatPatchText(patchText);
    if (!formatted.content) return null;
    return {
      content: formatted.content,
      path: formatted.path,
      isWrite: true,
      callId,
      toolStatus: status,
      toolName: 'apply_patch',
    };
  }

  const content = formatToolValue(input ?? {});
  return {
    content,
    path: 'tool:apply_patch',
    isWrite: true,
    callId,
    toolStatus: status,
    toolName: 'apply_patch',
  };
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
    if (tool === 'apply_patch' || tool === 'write') return null;
    const state =
      part?.state && typeof part.state === 'object'
        ? (part.state as Record<string, unknown>)
        : undefined;
    const input =
      state?.input && typeof state.input === 'object'
        ? (state.input as Record<string, unknown>)
        : undefined;
    const output =
      state?.output ?? (state?.metadata as Record<string, unknown> | undefined)?.output;
    const status = typeof state?.status === 'string' ? state.status : undefined;
    const callId =
      (part?.callID as string | undefined) ??
      (part?.callId as string | undefined) ??
      (properties?.callID as string | undefined) ??
      (properties?.callId as string | undefined);
    const path =
      (input?.filePath as string | undefined) ??
      (input?.path as string | undefined) ??
      (input?.name as string | undefined) ??
      `tool:${tool}`;
    const outputText = output !== undefined ? extractToolOutputText(output) : undefined;
    const toolTitle =
      (typeof input?.command === 'string' && input.command.trim()) ||
      (typeof state?.title === 'string' && state.title.trim()) ||
      (Array.isArray(input?.args)
        ? input.args.filter((entry) => typeof entry === 'string').join(' ')
        : undefined);

    if (tool === 'bash') {
      return {
        content: outputText ?? '',
        path,
        isWrite: false,
        callId,
        toolStatus: status,
        toolName: tool,
        toolTitle: toolTitle && toolTitle.trim() ? toolTitle : undefined,
      };
    }

    const blocks: string[] = [];
    const inputText = formatToolValue(input ?? {});
    blocks.push('input:');
    blocks.push(inputText);

    if (output !== undefined) {
      const outputValue = outputText ?? '';
      if (tool === 'read' && typeof outputValue === 'string') {
        const body = extractFileBodyFromReadOutput(outputValue);
        if (body) {
          return {
            content: body,
            path,
            isWrite: false,
            callId,
            toolStatus: status,
            toolName: tool,
          };
        }
      }
      blocks.push('output:');
      blocks.push(outputValue);
    }

    const content = blocks.join('\n');
    return { content, path, isWrite: false, callId, toolStatus: status, toolName: tool };
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
  if (resolvedRole === 'user' && typeof messageTime === 'number') {
    storeUserMessageTime(messageId ?? id, messageTime);
  }

  return {
    id,
    messageId,
    content: message,
    role: resolvedRole,
    partId,
    partType,
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
  if (!finish) return null;
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
  return { finish, sessionId, messageId };
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

  if (!type || !type.toLowerCase().includes('session.status')) return null;

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
  const width = 420;
  const height = 280;
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
  const params = new URLSearchParams();
  if (directory) params.set('directory', directory);
  const query = params.toString();
  const response = await fetch(
    `${OPENCODE_BASE_URL}/permission/${requestId}/reply${query ? `?${query}` : ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply }),
    },
  );
  if (!response.ok) throw new Error(`Permission reply failed (${response.status})`);
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
  },
  eventType: string,
  langOverride?: string,
) {
  if (entry.callId && entry.toolStatus) {
    if (entry.toolStatus === 'running' || entry.toolStatus === 'pending')
      runningToolIds.add(entry.callId);
    else runningToolIds.delete(entry.callId);
  }

  if (entry.toolName === 'apply_patch' && entry.toolStatus && entry.toolStatus !== 'running') {
    const existingIndex = entry.callId ? toolIndexByCallId.get(entry.callId) : undefined;
    if (existingIndex !== undefined) {
      const existing = queue.value[existingIndex];
      if (existing) {
        const time = Date.now();
        const nextExpiresAt = time + TOOL_COMPLETE_TTL_MS;
        queue.value.splice(existingIndex, 1, {
          ...existing,
          time,
          expiresAt: Math.max(existing.expiresAt, nextExpiresAt),
          toolStatus: entry.toolStatus,
        });
        scheduleToolScrollAnimation(
          existing.toolKey ?? entry.callId ?? `tool:apply_patch:${time}`,
        );
      }
    }
    return;
  }
  if (entry.toolName === 'read' && entry.toolStatus && entry.toolStatus !== 'completed') {
    return;
  }
  const isBashTool = entry.toolName === 'bash';
  const displayPath = resolveWorktreeRelativePath(entry.path);
  const hideHeader = entry.toolName === 'grep' || entry.toolName === 'apply_patch';
  const header = isBashTool || hideHeader
    ? ''
    : displayPath
      ? `# ${displayPath}\n\n`
      : eventType !== 'message'
        ? `# ${eventType}\n\n`
        : '';
  const time = Date.now();
  const text = `${header}${entry.content}`;
  const scrollDistance = 0;
  const scrollDuration = 0;
  const defaultExpiry = time + Math.ceil((scrollDuration || 0) * 1000 + TOOL_SCROLL_HOLD_MS);
  const isToolPending = entry.toolStatus === 'pending';
  const isToolRunning = entry.toolStatus === 'running';
  const isToolFinished = Boolean(entry.toolStatus && !isToolPending && !isToolRunning);
  const toolTtlMs = isToolPending
    ? TOOL_PENDING_TTL_MS
    : isToolRunning
      ? TOOL_RUNNING_TTL_MS
      : isToolFinished
        ? TOOL_COMPLETE_TTL_MS
        : 0;
  const expiresAt = toolTtlMs > 0 ? Math.max(defaultExpiry, time + toolTtlMs) : defaultExpiry;
  const lang =
    langOverride ??
    (detectDiffLike(entry.content, entry.path) ? 'diff' : guessLanguage(entry.path, eventType));

  if (entry.callId) {
    const existingIndex = toolIndexByCallId.get(entry.callId);
    if (existingIndex !== undefined) {
      const existing = queue.value[existingIndex];
      if (existing) {
        const toolKey =
          existing.toolKey ?? entry.callId ?? `${entry.path ?? entry.toolName ?? 'tool'}:${time}`;
        const nextExpiresAt =
          toolTtlMs > 0 ? Math.max(defaultExpiry, time + toolTtlMs) : defaultExpiry;
        queue.value.splice(existingIndex, 1, {
          ...existing,
          time,
          expiresAt: nextExpiresAt,
          header,
          path: entry.path,
          toolKey,
          content: entry.content,
          scroll: false,
          scrollDistance,
          scrollDuration,
          html: buildHtml(text, lang),
          isWrite: entry.isWrite,
          isMessage: false,
          callId: entry.callId,
          toolStatus: entry.toolStatus,
          toolName: entry.toolName,
          toolTitle: entry.toolTitle ?? existing.toolTitle,
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
    html: buildHtml(text, lang),
    isWrite: entry.isWrite,
    isMessage: false,
    callId: entry.callId,
    toolStatus: entry.toolStatus,
    toolName: entry.toolName,
    toolTitle: entry.toolTitle,
    zIndex: nextWindowZ(),
  });
  if (entry.callId) toolIndexByCallId.set(entry.callId, queue.value.length - 1);
  scheduleToolScrollAnimation(toolKey);
}

function scrollToBottom() {
  const dock = outputDock.value?.dockEl ?? null;
  if (!dock) return;
  dock.scrollTop = Math.max(0, dock.scrollHeight - dock.clientHeight);
}

function updateFollowState() {
  const dock = outputDock.value?.dockEl ?? null;
  if (!dock) return;
  const distanceFromBottom = dock.scrollHeight - dock.scrollTop - dock.clientHeight;
  isFollowing.value = distanceFromBottom <= FOLLOW_THRESHOLD_PX;
}

function handleMessageDockScroll() {
  updateFollowState();
}

function handleMessageDockWheel(event: WheelEvent) {
  if (event.deltaY < 0) {
    isFollowing.value = false;
    return;
  }
  updateFollowState();
}

function scheduleFollowScroll() {
  if (!isFollowing.value) return;
  nextTick(() => {
    requestAnimationFrame(() => {
      scrollToBottom();
      updateFollowState();
    });
  });
}

function resumeFollow() {
  isFollowing.value = true;
  nextTick(scrollToBottom);
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
    const permissionAsked = extractPermissionAsked(payload, resolvedEventType);
    if (permissionAsked) {
      if (isPermissionSessionAllowed(permissionAsked)) {
        upsertPermissionEntry(permissionAsked);
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

    const sessionStatus = extractSessionStatus(payload, resolvedEventType);
    if (sessionStatus) {
      if (sessionStatus.status === 'busy' || sessionStatus.status === 'idle') {
        retryStatus.value = null;
        const nextStatus = sessionStatus.status as 'busy' | 'idle';
        if (sessionId) sessionStatusById.set(sessionId, nextStatus);
        if (!selectedSessionId.value || sessionId === selectedSessionId.value) {
          selectedSessionStatus.value = nextStatus;
          updateReasoningExpiry(sessionId ?? selectedSessionId.value, nextStatus);
        } else if (sessionId) {
          updateSubagentExpiry(sessionId, nextStatus);
          updateReasoningExpiry(sessionId, nextStatus);
        }
      } else if (sessionStatus.status === 'retry') {
        if (sessionStatus.message && typeof sessionStatus.next === 'number') {
          retryStatus.value = {
            message: sessionStatus.message,
            next: sessionStatus.next,
            attempt: sessionStatus.attempt || 1,
          };
        }
      }
    }

    const canRenderSession = Boolean(selectedSessionId.value);
    if (!canRenderSession) return;

    const taskUpdate = extractTaskUpdate(payload, resolvedEventType, sessionId);
    if (taskUpdate) {
      applyTaskUpdate(taskUpdate);
    }

    const ptyEvent = extractPtyEvent(payload, resolvedEventType);
    if (ptyEvent) handlePtyEvent(ptyEvent);

    registerMessageMeta(payload);
    registerMessageSummary(payload);

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

    const messageFinish = extractMessageFinish(payload, resolvedEventType);
    if (messageFinish) {
      if (markReasoningFinished(messageFinish.sessionId ?? sessionId, messageFinish.messageId)) {
        scheduleReasoningClose(messageFinish.sessionId ?? sessionId);
      }
    }

    const patchEvent = extractPatch(payload);
    if (patchEvent) {
      upsertToolEntry(patchEvent, e.type, 'diff');
      return;
    }

    const fileRead = extractFileRead(payload, resolvedEventType);
    if (!fileRead) {
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
            const html = buildHtml(text, 'markdown');
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
              html,
              attachments,
              isWrite: false,
              isMessage: true,
              isSubagentMessage,
              messageId: attachmentUpdate.messageId,
              messageKey: attachmentKey,
              follow: isSubagentMessage ? true : undefined,
              sessionId,
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
      const stableMessageId = isReasoning
        ? `reasoning:${reasoningKey}`
        : (message.messageId ?? message.id);
      const messageKey = buildMessageKey(stableMessageId, sessionId);
      const isSubagentMessage =
        isReasoning ||
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
      if (message.partId && message.messageId) {
        const partMap = messagePartsById.get(messageKey) ?? new Map<string, string>();
        partMap.set(message.partId, message.content);
        messagePartsById.set(messageKey, partMap);
        const order = messagePartOrderById.get(messageKey) ?? [];
        if (!order.includes(message.partId)) order.push(message.partId);
        messagePartOrderById.set(messageKey, order);
        mergedContent = order.map((key) => partMap.get(key) ?? '').join('');
      }
      if (!message.content || message.content.trim().length === 0) {
        const emptyIndex = messageIndexById.get(messageKey);
        if (emptyIndex !== undefined) queue.value.splice(emptyIndex, 1);
        return;
      }

      const isUserMessage =
        message.role === 'user' ||
        userMessageIds.has(message.id) ||
        (message.messageId ? userMessageIds.has(message.messageId) : false);
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
      const displayMeta = isUserMessage ? resolveUserMessageDisplay(resolvedMeta) : null;

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
      const html = buildHtml(text, 'markdown');
      const attachments = messageAttachmentsById.get(messageKey);

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
            messageVariant: nextMessageVariant,
            messageTime: nextMessageTime,
            scroll: !isFloatingMessage && nextOverflowLines > 0,
            scrollDistance: isFloatingMessage ? 0 : nextScrollDistance,
            scrollDuration: isFloatingMessage ? 0 : nextScrollDuration,
            html: buildHtml(nextText, 'markdown'),
            attachments: nextAttachments,
            isReasoning,
            messageKey,
            follow: existing.follow ?? (isFloatingMessage ? true : undefined),
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
        messageVariant: displayMeta?.variant,
        messageTime: resolvedTime,
        scroll: !isFloatingMessage && overflowLines > 0,
        scrollDistance: isFloatingMessage ? 0 : scrollDistance,
        scrollDuration: isFloatingMessage ? 0 : scrollDuration,
        html,
        attachments,
        isWrite: false,
        isMessage: true,
        isSubagentMessage,
        isReasoning,
        messageId: stableMessageId,
        messageKey,
        follow: isFloatingMessage ? true : undefined,
        sessionId,
        zIndex: isFloatingMessage ? nextWindowZ() : undefined,
      });
      messageIndexById.set(messageKey, queue.value.length - 1);
      if (isFloatingMessage) scheduleReasoningScroll(messageKey);
      if (!isSubagentMessage) scheduleFollowScroll();
      return;
    }

    upsertToolEntry(fileRead, e.type);
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
  hydrateShellPtyStorage();
  void bootstrapSelections();
  fetchProviders();
  fetchAgents();
  fetchSessionStatus(activeDirectory.value || undefined);
  fetchCommands(activeDirectory.value || undefined);
  fetchPendingPermissions();
  const availableThemes = getBundledThemeNames();
  const chosenTheme = pickShikiTheme(availableThemes);
  if (chosenTheme) shikiTheme.value = chosenTheme;
  const languageSet = new Set<string>();
  if (Array.isArray(bundledLanguages)) {
    bundledLanguages.forEach((lang) => {
      if (typeof lang === 'string') languageSet.add(lang);
      else if (lang && typeof lang === 'object' && 'id' in lang) languageSet.add(String(lang.id));
    });
  } else {
    Object.keys(bundledLanguages).forEach((lang) => languageSet.add(lang));
  }
  const availableLangs = SHIKI_LANGS.filter((lang) => languageSet.has(lang));
  if (languageSet.has('diff') && !availableLangs.includes('diff')) availableLangs.push('diff');
  if (availableLangs.length === 0) availableLangs.push('text');
  createHighlighter({
    themes: [shikiTheme.value],
    langs: availableLangs,
  })
    .then((instance) => {
      highlighter.value = instance;
      queue.value = queue.value.map((entry) => {
        const text = `${entry.header}${entry.content}`;
        const path = entry.header ? entry.header.trim().replace(/^#\s*/, '') : undefined;
        const lang = entry.isMessage
          ? 'markdown'
          : detectDiffLike(entry.content, path)
            ? 'diff'
            : guessLanguage(path);
        return {
          ...entry,
          html: buildHtml(text, lang),
        };
      });
    })
    .catch((err) => {
      log('shiki init failed', err);
    });
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  connect();
});
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', handlePointerUp);
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
}

.app-output {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
}

.app-input {
  flex: 0 0 auto;
  position: relative;
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

.output-stage {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.output-stack {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  box-sizing: border-box;
}

.canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: hidden;
  z-index: 5;
  --dock-reserved: 0px;
  --tool-top-offset: 0px;
  --tool-area-height: 100%;
  --term-width: 640px;
  --term-height: 372px;
}

.message-dock {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  position: relative;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
}

.follow-button {
  position: sticky;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  width: 36px;
  height: 36px;
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

.follow-button:hover {
  background: rgba(30, 41, 59, 0.98);
}

.thinking-indicator {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid #334155;
  background: rgba(15, 23, 42, 0.92);
  box-shadow: 0 10px 24px rgba(2, 6, 23, 0.45);
  align-self: flex-start;
  margin-top: 4px;
}

.thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #94a3b8;
  animation: thinking-pulse 1.1s ease-in-out infinite;
}

.thinking-dot:nth-child(2) {
  animation-delay: 0.15s;
}

.thinking-dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes thinking-pulse {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.6;
  }
  50% {
    transform: translateY(-2px);
    opacity: 1;
  }
}

.message-entry {
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 8px 10px;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
}

.message-entry.is-user {
  background: rgba(37, 99, 235, 0.18);
  border-color: rgba(59, 130, 246, 0.6);
}

.message-dock .message-inner.is-scrolling {
  animation: none;
}


.term {
  position: absolute;
  font-size: 13px;
  --term-line-height: 1.2;
  --message-line-height: 1.2;
  --term-border-color: #ccc;
  width: var(--term-width);
  height: var(--term-height);
  background: black;
  color: white;
  border: 1px solid #ccc;
  overflow: hidden;
  font-family:
    ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  line-height: var(--term-line-height);
  padding: 0;
  z-index: 12;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

.term.is-message {
  background: #0e0e0e;
  border-color: #4a4a4a;
  --term-border-color: #4a4a4a;
}

.term.is-shell {
  background: #050505;
  border-color: #1f2937;
  --term-border-color: #1f2937;
}

.term.is-permission {
  background: #0b1320;
  border-color: #334155;
  --term-border-color: #334155;
}

.term.is-apply-patch,
.term.is-write {
  background: #0b1610;
  border-color: #34d399;
  --term-border-color: #34d399;
}

.term.is-apply-patch .term-titlebar,
.term.is-write .term-titlebar {
  background: rgba(52, 211, 153, 0.18);
  color: #bbf7d0;
  border-bottom: 1px solid rgba(52, 211, 153, 0.35);
}

.term.is-tasklist {
  background: #0b1120;
  border-color: #334155;
  --term-border-color: #334155;
  color: #e2e8f0;
}

.term-titlebar {
  height: 22px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-size: 12px;
  color: #cbd5f5;
  background: rgba(30, 41, 59, 0.92);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  cursor: grab;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}


.term-titlebar:active {
  cursor: grabbing;
}

.message-inner {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  --message-line-height: 1.2;
  line-height: var(--message-line-height);
}

.message-inner.is-scrolling {
  animation: scroll-down var(--scroll-duration) linear forwards;
}

.term-inner {
  margin: 0;
  white-space: normal;
  line-height: var(--term-line-height);
  padding: 2px;
  flex: 1;
  overflow: hidden;
}

.term.is-reasoning .term-inner {
  overflow: auto;
}

.term.is-shell .term-inner {
  padding: 0;
  overflow: hidden;
}

.term.is-permission .term-inner {
  padding: 8px;
  overflow: auto;
}

.term.is-tasklist .term-inner {
  padding: 8px;
  overflow: auto;
}

.tasklist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tasklist-header {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}

.tasklist-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tasklist-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: #e2e8f0;
}

.tasklist-status {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.18);
  color: #e2e8f0;
  border: 1px solid rgba(148, 163, 184, 0.35);
  white-space: nowrap;
}

.tasklist-item.is-running .tasklist-status {
  background: rgba(16, 185, 129, 0.2);
  color: #6ee7b7;
  border-color: rgba(16, 185, 129, 0.5);
}

.tasklist-item.is-pending .tasklist-status {
  background: rgba(245, 158, 11, 0.2);
  color: #fcd34d;
  border-color: rgba(245, 158, 11, 0.5);
}

.tasklist-text {
  flex: 1;
}

.tasklist-session {
  font-size: 11px;
  color: #94a3b8;
  margin-left: 4px;
  white-space: nowrap;
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

.term :deep(pre.shiki),
.term :deep(code),
.term :deep(.line),
.term :deep(.line)::before {
  line-height: var(--term-line-height) !important;
}


.message-window :deep(pre.shiki),
.message-window :deep(code),
.message-window :deep(.line),
.message-window :deep(.line)::before {
  line-height: var(--message-line-height) !important;
}

.shiki-host :deep(pre),
.shiki-host :deep(code) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  background-color: transparent !important;
  line-height: inherit !important;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}

.shiki-host :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.shiki-host :deep(.line),
.shiki-host :deep(.line)::before {
  line-height: inherit !important;
}

.shiki-host.is-message :deep(pre),
.shiki-host.is-message :deep(code) {
  white-space: pre-wrap;
  word-break: break-word;
}

.shiki-host :deep(pre) {
  counter-reset: shiki-line;
}

.shiki-host :deep(.line) {
  display: block;
  padding-left: 3.2em;
  position: relative;
  min-height: 1em;
  color: inherit;
  white-space: pre;
}

.shiki-host :deep(.line:empty)::after {
  content: ' ';
}

.shiki-host :deep(.line.line-added) {
  background: rgba(46, 160, 67, 0.22);
  box-shadow: inset 3px 0 0 #2ea043;
  color: #aff5b4;
}

.shiki-host :deep(.line.line-removed) {
  background: rgba(248, 81, 73, 0.2);
  box-shadow: inset 3px 0 0 #f85149;
  color: #ffdcd7;
}

.shiki-host :deep(.line.line-hunk) {
  background: rgba(56, 139, 253, 0.18);
  color: #c9d1d9;
}

.shiki-host :deep(.line.line-header) {
  background: rgba(110, 118, 129, 0.18);
  color: #c9d1d9;
}

.shiki-host :deep(.line)::before {
  counter-increment: shiki-line;
  content: counter(shiki-line);
  position: absolute;
  left: 0;
  width: 2.6em;
  text-align: right;
  color: #8a8a8a;
}

.shiki-host.is-message :deep(.line) {
  padding-left: 0;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: var(--message-line-height);
}

.shiki-host.is-message :deep(.line)::before {
  content: '';
}

.term-inner.is-scrolling .shiki-host {
  animation: scroll-down var(--scroll-duration) linear forwards;
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

.fade-enter-active,
.fade-leave-active {
  transition: all 0.15s ease-in;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;

  transform: scaleX(150%) scaleY(0%);
}

.shiki-host {
  line-height: var(--term-line-height);
  color: #c9d1d9;
  display: block;
}

.shiki-host.is-message {
  line-height: var(--message-line-height);
}
</style>
