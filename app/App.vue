<template>
  <div class="app">
    <header class="app-header">
      <TopPanel
        :projects="projects"
        :sessions="filteredSessions"
        v-model:selected-project-id="selectedProjectId"
        v-model:selected-session-id="selectedSessionId"
        @new-project="openProjectPicker"
        @new-session="createNewSession"
      />
    </header>
    <main class="app-output">
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
            @scroll="handleMessageDockScroll"
            @wheel="handleMessageDockWheel"
            @touchmove="handleMessageDockScroll"
            @resume-follow="resumeFollow"
          />
          <div ref="canvasEl" class="canvas">
            <TransitionGroup appear name="fade">
              <div
                v-for="q in queue.filter((entry) => !entry.isMessage || entry.isSubagentMessage)"
                :key="q.callId ?? q.messageId ?? q.time"
                class="term"
                :data-tool-key="q.toolKey ?? q.callId ?? undefined"
                :data-message-key="q.messageId ? buildMessageKey(q.messageId, q.sessionId) : undefined"
                :class="{
                  'is-write': q.isWrite,
                  'is-message': q.isSubagentMessage,
                  'is-apply-patch': q.toolName === 'apply_patch',
                  'is-reasoning': q.isReasoning,
                }"
                :style="{
                  left: `calc(${q.x} * (100% - var(--term-width)))`,
                  top: `calc(var(--tool-top-offset) + ${q.y} * (var(--tool-area-height) - var(--term-height)))`,
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
                >
                  <div
                    class="shiki-host"
                    :class="{ 'is-message': q.isSubagentMessage }"
                    v-html="q.html"
                  ></div>
                </div>
              </div>
            </TransitionGroup>
          </div>
        </div>
      </div>
    </main>
    <footer class="app-input">
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
        :commands="commands"
        v-model:message-input="messageInput"
        v-model:selected-mode="selectedMode"
        v-model:selected-model="selectedModel"
        v-model:selected-thinking="selectedThinking"
        @send="sendMessage"
        @abort="abortSession"
      />
    </footer>
    <ProjectPicker
      :open="isProjectPickerOpen"
      :base-url="OPENCODE_BASE_URL"
      :initial-directory="activeDirectory"
      @close="isProjectPickerOpen = false"
      @select="handleProjectDirectorySelect"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onMounted, shallowRef, onBeforeUnmount, ref, watch } from 'vue';
import { bundledLanguages, bundledThemes, createHighlighter } from 'shiki/bundle/web';
import ControlPanel from './ControlPanel.vue';
import TopPanel from './TopPanel.vue';
import OutputDock from './OutputDock.vue';
import ProjectPicker from './ProjectPicker.vue';

const OPENCODE_BASE_URL = 'http://localhost:4096';
const HISTORY_LIMIT = 60;
const FOLLOW_THRESHOLD_PX = 24;
const TOOL_PENDING_TTL_MS = 60_000;
const TOOL_RUNNING_TTL_MS = 5_000;
const REASONING_TTL_MS = 10_000;
const TOOL_SCROLL_SPEED_PX_S = 2000;
const TOOL_SCROLL_HOLD_MS = 250;
const SUBAGENT_ACTIVE_TTL_MS = 60 * 60 * 1000;
const SUBAGENT_IDLE_TTL_MS = 30_000;
const MAIN_REASONING_TITLES = ['Reasoning...', 'Thinking...', 'Working...'];
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
  isWrite: boolean;
  isMessage: boolean;
  isSubagentMessage?: boolean;
  isReasoning?: boolean;
  sessionId?: string;
  toolKey?: string;
  role?: 'user' | 'assistant';
  toolStatus?: string;
  toolName?: string;
  messageId?: string;
  callId?: string;
};

const queue = ref<FileReadEntry[]>([]);
const canvasEl = ref<HTMLDivElement | null>(null);
const outputDock = ref<{ dockEl: HTMLDivElement | null } | null>(null);
const isFollowing = ref(true);
const runningToolIds = new Set<string>();
const subagentSessionExpiry = new Map<string, number>();
const messageSummaryTitleById = new Map<string, string>();
const reasoningTitleBySessionId = new Map<string, string>();
const sessionStatusById = new Map<string, 'busy' | 'idle'>();
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
const selectedSessionStatus = ref<'busy' | 'idle' | ''>('');
const messageIndexById = new Map<string, number>();
const toolIndexByCallId = new Map<string, number>();
const userMessageIds = new Set<string>();
const messageContentById = new Map<string, string>();
const messagePartsById = new Map<string, Map<string, string>>();
const messagePartOrderById = new Map<string, string[]>();
const recentUserInputs: { text: string; time: number }[] = [];

type ProjectInfo = {
  id: string;
  worktree?: string;
};

type SessionInfo = {
  id: string;
  projectID?: string;
  parentID?: string;
  title?: string;
  slug?: string;
  directory?: string;
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
const sessions = ref<SessionInfo[]>([]);
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
const selectedSessionId = ref('');
const selectedDirectory = ref('');
const isProjectPickerOpen = ref(false);
const selectedMode = ref('build');
const selectedModel = ref('');
const selectedThinking = ref('');
const projectError = ref('');
const sessionError = ref('');
const messageInput = ref('');
const sendStatus = ref('Ready');
const isSending = ref(false);
const isAborting = ref(false);

const statusText = computed(
  () => projectError.value || sessionError.value || sendStatus.value,
);
const isStatusError = computed(() => Boolean(projectError.value || sessionError.value));

const filteredSessions = computed(() =>
  sessions.value.filter(
    (session) => session.projectID === selectedProjectId.value && !session.parentID,
  ),
);

const activeProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value),
);
const activeDirectory = computed(() =>
  selectedDirectory.value || activeProject.value?.worktree || '',
);

const allowedSessionIds = computed(() => {
  const rootId = selectedSessionId.value;
  if (!rootId) return new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  sessions.value.forEach((session) => {
    if (!session.parentID) return;
    const bucket = childrenByParent.get(session.parentID) ?? [];
    bucket.push(session.id);
    childrenByParent.set(session.parentID, bucket);
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
  Boolean(selectedSessionId.value && messageInput.value.trim().length > 0 && !isSending.value),
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

function projectLabel(project: ProjectInfo) {
  if (project.id === 'global') return 'global /';
  if (project.worktree) return project.worktree;
  return project.id;
}

function sessionLabel(session: SessionInfo) {
  const base = session.title || session.slug || session.id;
  return `${base} (${session.id.slice(0, 6)})`;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildMessageKey(messageId: string, sessionId?: string) {
  return `${sessionId ?? 'root'}:${messageId}`;
}

function clamp(value: number, min: number, max: number) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function getSessionTitle(sessionId?: string) {
  if (!sessionId) return undefined;
  const session = sessions.value.find((item) => item.id === sessionId);
  return session?.title || session?.slug || session?.id;
}

function mergeReasoningContent(prior: string, incoming: string) {
  if (!incoming) return prior;
  if (!prior) return incoming;
  if (incoming.startsWith(prior)) return incoming;
  if (prior.includes(incoming)) return prior;
  const maxCheck = Math.min(prior.length, incoming.length);
  let overlap = 0;
  for (let size = 1; size <= maxCheck; size += 1) {
    if (prior.endsWith(incoming.slice(0, size))) overlap = size;
  }
  const needsSeparator = overlap === 0 && !prior.endsWith('\n');
  const separator = needsSeparator ? '\n\n' : '';
  return `${prior}${separator}${incoming.slice(overlap)}`;
}

function randomMainReasoningTitle() {
  return MAIN_REASONING_TITLES[Math.floor(Math.random() * MAIN_REASONING_TITLES.length)];
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
  if (entry.toolName === 'read' && entry.path) return entry.path;
  if (entry.toolName) return entry.toolName;
  if (entry.path) return entry.path;
  if (entry.header) {
    const cleaned = entry.header.trim().replace(/^#\s*/, '').trim();
    if (cleaned) return cleaned;
  }
  return 'tool';
}

function getSubagentExpiry(sessionId?: string) {
  const now = Date.now();
  if (!sessionId) return now + SUBAGENT_ACTIVE_TTL_MS;
  return subagentSessionExpiry.get(sessionId) ?? now + SUBAGENT_ACTIVE_TTL_MS;
}

function updateSubagentExpiry(sessionId: string, status: 'busy' | 'idle') {
  const now = Date.now();
  const expiresAt = now + (status === 'idle' ? SUBAGENT_IDLE_TTL_MS : SUBAGENT_ACTIVE_TTL_MS);
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
  const now = Date.now();
  const nextExpiresAt = status === 'busy' ? Number.MAX_SAFE_INTEGER : now + REASONING_TTL_MS;
  queue.value.forEach((entry) => {
    if (!entry.isReasoning) return;
    const matchesSession =
      entry.sessionId === targetSessionId ||
      (!entry.sessionId && targetSessionId === selectedSessionId.value);
    if (!matchesSession) return;
    entry.expiresAt = nextExpiresAt;
  });
}

function startTermDrag(entry: FileReadEntry, event: PointerEvent) {
  if (event.button !== 0) return;
  const canvas = canvasEl.value;
  if (!canvas) return;
  const termEl = (event.currentTarget as HTMLElement).closest('.term') as HTMLElement | null;
  const canvasRect = canvas.getBoundingClientRect();
  const termRect = termEl?.getBoundingClientRect();
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
  const termWidth =
    Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : (termRect?.width ?? 640);
  const termHeight =
    Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : (termRect?.height ?? 350);
  const maxX = Math.max(1, canvasRect.width - termWidth);
  const maxY = Math.max(1, toolAreaHeight - termHeight);
  const startLeft = entry.x * maxX;
  const startTop = toolTop + entry.y * maxY;
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

function handlePointerMove(event: PointerEvent) {
  if (!dragState.value) return;
  const { entry, startX, startY, startLeft, startTop, maxX, maxY, toolTop } = dragState.value;
  const dx = event.clientX - startX;
  const dy = event.clientY - startY;
  const nextLeft = clamp(startLeft + dx, 0, maxX);
  const nextTop = clamp(startTop + dy, toolTop, toolTop + maxY);
  entry.x = maxX > 0 ? nextLeft / maxX : 0;
  entry.y = maxY > 0 ? (nextTop - toolTop) / maxY : 0;
}

function handlePointerUp() {
  dragState.value = null;
}

function scheduleReasoningScroll(messageKey: string) {
  nextTick(() => {
    requestAnimationFrame(() => {
      const canvas = canvasEl.value;
      if (!canvas) return;
      const term = canvas.querySelector(
        `[data-message-key="${messageKey}"] .term-inner`,
      ) as HTMLElement | null;
      if (!term) return;
      term.scrollTop = Math.max(0, term.scrollHeight - term.clientHeight);
    });
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
        const duration = distance / TOOL_SCROLL_SPEED_PX_S;
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

async function fetchCurrentProject(directory: string) {
  if (!directory) return null;
  try {
    const params = new URLSearchParams({ directory });
    const response = await fetch(`${OPENCODE_BASE_URL}/project/current?${params.toString()}`);
    if (!response.ok) return null;
    const data = (await response.json()) as ProjectInfo;
    return data && typeof data.id === 'string' ? data : null;
  } catch {
    return null;
  }
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
    sessions.value = Array.isArray(data) ? data : [];
  } catch (error) {
    const message = `Session load failed: ${toErrorMessage(error)}`;
    sessionError.value = message;
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
      const existing = sessions.value.find((session) => session.id === data.id);
      if (!existing) sessions.value.unshift(data);
      selectedSessionId.value = data.id;
      if (data.projectID) selectedProjectId.value = data.projectID;
      if (data.directory) selectedDirectory.value = data.directory;
    }
    void fetchSessions({ directory: activeDirectory.value || undefined, roots: true, limit: 200 });
  } catch (error) {
    sessionError.value = `Session create failed: ${toErrorMessage(error)}`;
  }
}

async function handleProjectDirectorySelect(directory: string) {
  isProjectPickerOpen.value = false;
  if (!directory) return;
  selectedDirectory.value = directory;
  await fetchProjects(directory);
  if (projects.value.length === 0) {
    const current = await fetchCurrentProject(directory);
    if (current) projects.value = [current];
  }
  if (projects.value.length > 0) {
    const match = projects.value.find((project) => project.worktree === directory);
    selectedProjectId.value = match?.id ?? projects.value[0]?.id ?? '';
  }
  void fetchSessions({ directory, roots: true, limit: 200 });
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

async function fetchHistory(sessionId: string, isSubagentMessage = false) {
  if (!sessionId) return;
  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}/message`);
    if (!response.ok) throw new Error(`History request failed (${response.status})`);
    const data = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return;
    const history = data
      .map((message) => {
        const info = message.info as Record<string, unknown> | undefined;
        const parts = message.parts as unknown;
        const text = extractMessageTextFromParts(parts) ?? '';
        if (!text.trim()) return null;
        const id = typeof info?.id === 'string' ? info.id : undefined;
        const role = typeof info?.role === 'string' ? info.role : undefined;
        if (!id) return null;
        return { id, role, text };
      })
      .filter((entry): entry is { id: string; role?: string; text: string } => Boolean(entry));

    history.slice(-HISTORY_LIMIT).forEach((entry) => {
      const messageKey = buildMessageKey(entry.id, sessionId);
      if (messageIndexById.has(messageKey)) return;
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
      queue.value.push({
        time,
        expiresAt,
        x: isSubagentMessage ? Math.random() : 0,
        y: isSubagentMessage ? Math.random() : 0,
        header,
        content: entry.text,
        role: entry.role === 'user' ? 'user' : 'assistant',
        scroll: overflowLines > 0,
        scrollDistance,
        scrollDuration,
        html,
        isWrite: false,
        isMessage: true,
        isSubagentMessage,
        messageId: entry.id,
        sessionId,
      });
      messageIndexById.set(messageKey, queue.value.length - 1);
      messageContentById.set(messageKey, entry.text);
    });
    if (!isSubagentMessage) scheduleFollowScroll();
  } catch (error) {
    log('History load failed', error);
  }
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
  const sessionId = selectedSessionId.value;
  if (!text || !sessionId) return;
  const slash = parseSlashCommand(text);
  const commandMatch = slash ? findCommandByName(slash.name) : null;
  const selectedInfo = modelOptions.value.find((model) => model.id === selectedModel.value);
  recentUserInputs.push({ text, time: Date.now() });
  while (recentUserInputs.length > 20) recentUserInputs.shift();
  messageInput.value = '';
  isSending.value = true;
  sendStatus.value = 'Sending...';
  try {
    if (slash && commandMatch) {
      await sendCommand(sessionId, commandMatch, slash.arguments ?? '');
      sendStatus.value = 'Sent.';
      return;
    }
    const response = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}/message`, {
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
        parts: [{ type: 'text', text }],
      }),
    });
    if (!response.ok) throw new Error(`Send failed (${response.status})`);
    sendStatus.value = 'Sent.';
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
    const response = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}/abort`, {
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
  [selectedProjectId, projects],
  () => {
    if (selectedDirectory.value) return;
    const project = projects.value.find((item) => item.id === selectedProjectId.value);
    if (project?.worktree) selectedDirectory.value = project.worktree;
  },
  { immediate: true },
);

watch(
  [filteredSessions, selectedProjectId],
  () => {
    if (!selectedProjectId.value) return;
    const isValid = filteredSessions.value.some(
      (session) => session.id === selectedSessionId.value,
    );
    if (!isValid) {
      selectedSessionId.value = filteredSessions.value[0]?.id ?? '';
    }
  },
  { immediate: true },
);

watch(selectedSessionId, () => {
  queue.value = [];
  messageIndexById.clear();
  toolIndexByCallId.clear();
  messageContentById.clear();
  messagePartsById.clear();
  messagePartOrderById.clear();
  messageSummaryTitleById.clear();
  reasoningTitleBySessionId.clear();
  subagentSessionExpiry.clear();
  selectedSessionStatus.value = '';
  if (selectedSessionId.value) {
    void fetchHistory(selectedSessionId.value);
  }
});

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
  void fetchCommands(directory || undefined);
});

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

function isSessionCreateEvent(type?: string) {
  if (!type) return false;
  const normalized = normalizeEventType(type);
  return normalized === 'sessioncreated' || normalized === 'sessioncreate';
}

function isSessionUpdateEvent(type?: string) {
  if (!type) return false;
  const normalized = normalizeEventType(type);
  return normalized === 'sessionupdated' || normalized === 'sessionupdate';
}

function shouldReloadSessionsForCreatedEvent(
  eventType: string,
  sessionInfo: SessionInfo,
  activeDirectory: string,
  selectedProjectId: string,
) {
  if (!isSessionCreateEvent(eventType)) return false;
  if (sessionInfo.parentID) return false;
  if (selectedProjectId && sessionInfo.projectID && sessionInfo.projectID !== selectedProjectId) {
    return false;
  }
  if (activeDirectory && sessionInfo.directory && sessionInfo.directory !== activeDirectory) {
    return false;
  }
  return true;
}

function shouldUpsertSessionFromUpdateEvent(
  eventType: string,
  sessionInfo: SessionInfo,
  activeDirectory: string,
  selectedProjectId: string,
) {
  if (!isSessionUpdateEvent(eventType)) return false;
  if (sessionInfo.parentID) return false;
  if (selectedProjectId && sessionInfo.projectID && sessionInfo.projectID !== selectedProjectId) {
    return false;
  }
  if (activeDirectory && sessionInfo.directory && sessionInfo.directory !== activeDirectory) {
    return false;
  }
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
  const part =
    properties?.part && typeof properties.part === 'object'
      ? (properties.part as Record<string, unknown>)
      : undefined;

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
    const blocks: string[] = [];
    const inputText = formatToolValue(input ?? {});
    blocks.push('input:');
    blocks.push(inputText);

    if (output !== undefined) {
      let outputText: string | undefined;
      if (typeof output === 'string') {
        outputText = output;
      } else if (output && typeof output === 'object') {
        const outputRecord = output as Record<string, unknown>;
        const outputContent =
          (outputRecord.content as string | undefined) ??
          (outputRecord.text as string | undefined) ??
          (outputRecord.body as string | undefined) ??
          (outputRecord.result as string | undefined);
        if (typeof outputContent === 'string') outputText = outputContent;
      }
      if (!outputText) outputText = formatToolValue(output);
      if (tool === 'read' && typeof outputText === 'string') {
        const body = extractFileBodyFromReadOutput(outputText);
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
      blocks.push(outputText);
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

  return { id, messageId, content: message, role: resolvedRole, partId, partType };
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
  return statusType ? { status: statusType } : null;
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

  if (id && role === 'user') {
    userMessageIds.add(id);
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

function upsertToolEntry(
  entry: {
    content: string;
    path?: string;
    isWrite: boolean;
    callId?: string;
    toolStatus?: string;
    toolName?: string;
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
      queue.value.splice(existingIndex, 1);
      toolIndexByCallId.delete(entry.callId!);
    }
    return;
  }
  if (entry.toolName === 'read' && entry.toolStatus && entry.toolStatus !== 'completed') {
    return;
  }
  const header = entry.path
    ? `# ${entry.path}\n\n`
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
  const toolTtlMs = isToolPending ? TOOL_PENDING_TTL_MS : isToolRunning ? TOOL_RUNNING_TTL_MS : 0;
  const expiresAt = toolTtlMs > 0 ? time + toolTtlMs : defaultExpiry;
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
        const nextExpiresAt = toolTtlMs > 0 ? time + toolTtlMs : defaultExpiry;
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
        });
        toolIndexByCallId.set(entry.callId, existingIndex);
        scheduleToolScrollAnimation(toolKey);
        return;
      }
    }
  }

  const toolKey = entry.callId ?? `${entry.path ?? entry.toolName ?? 'tool'}:${time}`;
  queue.value.push({
    time,
    expiresAt,
    x: Math.random(),
    y: Math.random(),
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

const src = shallowRef<EventSource>();
function connect() {
  if (src.value) return;

  log('connecting...');
  src.value = new EventSource(`${OPENCODE_BASE_URL}/event`);

  src.value.addEventListener('open', (e) => {
    log('connected.');
  });
  const handleEvent = (e: MessageEvent) => {
    const payload = parsePayload(e.data);
    const payloadText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    log(payloadText);

    const resolvedEventType = resolveEventType(payload, e.type);

    const sessionInfo = extractSessionInfo(payload, resolvedEventType);
    if (sessionInfo) {
      const isSelected = sessionInfo.id === selectedSessionId.value;
      const isChild = sessionInfo.parentID && allowedSessionIds.value.has(sessionInfo.parentID);
      const shouldUpsertFromUpdate = shouldUpsertSessionFromUpdateEvent(
        resolvedEventType,
        sessionInfo,
        activeDirectory.value,
        selectedProjectId.value,
      );
      if (isSelected || isChild || shouldUpsertFromUpdate) {
        upsertSessionFromEvent(sessionInfo);
        if (sessionInfo.parentID) {
          subagentSessionExpiry.set(sessionInfo.id, Date.now() + SUBAGENT_ACTIVE_TTL_MS);
        }
      }
      if (
        shouldReloadSessionsForCreatedEvent(
          resolvedEventType,
          sessionInfo,
          activeDirectory.value,
          selectedProjectId.value,
        )
      ) {
        void fetchSessions({
          directory: activeDirectory.value || undefined,
          roots: true,
          limit: 200,
        });
      }
    }

    const sessionId = extractSessionId(payload);
    if (sessionId && selectedSessionId.value && !allowedSessionIds.value.has(sessionId)) return;

    const sessionStatus = extractSessionStatus(payload, resolvedEventType);
    if (sessionStatus) {
      if (sessionStatus.status === 'busy' || sessionStatus.status === 'idle') {
        const nextStatus = sessionStatus.status as 'busy' | 'idle';
        if (sessionId) sessionStatusById.set(sessionId, nextStatus);
        if (!selectedSessionId.value || sessionId === selectedSessionId.value) {
          selectedSessionStatus.value = nextStatus;
          updateReasoningExpiry(sessionId ?? selectedSessionId.value, nextStatus);
        } else if (sessionId) {
          updateSubagentExpiry(sessionId, nextStatus);
          updateReasoningExpiry(sessionId, nextStatus);
        }
      }
    }

    registerMessageMeta(payload);
    registerMessageSummary(payload);

    const patchEvent = extractPatch(payload);
    if (patchEvent) {
      upsertToolEntry(patchEvent, e.type, 'diff');
      return;
    }

    const fileRead = extractFileRead(payload, resolvedEventType);
    if (!fileRead) {
      const message = extractMessage(payload, resolvedEventType);
      if (!message) return;
      const isReasoning = message.partType === 'reasoning';
      const reasoningKey = sessionId ?? selectedSessionId.value ?? 'main';
      const stableMessageId = isReasoning
        ? `reasoning:${reasoningKey}`
        : (message.messageId ?? message.id);
      const messageKey = buildMessageKey(stableMessageId, sessionId);
      const isSubagentMessage =
        isReasoning ||
        Boolean(sessionId && selectedSessionId.value && sessionId !== selectedSessionId.value);
      if (isReasoning) {
        const summaryTitle = message.messageId
          ? messageSummaryTitleById.get(message.messageId)
          : undefined;
        const resolvedSessionId = sessionId ?? selectedSessionId.value ?? undefined;
        const sessionTitle = getSessionTitle(resolvedSessionId);
        const isMain = resolvedSessionId && resolvedSessionId === selectedSessionId.value;
        const existingTitle = resolvedSessionId
          ? reasoningTitleBySessionId.get(resolvedSessionId)
          : undefined;
        const nextTitle =
          existingTitle ??
          (isMain ? randomMainReasoningTitle() : (summaryTitle ?? sessionTitle ?? 'Reasoning'));
        if (resolvedSessionId) reasoningTitleBySessionId.set(resolvedSessionId, nextTitle);
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
      const reasoningStatus = isReasoning
        ? sessionId
          ? sessionStatusById.get(sessionId) ??
            (sessionId === selectedSessionId.value ? selectedSessionStatus.value : undefined)
          : selectedSessionStatus.value
        : undefined;
      const expiresAt = isReasoning
        ? reasoningStatus === 'busy'
          ? Number.MAX_SAFE_INTEGER
          : time + REASONING_TTL_MS
        : isSubagentMessage
          ? getSubagentExpiry(sessionId)
          : time + 1000 * 60 * 30;
      const html = buildHtml(text, 'markdown');

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
          ? mergeReasoningContent(messageContentById.get(messageKey) ?? priorContent, mergedContent)
          : mergedContent;
        if (existing) {
          const nextText = `${header}${nextContent}`;
          const nextLines = countWrappedLines(nextText, messageColumns);
          const nextOverflowLines = Math.max(0, nextLines - visibleLines);
          const nextScrollDistance = Math.max(0, nextOverflowLines * lineHeight);
          const nextScrollDuration =
            nextOverflowLines > 0 ? Math.min(0.25, Math.max(0.08, nextOverflowLines * 0.01)) : 0;
          queue.value.splice(existingIndex, 1, {
            ...existing,
            time,
            expiresAt,
            header,
            content: nextContent,
            role: isUserMessage ? 'user' : existing.role,
            scroll: !isReasoning && nextOverflowLines > 0,
            scrollDistance: isReasoning ? 0 : nextScrollDistance,
            scrollDuration: isReasoning ? 0 : nextScrollDuration,
            html: buildHtml(nextText, 'markdown'),
            isReasoning,
          });
          messageIndexById.set(messageKey, existingIndex);
        }
        messageContentById.set(messageKey, nextContent);
        if (isReasoning) scheduleReasoningScroll(messageKey);
        if (!isSubagentMessage) scheduleFollowScroll();
        return;
      }

      messageContentById.set(messageKey, mergedContent);
      queue.value.push({
        time,
        expiresAt,
        x: isSubagentMessage ? Math.random() : 0,
        y: isSubagentMessage ? Math.random() : 0,
        header,
        content: mergedContent,
        role: isUserMessage ? 'user' : 'assistant',
        scroll: !isReasoning && overflowLines > 0,
        scrollDistance: isReasoning ? 0 : scrollDistance,
        scrollDuration: isReasoning ? 0 : scrollDuration,
        html,
        isWrite: false,
        isMessage: true,
        isSubagentMessage,
        isReasoning,
        messageId: stableMessageId,
        sessionId,
      });
      messageIndexById.set(messageKey, queue.value.length - 1);
      if (isReasoning) scheduleReasoningScroll(messageKey);
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
  fetchProjects();
  fetchSessions();
  fetchProviders();
  fetchAgents();
  fetchCommands(activeDirectory.value || undefined);
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
  font-size: 14px;
  --term-line-height: 1;
  --message-line-height: 1;
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
  --message-line-height: 14px;
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
