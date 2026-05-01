<template>
   <div ref="appEl" class="app">
     <ThemeInjector />
       <template v-if="uiInitState === 'ready'">
       <header class="app-header">
         <TopPanel
           ref="topPanelRef"
           :tree-data="topPanelTreeData"
          :notification-sessions="notificationSessions"
          :project-directory="projectDirectory"
          :active-directory="activeDirectory"
            :selected-session-id="selectedSessionId"
             :home-path="homePath"
             :codex-mode="activeBackendKind === 'codex'"
             :codex-connected="codexApi.connected.value"
             :pty-supported="ptySupported"
          @select-notification="handleNotificationSessionSelect"
          @create-worktree-from="createWorktreeFromWorktree"
          @new-session="createNewSession"
          @new-session-in="handleNewSessionInSandbox"
          @open-shell="openShellFromInput('')"
          @delete-active-directory="deleteWorktree"
          @delete-session="deleteSession"
           @archive-session="archiveSession"
           @unarchive-session="unarchiveSession"
           @rename-session="renameSession"
           @hide-session="hideCodexSession"
           @fork-session="forkCodexSession"
           @rollback-session="rollbackCodexSession"
           @compact-session="compactCodexSession"
           @unsubscribe-session="unsubscribeCodexSession"
           @pin-session="pinSession"
          @unpin-session="unpinSession"
          @pin-project="pinProject"
          @unpin-project="unpinProject"
          @pin-sandbox="(payload) => pinSandbox(payload.projectId, payload.directory)"
          @unpin-sandbox="(payload) => unpinSandbox(payload.projectId, payload.directory)"
          @select-session="handleTopPanelSessionSelect"
          @batch-session-action="handleTopPanelBatchSessionAction"
          @open-directory="openProjectPicker"
          @edit-project="handleEditProject"
    @open-settings="isSettingsOpen = true"
    @open-provider-manager="isProviderManagerOpen = true"
     @open-status-monitor="isStatusMonitorOpen = true"
     @open-codex-panel="openCodexPanel"
     @open-codex-subpanel="openCodexSubpanel"
           @logout="handleLogout"
          @dropdown-closed="focusInput"
        />
      </header>
      <div
        ref="appBodyEl"
        class="app-body"
        :class="{ 'todo-collapsed': sidePanelCollapsed }"
        :style="
          sidePanelWidth !== null
            ? ({ '--todo-panel-width': `${sidePanelWidth}px` } as any)
            : undefined
        "
      >
        <div ref="sidePanelAreaEl" class="side-panel-area">
          <SidePanel
            class="todo-panel"
            :class="{ 'is-disabled': !hasSession }"
            :collapsed="sidePanelCollapsed"
            :active-tab="sidePanelActiveTab"
            :selected-session-id="selectedSessionId"
            :todo-sessions="todoPanelSessions"
            :session-tree-data="sessionTreeData"
            :session-tree-expanded-paths="sessionTreeExpandedPaths"
            :tree-nodes="treeNodes"
            :expanded-tree-paths="expandedTreePaths"
            :selected-tree-path="selectedTreePath"
            :tree-loading="treeLoading"
            :tree-error="treeError"
            :tree-status-by-path="gitStatusByPath"
            :tree-branch-info="gitStatus?.branch"
            :tree-diff-stats="gitStatus?.diffStats"
            :tree-directory-name="treeDirectoryName"
            :tree-branch-entries="branchEntries"
            :tree-branch-list-loading="branchListLoading"
            :run-shell-command="runTreeShellCommand"
            :ensure-branch-entries-loaded="ensureBranchEntriesLoaded"
            @toggle-collapse="toggleSidePanelCollapsed"
            @change-tab="setSidePanelTab"
            @select-session="handleSidePanelSessionSelect"
            @toggle-expand="toggleSessionTreeExpand"
            @pin-project="pinProject"
            @unpin-project="unpinProject"
            @pin-sandbox="(payload) => pinSandbox(payload.projectId, payload.directory)"
            @unpin-sandbox="(payload) => unpinSandbox(payload.projectId, payload.directory)"
            @pin-session="handleSidePanelPinSession"
            @unpin-session="handleSidePanelUnpinSession"
            @toggle-dir="toggleTreeDirectory"
            @select-file="selectTreeFile"
            @open-diff="openGitDiff"
            @open-diff-all="handleOpenDiffAll"
            @open-file="openFileViewer"
            @reload="handleReloadSidebar"
          />
          <div
            v-if="!sidePanelCollapsed"
            class="side-resizer"
            @pointerdown="startSidePanelResize"
          ></div>
        </div>
        <div class="app-main-column">
          <main ref="outputEl" class="app-output">
            <div class="output-workspace">
              <div class="tool-window-layer">
                <div class="output-split">
                  <OutputPanel
                    ref="outputPanelRef"
                    :key="selectedSessionId"
                    class="output-panel"
                    :project-name="currentProjectName"
                    :project-color="currentProjectColor"
                    :current-session-id="selectedSessionId"
                    :session-history-meta-by-id="sessionHistoryMetaById"
                    :is-following="isFollowing"
                    :status-text="statusText"
                    :is-status-error="isStatusError"
                    :is-thinking="isThinking"
                    :is-retry-status="!!retryStatus"
                    :busy-descendant-count="busyDescendantSessionIds.length"
                    :theme="shikiTheme"
                    :resolve-agent-color="resolveAgentColorForName"
                    :resolve-model-meta="resolveModelMetaForPath"
                    :compute-context-percent="computeContextPercent"
                    :session-revert="sessionRevert"
                    :is-loading="isLoadingHistory"
                    :is-anchoring="isOutputAnchoring"
                    @message-rendered="handleOutputPanelMessageRendered"
                    @resume-follow="handleOutputPanelResumeFollow"
                    @fork-message="handleForkMessage"
                    @revert-message="handleRevertMessage"
                    @undo-revert="handleUndoRevert"
                    @show-message-diff="handleShowMessageDiff"
                    @show-commit="handleShowCommit"
                    @show-thread-history="handleShowThreadHistory"
                    @edit-message="handleEditMessage"
                    @open-image="handleOpenImage"
                    @open-file="openFileViewer"
                    @content-resized="handleOutputPanelContentResized"
                  />
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
              :current-session-id="selectedSessionId"
              :can-send="canSend"
              :agent-options="agentOptions"
              :subagent-options="subagentOptions"
              :has-agent-options="hasAgentOptions"
              :agent-color="currentAgentColor"
              :resolve-agent-color="resolveAgentColorForName"
              :model-options="availableModelOptions"
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
              @apply-history-entry="handleApplyHistoryEntry"
              @send="sendMessage"
              @abort="abortSession"
              @add-attachments="handleAddAttachments"
              @remove-attachment="removeAttachment"
              @open-image="handleOpenImage"
            />
          </footer>
        </div>
        <div ref="toolWindowCanvasEl" class="tool-window-canvas">
          <TransitionGroup appear name="scale">
            <FloatingWindow
              v-for="entry in fw.entries.value"
              :key="entry.key"
              :entry="entry"
              :manager="fw"
              @focus="fw.bringToFront(entry.key)"
              @minimize="handleFloatingWindowMinimize(entry.key)"
              @close="handleFloatingWindowClose(entry.key)"
              @open="handleFloatingWindowOpen(entry.key)"
            />
          </TransitionGroup>
        </div>
      </div>
      <footer v-if="showDockPanel" class="app-dock-panel" role="toolbar">
        <div class="window-dock-tray">
          <button
            v-for="entry in minimizedEntries"
            :key="`dock-${entry.key}`"
            type="button"
            class="window-dock-chip"
            :title="$t('app.dock.restoreTitle', { title: entry.title || $t('app.dock.restoreFallbackWindow') })"
            @click="restoreFloatingWindow(entry.key)"
          >
            <span class="window-dock-chip-title">{{ entry.title || entry.key }}</span>
          </button>
        </div>
       </footer>
      </template>
    <div v-else class="app-loading-view" role="status" aria-live="polite">
      <div class="app-loading-card">
        <div class="absolute w-0 h-0 -z-10 flex items-center justify-center">
          <div class="flex fixed flex-col items-center w-96 h-40 translate-x-1/2 -translate-y-1/2">
            <div class="mb-4">
              <svg
                width="24mm"
                height="12mm"
                version="1.1"
                viewBox="0 0 24 12"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="m12.342 2.4512v3.328l1.3352 1.3352v3.9658l-0.67757 0.67756h-1.2953l-0.67757-0.67756v-8.629zm0-1.0562h-1.3153l-0.23914-0.23914v-0.91671l0.23914-0.23914h1.3153l0.23914 0.23914v0.91671zm10.602 9.6852-0.67756 0.67756h-6.6162l-0.67756-0.67756v-1.9928h1.3352v1.3352h2.6305v-2.6505h-3.2882l-0.67756-0.67756v-3.9658l0.67756-0.67757h6.6162l0.67756 0.67757v1.9729h-1.3153v-1.3153h-3.9857v2.6505h4.6234l0.67756 0.67757z"
                  fill="#ffffff"
                />
                <path
                  d="m1 0 5.4506 6-5.4506 6h3.6337l4.851-5.34v-1.32l-4.851-5.34z"
                  fill="#60a5fa"
                />
              </svg>
            </div>
            <div class="app-loading-brand">
              <span class="app-loading-brand-accent">V</span>{{ $t('app.brand.title').slice(1) }}
            </div>
          </div>
        </div>
        <div v-if="uiInitState === 'login'" class="app-login-form">
          <p class="app-loading-title">{{ loginTitle }}</p>
          <div class="app-login-backends" role="group" :aria-label="t('app.login.backendLabel')">
            <button
              type="button"
              class="app-login-backend"
              :class="{ active: loginBackendKind === 'opencode' }"
              @click="loginBackendKind = 'opencode'"
            >
              {{ t('app.login.openCodeBackend') }}
            </button>
            <button
              type="button"
              class="app-login-backend"
              :class="{ active: loginBackendKind === 'codex' }"
              @click="loginBackendKind = 'codex'"
            >
              {{ t('app.login.codexBackend') }}
            </button>
          </div>
          <div class="app-login-fields">
            <template v-if="loginBackendKind === 'opencode'">
              <input
              v-model="loginUsername"
              type="text"
              class="app-login-input"
              :placeholder="t('app.login.username')"
              name="username"
              :disabled="!loginRequiresAuth"
              @keydown.enter="handleLogin"
            />
              <input
              v-model="loginPassword"
              type="password"
              class="app-login-input"
              :placeholder="t('app.login.password')"
              :disabled="!loginRequiresAuth"
              @keydown.enter="handleLogin"
            />
              <label class="app-login-checkbox">
              <input v-model="loginRequiresAuth" type="checkbox" />
              {{ t('app.login.authRequired') }}
              </label>
              <input
              v-model="loginUrl"
              type="text"
              class="app-login-input"
              :placeholder="$t('app.login.url')"
              name="url"
              @keydown.enter="handleLogin"
            />
            </template>
            <template v-else>
              <input
                v-model="loginCodexBridgeUrl"
                type="text"
                class="app-login-input"
                :placeholder="t('app.login.codexBridgeUrl')"
                name="codexBridgeUrl"
                @keydown.enter="handleLogin"
              />
              <input
                v-model="loginCodexBridgeToken"
                type="password"
                class="app-login-input"
                :placeholder="t('app.login.codexBridgeToken')"
                name="codexBridgeToken"
                @keydown.enter="handleLogin"
              />
              <p class="app-login-hint">{{ t('app.login.codexBridgeHint') }}</p>
            </template>
          </div>
          <p v-if="initErrorMessage" class="app-loading-message app-error-message">
            {{ initErrorMessage }}
          </p>
          <button type="button" class="app-loading-retry app-loading-connect" @click="handleLogin">
            {{ t('app.login.connect') }}
          </button>

          <Welcome :theme="shikiTheme" class="mt-8" />
        </div>
        <div v-else>
          <div class="app-loading-spinner" aria-hidden="true"></div>
          <p class="app-loading-title">{{ t('app.loading') }}</p>
          <p class="app-loading-message">
            {{ uiInitState === 'error' ? initErrorMessage : initLoadingMessage }}
          </p>
          <div class="app-loading-actions">
            <button
              v-if="uiInitState === 'error'"
              type="button"
              class="app-loading-retry"
              @click="startInitialization"
            >
              {{ t('app.login.retry') }}
            </button>
            <button
              v-if="uiInitState === 'loading' && connectionState === 'connecting'"
              type="button"
              class="app-loading-retry app-loading-abort"
              @click="handleAbortInit"
            >
              {{ t('app.login.abort') }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <ProjectPicker
      :open="isProjectPickerOpen"
      :home-path="projectPickerHomePath"
      @close="isProjectPickerOpen = false"
      @select="handleProjectDirectorySelect"
    />
    <SettingsModal :open="isSettingsOpen" @close="isSettingsOpen = false" />
    <ProviderManagerModal
      :open="isProviderManagerOpen"
      :providers="providers"
      :connected-provider-ids="connectedProviderIds"
      :selected-model="selectedModel"
      :hidden-models="hiddenModels"
      :provider-config="providerConfig"
      @close="isProviderManagerOpen = false"
      @update:model-visibility="handleModelVisibilityUpdate"
      @config-updated="handleProviderConfigUpdated"
      @providers-changed="handleProvidersChanged"
    />
    <StatusMonitorModal
      :open="isStatusMonitorOpen"
      :session-id="selectedSessionId"
      :codex-api="codexApi"
      @close="isStatusMonitorOpen = false"
    />
    <ProjectSettingsDialog
      :open="!!editingProject"
      :project-id="editingProject?.projectId ?? ''"
      :worktree="editingProject?.worktree ?? ''"
      :name="editingProjectMeta?.name"
      :icon-color="editingProjectMeta?.icon?.color"
      :icon-override="editingProjectMeta?.icon?.override"
      :commands-start="editingProjectMeta?.commands?.start"
      @close="editingProject = null"
      @save="handleSaveProject"
    />
    <dialog
      ref="promptDialogRef"
      class="prompt-dialog-backdrop"
      @close="handlePromptClose"
      @cancel.prevent
      @click.self="promptDialogRef?.close()"
    >
      <div class="prompt-dialog">
        <div class="prompt-dialog-title">{{ promptTitle }}</div>
        <input
          ref="promptInputRef"
          v-model="promptValue"
          type="text"
          class="prompt-dialog-input"
          @keydown.enter.prevent="handlePromptConfirm"
          @keydown.esc.prevent="promptDialogRef?.close()"
        />
        <div class="prompt-dialog-actions">
          <button type="button" class="prompt-dialog-btn prompt-dialog-btn-cancel" @click="promptDialogRef?.close()">
            {{ t('app.prompt.cancel') }}
          </button>
          <button type="button" class="prompt-dialog-btn prompt-dialog-btn-confirm" @click="handlePromptConfirm">
            {{ t('app.prompt.confirm') }}
          </button>
        </div>
      </div>
    </dialog>
    <dialog
      ref="confirmDialogRef"
      class="confirm-dialog-backdrop"
      @close="handleConfirmClose"
      @cancel.prevent
      @click.self="confirmDialogRef?.close()"
    >
      <div class="confirm-dialog">
        <div class="confirm-dialog-message">{{ confirmMessage }}</div>
        <div class="confirm-dialog-actions">
          <button type="button" class="confirm-dialog-btn confirm-dialog-btn-cancel" @click="confirmDialogRef?.close()">
            {{ t('app.prompt.cancel') }}
          </button>
          <button type="button" class="confirm-dialog-btn confirm-dialog-btn-confirm" @click="handleConfirmAccept">
            {{ t('app.prompt.confirm') }}
          </button>
        </div>
      </div>
    </dialog>
  </div>
</template>

<script lang="ts" setup>
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  type Component,
  watch,
  watchEffect,
} from 'vue';
import { useI18n } from 'vue-i18n';
import { bundledThemes } from 'shiki/bundle/web';
import InputPanel from './components/InputPanel.vue';
import OutputPanel from './components/OutputPanel.vue';
import ProjectPicker from './components/ProjectPicker.vue';
import FloatingWindow from './components/FloatingWindow.vue';
import GlobContent from './components/ToolWindow/Glob.vue';
import GrepContent from './components/ToolWindow/Grep.vue';
import ReasoningContent from './components/ToolWindow/Reasoning.vue';
import ThreadHistoryContent from './components/ThreadHistoryContent.vue';
import SubagentContent from './components/ToolWindow/Subagent.vue';
import WebContent from './components/ToolWindow/Web.vue';
import SidePanel from './components/SidePanel.vue';
import Welcome from './components/Welcome.vue';
import TopPanel, {
  type TopPanelBatchSessionActionPayload,
  type TopPanelBatchSessionTarget,
  type TopPanelCodexSubpanel,
  type TopPanelNotificationSession,
  type TopPanelWorktree,
} from './components/TopPanel.vue';
import ProviderManagerModal from './components/ProviderManagerModal.vue';
import SettingsModal from './components/SettingsModal.vue';
import StatusMonitorModal from './components/StatusMonitorModal.vue';
import ProjectSettingsDialog from './components/ProjectSettingsDialog.vue';
import ThemeInjector from './components/ThemeInjector.vue';
import CodexPanel from './components/CodexPanel.vue';
import CodexAppManager from './components/codex/CodexAppManager.vue';
import CodexCollaborationModeManager from './components/codex/CodexCollaborationModeManager.vue';
import CodexConfigViewer from './components/codex/CodexConfigViewer.vue';
import CodexExperimentalFeatureManager from './components/codex/CodexExperimentalFeatureManager.vue';
import CodexExternalAgentConfig from './components/codex/CodexExternalAgentConfig.vue';
import CodexFeedbackUploader from './components/codex/CodexFeedbackUploader.vue';
import CodexMcpServerManager from './components/codex/CodexMcpServerManager.vue';
import CodexPluginManager from './components/codex/CodexPluginManager.vue';
import CodexSkillsManager from './components/codex/CodexSkillsManager.vue';
import ContentViewer from './components/viewers/ContentViewer.vue';
import DiffViewer from './components/viewers/DiffViewer.vue';
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
import { useFileTree, type FileNode } from './composables/useFileTree';
import { usePtyOneshot } from './composables/usePtyOneshot';
import { useFloatingWindows } from './composables/useFloatingWindows';
import { usePermissions, type PermissionRequest } from './composables/usePermissions';
import { useQuestions, type QuestionRequest } from './composables/useQuestions';
import { useTodos, type TodoItem } from './composables/useTodos';
import { useDeltaAccumulator } from './composables/useDeltaAccumulator';
import { useGlobalEvents } from './composables/useGlobalEvents';
import { useMessages } from './composables/useMessages';
import { pendingWorkerRenders } from './composables/useRenderState';
import { useOpenCodeApi } from './composables/useOpenCodeApi';
import { useCodexApi } from './composables/useCodexApi';
import { CODEX_PROJECT_ID, useCodexWorkspace } from './composables/useCodexWorkspace';
import { useReasoningWindows } from './composables/useReasoningWindows';
import { useServerState } from './composables/useServerState';
import { useSessionSelection } from './composables/useSessionSelection';
import { useSubagentWindows } from './composables/useSubagentWindows';
import { renderWorkerHtml, type RenderRequest } from './utils/workerRenderer';
import type { HistoryWindowEntry, MessageDiffEntry } from './types/message';
import type { MessagePart, ReasoningPart, ToolPart } from './types/sse';
import type { ProjectState, SandboxState } from './types/worker-state';
import type { SessionTreeData, SessionTreeProject, SessionTreeSandbox, SessionTreeSession } from './types/session-tree';
import type { Terminal } from '@xterm/xterm';
import { DEFAULT_OPENCODE_URL } from './utils/constants';
import {
  isSamePinnedSessionStore,
  limitPinnedSessionStore,
  normalizePinnedAt,
  parsePinnedSessionStore,
  pinnedSessionStoreKey,
  projectPinKey,
  reconcilePinnedSessionStore,
  sandboxPinKey,
  type LocalPinnedSessionStore,
} from './utils/pinnedSessions';
import {
  isBatchSessionAction,
  normalizeBatchSessionTargets,
} from './utils/batchSessionTargets';
import { mapWithConcurrency } from './utils/mapWithConcurrency';
import { resolveProjectColorHex } from './utils/stateBuilder';
import {
  extractFileRead as extractToolFileRead,
  extractPatch as extractToolPatch,
} from './utils/toolRenderers';
import { toMessageDiffViewerEntry } from './utils/messageDiff';
import { buildLineCommentFileUrl, formatCommentNote } from './utils/lineComment';
import {
  configureCodexBackend,
  configureOpenCodeBackend,
  getActiveBackendAdapter,
  setActiveBackendKind,
} from './backends/registry';
import type { BackendKind } from './backends/types';
import { opencodeTheme, resolveTheme, resolveAgentColor } from './utils/theme';
import { DEFAULT_SYNTAX_THEME } from './utils/themeTokens';
import { splitFileContentDirectoryAndPath, normalizeDirectory } from './utils/path';
import { useCredentials } from './composables/useCredentials';
import { useSettings } from './composables/useSettings';
import {
  StorageKeys,
  storageGet,
  storageKey,
  storageRemove,
  storageSet,
  storageSetJSON,
} from './utils/storageKeys';
import {
  isSandboxMarkedDeleted,
  markSandboxDeleted,
  pruneDeletedSandboxStore,
  readDeletedSandboxStore,
  writeDeletedSandboxStore,
  type DeletedSandboxStore,
} from './utils/deletedSandboxes';

const { t } = useI18n();

type LocalizedStatusState =
  | { mode: 'i18n'; key: string; params?: Record<string, unknown> }
  | { mode: 'text'; text: string }
  | { mode: 'render'; render: () => string };
const credentials = useCredentials();
const {
  suppressAutoWindows,
  showMinimizeButtons,
  dockAlwaysOpen,
  terminalFontFamily,
  appMonospaceFontFamily,
  terminalFontSizePx,
  appFontSizePx,
  messageFontSizePx,
  uiFontSizePx,
} = useSettings();
const FOLLOW_THRESHOLD_PX = 24;
const FILE_VIEWER_WINDOW_WIDTH = 840;
const FILE_VIEWER_WINDOW_HEIGHT = 520;
const TERM_COLUMNS = 80;
const TERM_ROWS = 25;
const TERM_FONT_SIZE_PX = computed(() => terminalFontSizePx.value);
const TERM_LINE_HEIGHT = 1.1;
const TERM_TITLEBAR_HEIGHT_PX = 22;
const TERM_WINDOW_BORDER_PX = 2;
const TERM_INNER_PADDING_X_PX = 4;
const TERM_INNER_PADDING_Y_PX = 4;
const TERM_GUTTER_WIDTH_EM = 3.2;
const TRANSPARENT_TERMINAL_BACKGROUND = 'rgba(0, 0, 0, 0)';

const SHELL_LINGER_MS = 1000;
const TREE_DATA_CACHE_TTL_MS = 15000;
const COMMIT_SNAPSHOT_SCRIPT = [
  'stty -opost -echo 2>/dev/null',
  'export GIT_PAGER=cat',
  'export GIT_TERMINAL_PROMPT=0',
  'h=$1',
  'printf "##TITLE\\t%s\\n" "$(git --no-pager log --format="%h %s" -1 "$h" 2>/dev/null)"',
  'git diff-tree --no-commit-id -r --name-status --find-renames --find-copies --first-parent --root "$h" 2>/dev/null | while IFS="$(printf "\\t")" read -r st p1 p2; do',
  '  code=${st%"${st#?}"}',
  '  old=$p1',
  '  new=$p1',
  '  if [ "$code" = "R" ] || [ "$code" = "C" ]; then',
  '    old=$p1',
  '    new=$p2',
  '  fi',
  '  printf "##FILE\\t%s\\t%s\\n" "$st" "$new"',
  '  printf "##BEFORE\\n"',
  '  if [ "$code" != "A" ]; then',
  '    git --no-pager show "$h^:$old" 2>/dev/null | base64 -w 76',
  '  fi',
  '  printf "##AFTER\\n"',
  '  if [ "$code" != "D" ]; then',
  '    git --no-pager show "$h:$new" 2>/dev/null | base64 -w 76',
  '  fi',
  'done',
].join('\n');
const FILE_SNAPSHOT_SCRIPT = [
  'stty -opost -echo 2>/dev/null',
  'export GIT_PAGER=cat',
  'export GIT_TERMINAL_PROMPT=0',
  'mode=$1',
  'path=$2',
  'printf "##BEFORE\\n"',
  'if [ "$mode" = "staged" ]; then',
  '  git --no-pager show "HEAD:$path" 2>/dev/null | base64 -w 76',
  'else',
  '  git --no-pager show ":$path" 2>/dev/null | base64 -w 76',
  'fi',
  'printf "##AFTER\\n"',
  'if [ "$mode" = "staged" ]; then',
  '  git --no-pager show ":$path" 2>/dev/null | base64 -w 76',
  'else',
  '  if [ -f "$path" ]; then',
  '    base64 -w 76 < "$path"',
  '  fi',
  'fi',
].join('\n');
type WorktreeSnapshotMode = 'staged' | 'changes' | 'all';

function shellEscapeForSingleQuotes(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeShellTitle(value: string): string {
  let normalized = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) {
      normalized += ' ';
      continue;
    }
    normalized += char;
  }
  return normalized;
}

function buildWorktreeSnapshotScript(mode: WorktreeSnapshotMode, translate: (key: string) => string): string {
  const title =
    mode === 'staged'
      ? translate('app.git.stagedChanges')
      : mode === 'changes'
        ? translate('app.git.unstagedChanges')
        : translate('app.git.workingTree');
  const escapedTitle = shellEscapeForSingleQuotes(normalizeShellTitle(title));
  // Filter logic: which files to include based on mode
  // x = index status (1st column), y = worktree status (2nd column)
  let filterLines: string[];
  if (mode === 'staged') {
    // Only files with index changes (x != ' ' and x != '?')
    filterLines = ['  [ "$x" = " " ] && continue', '  [ "$x" = "?" ] && continue'];
  } else if (mode === 'changes') {
    // Only files with worktree changes (y != ' '); include untracked (y='?')
    filterLines = ['  [ "$y" = " " ] && continue'];
   } else {
     // All: include all files (git status already filters to changed files)
     filterLines = [];
   }
  // Before/after source depends on mode
  let beforeLines: string[];
  let afterLines: string[];
  if (mode === 'staged') {
    // staged: HEAD -> index
    beforeLines = [
      '  printf "##BEFORE\\n"',
      '  if [ "$code" != "A" ]; then',
      '    git --no-pager show "HEAD:$old" 2>/dev/null | base64 -w 76',
      '  fi',
    ];
    afterLines = [
      '  printf "##AFTER\\n"',
      '  if [ "$code" != "D" ]; then',
      '    git --no-pager show ":$new" 2>/dev/null | base64 -w 76',
      '  fi',
    ];
  } else if (mode === 'changes') {
    // changes: index -> working tree
    beforeLines = [
      '  printf "##BEFORE\\n"',
      '  if [ "$code" != "A" ]; then',
      '    git --no-pager show ":$old" 2>/dev/null | base64 -w 76',
      '  fi',
    ];
    afterLines = [
      '  printf "##AFTER\\n"',
      '  if [ "$code" != "D" ] && [ -f "$new" ]; then',
      '    base64 -w 76 < "$new"',
      '  fi',
    ];
  } else {
    // all: HEAD -> working tree
    beforeLines = [
      '  printf "##BEFORE\\n"',
      '  if [ "$code" != "A" ]; then',
      '    git --no-pager show "HEAD:$old" 2>/dev/null | base64 -w 76',
      '  fi',
    ];
    afterLines = [
      '  printf "##AFTER\\n"',
      '  if [ "$code" != "D" ] && [ -f "$new" ]; then',
      '    base64 -w 76 < "$new"',
      '  fi',
    ];
  }
  return [
    'stty -opost -echo 2>/dev/null',
    'export GIT_PAGER=cat',
    'export GIT_TERMINAL_PROMPT=0',
    `printf "##TITLE\\t%s\\n" ${escapedTitle}`,
    'git --no-pager status --porcelain=v1 -uall 2>/dev/null | while IFS= read -r line; do',
    '  [ -z "$line" ] && continue',
    '  x=${line%"${line#?}"}',
    '  rest=${line#?}',
    '  y=${rest%"${rest#?}"}',
    ...filterLines,
    '  path=${line#???}',
    '  old=$path',
    '  new=$path',
  '  code=M',
  '  if [ "$x" = "?" ] && [ "$y" = "?" ]; then',
  '    code=A',
  '  elif [ "$x" = "D" ] || [ "$y" = "D" ]; then',
  '    code=D',
  '  elif [ "$x" = "A" ]; then',
  '    code=A',
  '  elif [ "$x" = "R" ] || [ "$y" = "R" ]; then',
  '    code=R',
  '    old=${path%% -> *}',
  '    new=${path#* -> }',
  '  elif [ "$x" = "C" ] || [ "$y" = "C" ]; then',
  '    code=C',
  '    old=${path%% -> *}',
  '    new=${path#* -> }',
  '  fi',
    '  printf "##FILE\\t%s\\t%s\\n" "$code" "$new"',
    ...beforeLines,
    ...afterLines,
    'done',
  ].join('\n');
}
const REASONING_CLOSE_DELAY_MS = 3000;
const SUBAGENT_CLOSE_DELAY_MS = 3000;
type TodoPanelSession = {
  sessionId: string;
  title: string;
  isSubagent: boolean;
  todos: TodoItem[];
  loading: boolean;
  error: string | undefined;
};

type FileContentResponse = {
  content?: string;
  encoding?: string;
  type?: 'text' | 'binary';
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
  terminal: Terminal;
  socket?: WebSocket;
  exiting?: boolean;
  closeOnSuccess?: boolean;
  exitResolve?: (exitCode: number) => void;
};

type CommitSnapshotEntry = {
  status: string;
  file: string;
  before: string;
  after: string;
  beforeBase64: string;
  afterBase64: string;
};

type CommitSnapshotResult = {
  title: string;
  files: CommitSnapshotEntry[];
};

type FileSnapshotResult = {
  before: string;
  after: string;
  beforeBase64: string;
  afterBase64: string;
};

type LineCommentData = { path: string; startLine: number; endLine: number; text: string };

type Attachment = {
  id: string;
  filename: string;
  mime: string;
  dataUrl: string;
  lineComment?: LineCommentData;
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

const BATCH_SESSION_ACTION_CONCURRENCY = 6;

const fw = useFloatingWindows();
const CODEX_PANEL_KEY = 'codex-panel';
const minimizedEntries = computed(() => fw.entries.value.filter((entry) => entry.minimized));
const showDockPanel = computed(
  () => showMinimizeButtons.value && (dockAlwaysOpen.value || minimizedEntries.value.length > 0),
);

// Close auto-opened floating windows when suppress is toggled ON.
// Tool auto windows: closable === false AND finite expiry (not Infinity).
// Reasoning/subagent windows: closable === false AND key starts with 'reasoning:' or 'subagent:'.
// Permission/question (closable: false, expiry: Infinity) are excluded.
watch(suppressAutoWindows, (suppressed) => {
  if (!suppressed) return;
  const keysToClose = new Set<string>();
  for (const entry of fw.entries.value) {
    if (
      !entry.closable &&
      (entry.expiresAt < Number.MAX_SAFE_INTEGER ||
        entry.key.startsWith('reasoning:') ||
        entry.key.startsWith('subagent:'))
    ) {
      keysToClose.add(entry.key);
    }
  }
  if (keysToClose.size > 0) {
    fw.closeAll({ exclude: (key) => !keysToClose.has(key) });
  }
});

watch(showMinimizeButtons, (enabled) => {
  if (enabled) return;
  restoreAllMinimizedWindows();
});

function openCodexPanel() {
  const width = 760;
  const height = 560;
  const extent = fw.getExtent();
  void fw.open(CODEX_PANEL_KEY, {
    component: CodexPanel,
    props: markRaw({ api: markRaw(codexApi) }),
    title: t('codexPanel.title'),
    width,
    height,
    x: Math.max(20, extent.width - width - 24),
    y: 84,
    closable: true,
    resizable: true,
    scroll: 'none',
    focusOnOpen: true,
    expiry: Infinity,
  });
}

type CodexSubpanelDefinition = {
  component: Component;
  titleKey: string;
  width: number;
  height: number;
  scroll?: 'manual' | 'none' | 'follow' | 'force';
};

const codexSubpanelDefinitions: Record<TopPanelCodexSubpanel, CodexSubpanelDefinition> = {
  mcp: { component: CodexMcpServerManager, titleKey: 'codexPanel.mcpTitle', width: 700, height: 600 },
  skills: { component: CodexSkillsManager, titleKey: 'codexPanel.skillsTitle', width: 680, height: 560 },
  plugins: { component: CodexPluginManager, titleKey: 'codexPanel.pluginsTitle', width: 720, height: 600 },
  apps: { component: CodexAppManager, titleKey: 'codexPanel.appsTitle', width: 640, height: 520 },
  config: { component: CodexConfigViewer, titleKey: 'codexPanel.configTitle', width: 720, height: 600, scroll: 'manual' },
  experimentalFeatures: { component: CodexExperimentalFeatureManager, titleKey: 'codexPanel.experimentalFeaturesTitle', width: 640, height: 520 },
  collaborationModes: { component: CodexCollaborationModeManager, titleKey: 'codexPanel.collaborationModesTitle', width: 600, height: 460 },
  externalAgentConfig: { component: CodexExternalAgentConfig, titleKey: 'codexPanel.externalAgentConfigTitle', width: 640, height: 520 },
  feedback: { component: CodexFeedbackUploader, titleKey: 'codexPanel.feedbackTitle', width: 560, height: 500 },
};

function refreshCodexSubpanel(panel: TopPanelCodexSubpanel) {
  if (!codexApi.connected.value) return;
  switch (panel) {
    case 'mcp':
      void codexApi.refreshMcpServers();
      break;
    case 'skills':
      void codexApi.refreshSkills();
      break;
    case 'plugins':
      void codexApi.refreshPlugins();
      break;
    case 'apps':
      void codexApi.refreshApps();
      break;
    case 'config':
      void codexApi.refreshConfig();
      void codexApi.refreshConfigRequirements();
      break;
    case 'experimentalFeatures':
      void codexApi.refreshExperimentalFeatures();
      break;
    case 'collaborationModes':
      void codexApi.refreshCollaborationModes();
      break;
    case 'externalAgentConfig':
      void codexApi.detectExternalAgentConfig();
      break;
    case 'feedback':
      break;
  }
}

function openCodexSubpanel(panel: TopPanelCodexSubpanel) {
  const definition = codexSubpanelDefinitions[panel];
  if (!codexApi.connected.value) {
    openCodexPanel();
    return;
  }
  const extent = fw.getExtent();
  const x = Math.max(20, extent.width - definition.width - 36);
  const y = 96;
  void fw.open(`codex-${panel}`, {
    component: definition.component,
    props: { api: codexApi },
    title: t(definition.titleKey),
    width: definition.width,
    height: definition.height,
    x,
    y,
    closable: true,
    resizable: true,
    scroll: definition.scroll ?? 'manual',
    focusOnOpen: true,
    expiry: Infinity,
  });
  refreshCodexSubpanel(panel);
}

const outputEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLElement | null>(null);
const appEl = ref<HTMLDivElement | null>(null);
const toolWindowCanvasEl = ref<HTMLDivElement | null>(null);
const outputPanelRef = ref<{ panelEl: HTMLDivElement | null; scrollToBottom: () => Promise<void> } | null>(null);
const topPanelRef = ref<{
  openSessionDropdown: () => void;
  closeSessionDropdown: () => void;
  toggleSessionDropdown: () => void;
} | null>(null);
const inputPanelRef = ref<{ focus: () => void; reset: () => void } | null>(null);
const outputPanelContainerEl = computed(() => outputPanelRef.value?.panelEl ?? undefined);
const outputPanelScrollMode = computed<ScrollMode>(() => 'follow');
const {
  isFollowing,
  enableFollow,
  resetFollow,
  resumeFollow,
  notifyContentChange,
} = useAutoScroller(outputPanelContainerEl, outputPanelScrollMode, {
  bottomThresholdPx: FOLLOW_THRESHOLD_PX,
  observeDelayMs: 0,
  smoothEngine: 'native',
  smoothOnInitialFollow: false,
});

function handleOutputPanelResumeFollow() {
  resumeFollow();
}

function handleOutputPanelMessageRendered() {
  notifyContentChange();
}

function handleOutputPanelContentResized() {
  notifyContentChange();
}

async function anchorOutputToBottom() {
  const requestId = ++outputAnchorRequestId;
  isOutputAnchoring.value = true;
  try {
    await nextTick();
    await outputPanelRef.value?.scrollToBottom();
  } finally {
    if (requestId === outputAnchorRequestId) {
      isOutputAnchoring.value = false;
    }
  }
}

function scheduleFloatingExtentSync() {
  if (floatingExtentFrameId !== null) return;
  floatingExtentFrameId = requestAnimationFrame(() => {
    floatingExtentFrameId = null;
    syncFloatingExtent();
  });
}

function scheduleShellFitAllNextFrame() {
  if (shellFitAllFrameId !== null) return;
  shellFitAllFrameId = requestAnimationFrame(() => {
    shellFitAllFrameId = null;
    scheduleShellFitAll();
  });
}

function flushResizeSideEffects() {
  scheduleFloatingExtentSync();
  scheduleShellFitAllNextFrame();
}

const runningToolIds = reactive(new Set<string>());

const userMessageMetaById = ref<Record<string, UserMessageMeta>>({});
const userMessageTimeById = ref<Record<string, number>>({});
const isLoadingHistory = ref(false);
const isOutputAnchoring = ref(false);
const deferredSessionReloadId = ref<string | null>(null);
const globalEventUnsubscribers: Array<() => void> = [];

const inputResizeState = ref<{
  startY: number;
  startHeight: number;
  minHeight: number;
  maxHeight: number;
} | null>(null);
const inputHeight = ref<number | null>(null);
const sidePanelResizeState = ref<{
  startX: number;
  startWidth: number;
  minWidth: number;
  maxWidth: number;
} | null>(null);
const sidePanelWidth = ref<number | null>(null);
const appBodyEl = ref<HTMLDivElement | null>(null);
const sidePanelAreaEl = ref<HTMLDivElement | null>(null);
let primaryHistoryRequestId = 0;
let sessionReloadRequestId = 0;
let outputAnchorRequestId = 0;
const recentUserInputs: { text: string; time: number }[] = [];
const composerDraftRevisionByContext = new Map<string, number>();
const localPinnedSessionStore = ref<LocalPinnedSessionStore>(readPinnedSessionStore());
const deletedSandboxStore = ref<DeletedSandboxStore>(readDeletedSandboxStore());
const sessionTreeExpandedPaths = ref<string[]>(readSessionTreeExpandedPaths());
const composerDraftTabId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const shellSessionsByPtyId = new Map<string, ShellSession>();
const pendingShellFits = new Set<string>();
const shellExitWaiters = new Map<string, (exitCode: number) => void>();
const ptyToFileMap = new Map<string, string>();
const codexSessionCreationByDirectory = new Map<string, Promise<SessionInfo | undefined>>();
const ptyMetaDecoder = new TextDecoder();
let floatingExtentResizeObserver: ResizeObserver | null = null;
let floatingExtentObservedEl: HTMLDivElement | null = null;
let floatingExtentFrameId: number | null = null;
let shellFitAllFrameId: number | null = null;
let windowResizeFrameId: number | null = null;
let pendingPointerEvent: PointerEvent | null = null;
let pointerMoveFrameId: number | null = null;

const notificationSessionOrder = ref<string[]>([]);
const notificationPermissionRequested = ref(false);

const sidePanelCollapsed = ref(readSidePanelCollapsed());
const sidePanelActiveTab = ref(readSidePanelTab());

type SessionInfo = {
  id: string;
  projectID?: string;
  projectId?: string;
  parentID?: string;
  title?: string;
  slug?: string;
  status?: 'busy' | 'idle' | 'retry';
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
    pinned?: number;
  };
  revert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };
};

type WorktreeInfo = {
  name: string;
  branch: string;
  directory: string;
};

type ProviderModel = {
  id: string;
  name?: string;
  providerID?: string;
  family?: string;
  status?: string;
  variants?: Record<string, unknown>;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  capabilities?: {
    attachment?: boolean;
    reasoning?: boolean;
    toolcall?: boolean;
  };
};

type ProviderInfo = {
  id: string;
  name?: string;
  source?: string;
  key?: string;
  models?: Record<string, ProviderModel>;
};

type ProviderResponse = {
  all?: ProviderInfo[];
  default?: Record<string, string>;
  connected?: string[];
};

type ProviderConfigState = {
  enabled_providers?: string[];
  disabled_providers?: string[];
  provider?: Record<string, unknown>;
};

type ModelVisibilityEntry = {
  providerID: string;
  modelID: string;
  visibility: 'show' | 'hide';
};

type ModelVisibilityStore = {
  user: ModelVisibilityEntry[];
  recent: string[];
  variant: Record<string, string>;
};

const MODEL_VISIBILITY_STORAGE_KEY = 'opencode.global.dat:model';
const LEGACY_DISABLED_MODELS_STORAGE_KEY = 'opencode.settings.disabledModels.v1';

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

const providers = ref<ProviderInfo[]>([]);
const connectedProviderIds = ref<string[]>([]);
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
const serverState = useServerState();
const openCodeApi = useOpenCodeApi(serverState.projects, t);
const codexApi = useCodexApi();
const codexWorkspace = useCodexWorkspace(codexApi);
const bootstrapReady = serverState.bootstrapped;
const sessionSelection = useSessionSelection(
  computed(() => serverState.projects),
  async (projectId) => {
    const directory = serverState.projects[projectId]?.worktree?.trim();
    if (!directory) {
      throw new Error(t('errors.sessionCreateEmptyWorktree'));
    }
    const created = await openCodeApi.createSession(directory);
    if (!created?.id) {
      throw new Error(t('errors.sessionCreateInvalidResponse'));
    }
    return { id: created.id, projectId: projectId };
  },
  t,
);
const {
  selectedProjectId,
  selectedSessionId,
  projectDirectory,
  activeDirectory,
  switchSession: switchSessionSelection,
  initialize: initializeSessionSelection,
} = sessionSelection;

function toSessionInfo(
  projectId: string,
  directory: string,
  session: {
    id: string;
    parentID?: string;
    title?: string;
    slug?: string;
    status?: 'busy' | 'idle' | 'retry';
    timeCreated?: number;
    timeUpdated?: number;
    timeArchived?: number;
    timePinned?: number;
    revert?: SessionInfo['revert'];
  },
): SessionInfo {
  return {
    id: session.id,
    projectID: projectId,
    projectId,
    parentID: session.parentID,
    title: session.title,
    slug: session.slug,
    directory,
    status: session.status,
    time: {
      created: session.timeCreated,
      updated: session.timeUpdated,
      archived: session.timeArchived,
      pinned: session.timePinned,
    },
    revert: session.revert,
  };
}

function collectAllSessionsByProject() {
  const byProject: Record<string, SessionInfo[]> = {};
  Object.values(serverState.projects).forEach((project) => {
    const list: SessionInfo[] = [];
    (Object.values(project.sandboxes) as SandboxState[]).forEach((sandbox) => {
      Object.values(sandbox.sessions).forEach((session) => {
        list.push(toSessionInfo(project.id, sandbox.directory, session));
      });
    });
    byProject[project.id] = list;
  });
  return byProject;
}

const sessionsByProject = computed(() => collectAllSessionsByProject());

const sessionHistoryMetaById = computed(() => {
  const meta: Record<string, { parentID?: string; label: string }> = {};
  Object.values(sessionsByProject.value)
    .flat()
    .forEach((session) => {
      meta[session.id] = {
        parentID: session.parentID,
        label: sessionLabel(session),
      };
    });
  return meta;
});

const sessions = computed<SessionInfo[]>(() => {
  const projectId = selectedProjectId.value.trim();
  if (!projectId) return [];
  const directory = activeDirectory.value.trim();
  const all = sessionsByProject.value[projectId] ?? [];
  const roots = all.filter((session) => !session.parentID);
  const filtered = directory
    ? roots.filter((session) => !session.directory || session.directory === directory)
    : roots;
  return filtered.slice().sort(compareSessionsForSelection);
});

const sessionParentById = computed(() => {
  const map = new Map<string, string | undefined>();
  const projectId = selectedProjectId.value.trim();
  if (!projectId) return map;
  const all = sessionsByProject.value[projectId] ?? [];
  all.forEach((session) => {
    map.set(session.id, session.parentID);
  });
  return map;
});

const currentProjectColor = computed(() => {
  const project = serverState.projects[selectedProjectId.value];
  return resolveProjectColorHex(project?.icon?.color);
});

const currentProjectName = computed(() => {
  const project = serverState.projects[selectedProjectId.value];
  if (!project) return undefined;
  const name = project.name?.trim();
  if (name) return name;
  return project.worktree?.replace(/\/+$/, '').split('/').pop() || undefined;
});

const reasoning = useReasoningWindows({
  selectedSessionId,
  fw,
  reasoningComponent: ReasoningContent,
  theme: () => DEFAULT_SYNTAX_THEME,
  reasoningCloseDelayMs: REASONING_CLOSE_DELAY_MS,
  resolveModelName: (providerID, modelID) => {
    const key = `${providerID}/${modelID}`;
    return modelOptions.value.find((m) => m.id === key)?.displayName;
  },
  suppressAutoWindows,
  t,
});
const { updateReasoningExpiry } = reasoning;

const subagentWindows = useSubagentWindows({
  selectedSessionId,
  fw,
  subagentComponent: SubagentContent,
  theme: () => DEFAULT_SYNTAX_THEME,
  closeDelayMs: SUBAGENT_CLOSE_DELAY_MS,
  resolveModelName: (providerID, modelID) => {
    const key = `${providerID}/${modelID}`;
    return modelOptions.value.find((m) => m.id === key)?.displayName;
  },
  suppressAutoWindows,
});

const homePath = ref('');
const serverWorktreePath = ref('');

const initialQuery = readQuerySelection();
const isProjectPickerOpen = ref(false);
const editingProject = ref<{ projectId: string; worktree: string } | null>(null);
const editingProjectMeta = computed(() => {
  const pid = editingProject.value?.projectId;
  return pid ? serverState.projects[pid] : undefined;
});
const isSettingsOpen = ref(false);
const isProviderManagerOpen = ref(false);
const isStatusMonitorOpen = ref(false);

const promptDialogRef = ref<HTMLDialogElement | null>(null);
const promptInputRef = ref<HTMLInputElement | null>(null);
const promptValue = ref('');
const promptTitle = ref('');
let promptResolve: ((value: string | null) => void) | null = null;

async function showPrompt(title: string, defaultValue = ''): Promise<string | null> {
  promptTitle.value = title;
  promptValue.value = defaultValue;
  promptResolve = null;
  return new Promise((resolve) => {
    promptResolve = resolve;
    promptDialogRef.value?.showModal();
    nextTick(() => {
      promptInputRef.value?.focus();
      promptInputRef.value?.select();
    });
  });
}

function handlePromptConfirm() {
  const value = promptValue.value;
  promptDialogRef.value?.close();
  promptResolve?.(value);
  promptResolve = null;
}

function handlePromptClose() {
  if (promptResolve) {
    promptResolve(null);
    promptResolve = null;
  }
}

const confirmDialogRef = ref<HTMLDialogElement | null>(null);
const confirmMessage = ref('');
let confirmResolve: ((value: boolean) => void) | null = null;

async function showConfirm(message: string): Promise<boolean> {
  confirmMessage.value = message;
  confirmResolve = null;
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmDialogRef.value?.showModal();
  });
}

function handleConfirmAccept() {
  confirmDialogRef.value?.close();
  confirmResolve?.(true);
  confirmResolve = null;
}

function handleConfirmClose() {
  if (confirmResolve) {
    confirmResolve(false);
    confirmResolve = null;
  }
}

import { provide } from 'vue';
provide('showPrompt', showPrompt);
provide('showConfirm', showConfirm);

const selectedMode = ref('build');
const selectedModel = ref('');
const selectedThinking = ref<string | undefined>(undefined);
const hiddenModels = ref<string[]>(readHiddenModelsFromStorage());
const providerConfig = ref<ProviderConfigState | null>(null);
const projectError = ref('');
const worktreeError = ref('');
const sessionError = ref('');
const messageInput = ref('');
const attachments = ref<Attachment[]>([]);
const sendStatus = ref<LocalizedStatusState>({ mode: 'i18n', key: 'app.status.ready' });
const isSending = ref(false);
const isAborting = ref(false);
const isBootstrapping = ref(false);
const uiInitState = ref<'loading' | 'ready' | 'error' | 'login'>('loading');
const initLoadingMessage = ref(t('app.connection.connecting'));
const initErrorMessage = ref('');
const connectionState = ref<'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error'>(
  'connecting',
);
const reconnectingMessage = ref('');
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let initializationInFlight = false;
const loginUrl = ref(DEFAULT_OPENCODE_URL);
const loginUsername = ref('');
const loginPassword = ref('');
const loginRequiresAuth = ref(false);
const activeBackendKind = ref<BackendKind>('opencode');
const loginBackendKind = ref<BackendKind>('opencode');
const loginCodexBridgeUrl = ref(credentials.codexBridgeUrl.value);
const loginCodexBridgeToken = ref(credentials.codexBridgeToken.value);
const retryStatus = ref<{
  message: string;
  next: number;
  attempt: number;
} | null>(null);

const loginTitle = computed(() => (
  loginBackendKind.value === 'codex'
    ? t('app.login.codexTitle')
    : t('app.login.title')
));

function setSendStatusKey(key: string, params?: Record<string, unknown>) {
  sendStatus.value = params ? { mode: 'i18n', key, params } : { mode: 'i18n', key };
}

function setSendStatusText(text: string) {
  sendStatus.value = { mode: 'text', text };
}

function setSendStatusRender(render: () => string) {
  sendStatus.value = { mode: 'render', render };
}

const resolvedSendStatus = computed(() => {
  const status = sendStatus.value;
  if (status.mode === 'text') return status.text;
  if (status.mode === 'render') return status.render();
  return t(status.key, status.params ?? {});
});

const statusText = computed(() => {
  if (connectionState.value === 'reconnecting') {
    return reconnectingMessage.value || t('app.connection.reconnecting');
  }
  if (retryStatus.value) {
    const timeStr = formatRetryTime(retryStatus.value.next);
    return `${retryStatus.value.message} | ${t('app.status.next')}: ${timeStr}`;
  }
  if (openCodeApi.pending.value) {
    return t('app.status.synchronizing');
  }
  return projectError.value || worktreeError.value || sessionError.value || resolvedSendStatus.value;
});
const isStatusError = computed(() =>
  Boolean(projectError.value || worktreeError.value || sessionError.value || retryStatus.value),
);

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

const treeDataCache = shallowRef<{
  data: TopPanelWorktree[];
  hash: string;
  timestamp: number;
} | null>(null);

const sessionTreeDataCache = shallowRef<{
  data: SessionTreeData;
  hash: string;
  timestamp: number;
} | null>(null);

function mixStringIntoHash(hash: number, str: string): number {
  let h = hash;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

function computeProjectsHash(
  projects: Record<string, ProjectState>,
  pinnedStore: LocalPinnedSessionStore,
  deletedStore: DeletedSandboxStore,
): string {
  let hash = 0;
  const projectEntries = Object.entries(projects);
  for (const [id, project] of projectEntries) {
    hash ^= id.length + Object.keys(project.sandboxes).length;
    hash = mixStringIntoHash(hash, project.name ?? '');
    for (const sandbox of (Object.values(project.sandboxes) as SandboxState[])) {
      hash += sandbox.rootSessions.length;
      hash = mixStringIntoHash(hash, sandbox.name);
      hash = mixStringIntoHash(hash, sandbox.directory);
      for (const sessionId of sandbox.rootSessions) {
        const session = sandbox.sessions[sessionId];
        if (session) {
          hash += (session.timeUpdated ?? session.timeCreated ?? 0) & 0xffff;
          hash += (session.timePinned ?? 0) & 0xffff;
        }
      }
    }
  }

  const pinnedEntries = Object.entries(pinnedStore).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const pinnedHash = pinnedEntries.map(([key, value]) => `${key}:${value}`).join('|');

  const deletedEntries = Object.entries(deletedStore)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([projectId, directories]) => `${projectId}:${directories.slice().sort().join(',')}`);
  const deletedHash = deletedEntries.join('|');

  return `${hash}-${projectEntries.length}-${pinnedHash}-${deletedHash}`;
}

const treeDataHash = computed(() =>
  computeProjectsHash(
    serverState.projects,
    localPinnedSessionStore.value,
    deletedSandboxStore.value,
  ),
);

const sessionLocationById = computed(() => {
  const locations = new Map<string, {
    projectId: string;
    sandbox: SandboxState;
    session: SandboxState['sessions'][string];
  }>();

  for (const [projectId, project] of Object.entries(serverState.projects)) {
    for (const sandbox of (Object.values(project.sandboxes) as SandboxState[])) {
      for (const session of Object.values(sandbox.sessions)) {
        locations.set(session.id, {
          projectId,
          sandbox,
          session,
        });
      }
    }
  }

  return locations;
});

const topPanelTreeData = computed<TopPanelWorktree[]>(() => {
  const currentHash = treeDataHash.value;
  const now = Date.now();
  
  if (
    treeDataCache.value &&
    treeDataCache.value.hash === currentHash &&
    now - treeDataCache.value.timestamp < TREE_DATA_CACHE_TTL_MS
  ) {
    return treeDataCache.value.data;
  }
  
  const entries = Object.values(serverState.projects)
    .map((project) => {
      const worktreeDirectory = project.worktree;
      const sandboxEntries = (Object.values(project.sandboxes) as SandboxState[])
        .filter(
          (sandbox) =>
            sandbox.directory === worktreeDirectory ||
            !isSandboxMarkedDeleted(deletedSandboxStore.value, project.id, sandbox.directory),
        )
        .map((sandbox) => {
          const projectPinnedAt = normalizePinnedAt(localPinnedSessionStore.value[projectPinKey(project.id)]);
          const sandboxLocalValue = localPinnedSessionStore.value[sandboxPinKey(project.id, sandbox.directory)];
          const sandboxPinnedAt = normalizePinnedAt(sandboxLocalValue);
          const isSandboxDirectlyPinned = sandboxPinnedAt > 0;
          const isSandboxExplicitlyUnpinned = typeof sandboxLocalValue === 'number' && sandboxLocalValue < 0;
          const isSandboxPinned = isSandboxDirectlyPinned || (projectPinnedAt > 0 && !isSandboxExplicitlyUnpinned);
          const sandboxEffectivePinnedAt = isSandboxPinned
            ? (isSandboxDirectlyPinned ? sandboxPinnedAt : projectPinnedAt)
            : 0;
          const sessionsForSandbox = sandbox.rootSessions
            .map((sessionId) => sandbox.sessions[sessionId])
            .filter((session): session is NonNullable<typeof session> => Boolean(session))
            .map((session) => {
              const sessionLocalValue = localPinnedSessionStore.value[pinnedSessionStoreKey(project.id, session.id)];
              const sessionLocalPinnedAt = normalizePinnedAt(sessionLocalValue);
              const sessionServerPinnedAt = normalizePinnedAt(session.timePinned);
              const isSessionDirectlyPinned = sessionLocalPinnedAt > 0 || sessionServerPinnedAt > 0;
              const isSessionExplicitlyUnpinned =
                typeof sessionLocalValue === 'number' && sessionLocalValue < 0;
              const isSessionImplicitlyPinned =
                !isSessionDirectlyPinned && !isSessionExplicitlyUnpinned && isSandboxPinned;
              return {
                id: session.id,
                title: session.title,
                slug: session.slug,
                status: (session.status ?? 'unknown') as 'busy' | 'idle' | 'retry' | 'unknown',
                timeCreated: session.timeCreated,
                timeUpdated: session.timeUpdated ?? session.timeCreated,
                archivedAt: session.timeArchived,
                pinnedAt: isSessionDirectlyPinned
                  ? (sessionLocalPinnedAt || sessionServerPinnedAt)
                  : (isSessionImplicitlyPinned ? sandboxEffectivePinnedAt : 0),
                isPinned: isSessionDirectlyPinned,
                isImplicitlyPinned: isSessionImplicitlyPinned,
              };
            })
            .sort((a, b) => {
              const pinDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
              if (pinDiff !== 0) return pinDiff;
              return (b.timeUpdated ?? b.timeCreated ?? 0) - (a.timeUpdated ?? a.timeCreated ?? 0);
            });
          const latestUpdated = sessionsForSandbox.reduce(
            (max, session) => Math.max(max, session.timeUpdated ?? session.timeCreated ?? 0),
            0,
          );
          const oldestCreated =
            sessionsForSandbox.length > 0
              ? Math.min(...sessionsForSandbox.map((session) => session.timeCreated ?? Infinity))
              : 0;
          return {
            directory: sandbox.directory,
            branch: sandbox.name || undefined,
            sessions: sessionsForSandbox,
            latestUpdated,
            oldestCreated,
            pinnedAt: sandboxEffectivePinnedAt,
            isPinned: isSandboxDirectlyPinned,
            isImplicitlyPinned: isSandboxPinned && !isSandboxDirectlyPinned,
          };
        })
        .sort((a, b) => {
          const aIsPrimary = a.directory === worktreeDirectory;
          const bIsPrimary = b.directory === worktreeDirectory;
          if (aIsPrimary !== bIsPrimary) return aIsPrimary ? -1 : 1;
          return (b.oldestCreated || 0) - (a.oldestCreated || 0);
        });
      const latestSandboxUpdated = sandboxEntries
        .flatMap((sandbox) => sandbox.sessions)
        .reduce((max, session) => Math.max(max, session.timeUpdated ?? 0), 0);
      const name =
        project.name?.trim() || worktreeDirectory.replace(/\/+$/, '').split('/').pop() || undefined;
      const projectPinnedAt = normalizePinnedAt(localPinnedSessionStore.value[projectPinKey(project.id)]);
      return {
        directory: worktreeDirectory,
        label: replaceHomePrefix(worktreeDirectory),
        name,
        projectId: project.id,
        projectColor: resolveProjectColorHex(project.icon?.color),
        sandboxes: sandboxEntries,
        latestUpdated: latestSandboxUpdated,
        pinnedAt: projectPinnedAt,
        isPinned: projectPinnedAt > 0,
      };
    })
    .sort((a, b) => {
      if (a.directory === '/' && b.directory !== '/') return 1;
      if (b.directory === '/' && a.directory !== '/') return -1;
      return (a.name || a.label).localeCompare(b.name || b.label);
    });
  
  treeDataCache.value = { data: entries, hash: currentHash, timestamp: now };
  return entries;
});

// Navigable session tree: mirrors TopPanel's displayedTree (no-search mode).
// Filters archived sessions, truncates per-sandbox, and drops empty worktrees.
const NAVIGABLE_MAX_SESSIONS = 5;
const navigableTree = computed(() => {
  return topPanelTreeData.value
    .map((worktree) => ({
      ...worktree,
      sandboxes: worktree.sandboxes
        .map((sandbox) => ({
          ...sandbox,
          sessions: sandbox.sessions.filter((s) => !s.archivedAt).slice(0, NAVIGABLE_MAX_SESSIONS),
        }))
        .filter((sandbox) => worktree.projectId !== 'global' || sandbox.sessions.length > 0),
    }))
    .filter((worktree) => worktree.sandboxes.some((sandbox) => sandbox.sessions.length > 0));
});

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

const {
  upsertPermissionEntry,
  removePermissionEntry,
  prunePermissionEntries,
  fetchPendingPermissions,
} = usePermissions({
  fw,
  allowedSessionIds,
  activeDirectory,
  ensureConnectionReady,
  onReplied: dismissCodexPermissionDialog,
});

const { upsertQuestionEntry, removeQuestionEntry, pruneQuestionEntries, fetchPendingQuestions } =
  useQuestions({
    fw,
    allowedSessionIds,
    activeDirectory,
    ensureConnectionReady,
    getTextContent: (messageId: string) => msg.getTextContent(messageId) || '',
    onReplied: dismissCodexToolQuestionDialog,
    onRejected: dismissCodexToolQuestionDialog,
  });

type CodexServerDialogRequest = typeof codexApi.serverRequests.value[number];
type CodexToolUserInputDialogRequest = typeof codexApi.toolUserInputRequests.value[number];
type CodexDynamicToolCallDialogRequest = typeof codexApi.dynamicToolCalls.value[number];

function encodeCodexDialogRequestId(id: string | number) {
  return `codex:${JSON.stringify(id)}`;
}

function encodeCodexToolQuestionRequestId(request: CodexToolUserInputDialogRequest) {
  return `codex-tool:${JSON.stringify({
    id: request.requestId,
    questionIds: request.questions.map((question) => question.id),
  })}`;
}

function encodeCodexDynamicToolCallRequestId(request: CodexDynamicToolCallDialogRequest) {
  return `codex-dynamic:${JSON.stringify(request.requestId)}`;
}

function decodeCodexDialogRequestId(dialogId: string) {
  const prefix = 'codex:';
  if (!dialogId.startsWith(prefix)) return dialogId;
  try {
    const parsed: unknown = JSON.parse(dialogId.slice(prefix.length));
    if (typeof parsed === 'string' || typeof parsed === 'number') return parsed;
  } catch {
    return dialogId;
  }
  return dialogId;
}

function decodeCodexToolQuestionRequestId(dialogId: string) {
  const dynamicPrefix = 'codex-dynamic:';
  if (dialogId.startsWith(dynamicPrefix)) {
    try {
      const parsed: unknown = JSON.parse(dialogId.slice(dynamicPrefix.length));
      if (typeof parsed === 'string' || typeof parsed === 'number') return parsed;
    } catch {
      return dialogId;
    }
    return dialogId;
  }
  const prefix = 'codex-tool:';
  if (!dialogId.startsWith(prefix)) return dialogId;
  try {
    const parsed: unknown = JSON.parse(dialogId.slice(prefix.length));
    if (parsed && typeof parsed === 'object') {
      const id = (parsed as Record<string, unknown>).id;
      if (typeof id === 'string' || typeof id === 'number') return id;
    }
  } catch {
    return dialogId;
  }
  return dialogId;
}

function sameCodexRequestId(left: string | number, right: string | number) {
  return String(left) === String(right) && typeof left === typeof right;
}

function dismissCodexPermissionDialog(dialogId: string) {
  const requestId = decodeCodexDialogRequestId(dialogId);
  codexApi.serverRequests.value = codexApi.serverRequests.value.filter(
    (request) => !sameCodexRequestId(request.id, requestId),
  );
}

function dismissCodexToolQuestionDialog(dialogId: string) {
  const requestId = decodeCodexToolQuestionRequestId(dialogId);
  codexApi.toolUserInputRequests.value = codexApi.toolUserInputRequests.value.filter(
    (request) => !sameCodexRequestId(request.requestId, requestId),
  );
  codexApi.dynamicToolCalls.value = codexApi.dynamicToolCalls.value.filter(
    (request) => !sameCodexRequestId(request.requestId, requestId),
  );
}

function codexPermissionLabel(request: CodexServerDialogRequest) {
  if (request.method.includes('commandExecution')) return 'Codex command approval';
  if (request.method.includes('fileChange')) return 'Codex file change approval';
  if (request.context.host) return 'Codex network approval';
  return 'Codex approval';
}

function codexPermissionPatterns(request: CodexServerDialogRequest) {
  const patterns = new Set<string>();
  if (request.context.command) patterns.add(request.context.command);
  if (request.context.cwd) patterns.add(`cwd: ${request.context.cwd}`);
  if (request.context.host) patterns.add(`host: ${request.context.host}`);
  request.context.fileChanges?.forEach((change) => patterns.add(`${change.kind}: ${change.path}`));
  return Array.from(patterns);
}

function normalizeCodexPermissionRequest(request: CodexServerDialogRequest): PermissionRequest {
  return {
    id: encodeCodexDialogRequestId(request.id),
    sessionID: request.threadId,
    permission: codexPermissionLabel(request),
    patterns: codexPermissionPatterns(request),
    metadata: {
      method: request.method,
      turnId: request.turnId,
      ...request.context,
    },
    always: request.availableDecisions.includes('acceptForSession') ? ['acceptForSession'] : [],
  };
}

function normalizeCodexToolQuestionRequest(request: CodexToolUserInputDialogRequest): QuestionRequest {
  return {
    id: encodeCodexToolQuestionRequestId(request),
    sessionID: request.threadId,
    questions: request.questions.map((question) => ({
      question: question.text,
      header: question.text,
      options: [{ label: 'Respond', description: 'Provide a text response to Codex.' }],
      multiple: false,
      custom: true,
    })),
    tool: {
      messageID: request.turnId,
      callID: String(request.requestId),
    },
  };
}

function normalizeCodexDynamicToolCallRequest(request: CodexDynamicToolCallDialogRequest): QuestionRequest {
  return {
    id: encodeCodexDynamicToolCallRequestId(request),
    sessionID: request.threadId,
    questions: [{
      question: JSON.stringify(request.arguments, null, 2),
      header: `Dynamic tool: ${request.toolName}`,
      options: [{ label: 'Respond', description: 'Provide content items as plain text.' }],
      multiple: false,
      custom: true,
    }],
    tool: {
      messageID: request.turnId,
      callID: String(request.requestId),
    },
  };
}

const codexPermissionDialogIds = ref<Set<string>>(new Set());
const codexQuestionDialogIds = ref<Set<string>>(new Set());
const codexDynamicQuestionDialogIds = ref<Set<string>>(new Set());

watch(
  () => codexApi.serverRequests.value,
  (requests) => {
    if (activeBackendKind.value !== 'codex') return;
    const nextIds = new Set(requests.map((request) => encodeCodexDialogRequestId(request.id)));
    codexPermissionDialogIds.value.forEach((id) => {
      if (!nextIds.has(id)) removePermissionEntry(id);
    });
    requests.forEach((request) => upsertPermissionEntry(normalizeCodexPermissionRequest(request)));
    codexPermissionDialogIds.value = nextIds;
  },
  { deep: true },
);

watch(
  () => codexApi.toolUserInputRequests.value,
  (requests) => {
    if (activeBackendKind.value !== 'codex') return;
    const nextIds = new Set(requests.map((request) => encodeCodexToolQuestionRequestId(request)));
    codexQuestionDialogIds.value.forEach((id) => {
      if (!nextIds.has(id)) removeQuestionEntry(id);
    });
    requests.forEach((request) => upsertQuestionEntry(normalizeCodexToolQuestionRequest(request)));
    codexQuestionDialogIds.value = nextIds;
  },
  { deep: true },
);

watch(
  () => codexApi.dynamicToolCalls.value,
  (requests) => {
    if (activeBackendKind.value !== 'codex') return;
    const nextIds = new Set(requests.map((request) => encodeCodexDynamicToolCallRequestId(request)));
    codexDynamicQuestionDialogIds.value.forEach((id) => {
      if (!nextIds.has(id)) removeQuestionEntry(id);
    });
    requests.forEach((request) => upsertQuestionEntry(normalizeCodexDynamicToolCallRequest(request)));
    codexDynamicQuestionDialogIds.value = nextIds;
  },
  { deep: true },
);

const {
  todosBySessionId,
  todoLoadingBySessionId,
  todoErrorBySessionId,
  normalizeTodoItems,
  reloadTodosForAllowedSessions,
} = useTodos({ selectedSessionId, allowedSessionIds, activeDirectory });

const {
  treeNodes,
  expandedTreePaths,
  expandedTreePathSet,
  selectedTreePath,
  treeLoading,
  treeError,
  gitStatus,
  gitStatusByPath,
  refreshGitStatus,
  reloadTree,
  feed,
  invalidateDirectorySidebarCache,
  toggleTreeDirectory,
  selectTreeFile,
  branchEntries,
  branchListLoading,
  refreshBranchEntries,
  ensureBranchEntriesLoaded,
} = useFileTree({ activeDirectory });

const treeDirectoryName = computed(() => {
  const raw = activeDirectory.value.trim();
  if (!raw) return '';
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed) return '/';
  const segments = trimmed.split('/').filter(Boolean);
  return segments.at(-1) ?? '/';
});

const { runOneShotPtyCommand } = usePtyOneshot({ activeDirectory, translate: t });

const sessionRevert = computed<SessionInfo['revert'] | null>(() => {
  const projectId = selectedProjectId.value.trim();
  const sessionId = selectedSessionId.value.trim();
  if (!projectId || !sessionId) return null;
  const project = serverState.projects[projectId];
  if (!project) return null;
  for (const sandbox of (Object.values(project.sandboxes) as SandboxState[])) {
    const session = sandbox.sessions[sessionId];
    if (session) return session.revert ?? null;
  }
  return null;
});

const notificationSessions = computed<TopPanelNotificationSession[]>(() =>
  notificationSessionOrder.value
    .map((key) => {
      const entry = serverState.notifications[key];
      if (!entry) return null;
      return {
        projectId: entry.projectId,
        sessionId: entry.sessionId,
        count: entry.requestIds.length,
      };
    })
    .filter((item): item is TopPanelNotificationSession => Boolean(item))
    .filter((item) => item.count > 0),
);

watch(
  () => serverState.notifications,
  (notifications) => {
    const keys = Object.keys(notifications);
    const keep = notificationSessionOrder.value.filter((key) => keys.includes(key));
    const next = keys.filter((key) => !keep.includes(key));
    notificationSessionOrder.value = [...keep, ...next];
  },
  { immediate: true, deep: true },
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

const sessionTreeData = computed<SessionTreeData>(() => {
  const currentHash = treeDataHash.value;
  const now = Date.now();

  if (
    sessionTreeDataCache.value &&
    sessionTreeDataCache.value.hash === currentHash &&
    now - sessionTreeDataCache.value.timestamp < TREE_DATA_CACHE_TTL_MS
  ) {
    return sessionTreeDataCache.value.data;
  }

  const store = localPinnedSessionStore.value;
  const result: SessionTreeProject[] = [];

  for (const project of Object.values(serverState.projects)) {
    const projectName =
      project.name?.trim() || project.worktree.replace(/\/+$/, '').split('/').pop() || project.id;
    const projectKey = projectPinKey(project.id);
    const projectLocal = store[projectKey];
    const isProjectPinned = typeof projectLocal === 'number' && projectLocal > 0;
    const isProjectUnpinned = typeof projectLocal === 'number' && projectLocal < 0;

    if (isProjectUnpinned) continue;

    const sandboxes: SessionTreeSandbox[] = [];
    for (const sandbox of Object.values(project.sandboxes) as SandboxState[]) {
      const sandboxKey = sandboxPinKey(project.id, sandbox.directory);
      const sandboxLocal = store[sandboxKey];
      const isSandboxDirectlyPinned = typeof sandboxLocal === 'number' && sandboxLocal > 0;
      const isSandboxUnpinned = typeof sandboxLocal === 'number' && sandboxLocal < 0;
      const isSandboxPinned = isSandboxDirectlyPinned || isProjectPinned;

      if (isSandboxUnpinned) continue;

      const sessions: SessionTreeSession[] = [];
      for (const session of Object.values(sandbox.sessions)) {
        if (session.parentID || session.timeArchived) continue;

        const sessionKey = pinnedSessionStoreKey(project.id, session.id);
        const sessionLocal = store[sessionKey];
        const isSessionDirectlyPinned = typeof sessionLocal === 'number' && sessionLocal > 0;
        const isSessionUnpinned = typeof sessionLocal === 'number' && sessionLocal < 0;

        if (isSessionUnpinned) continue;

        const serverPinnedAt = session.timePinned;
        const isSessionPinned = isSessionDirectlyPinned || normalizePinnedAt(serverPinnedAt) > 0;
        const isSessionInPinnedTree = isSessionPinned || isSandboxPinned || isProjectPinned;

        if (!isSessionInPinnedTree) continue;

        const isSessionImplicitlyPinned = isSessionInPinnedTree && !isSessionPinned;
        const pinnedAt = isSessionPinned
          ? (isSessionDirectlyPinned ? (sessionLocal as number) : normalizePinnedAt(serverPinnedAt))
          : isSandboxDirectlyPinned
            ? (sandboxLocal as number)
            : (projectLocal as number);

        sessions.push({
          type: 'session',
          sessionId: session.id,
          projectId: project.id,
          directory: sandbox.directory,
          title: session.title || session.slug || session.id,
          status: (session.status ?? 'unknown') as 'busy' | 'idle' | 'retry' | 'unknown',
          pinnedAt,
          isPinned: isSessionPinned,
          isImplicitlyPinned: isSessionImplicitlyPinned,
        });
      }

      if (sessions.length === 0 && !isSandboxPinned) continue;

      sessions.sort((a, b) => {
        if (b.pinnedAt !== a.pinnedAt) return b.pinnedAt - a.pinnedAt;
        return a.title.localeCompare(b.title);
      });

      const isSandboxImplicitlyPinned = isSandboxPinned && !isSandboxDirectlyPinned;
      sandboxes.push({
        type: 'sandbox',
        directory: sandbox.directory,
        projectId: project.id,
        name: sandbox.name || 'main',
        pinnedAt: isSandboxPinned ? (isSandboxDirectlyPinned ? (sandboxLocal as number) : (projectLocal as number)) : 0,
        isPinned: isSandboxPinned && !isSandboxImplicitlyPinned,
        isImplicitlyPinned: isSandboxImplicitlyPinned,
        sessions,
      });
    }

    if (sandboxes.length === 0 && !isProjectPinned) continue;

    sandboxes.sort((a, b) => {
      const aIsPrimary = a.directory === project.worktree;
      const bIsPrimary = b.directory === project.worktree;
      if (aIsPrimary !== bIsPrimary) return aIsPrimary ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    result.push({
      type: 'project',
      projectId: project.id,
      name: projectName,
      color: resolveProjectColorHex(project.icon?.color),
      pinnedAt: typeof projectLocal === 'number' ? projectLocal : 0,
      isPinned: isProjectPinned,
      sandboxes,
    });
  }

  result.sort((a, b) => {
    if (a.pinnedAt !== b.pinnedAt) return b.pinnedAt - a.pinnedAt;
    return a.name.localeCompare(b.name);
  });

  sessionTreeDataCache.value = { data: result, hash: currentHash, timestamp: now };
  return result;
});

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
  const ids: string[] = [];
  for (const sid of allowed) {
    if (sid === selected) continue;
    const status = getSessionStatus(sid);
    if (status === 'busy' || status === 'retry') ids.push(sid);
  }
  return ids;
});

const isThinking = computed(() => {
  if (activeBackendKind.value === 'codex') {
    const status = codexApi.activeTurn.value?.status;
    return Boolean(status && status !== 'completed' && status !== 'failed' && status !== 'interrupted');
  }
  const selected = selectedSessionId.value;
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
function isProviderConnected(providerId: string) {
  return connectedProviderIds.value.includes(providerId);
}

const availableModelOptions = computed(() =>
  modelOptions.value.filter(
    (model) => {
      const providerId = model.providerID?.trim() ?? '';
      return (
        isProviderConnected(providerId) &&
        isProviderEnabled(providerId) &&
        isModelAvailable(model.id)
      );
    },
  ),
);
const hasModelOptions = computed(() => availableModelOptions.value.length > 0);
const hasThinkingOptions = computed(() => thinkingOptions.value.length > 0);

// Subagent options for @ invocation (includes subagents only, no hidden agents)
const subagentOptions = computed(() => {
  return agents.value
    .filter((agent) => agent.mode === 'subagent' && !agent.hidden)
    .map((agent) => ({
      id: agent.name,
      label: agent.name
        ? `${agent.name.charAt(0).toUpperCase()}${agent.name.slice(1)}`
        : agent.name,
      description: agent.description,
      color: agent.color,
      isSubagent: true,
    }));
});
const canAttach = computed(() => availableModelOptions.value.length > 0);
const commandOptions = computed(() => {
  const list = commands.value.slice();
  const hasShell = list.some((command) => command.name.toLowerCase() === 'shell');
  if (!hasShell) {
    list.push({
      name: 'shell',
      description: t('app.descriptions.openLocalShell'),
      source: 'local',
    });
  }
  const hasDebug = list.some((command) => command.name.toLowerCase() === 'debug');
  if (!hasDebug) {
    list.push({
      name: 'debug',
      description: t('app.menu.debugUtilities'),
      source: 'local',
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
});

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

function requireSelectedWorktree(_context: 'send') {
  const directory = getSelectedWorktreeDirectory();
  if (directory) return directory;
  const message = t('app.error.noWorktreeSelected');
  setSendStatusText(message);
  return '';
}

function ensureConnectionReady(action: string) {
  if (connectionState.value === 'ready' && uiInitState.value === 'ready') return true;
  if (connectionState.value === 'reconnecting') {
    setSendStatusRender(
      () => `${t('app.connection.reconnecting')} ${t('app.error.actionDisabled', { action })}`,
    );
  } else if (uiInitState.value === 'loading') {
    setSendStatusRender(
      () => `${t('app.error.stillLoading')} ${t('app.error.actionDisabled', { action })}`,
    );
  } else {
    setSendStatusRender(
      () => `${t('app.error.notConnected')} ${t('app.error.unavailable', { action })}`,
    );
  }
  return false;
}

function sessionSortKey(session: SessionInfo) {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function compareSessionsForSelection(a: SessionInfo, b: SessionInfo) {
  const pinDiff = getSessionEffectivePinnedAt(b) - getSessionEffectivePinnedAt(a);
  if (pinDiff !== 0) return pinDiff;
  return sessionSortKey(b) - sessionSortKey(a);
}

function pickPreferredSessionId(list: SessionInfo[]) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const sorted = list
    .filter((session) => !session.parentID && !session.time?.archived)
    .slice()
    .sort(compareSessionsForSelection);
  return sorted[0]?.id ?? '';
}

function validateSelectedSession() {
  const sessionId = selectedSessionId.value.trim();
  if (!sessionId) return;

  const projectId = selectedProjectId.value.trim();
  const allSessions = projectId ? (sessionsByProject.value[projectId] ?? []) : [];
  const current = allSessions.find((session) => session.id === sessionId);
  if (current && !current.parentID && !current.time?.archived) {
    return;
  }

  const nextSessionId = pickPreferredSessionId(
    allSessions.filter((session) => session.id !== sessionId),
  );
  selectedSessionId.value = nextSessionId;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

const resolvedTheme = computed(() => resolveTheme(opencodeTheme, 'dark'));

const visibleAgents = computed(() => agents.value.filter((a) => !a.hidden));

function resolveAgentColorForName(agentName?: string) {
  const agent = agentName ? agents.value.find((a) => a.name === agentName) : undefined;
  return resolveAgentColor(agentName ?? '', agent?.color, visibleAgents.value, resolvedTheme.value);
}

function resolveModelMetaForPath(modelPath?: string) {
  if (!modelPath) return undefined;
  const matched = modelOptions.value.find((model) => model.id === modelPath);
  if (!matched) return undefined;
  return {
    displayName: matched.displayName,
    providerLabel: matched.providerLabel,
  };
}

const currentAgentColor = computed(() => resolveAgentColorForName(selectedMode.value));

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

function normalizeIdList(values?: string[]) {
  return Array.isArray(values)
    ? values.map((value) => value.trim()).filter((value) => value.length > 0)
    : [];
}

function createEmptyModelVisibilityStore(): ModelVisibilityStore {
  return {
    user: [],
    recent: [],
    variant: {},
  };
}

function parseModelVisibilityStore(raw: string | null): ModelVisibilityStore {
  if (!raw) return createEmptyModelVisibilityStore();
  try {
    const parsed = JSON.parse(raw) as Partial<ModelVisibilityStore>;
    return {
      user: Array.isArray(parsed.user)
        ? parsed.user.filter(
            (entry): entry is ModelVisibilityEntry =>
              Boolean(entry?.providerID && entry?.modelID) &&
              (entry.visibility === 'show' || entry.visibility === 'hide'),
          )
        : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter((value): value is string => typeof value === 'string') : [],
      variant:
        parsed.variant && typeof parsed.variant === 'object' && !Array.isArray(parsed.variant)
          ? Object.fromEntries(
              Object.entries(parsed.variant).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
            )
          : {},
    };
  } catch {
    return createEmptyModelVisibilityStore();
  }
}

function modelVisibilityKey(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`;
}

function readHiddenModelsFromStorage() {
  if (typeof window === 'undefined') return [];
  const currentStore = parseModelVisibilityStore(window.localStorage.getItem(MODEL_VISIBILITY_STORAGE_KEY));
  const currentHidden = currentStore.user
    .filter((entry) => entry.visibility === 'hide')
    .map((entry) => modelVisibilityKey(entry.providerID, entry.modelID));
  if (currentHidden.length > 0) return Array.from(new Set(currentHidden)).sort();
  const legacyRaw = window.localStorage.getItem(LEGACY_DISABLED_MODELS_STORAGE_KEY);
  if (!legacyRaw) return [];
  try {
    const legacy = JSON.parse(legacyRaw) as string[];
    return Array.isArray(legacy) ? [...new Set(legacy.filter((value): value is string => typeof value === 'string'))].sort() : [];
  } catch {
    return [];
  }
}

function writeHiddenModelsToStorage(nextHiddenModels: string[]) {
  if (typeof window === 'undefined') return;
  const store = parseModelVisibilityStore(window.localStorage.getItem(MODEL_VISIBILITY_STORAGE_KEY));
  const hiddenSet = new Set(nextHiddenModels);
  const preservedUser = store.user.filter(
    (entry) => !hiddenSet.has(modelVisibilityKey(entry.providerID, entry.modelID)),
  );
  const nextUser = [
    ...preservedUser,
    ...Array.from(hiddenSet)
      .sort()
      .map((key) => {
        const { providerID, modelID } = parseProviderModelKey(key);
        return providerID && modelID ? { providerID, modelID, visibility: 'hide' as const } : null;
      })
      .filter(
        (entry): entry is { providerID: string; modelID: string; visibility: 'hide' } => Boolean(entry),
      ),
  ];
  window.localStorage.setItem(
    MODEL_VISIBILITY_STORAGE_KEY,
    JSON.stringify({
      ...store,
      user: nextUser,
    }),
  );
  window.localStorage.removeItem(LEGACY_DISABLED_MODELS_STORAGE_KEY);
}

function isModelAvailable(modelId: string) {
  return !hiddenModels.value.includes(modelId);
}

function isProviderEnabled(providerId: string) {
  if (!providerId) return true;
  const enabled = normalizeIdList(providerConfig.value?.enabled_providers);
  const disabled = new Set(normalizeIdList(providerConfig.value?.disabled_providers));
  if (enabled.length > 0) {
    return enabled.includes(providerId) && !disabled.has(providerId);
  }
  return !disabled.has(providerId);
}

function getFirstAvailableModelId() {
  return modelOptions.value.find(
    (model) => {
      const providerId = model.providerID?.trim() ?? '';
      return (
        isProviderConnected(providerId) &&
        isProviderEnabled(providerId) &&
        isModelAvailable(model.id)
      );
    },
  )?.id;
}

function ensureSelectedModelAvailable() {
  if (modelOptions.value.length === 0) return;
  const selectedInfo = modelOptions.value.find((model) => model.id === selectedModel.value);
  const selectedProviderId =
    selectedInfo?.providerID?.trim() ?? parseProviderModelKey(selectedModel.value).providerID;
  if (
    selectedInfo &&
    isModelAvailable(selectedInfo.id) &&
    isProviderConnected(selectedProviderId) &&
    isProviderEnabled(selectedProviderId)
  ) {
    return;
  }
  selectedModel.value = getFirstAvailableModelId() ?? '';
}

function applyModelVariantSelection(model: string | undefined, variant: string | undefined) {
  if (modelOptions.value.length === 0) {
    if (model) selectedModel.value = model;
    selectedThinking.value = variant;
    return;
  }

  if (model && modelOptions.value.some((option) => option.id === model)) {
    selectedModel.value = model;
  }

  if (!selectedModel.value && modelOptions.value.length > 0) {
    selectedModel.value = modelOptions.value[0]?.id ?? '';
  }

  const selectedInfo = modelOptions.value.find((option) => option.id === selectedModel.value);
  const nextThinkingOptions = buildThinkingOptions(selectedInfo?.variants);
  const sameThinking =
    nextThinkingOptions.length === thinkingOptions.value.length &&
    nextThinkingOptions.every((value, index) => value === thinkingOptions.value[index]);
  if (!sameThinking) thinkingOptions.value = nextThinkingOptions;

  if (nextThinkingOptions.includes(variant)) {
    selectedThinking.value = variant;
  } else {
    selectedThinking.value = nextThinkingOptions[0];
  }
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

function normalizeStoredAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const filename = typeof record.filename === 'string' ? record.filename.trim() : '';
  const mime = typeof record.mime === 'string' ? record.mime.trim() : '';
  const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
  const rawLineComment = record.lineComment;
  let lineComment: LineCommentData | undefined;
  if (rawLineComment !== undefined) {
    if (!rawLineComment || typeof rawLineComment !== 'object') return null;
    const lineCommentRecord = rawLineComment as Record<string, unknown>;
    const path = typeof lineCommentRecord.path === 'string' ? lineCommentRecord.path : '';
    const startLine = typeof lineCommentRecord.startLine === 'number' ? lineCommentRecord.startLine : Number.NaN;
    const endLine = typeof lineCommentRecord.endLine === 'number' ? lineCommentRecord.endLine : Number.NaN;
    const line = typeof lineCommentRecord.line === 'number' ? lineCommentRecord.line : Number.NaN;
    // Support both old (line) and new (startLine/endLine) formats
    const resolvedStartLine = Number.isFinite(startLine) ? startLine : line;
    const resolvedEndLine = Number.isFinite(endLine) ? endLine : line;
    const text = typeof lineCommentRecord.text === 'string' ? lineCommentRecord.text : '';
    if (!path || !Number.isFinite(resolvedStartLine) || !Number.isFinite(resolvedEndLine) || typeof lineCommentRecord.text !== 'string') return null;
    lineComment = { path, startLine: resolvedStartLine, endLine: resolvedEndLine, text };
  }
  if (!id || !filename || !mime || (!dataUrl && !lineComment)) return null;
  return { id, filename, mime, dataUrl, lineComment };
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

function readPinnedSessionStore() {
  const raw = storageGet(StorageKeys.state.pinnedSessions);
  return parsePinnedSessionStore(raw, 10000);
}

function writePinnedSessionStore(store: LocalPinnedSessionStore) {
  const limitedStore = limitPinnedSessionStore(store, 10000);
  if (Object.keys(limitedStore).length === 0) {
    storageRemove(StorageKeys.state.pinnedSessions);
    return;
  }
  const nextRaw = JSON.stringify(limitedStore);
  const currentRaw = storageGet(StorageKeys.state.pinnedSessions);
  if (currentRaw === nextRaw) return;
  storageSet(StorageKeys.state.pinnedSessions, nextRaw);
}

let queuedPinnedSessionStoreWrite: LocalPinnedSessionStore | null = null;
let pinnedSessionStoreWriteScheduled = false;

function schedulePinnedSessionStoreWrite(store: LocalPinnedSessionStore) {
  queuedPinnedSessionStoreWrite = store;
  if (pinnedSessionStoreWriteScheduled) return;
  pinnedSessionStoreWriteScheduled = true;
  queueMicrotask(() => {
    pinnedSessionStoreWriteScheduled = false;
    const nextStore = queuedPinnedSessionStoreWrite;
    queuedPinnedSessionStoreWrite = null;
    if (!nextStore) return;
    writePinnedSessionStore(nextStore);
  });
}

function readSessionTreeExpandedPaths(): string[] {
  try {
    const raw = storageGet(StorageKeys.state.sessionTreeExpanded);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function writeSessionTreeExpandedPaths(paths: string[]) {
  const currentRaw = storageGet(StorageKeys.state.sessionTreeExpanded);
  const nextRaw = JSON.stringify(paths);
  if (currentRaw === nextRaw) return;
  storageSet(StorageKeys.state.sessionTreeExpanded, nextRaw);
}

function collectLiveSandboxDirectoriesByProject(projects: Record<string, ProjectState>) {
  const result: Record<string, string[]> = {};
  Object.values(projects).forEach((project) => {
    result[project.id] = Object.keys(project.sandboxes)
      .map((directory) => normalizeDirectory(directory))
      .filter((directory): directory is string => Boolean(directory));
  });
  return result;
}

function getSessionPinnedOverride(projectId: string, sessionId: string) {
  const key = pinnedSessionStoreKey(projectId, sessionId);
  if (!key) return undefined;
  return localPinnedSessionStore.value[key];
}

function getEffectiveSessionPinnedAt(
  projectId: string,
  sessionId: string,
  serverPinnedAt?: number,
  directory?: string,
) {
  const store = localPinnedSessionStore.value;
  const key = pinnedSessionStoreKey(projectId, sessionId);
  if (key && key in store) {
    const localValue = store[key];
    if (typeof localValue === 'number' && localValue !== 0) {
      return normalizePinnedAt(localValue);
    }
  }
  if (directory) {
    const sandboxKey = sandboxPinKey(projectId, directory);
    if (sandboxKey && sandboxKey in store && store[sandboxKey] > 0) {
      return store[sandboxKey];
    }
  }
  const projectKey = projectPinKey(projectId);
  if (projectKey && projectKey in store && store[projectKey] > 0) {
    return store[projectKey];
  }
  return normalizePinnedAt(serverPinnedAt);
}

function getSessionEffectivePinnedAt(session: SessionInfo) {
  const projectId = (session.projectID || session.projectId || '').trim();
  return getEffectiveSessionPinnedAt(projectId, session.id, session.time?.pinned);
}

function setLocalPinnedSession(projectId: string, sessionId: string, pinnedAt: number) {
  const key = pinnedSessionStoreKey(projectId, sessionId);
  if (!key) return;
  localPinnedSessionStore.value = limitPinnedSessionStore({
    ...localPinnedSessionStore.value,
    [key]: pinnedAt,
  }, 10000);
}

function setLocalUnpinnedSession(projectId: string, sessionId: string) {
  const key = pinnedSessionStoreKey(projectId, sessionId);
  if (!key) return;
  localPinnedSessionStore.value = {
    ...localPinnedSessionStore.value,
    [key]: -Date.now(),
  };
}

function clearLocalPinnedSessionOverride(projectId: string, sessionId: string) {
  const key = pinnedSessionStoreKey(projectId, sessionId);
  if (!key || !(key in localPinnedSessionStore.value)) return;
  const next = { ...localPinnedSessionStore.value };
  delete next[key];
  localPinnedSessionStore.value = next;
}

function restoreLocalPinnedSessionOverride(
  projectId: string,
  sessionId: string,
  previousOverride?: number,
) {
  if (typeof previousOverride === 'number' && Number.isFinite(previousOverride) && previousOverride !== 0) {
    const key = pinnedSessionStoreKey(projectId, sessionId);
    if (!key) return;
    localPinnedSessionStore.value = {
      ...localPinnedSessionStore.value,
      [key]: previousOverride,
    };
    return;
  }
  clearLocalPinnedSessionOverride(projectId, sessionId);
}

function clearNegativeSandboxAndSessionOverridesForProject(
  projectId: string,
  store: LocalPinnedSessionStore,
) {
  const project = serverState.projects[projectId];
  if (!project) return store;

  let next = store;
  for (const sandbox of (Object.values(project.sandboxes) as SandboxState[])) {
    const sandboxKey = sandboxPinKey(projectId, sandbox.directory);
    if (sandboxKey && next[sandboxKey] < 0) {
      if (next === store) next = { ...store };
      delete next[sandboxKey];
    }

    for (const session of Object.values(sandbox.sessions)) {
      const sessionKey = pinnedSessionStoreKey(projectId, session.id);
      if (sessionKey && next[sessionKey] < 0) {
        if (next === store) next = { ...store };
        delete next[sessionKey];
      }
    }
  }

  return next;
}

function clearNegativeSessionOverridesForSandbox(
  projectId: string,
  directory: string,
  store: LocalPinnedSessionStore,
) {
  const sandbox = serverState.projects[projectId]?.sandboxes?.[directory];
  if (!sandbox) return store;

  let next = store;
  const sandboxKey = sandboxPinKey(projectId, directory);
  if (sandboxKey && next[sandboxKey] < 0) {
    if (next === store) next = { ...store };
    delete next[sandboxKey];
  }

  for (const session of Object.values(sandbox.sessions)) {
    const sessionKey = pinnedSessionStoreKey(projectId, session.id);
    if (sessionKey && next[sessionKey] < 0) {
      if (next === store) next = { ...store };
      delete next[sessionKey];
    }
  }

  return next;
}

function clearSandboxAndSessionOverridesForProject(
  projectId: string,
  store: LocalPinnedSessionStore,
) {
  const project = serverState.projects[projectId];
  if (!project) return store;

  let next = store;
  for (const sandbox of (Object.values(project.sandboxes) as SandboxState[])) {
    const sandboxKey = sandboxPinKey(projectId, sandbox.directory);
    if (sandboxKey && sandboxKey in next) {
      if (next === store) next = { ...store };
      delete next[sandboxKey];
    }

    for (const session of Object.values(sandbox.sessions)) {
      const sessionKey = pinnedSessionStoreKey(projectId, session.id);
      if (sessionKey && sessionKey in next) {
        if (next === store) next = { ...store };
        delete next[sessionKey];
      }
    }
  }

  return next;
}

function clearSessionOverridesForSandbox(
  projectId: string,
  directory: string,
  store: LocalPinnedSessionStore,
) {
  const sandbox = serverState.projects[projectId]?.sandboxes?.[directory];
  if (!sandbox) return store;

  let next = store;
  for (const session of Object.values(sandbox.sessions)) {
    const sessionKey = pinnedSessionStoreKey(projectId, session.id);
    if (sessionKey && sessionKey in next) {
      if (next === store) next = { ...store };
      delete next[sessionKey];
    }
  }

  return next;
}

function reconcileLocalPinnedSessionStore() {
  if (!bootstrapReady.value) return;
  const currentStore = localPinnedSessionStore.value;
  if (Object.keys(currentStore).length === 0) return;
  const nextStore = reconcilePinnedSessionStore(
    currentStore,
    serverState.projects,
    10000,
  );

  if (isSamePinnedSessionStore(currentStore, nextStore)) return;
  localPinnedSessionStore.value = nextStore;
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

function readSidePanelCollapsed() {
  const raw = storageGet(StorageKeys.state.sidePanelCollapsed);
  return raw === '1';
}

function persistSidePanelCollapsed(value: boolean) {
  storageSet(StorageKeys.state.sidePanelCollapsed, value ? '1' : '0');
}

function readSidePanelTab(): 'todo' | 'session' | 'tree' {
  const raw = storageGet(StorageKeys.state.sidePanelTab);
  if (raw === 'todo' || raw === 'session' || raw === 'tree') return raw;
  return 'tree';
}

function persistSidePanelTab(value: 'todo' | 'session' | 'tree') {
  storageSet(StorageKeys.state.sidePanelTab, value);
}

function toggleSidePanelCollapsed() {
  sidePanelCollapsed.value = !sidePanelCollapsed.value;
  sidePanelWidth.value = null;
  persistSidePanelCollapsed(sidePanelCollapsed.value);
  nextTick(() => {
    syncFloatingExtent();
    scheduleShellFitAll();
  });
}

function setSidePanelTab(value: 'todo' | 'session' | 'tree') {
  if (sidePanelActiveTab.value === value) return;
  sidePanelActiveTab.value = value;
  persistSidePanelTab(value);
}

function findSessionInProjects(sessionId: string) {
  const target = sessionId.trim();
  if (!target) return null;
  return sessionLocationById.value.get(target) ?? null;
}

function resolveSessionOperationPayload(sessionId: string, projectIdHint?: string, directoryHint?: string) {
  const resolved = findSessionInProjects(sessionId);
  const projectId = (projectIdHint || resolved?.projectId || resolveProjectIdForSession(sessionId)).trim();
  const directory = (directoryHint || resolved?.sandbox.directory || activeDirectory.value).trim();
  return {
    projectId,
    directory: directory || undefined,
  };
}

function resolveProjectIdForSession(sessionId: string) {
  return findSessionInProjects(sessionId)?.projectId ?? '';
}

function clearComposerInputState() {
  messageInput.value = '';
  attachments.value = [];
}

function draftKeyForSelectedContext() {
  return selectedSessionId.value;
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

  const modelToApply =
    draft.model && availableModelOptions.value.some((model) => model.id === draft.model)
      ? draft.model
      : undefined;
  applyModelVariantSelection(modelToApply, draft.variant);
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
    if (match && availableModelOptions.value.some((option) => option.id === match.id)) {
      applyModelVariantSelection(match.id, agent?.variant);
    }
  }
}

function resolveDefaultAgentModel(): { agent: string; model: string; variant: string | undefined } {
  // Determine the default agent: prefer 'build' if it exists, otherwise use first available
  const defaultAgent =
    agentOptions.value.find((o) => o.id === 'build')?.id ?? agentOptions.value[0]?.id ?? '';

  // Set the agent and apply its defaults (model + variant)
  selectedMode.value = defaultAgent;
  applyAgentDefaults(defaultAgent);

  // If model is still empty after applyAgentDefaults, fall back to provider default or first model
  if (!selectedModel.value && modelOptions.value.length > 0) {
    // Try to find a model from provider defaults
    const providers_data = providers.value;
    const defaults = providers_data.length > 0 ? ((providers_data[0] as any)?.default ?? {}) : {};
    const preferredModelId = Object.entries(defaults)
      .map(([providerID, modelID]) => {
        const match = availableModelOptions.value.find(
          (m) => m.providerID === providerID && m.modelID === modelID,
        );
        return match?.id;
      })
      .find((id) => Boolean(id));

    selectedModel.value = preferredModelId || availableModelOptions.value[0]?.id || '';
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

function handleApplyHistoryEntry(entry: {
  text: string;
  agent?: string;
  model?: string;
  variant?: string;
}) {
  messageInput.value = entry.text;
  if (entry.agent && agentOptions.value.some((option) => option.id === entry.agent)) {
    selectedMode.value = entry.agent;
    applyAgentDefaults(entry.agent);
  }
  applyModelVariantSelection(entry.model, entry.variant);
  persistComposerDraftForCurrentContext();
}

function handleSelectedModelUpdate(value: string) {
  if (value && !availableModelOptions.value.some((option) => option.id === value)) return;
  selectedModel.value = value;
  nextTick(() => {
    persistComposerDraftForCurrentContext();
  });
}

function handleModelVisibilityUpdate(next: ModelVisibilityEntry[]) {
  hiddenModels.value = next
    .filter((entry) => entry.visibility === 'hide')
    .map((entry) => modelVisibilityKey(entry.providerID, entry.modelID))
    .sort();
  ensureSelectedModelAvailable();
  nextTick(() => {
    persistComposerDraftForCurrentContext();
  });
}

function handleProviderConfigUpdated(next: ProviderConfigState) {
  providerConfig.value = next ?? null;
  ensureSelectedModelAvailable();
}

async function handleProvidersChanged() {
  await fetchProviders(true);
}

async function fetchGlobalProviderConfig() {
  try {
    if (activeBackendKind.value === 'codex') {
      await codexApi.refreshConfig();
      providerConfig.value = (codexApi.config.value as ProviderConfigState | null) ?? null;
      return;
    }
    const getGlobalConfig = requireBackendMethod(backend().getGlobalConfig, 'global config');
    const data = (await getGlobalConfig()) as ProviderConfigState;
    providerConfig.value = data ?? null;
  } catch (error) {
    log('Provider config load failed', error);
  }
}

function handleModelVisibilityStorage(event: StorageEvent) {
  if (event.key !== MODEL_VISIBILITY_STORAGE_KEY && event.key !== LEGACY_DISABLED_MODELS_STORAGE_KEY) return;
  try {
    hiddenModels.value = readHiddenModelsFromStorage();
    ensureSelectedModelAvailable();
  } catch {
    hiddenModels.value = [];
  }
}

function handleSelectedThinkingUpdate(value: string | undefined) {
  selectedThinking.value = value;
  persistComposerDraftForCurrentContext();
}

function handleComposerDraftStorage(event: StorageEvent) {
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

function handlePinnedSessionStoreStorage(event: StorageEvent) {
  if (event.key !== storageKey(StorageKeys.state.pinnedSessions)) return;
  const nextStore = limitPinnedSessionStore(
    parsePinnedSessionStore(event.newValue, 10000),
    10000,
  );
  if (isSamePinnedSessionStore(localPinnedSessionStore.value, nextStore)) return;
  localPinnedSessionStore.value = nextStore;
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
  const contextKey = forkedSession.id.trim();
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
  const preferredProjectId = projectId?.trim() || resolveProjectIdForSession(sessionId);
  const candidates = preferredProjectId
    ? (sessionsByProject.value[preferredProjectId] ?? [])
    : Object.values(sessionsByProject.value).flat();
  const found = candidates.find((session) => session.id === sessionId);
  const status = found?.status;
  return status === 'busy' || status === 'idle' || status === 'retry' ? status : undefined;
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

function splitFontFamilyList(fontFamily: string) {
  return fontFamily
    .split(',')
    .map((family) => family.trim())
    .filter((family) => family.length > 0);
}

function getTerminalWindowSize() {
  const cellWidth = measureTerminalCellWidth(terminalFontFamily.value, TERM_FONT_SIZE_PX.value);
  const lineHeightPx = TERM_FONT_SIZE_PX.value * TERM_LINE_HEIGHT;
  const gutterWidthPx = TERM_FONT_SIZE_PX.value * TERM_GUTTER_WIDTH_EM;
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
  canvas.style.setProperty('--term-font-family', terminalFontFamily.value);
  canvas.style.setProperty('--term-font-size', `${terminalFontSizePx.value}px`);
  canvas.style.setProperty('--term-line-height', String(TERM_LINE_HEIGHT));
  canvas.style.setProperty('--term-width', `${width}px`);
  canvas.style.setProperty('--term-height', `${height}px`);
}

function syncAppMonospaceMetrics() {
  const app = appEl.value;
  if (app) {
    app.style.setProperty('--app-monospace-font-family', appMonospaceFontFamily.value);
    app.style.setProperty('--app-monospace-font-size', `${appFontSizePx.value}px`);
    app.style.setProperty('--message-font-size', `${messageFontSizePx.value}px`);
    app.style.setProperty('--ui-font-size', `${uiFontSizePx.value}px`);
  }
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty(
      '--app-monospace-font-family',
      appMonospaceFontFamily.value,
    );
    document.documentElement.style.setProperty(
      '--app-monospace-font-size',
      `${appFontSizePx.value}px`,
    );
    document.documentElement.style.setProperty(
      '--message-font-size',
      `${messageFontSizePx.value}px`,
    );
    document.documentElement.style.setProperty(
      '--ui-font-size',
      `${uiFontSizePx.value}px`,
    );
  }
}

async function waitForTerminalFontsReady(fontFamily = terminalFontFamily.value) {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const fontSet = document.fonts;
  const requestedFonts = splitFontFamilyList(fontFamily).map((family) =>
    fontSet.load(`${TERM_FONT_SIZE_PX.value}px ${family}`)
  );
  await Promise.allSettled(requestedFonts);
  await fontSet.ready;
}

async function refreshOpenShellFonts() {
  await waitForTerminalFontsReady();
  shellSessionsByPtyId.forEach((session) => {
    session.terminal.options.fontFamily = terminalFontFamily.value;
    session.terminal.options.fontSize = TERM_FONT_SIZE_PX.value;
    session.terminal.options.lineHeight = TERM_LINE_HEIGHT;
    session.terminal.refresh(0, Math.max(0, session.terminal.rows - 1));
  });
  syncCanvasTermMetrics();
  scheduleShellFitAll();
}

function handleWindowResize() {
  if (windowResizeFrameId !== null) return;
  windowResizeFrameId = requestAnimationFrame(() => {
    windowResizeFrameId = null;
    syncCanvasTermMetrics();
    syncFloatingExtent();
    scheduleShellFitAll();
  });
}

function syncFloatingExtent() {
  const canvas = toolWindowCanvasEl.value;
  const header = document.querySelector('.app-header') as HTMLElement | null;
  const input = inputEl.value;
  if (!canvas || !header || !input) return;
  const headerRect = header.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();
  const headerBottom = headerRect.bottom;
  const inputTop = inputRect.top;
  const dockReserved = 0;
  const topOffset = Math.max(0, headerBottom);
  const availableHeight = Math.max(0, inputTop - headerBottom);
  canvas.style.setProperty('--canvas-top', `${topOffset}px`);
  canvas.style.setProperty('--canvas-height', `${availableHeight}px`);
  canvas.style.setProperty('--dock-reserved', `${dockReserved}px`);
  canvas.style.setProperty('--tool-area-height', `${Math.max(0, availableHeight - dockReserved)}px`);
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

function generateAttachmentId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t('app.error.fileReadFailed')));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error(t('app.error.fileReadFailed')));
    };
    reader.readAsDataURL(file);
  });
}

function normalizeAttachmentMime(mime: string) {
  const normalized = mime.trim().toLowerCase();
  if (!normalized) return 'text/plain';
  if (normalized.startsWith('image/')) return normalized;
  if (normalized === 'application/pdf') return normalized;
  return 'text/plain';
}

async function handleAddAttachments(files: File[]) {
  const accepted = files.filter((file) => file.size > 0 || file.type.length > 0 || file.name.length > 0);
  if (accepted.length === 0) {
    setSendStatusKey('app.error.unsupportedAttachment');
    return;
  }
  try {
    const next = await Promise.all(
        accepted.map(async (file) => ({
          id: generateAttachmentId(),
          filename: file.name || 'image',
          mime: normalizeAttachmentMime(file.type || 'text/plain'),
          dataUrl: await readFileAsDataUrl(file),
        })),
    );
    attachments.value = [...attachments.value, ...next];
    persistComposerDraftForCurrentContext();
  } catch (error) {
    setSendStatusKey('app.error.attachmentFailed', { message: toErrorMessage(error) });
  }
}

function addLineComment(payload: { path: string; startLine: number; endLine: number; text: string }) {
  const basename = payload.path.split(/[\\/]/).pop() || payload.path;
  const lineLabel = payload.startLine === payload.endLine
    ? `${payload.startLine}`
    : `${payload.startLine}-${payload.endLine}`;
  const attachment: Attachment = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    filename: `${basename}:${lineLabel}`,
    mime: 'text/x-line-comment',
    dataUrl: '',
    lineComment: {
      path: payload.path,
      startLine: payload.startLine,
      endLine: payload.endLine,
      text: payload.text,
    },
  };
  attachments.value.push(attachment);
  persistComposerDraftForCurrentContext();
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((item) => item.id !== id);
  persistComposerDraftForCurrentContext();
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

function startSidePanelResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const body = appBodyEl.value;
  const panel = sidePanelAreaEl.value;
  if (!body || !panel) return;
  const bodyRect = body.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const style = getComputedStyle(body);
  const gap = parseFloat(style.getPropertyValue('--todo-panel-gap')) || 10;
  const currentWidth = panelRect.width;
  const minW = 160;
  const maxW = Math.max(minW, bodyRect.width * 0.5 - gap);
  sidePanelResizeState.value = {
    startX: event.clientX,
    startWidth: currentWidth,
    minWidth: minW,
    maxWidth: maxW,
  };
  sidePanelWidth.value = currentWidth;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function handlePointerMove(event: PointerEvent) {
  pendingPointerEvent = event;
  if (pointerMoveFrameId !== null) return;
  pointerMoveFrameId = requestAnimationFrame(() => {
    pointerMoveFrameId = null;
    const nextEvent = pendingPointerEvent;
    pendingPointerEvent = null;
    if (!nextEvent) return;
    applyPointerResize(nextEvent);
  });
}

function applyPointerResize(event: PointerEvent) {
  if (sidePanelResizeState.value) {
    const { startX, startWidth, minWidth, maxWidth } = sidePanelResizeState.value;
    const dx = event.clientX - startX;
    sidePanelWidth.value = clamp(startWidth + dx, minWidth, maxWidth);
    flushResizeSideEffects();
    return;
  }
  if (inputResizeState.value) {
    const { startY, startHeight, minHeight, maxHeight } = inputResizeState.value;
    const dy = event.clientY - startY;
    inputHeight.value = clamp(startHeight - dy, minHeight, maxHeight);
    flushResizeSideEffects();
    return;
  }
}

function handlePointerUp() {
  if (pointerMoveFrameId !== null) {
    cancelAnimationFrame(pointerMoveFrameId);
    pointerMoveFrameId = null;
  }
  const nextEvent = pendingPointerEvent;
  pendingPointerEvent = null;
  if (nextEvent) applyPointerResize(nextEvent);
  if (inputResizeState.value) scheduleShellFitAllNextFrame();
  inputResizeState.value = null;
  if (sidePanelResizeState.value) scheduleShellFitAllNextFrame();
  sidePanelResizeState.value = null;
}

function resolveProjectIdForDirectory(directory?: string) {
  const normalized = directory?.trim() || '';
  if (!normalized) return '';
  for (const [projectId, project] of Object.entries(serverState.projects)) {
    if (project.worktree === normalized) return projectId;
    if (project.sandboxes[normalized]) return projectId;
  }
  return '';
}

async function fetchHomePath() {
  try {
    const getPathInfo = requireBackendMethod(backend().getPathInfo, 'path info');
    const data = (await getPathInfo()) as {
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

function handleEditProject(payload: { projectId: string; worktree: string }) {
  editingProject.value = payload;
}

async function handleSaveProject(payload: {
  projectId: string;
  worktree: string;
  name: string;
  icon: { color: string; override: string };
  commands: { start: string };
}) {
  try {
    await openCodeApi.updateProject(payload.projectId, {
      directory: payload.worktree,
      name: payload.name,
      icon: payload.icon,
      commands: payload.commands,
    });
    editingProject.value = null;
  } catch (error) {
    console.error('Failed to update project:', error);
  }
}

async function createSessionInDirectory(directory: string) {
  if (activeBackendKind.value === 'codex') {
    const codexDirectory = normalizeProjectDirectoryForActiveBackend(directory);
    const existing = codexSessionCreationByDirectory.get(codexDirectory);
    if (existing) return existing;
    const creation = (async () => {
      const thread = await codexApi.startThread(codexDirectory);
      if (!thread?.id) return undefined;
      selectedProjectId.value = CODEX_PROJECT_ID;
      selectedSessionId.value = thread.id;
      return {
        id: thread.id,
        projectID: CODEX_PROJECT_ID,
        directory: normalizeProjectDirectoryForActiveBackend(thread.cwd || codexDirectory),
        title: thread.name || thread.preview || thread.id,
      } as SessionInfo;
    })().finally(() => {
      codexSessionCreationByDirectory.delete(codexDirectory);
    });
    codexSessionCreationByDirectory.set(codexDirectory, creation);
    return creation;
  }
  const session = await openCodeApi.createSession(directory);
  if (!session?.id) return undefined;
  const nextProjectId = (session.projectID || selectedProjectId.value).trim();
  if (nextProjectId) {
    selectedProjectId.value = nextProjectId;
  }
  selectedSessionId.value = session.id;
  return session;
}

async function createWorktreeFromWorktree(worktree: string) {
  if (!ensureConnectionReady(t('app.actions.creatingWorktree'))) return;
  worktreeError.value = '';
  if (!worktree) {
    worktreeError.value = t('app.error.worktreeBaseNotSet');
    return;
  }
  try {
    const data = (await openCodeApi.createWorktree({
      directory: worktree,
      projectId: selectedProjectId.value,
    })) as WorktreeInfo;
    if (data && typeof data.directory === 'string') {
      await createSessionInDirectory(data.directory);
    }
  } catch (error) {
    worktreeError.value = t('app.error.worktreeCreateFailed', { message: toErrorMessage(error) });
  }
}

async function deleteWorktree(payload: { projectId?: string; worktree: string; directory: string }) {
  if (!ensureConnectionReady(t('app.actions.deletingWorktree'))) return;
  worktreeError.value = '';
  const targetDir = normalizeDirectory(payload.directory);
  const baseDir = normalizeDirectory(payload.worktree);
  const projectId =
    payload.projectId?.trim() ||
    resolveProjectIdForDirectory(targetDir) ||
    resolveProjectIdForDirectory(baseDir) ||
    selectedProjectId.value.trim();
  if (!targetDir) return;
  if (!baseDir) {
    worktreeError.value = t('app.error.worktreeBaseNotSet');
    return;
  }
  if (baseDir && targetDir === baseDir) return;
  const previousDeletedStore = deletedSandboxStore.value;
  deletedSandboxStore.value = markSandboxDeleted(previousDeletedStore, projectId, targetDir);
  writeDeletedSandboxStore(deletedSandboxStore.value);
  try {
    await openCodeApi.deleteWorktree({
      directory: baseDir,
      targetDirectory: targetDir,
      projectId,
    });

    ge.sendToWorker({
      type: 'sandbox.deleted',
      projectId,
      directory: targetDir,
    });

    const affectedProject = serverState.projects[projectId];
    if (affectedProject?.sandboxes?.[targetDir]) {
      delete affectedProject.sandboxes[targetDir];
    }

    if (normalizeDirectory(activeDirectory.value) === targetDir) {
      const candidates = (sessionsByProject.value[projectId] ?? []).filter((session) => {
        if (session.parentID || session.time?.archived) return false;
        const sessionDirectory = normalizeDirectory(session.directory || baseDir);
        return sessionDirectory !== targetDir;
      });
      const nextSessionId = pickPreferredSessionId(candidates);
      if (projectId && nextSessionId) {
        selectedProjectId.value = projectId;
        selectedSessionId.value = nextSessionId;
      } else {
        await createSessionInDirectory(baseDir);
      }
    }
  } catch (error) {
    deletedSandboxStore.value = previousDeletedStore;
    writeDeletedSandboxStore(deletedSandboxStore.value);
    worktreeError.value = t('app.error.worktreeDeleteFailed', { message: toErrorMessage(error) });
  }
}

async function openProjectPicker() {
  if (activeBackendKind.value === 'codex') {
    const home = await codexApi.refreshHomeDir(true);
    if (home) homePath.value = home;
  }
  isProjectPickerOpen.value = true;
}

async function createNewSession(): Promise<SessionInfo | undefined> {
  if (!ensureConnectionReady(t('app.actions.creatingSession'))) return undefined;
  sessionError.value = '';
  try {
    const directory = activeDirectory.value.trim();
    if (!directory) {
      throw new Error(t('errors.sessionCreateEmptyDirectory'));

    }
    if (activeBackendKind.value === 'codex') {
      return await createSessionInDirectory(directory);
    }
    const data = await openCodeApi.createSession(directory);
    if (data && typeof data.id === 'string') {
      const nextProjectId = (data.projectID || selectedProjectId.value).trim();
      if (nextProjectId) {
        selectedProjectId.value = nextProjectId;
      }
      selectedSessionId.value = data.id;
    }
    return data;
  } catch (error) {
    sessionError.value = t('app.error.sessionCreateFailed', { message: toErrorMessage(error) });
    return undefined;
  }
}

async function handleNewSessionInSandbox(payload: { worktree: string; directory: string }) {
  await createSessionInDirectory(payload.directory);
}

function handleTopPanelSessionSelect(payload: {
  projectId?: string;
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
  const projectId =
    payload.projectId ||
    resolveProjectIdForDirectory(payload.directory) ||
    resolveProjectIdForDirectory(payload.worktree) ||
    selectedProjectId.value;
  void switchSessionSelection(projectId, payload.sessionId);
}

function handleNotificationSessionSelect() {
  const queue = notificationSessionOrder.value.filter((key) => {
    const entry = serverState.notifications[key];
    return Boolean(entry && entry.requestIds.length > 0);
  });
  if (queue.length === 0) return;
  const currentSessionId = selectedSessionId.value;
  const nextKey = queue.find((key) => key !== currentSessionId) ?? queue[0];
  if (!nextKey) return;
  const entry = serverState.notifications[nextKey];
  if (!entry) return;
  void switchSessionSelection(entry.projectId.trim(), entry.sessionId.trim());
}

async function deleteSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
  if (!ensureConnectionReady(t('app.actions.deletingSession'))) return;
  sessionError.value = '';
  if (!sessionId) return;
  let optimisticProjectId = '';
  let previousOverride: number | undefined;
  try {
    const { projectId, directory } = resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    optimisticProjectId = projectId;
    previousOverride = getSessionPinnedOverride(projectId, sessionId);
    clearLocalPinnedSessionOverride(projectId, sessionId);
    await openCodeApi.deleteSession({
      sessionId,
      projectId,
      directory,
    });
  } catch (error) {
    if (optimisticProjectId) {
      restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
    }
    sessionError.value = t('app.error.sessionDeleteFailed', { message: toErrorMessage(error) });
  }
}

async function archiveSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
  if (!ensureConnectionReady(t('app.actions.archivingSession'))) return;
  sessionError.value = '';
  if (!sessionId) return;
  let optimisticProjectId = '';
  let previousOverride: number | undefined;
  try {
    if (activeBackendKind.value === 'codex') {
      await codexApi.archiveThread(sessionId);
      if (selectedSessionId.value === sessionId) {
        selectedSessionId.value = codexApi.activeThreadId.value || codexApi.visibleThreads.value[0]?.id || '';
      }
      return;
    }
    const { projectId, directory } = resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    optimisticProjectId = projectId;
    previousOverride = getSessionPinnedOverride(projectId, sessionId);
    clearLocalPinnedSessionOverride(projectId, sessionId);
    await openCodeApi.archiveSession({
      sessionId,
      projectId,
      directory,
    });
  } catch (error) {
    if (optimisticProjectId) {
      restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
    }
    sessionError.value = t('app.error.sessionArchiveFailed', { message: toErrorMessage(error) });
  }
}

async function unarchiveSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
  if (!ensureConnectionReady(t('app.actions.unarchivingSession'))) return;
  sessionError.value = '';
  if (!sessionId) return;
  let optimisticProjectId = '';
  let previousOverride: number | undefined;
  try {
    if (activeBackendKind.value === 'codex') {
      await codexApi.unarchiveThread(sessionId);
      selectedSessionId.value = codexApi.activeThreadId.value || sessionId;
      return;
    }
    const { projectId, directory } = resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    optimisticProjectId = projectId;
    previousOverride = getSessionPinnedOverride(projectId, sessionId);
    clearLocalPinnedSessionOverride(projectId, sessionId);
    await openCodeApi.unarchiveSession({
      sessionId,
      projectId,
      directory,
    });
  } catch (error) {
    if (optimisticProjectId) {
      restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
    }
    sessionError.value = t('app.error.sessionUnarchiveFailed', { message: toErrorMessage(error) });
  }
}

async function renameSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
  if (!ensureConnectionReady(t('app.actions.renamingSession'))) return;
  sessionError.value = '';
  if (!sessionId) return;
  try {
    const resolved = findSessionInProjects(sessionId);
    const currentTitle =
      resolved?.session.title?.trim() ||
      resolved?.session.slug?.trim() ||
      sessionId;
    const nextTitle = await showPrompt(t('topPanel.sessionActions.rename'), currentTitle);
    if (nextTitle === null) return;
    const trimmedTitle = nextTitle.trim();
    if (!trimmedTitle || trimmedTitle === currentTitle) return;
    if (activeBackendKind.value === 'codex') {
      await codexApi.setThreadName(sessionId, trimmedTitle);
      return;
    }
    const { projectId, directory } = resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    await openCodeApi.renameSession({
      sessionId,
      projectId,
      directory,
      title: trimmedTitle,
    });
  } catch (error) {
    sessionError.value = t('app.error.sessionRenameFailed', { message: toErrorMessage(error) });
  }
}

async function pinSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
  if (!ensureConnectionReady(t('app.actions.pinningSession'))) return;
  sessionError.value = '';
  if (!sessionId) return;
  let optimisticProjectId = '';
  let previousOverride: number | undefined;
  try {
    if (activeBackendKind.value === 'codex') {
      codexApi.pinThread(sessionId);
      return;
    }
    const { projectId, directory } = resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    optimisticProjectId = projectId;
    previousOverride = getSessionPinnedOverride(projectId, sessionId);
    const pinnedAt = Date.now();
    setLocalPinnedSession(projectId, sessionId, pinnedAt);
    await openCodeApi.pinSession({
      sessionId,
      projectId,
      directory,
      pinnedAt,
    });
  } catch (error) {
    if (optimisticProjectId) {
      restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
    }
    sessionError.value = t('app.error.sessionPinFailed', { message: toErrorMessage(error) });
  }
}

async function unpinSession(
  sessionId: string,
  hints?: { projectId?: string; directory?: string },
) {
  if (!sessionId) return;

  if (activeBackendKind.value === 'codex') {
    codexApi.unpinThread(sessionId);
    return;
  }

  const { projectId, directory } = resolveSessionOperationPayload(
    sessionId,
    hints?.projectId,
    hints?.directory,
  );
  const sessionKey = pinnedSessionStoreKey(projectId, sessionId);
  const isDirectlyPinned = sessionKey && localPinnedSessionStore.value[sessionKey] > 0;

  if (!isDirectlyPinned) {
    // Implicitly pinned via parent project/sandbox: add unpin override and cascade upward
    const next = { ...localPinnedSessionStore.value };
    if (sessionKey) next[sessionKey] = -Date.now();

    // Cascade: if no other visible sessions remain in this sandbox, unpin the sandbox
    if (directory) {
      const sandboxKey = sandboxPinKey(projectId, directory);
      const isSandboxDirectlyPinned = sandboxKey && next[sandboxKey] > 0;

      if (!isSandboxDirectlyPinned) {
        const project = serverState.projects[projectId];
        const sandbox = project?.sandboxes?.[directory];
        if (sandbox) {
          let hasVisibleSession = false;
          for (const s of Object.values(sandbox.sessions)) {
            if (s.parentID || s.timeArchived) continue;
            if (s.id === sessionId) continue;
            const sKey = pinnedSessionStoreKey(projectId, s.id);
            const sUnpinned = sKey && next[sKey] < 0;
            if (sUnpinned) continue;
            // Session has no unpinned override and would be visible via project/sandbox pin
            hasVisibleSession = true;
            break;
          }
          if (!hasVisibleSession) {
            // All sessions in sandbox are unpinned -> unpin sandbox
            if (sandboxKey) next[sandboxKey] = -Date.now();

            // Cascade further: if no visible sandboxes remain in project, unpin project
            const projectKey = projectPinKey(projectId);
            if (projectKey && next[projectKey] > 0 && project) {
              let hasVisibleSandbox = false;
              for (const sb of Object.values(project.sandboxes) as SandboxState[]) {
                const sbKey = sandboxPinKey(projectId, sb.directory);
                const sbUnpinned = sbKey && next[sbKey] < 0;
                if (sbUnpinned) continue;
                const sbDirectlyPinned = sbKey && next[sbKey] > 0;
                if (sbDirectlyPinned || next[projectKey] > 0) {
                  hasVisibleSandbox = true;
                  break;
                }
              }
              if (!hasVisibleSandbox) {
                delete next[projectKey];
              }
            }
          }
        }
      }
    }

     localPinnedSessionStore.value = next;
    return;
  }

  // Directly pinned: use server API
  if (!ensureConnectionReady(t('app.actions.unpinningSession'))) return;
  sessionError.value = '';
  let optimisticProjectId = '';
  let previousOverride: number | undefined;
  try {
    optimisticProjectId = projectId;
    previousOverride = getSessionPinnedOverride(projectId, sessionId);
    setLocalUnpinnedSession(projectId, sessionId);
    await openCodeApi.unpinSession({
      sessionId,
      projectId,
      directory,
    });
  } catch (error) {
    if (optimisticProjectId) {
      restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
    }
    sessionError.value = t('app.error.sessionUnpinFailed', { message: toErrorMessage(error) });
  }
}

function pinProject(projectId: string) {
  if (!projectId) return;
  const key = projectPinKey(projectId);
  if (!key) return;
  const next = clearNegativeSandboxAndSessionOverridesForProject(projectId, localPinnedSessionStore.value);
  localPinnedSessionStore.value = {
    ...next,
    [key]: Date.now(),
  };
}

function unpinProject(projectId: string) {
  if (!projectId) return;
  const next = clearSandboxAndSessionOverridesForProject(projectId, { ...localPinnedSessionStore.value });

  const projectKey = projectPinKey(projectId);
  if (projectKey) delete next[projectKey];

  localPinnedSessionStore.value = next;
}

function pinSandbox(projectId: string, directory: string) {
  if (!projectId || !directory) return;
  const key = sandboxPinKey(projectId, directory);
  if (!key) return;
  const next = clearNegativeSessionOverridesForSandbox(projectId, directory, localPinnedSessionStore.value);
  localPinnedSessionStore.value = {
    ...next,
    [key]: Date.now(),
  };
}

function unpinSandbox(projectId: string, directory: string) {
  if (!projectId || !directory) return;
  const next = clearSessionOverridesForSandbox(projectId, directory, { ...localPinnedSessionStore.value });

  const sandboxKey = sandboxPinKey(projectId, directory);
  const isDirectlyPinned = sandboxKey && next[sandboxKey] > 0;

  if (isDirectlyPinned) {
    // Directly pinned: remove sandbox key, keep session keys (they may be directly pinned)
    delete next[sandboxKey];
  } else {
    // Implicitly pinned via project: add unpin override
    if (sandboxKey) next[sandboxKey] = -Date.now();
  }

  // Cascade: if project is pinned and no visible sandboxes remain, unpin project
  const projectKey = projectPinKey(projectId);
  if (projectKey && next[projectKey] > 0) {
    const project = serverState.projects[projectId];
    let hasVisibleSandbox = false;
    if (project) {
      for (const sb of Object.values(project.sandboxes) as SandboxState[]) {
        const sbKey = sandboxPinKey(projectId, sb.directory);
        const sbUnpinned = sbKey && next[sbKey] < 0;
        if (sbUnpinned) continue;
        const sbDirectlyPinned = sbKey && next[sbKey] > 0;
        if (sbDirectlyPinned || next[projectKey] > 0) {
          hasVisibleSandbox = true;
          break;
        }
      }
    }
    if (!hasVisibleSandbox) {
      delete next[projectKey];
    }
  }

  localPinnedSessionStore.value = next;
}

function toggleSessionTreeExpand(path: string) {
  const current = new Set(sessionTreeExpandedPaths.value);
  if (current.has(path)) {
    current.delete(path);
  } else {
    current.add(path);
  }
  const next = Array.from(current);
  sessionTreeExpandedPaths.value = next;
  writeSessionTreeExpandedPaths(next);
}

async function runTopPanelBatchSessionActionTarget(
  action: TopPanelBatchSessionActionPayload['action'],
  target: TopPanelBatchSessionTarget,
) {
  if (activeBackendKind.value === 'codex') {
    switch (action) {
      case 'pin':
        codexApi.pinThread(target.sessionId);
        return;
      case 'unpin':
        codexApi.unpinThread(target.sessionId);
        return;
      case 'archive':
        await codexApi.archiveThread(target.sessionId);
        return;
      case 'unarchive':
        await codexApi.unarchiveThread(target.sessionId);
        return;
      case 'delete':
        codexApi.hideThread(target.sessionId);
        return;
      default:
        throw new Error(`Unsupported Codex batch session action: ${action}`);
    }
  }
  const resolved = findSessionInProjects(target.sessionId);
  const hints = {
    projectId: target.projectId || resolved?.projectId,
    directory: target.directory || resolved?.sandbox.directory,
  };

  const { projectId, directory } = resolveSessionOperationPayload(
    target.sessionId,
    hints.projectId,
    hints.directory,
  );
  const previousOverride = getSessionPinnedOverride(projectId, target.sessionId);

  switch (action) {
    case 'pin': {
      const pinnedAt = Date.now();
      setLocalPinnedSession(projectId, target.sessionId, pinnedAt);
      try {
        await openCodeApi.pinSession({
          sessionId: target.sessionId,
          projectId,
          directory,
          pinnedAt,
        });
      } catch (error) {
        restoreLocalPinnedSessionOverride(projectId, target.sessionId, previousOverride);
        throw error;
      }
      return;
    }
    case 'unpin': {
      setLocalUnpinnedSession(projectId, target.sessionId);
      try {
        await openCodeApi.unpinSession({
          sessionId: target.sessionId,
          projectId,
          directory,
        });
      } catch (error) {
        restoreLocalPinnedSessionOverride(projectId, target.sessionId, previousOverride);
        throw error;
      }
      return;
    }
    case 'archive': {
      clearLocalPinnedSessionOverride(projectId, target.sessionId);
      try {
        await openCodeApi.archiveSession({
          sessionId: target.sessionId,
          projectId,
          directory,
        });
      } catch (error) {
        restoreLocalPinnedSessionOverride(projectId, target.sessionId, previousOverride);
        throw error;
      }
      return;
    }
    case 'unarchive': {
      clearLocalPinnedSessionOverride(projectId, target.sessionId);
      try {
        await openCodeApi.unarchiveSession({
          sessionId: target.sessionId,
          projectId,
          directory,
        });
      } catch (error) {
        restoreLocalPinnedSessionOverride(projectId, target.sessionId, previousOverride);
        throw error;
      }
      return;
    }
    case 'delete': {
      clearLocalPinnedSessionOverride(projectId, target.sessionId);
      try {
        await openCodeApi.deleteSession({
          sessionId: target.sessionId,
          projectId,
          directory,
        });
      } catch (error) {
        restoreLocalPinnedSessionOverride(projectId, target.sessionId, previousOverride);
        throw error;
      }
      return;
    }
    default:
      throw new Error(`Unsupported batch session action: ${action}`);
  }
}

async function handleTopPanelBatchSessionAction(payload: TopPanelBatchSessionActionPayload) {
  if (!payload || !Array.isArray(payload.sessions) || payload.sessions.length === 0) return;

  if (!ensureConnectionReady(t('app.actions.batchSessionOperation'))) return;

   if (!isBatchSessionAction(payload.action)) {
    sessionError.value = t('app.error.batchOperationPartialFailure', {
      action: 'unknown',
      failures: 1,
      total: payload.sessions.length,
      firstError: `Unsupported batch session action: ${String(payload.action)}`,
    });
    return;
  }

  const targets = normalizeBatchSessionTargets(payload.sessions) as TopPanelBatchSessionTarget[];

  if (targets.length === 0) return;

  sessionError.value = '';
  const results = await mapWithConcurrency(
    targets,
    BATCH_SESSION_ACTION_CONCURRENCY,
    async (target) => {
      await runTopPanelBatchSessionActionTarget(payload.action, target);
    },
  );

  const failures = results.flatMap((result, index) => {
    if (result?.status === 'rejected') {
      return [`${targets[index]?.sessionId}: ${toErrorMessage(result.reason)}`];
    }
    return [];
  });

  if (failures.length > 0) {
    const firstError = failures[0];
    sessionError.value = t('app.error.batchOperationPartialFailure', {
      action: payload.action,
      failures: failures.length,
      total: targets.length,
      firstError,
    });
  }
}

function handleSidePanelSessionSelect(payload: { projectId: string; sessionId: string }) {
  if (!payload?.sessionId) return;
  const projectId = payload.projectId?.trim() || resolveProjectIdForSession(payload.sessionId);
  if (!projectId) return;
  void switchSessionSelection(projectId, payload.sessionId);
}

function handleSidePanelPinSession(payload: { sessionId: string; projectId: string }) {
  if (!payload?.sessionId) return;
  void pinSession(payload.sessionId, { projectId: payload.projectId });
}

function handleSidePanelUnpinSession(payload: { sessionId: string; projectId: string }) {
  if (!payload?.sessionId) return;
  void unpinSession(payload.sessionId, { projectId: payload.projectId });
}

function hideCodexSession(sessionId: string) {
  if (activeBackendKind.value !== 'codex' || !sessionId) return;
  codexApi.hideThread(sessionId);
  if (selectedSessionId.value === sessionId) {
    selectedSessionId.value = codexApi.activeThreadId.value || codexApi.visibleThreads.value[0]?.id || '';
  }
}

async function forkCodexSession(sessionId: string) {
  if (activeBackendKind.value !== 'codex' || !sessionId) return;
  if (!ensureConnectionReady(t('app.actions.fork'))) return;
  sessionError.value = '';
  try {
    setSendStatusKey('app.status.forking');
    const thread = await codexApi.forkThread(sessionId);
    if (thread?.id) {
      selectedProjectId.value = CODEX_PROJECT_ID;
      selectedSessionId.value = thread.id;
    }
    setSendStatusKey('app.status.forked');
  } catch (error) {
    sessionError.value = t('app.error.sessionForkFailed', { message: toErrorMessage(error) });
  }
}

async function rollbackCodexSession(sessionId: string) {
  if (activeBackendKind.value !== 'codex' || !sessionId) return;
  if (!ensureConnectionReady(t('app.actions.revert'))) return;
  sessionError.value = '';
  try {
    setSendStatusKey('app.status.reverting');
    const thread = await codexApi.rollbackThread(sessionId, 1);
    if (thread?.id) {
      selectedProjectId.value = CODEX_PROJECT_ID;
      selectedSessionId.value = thread.id;
      await codexApi.selectThread(thread.id);
      await reloadSelectedSessionState(thread.id);
    }
    setSendStatusKey('app.status.reverted');
  } catch (error) {
    sessionError.value = t('app.error.sessionRevertFailed', { message: toErrorMessage(error) });
  }
}

async function compactCodexSession(sessionId: string) {
  if (activeBackendKind.value !== 'codex' || !sessionId) return;
  const confirmed = await showConfirm(t('codexPanel.compactThreadConfirm'));
  if (!confirmed) return;
  sessionError.value = '';
  try {
    await codexApi.startThreadCompaction(sessionId);
  } catch (error) {
    sessionError.value = toErrorMessage(error);
  }
}

async function unsubscribeCodexSession(sessionId: string) {
  if (activeBackendKind.value !== 'codex' || !sessionId) return;
  sessionError.value = '';
  try {
    await codexApi.unsubscribeThread(sessionId);
  } catch (error) {
    sessionError.value = toErrorMessage(error);
  }
}

async function handleForkMessage(payload: { sessionId: string; messageId: string }) {
  if (activeBackendKind.value === 'codex') {
    await forkCodexSession(payload.sessionId);
    return;
  }
  if (!ensureConnectionReady(t('app.actions.fork'))) return;
  sessionError.value = '';
  try {
    setSendStatusKey('app.status.forking');
    const data = (await openCodeApi.forkSession({
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      directory: activeDirectory.value.trim() || undefined,
      projectId: selectedProjectId.value,
    })) as SessionInfo;
    if (data && typeof data.id === 'string') {
      seedForkedSessionComposerDraft(payload, data);
      await switchSessionSelection(selectedProjectId.value, data.id);
    }
    setSendStatusKey('app.status.forked');
  } catch (error) {
    sessionError.value = t('app.error.sessionForkFailed', { message: toErrorMessage(error) });
  }
}

async function handleRevertMessage(payload: { sessionId: string; messageId: string }) {
  if (activeBackendKind.value === 'codex') {
    await rollbackCodexSession(payload.sessionId);
    return;
  }
  if (!ensureConnectionReady(t('app.actions.revert'))) return;
  sessionError.value = '';
  try {
    setSendStatusKey('app.status.reverting');
    await openCodeApi.revertSession({
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      projectId: selectedProjectId.value,
      directory: activeDirectory.value.trim() || undefined,
    });
    setSendStatusKey('app.status.reverted');
    if (selectedSessionId.value === payload.sessionId) void reloadSelectedSessionState();
  } catch (error) {
    sessionError.value = t('app.error.sessionRevertFailed', { message: toErrorMessage(error) });
  }
}

async function handleUndoRevert() {
  const sessionId = selectedSessionId.value;
  if (!sessionId) return;
  if (!ensureConnectionReady(t('app.actions.undo'))) return;
  sessionError.value = '';
  try {
    setSendStatusKey('app.status.undoing');
    await openCodeApi.unrevertSession({
      sessionId,
      projectId: selectedProjectId.value,
      directory: activeDirectory.value.trim() || undefined,
    });
    setSendStatusKey('app.status.undone');
  } catch (error) {
    sessionError.value = t('app.error.sessionUndoFailed', { message: toErrorMessage(error) });
  }
}

/** Set project name from package.json for newly created projects (fire-and-forget). */
async function initProjectNameFromPackageJson(projectId: string, directory: string) {
  try {
    const readFileContent = requireBackendMethod(backend().readFileContent, 'file reading');
    const result = (await readFileContent({
      directory,
      path: 'package.json',
    })) as FileContentResponse | string;
    const content = typeof result === 'string' ? result : result?.content;
    if (!content) return;
    const isBase64 = typeof result !== 'string' && result?.encoding === 'base64';
    const decoded =
      typeof content === 'string' && isBase64
        ? decodeApiTextContent(result as FileContentResponse)
        : content;
    const parsed = JSON.parse(decoded);
    const name = parsed?.name;
    if (typeof name !== 'string' || !name.trim()) return;
    await openCodeApi.updateProject(projectId, { directory, name: name.trim() });
  } catch {
    // Silently ignore - package.json may not exist or be invalid
  }
}

async function handleProjectDirectorySelect(directory: string) {
  isProjectPickerOpen.value = false;
  if (!directory) return;
  const targetDirectory = normalizeProjectDirectoryForActiveBackend(directory);

  if (activeBackendKind.value === 'codex') {
    const existing = codexApi.visibleThreads.value.find((thread) => (
      normalizeDirectory(thread.cwd || codexApi.homeDir.value || '/') === targetDirectory
    ));
    const sessionId = existing?.id || (await createSessionInDirectory(targetDirectory))?.id || '';
    if (!sessionId) return;
    if (existing) await codexApi.selectThread(existing.id);
    selectedProjectId.value = CODEX_PROJECT_ID;
    selectedSessionId.value = sessionId;
    await nextTick();
    try {
      await switchSessionSelection(CODEX_PROJECT_ID, sessionId);
    } catch {
      selectedProjectId.value = CODEX_PROJECT_ID;
      selectedSessionId.value = sessionId;
    }
    return;
  }

  const isNewProject = !Object.values(serverState.projects).some((p) => p.worktree === targetDirectory);

  const { projectId, sessionId } = await openCodeApi.openProject(targetDirectory);
  ge.sendToWorker({
    type: 'load-sessions',
    directory: targetDirectory,
  });
  await switchSessionSelection(projectId, sessionId);

  if (isNewProject && projectId !== 'global') {
    void initProjectNameFromPackageJson(projectId, targetDirectory);
  }
}
async function bootstrapSelections() {
  if (isBootstrapping.value) return;
  isBootstrapping.value = true;
  try {
    if (!serverState.bootstrapped.value) {
      await new Promise<void>((resolve) => {
        const stop = watch(
          bootstrapReady,
          (ready) => {
            if (!ready) return;
            stop();
            resolve();
          },
          { immediate: true },
        );
      });
    }

    const initialProjectId = initialQuery.projectId.trim();
    const initialSessionId = initialQuery.sessionId.trim();
    if (activeBackendKind.value === 'codex') {
      selectedProjectId.value = CODEX_PROJECT_ID;
      const activeSessionId = codexWorkspace.activeSessionId.value;
      if (!selectedSessionId.value && activeSessionId) selectedSessionId.value = activeSessionId;
    } else if (initialProjectId && initialSessionId) {
      await switchSessionSelection(initialProjectId, initialSessionId);
    } else {
      await initializeSessionSelection();
    }

  } finally {
    isBootstrapping.value = false;
    const deferredSessionId = deferredSessionReloadId.value;
    if (deferredSessionId && deferredSessionId === selectedSessionId.value) {
      deferredSessionReloadId.value = null;
      void reloadSelectedSessionState(deferredSessionId);
    }
  }
}

async function fetchProviders(force = false) {
  if (providersLoading.value || (!force && providersLoaded.value)) return;
  providersLoading.value = true;
  if (force) providersLoaded.value = false;
  providersFetchCount.value += 1;
  log('providers fetch start', providersFetchCount.value);
  try {
    const data = activeBackendKind.value === 'codex'
      ? (await codexApi.listProviders()) as ProviderResponse
      : (await requireBackendMethod(backend().listProviders, 'providers')()) as ProviderResponse;
    providers.value = Array.isArray(data.all) ? data.all : [];
    connectedProviderIds.value = Array.isArray(data.connected) ? data.connected : [];
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
          attachmentCapable: true,
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
        .find((value) => Boolean(value) && isModelAvailable(value) && isProviderEnabled(parseProviderModelKey(value).providerID));
      const firstModel = getFirstAvailableModelId();
      selectedModel.value = preferredModelId || firstModel || '';
    }
    ensureSelectedModelAvailable();
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
    const listAgents = requireBackendMethod(backend().listAgents, 'agents');
    const data = (await listAgents()) as AgentInfo[];
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
    const listCommands = requireBackendMethod(backend().listCommands, 'commands');
    const data = (await listCommands(directory)) as CommandInfo[];
    const list = Array.isArray(data) ? data : [];
    list.sort((a, b) => a.name.localeCompare(b.name));
    commands.value = list;
  } catch (error) {
    log('Command load failed', error);
  } finally {
    commandsLoading.value = false;
  }
}

function ensureBrowserNotificationPermission() {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  if (notificationPermissionRequested.value) return;
  notificationPermissionRequested.value = true;
  void Notification.requestPermission();
}

/** The window is visible AND focused — the user is likely paying attention. */
function isWindowAttentive(): boolean {
  if (typeof document === 'undefined') return true;
  return !document.hidden && document.hasFocus();
}

function showBrowserNotification(
  projectId: string,
  sessionId: string,
  type: 'permission' | 'question' | 'idle',
) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof Notification === 'undefined') return;
  if (isWindowAttentive()) return;
  if (Notification.permission !== 'granted') return;
  const session = sessions.value.find(
    (entry) => entry.id === sessionId && resolveProjectIdForSession(entry.id) === projectId,
  );
  const kind =
    type === 'permission' ? t('app.notification.permission') : type === 'question' ? t('app.notification.question') : t('app.notification.idle');
  const sessionName = session ? sessionLabel(session) : sessionId;
  const body =
    type === 'idle'
      ? t('app.notification.sessionIdle', { session: sessionName })
      : t('app.notification.sessionRequiresResponse', { session: sessionName });
  const notification = new Notification(`${kind}`, {
    body,
    tag: `vis-${type}-${projectId}-${sessionId}`,
  });
  notification.onclick = () => {
    window.focus();
    void switchSessionSelection(projectId.trim(), sessionId.trim());
    notification.close();
  };
}

function syncActiveSelectionToWorker() {
  ge.sendToWorker({
    type: 'selection.active',
    projectId: isWindowAttentive() ? selectedProjectId.value : '',
    sessionId: isWindowAttentive() ? selectedSessionId.value : '',
    directory: isWindowAttentive() ? activeDirectory.value : '',
  });
}

function handleWindowAttentionChange() {
  syncActiveSelectionToWorker();
}

type UserMessageMeta = {
  agent?: string;
  providerId?: string;
  modelId?: string;
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
  const variant =
    typeof model?.variant === 'string'
      ? model.variant.trim()
      : typeof info.variant === 'string'
        ? info.variant.trim()
        : '';
  if (!agent && !modelId && !providerId && !variant) return null;
  return {
    agent: agent || undefined,
    providerId: providerId || undefined,
    modelId: modelId || undefined,
    variant: variant || undefined,
  };
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
  const total =
    tokens.input + tokens.output + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((total / contextLimit) * 100);
}

function storeUserMessageMeta(messageId: string | undefined, meta: UserMessageMeta | null) {
  if (!messageId || !meta) return;
  userMessageMetaById.value = { ...userMessageMetaById.value, [messageId]: meta };
}

function storeUserMessageTime(messageId: string | undefined, messageTime?: number) {
  if (!messageId || typeof messageTime !== 'number') return;
  userMessageTimeById.value = { ...userMessageTimeById.value, [messageId]: messageTime };
}

async function fetchHistory(
  sessionId: string,
  isSubagentMessage = false,
  rootRequestId?: number,
  rootSessionId?: string,
) {
  if (!sessionId) return;
  const requestId = !isSubagentMessage ? ++primaryHistoryRequestId : 0;
  const requestedDirectory = getSelectedWorktreeDirectory();
  const expectedRootRequestId = isSubagentMessage ? rootRequestId ?? 0 : requestId;
  const expectedRootSessionId = rootSessionId ?? sessionId;
  try {
    const directory = getSelectedWorktreeDirectory();
    const listSessionMessages = requireBackendMethod(backend().listSessionMessages, 'session messages');
    const data = (await listSessionMessages(sessionId, {
      directory: directory || undefined,
    })) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return;
    if (expectedRootRequestId !== primaryHistoryRequestId) return;
    if (selectedSessionId.value !== expectedRootSessionId) return;
    if (getSelectedWorktreeDirectory() !== requestedDirectory) return;
    // 全量加载，避免消息在加载过程中逐步显示导致未加载内容的卡片残留
    msg.loadHistory(data);

    if (expectedRootRequestId !== primaryHistoryRequestId) return;
    if (selectedSessionId.value !== expectedRootSessionId) return;
    if (getSelectedWorktreeDirectory() !== requestedDirectory) return;

    data.forEach((message) => {
      const info = message.info as Record<string, unknown> | undefined;
      const id = typeof info?.id === 'string' ? info.id : undefined;
      if (!id) return;
      const meta = parseUserMessageMeta(info);
      const messageTime = parseMessageTime(info);
      storeUserMessageMeta(id, meta);
      storeUserMessageTime(id, messageTime);
    });

  } catch (error) {
    log('History load failed', error);
  }
}

async function fetchAllowedSessionHistories(rootSessionId: string) {
  await fetchHistory(rootSessionId);
  const rootRequestId = primaryHistoryRequestId;
  const descendantSessionIds = Array.from(allowedSessionIds.value).filter((id) => id !== rootSessionId);
  if (descendantSessionIds.length === 0) return;
  await Promise.all(
    descendantSessionIds.map((id) => fetchHistory(id, true, rootRequestId, rootSessionId)),
  );
}

function buildPtyWsUrl(path: string, directory?: string) {
  const createPtyWebSocketUrl = requireBackendMethod(backend().createPtyWebSocketUrl, 'PTY websocket URLs');
  return createPtyWebSocketUrl(path, { directory });
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
    const listPtys = requireBackendMethod(backend().listPtys, 'PTY listing');
    const data = await listPtys(directory);
  if (!Array.isArray(data)) return [] as PtyInfo[];
  return data.map(parsePtyInfo).filter((pty): pty is PtyInfo => Boolean(pty));
}

async function createPtySession(command?: string, args?: string[]) {
  const directory = activeDirectory.value || undefined;
    const createPty = requireBackendMethod(backend().createPty, 'PTY creation');
    const data = await createPty({
    directory,
    command,
    args,
    cwd: directory,
    title: t('app.windowTitles.shell'),
  });
  return parsePtyInfo(data);
}

async function updatePtySize(ptyId: string, rows: number, cols: number, directory?: string) {
    const updatePtySize = requireBackendMethod(backend().updatePtySize, 'PTY resizing');
    const data = await updatePtySize(ptyId, {
    directory,
    rows,
    cols,
  });
  return parsePtyInfo(data);
}

async function ensureShellWindow(pty: PtyInfo) {
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
    title: pty.title === 'One-shot PTY' ? t('app.windowTitles.oneShotPty') : (pty.title || t('app.windowTitles.shell')),
    width,
    height,
    x: randomPosition.x,
    y: randomPosition.y,
    expiry: Infinity,
    onResize: () => scheduleShellFit(pty.id),
  });
  
  // Dynamic import of Terminal for code splitting
  const { Terminal } = await import('@xterm/xterm');
  
  const terminal = new Terminal({
    cols: TERM_COLUMNS,
    rows: TERM_ROWS,
    fontFamily: terminalFontFamily.value,
    fontSize: TERM_FONT_SIZE_PX.value,
    lineHeight: TERM_LINE_HEIGHT,
    cursorBlink: true,
    allowTransparency: true,
    theme: {
      background: TRANSPARENT_TERMINAL_BACKGROUND,
      foreground: '#e2e8f0',
      cursor: '#e2e8f0',
      selectionBackground: 'rgba(148, 163, 184, 0.3)',
    },
  });
  shellSessionsByPtyId.set(pty.id, {
    pty,
    terminal,
  });
  // Connect WebSocket immediately so the server's buffer replay arrives
  // before a fast-exiting command deletes the session.
  // xterm.js buffers write() calls made before open(), so data is not lost.
  connectShellSocket(pty.id);
  nextTick(() => {
    void waitForTerminalFontsReady().then(() => {
      const host = toolWindowCanvasEl.value?.querySelector(
        `[data-shell-id="${pty.id}"]`,
      ) as HTMLElement | null;
      if (!host) return;
      terminal.open(host);
      // Wait for first paint so xterm has rendered cell dimensions
      requestAnimationFrame(() => {
        resizeWindowToFitTerminal(key, terminal, host);
      });
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
    const currentSession = session;

    let prevCols = -1;
    let prevRows = -1;
    let attempts = 0;

    function tick() {
      if (attempts >= 30 || !currentSession.terminal.element?.isConnected) {
        notifyPtySize(currentSession);
        return;
      }
      attempts++;
      fitTerminalToContainer(currentSession);
      const { cols, rows } = currentSession.terminal;
      if (cols === prevCols && rows === prevRows) {
        notifyPtySize(currentSession);
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
          if (
            typeof meta.cursor === 'number' &&
            Number.isSafeInteger(meta.cursor) &&
            meta.cursor >= 0
          ) {
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
            keys.length === 1 &&
            keys[0] === 'cursor' &&
            typeof meta.cursor === 'number' &&
            Number.isSafeInteger(meta.cursor) &&
            meta.cursor >= 0
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
    // focus() requires the terminal to be mounted; defer if not yet attached.
    if (session.terminal.element) {
      session.terminal.focus();
    } else {
      nextTick(() => session.terminal.focus());
    }
  });
  session.terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  });
  socket.addEventListener('close', () => {
    if (session.exiting) {
      setTimeout(() => removeShellWindow(ptyId), SHELL_LINGER_MS);
    }
  });
}

function removeShellWindow(ptyId: string, options?: { kill?: boolean }) {
  const session = shellSessionsByPtyId.get(ptyId);
  if (!session) return;
  pendingShellFits.delete(ptyId);
  session.socket?.close();
  session.terminal.dispose();
  shellSessionsByPtyId.delete(ptyId);
  shellExitWaiters.delete(ptyId);
  ptyToFileMap.delete(ptyId);
  fw.close(`shell:${ptyId}`);
  if (options?.kill) {
    const directory = session.pty.cwd || activeDirectory.value || undefined;
      const deletePty = backend().deletePty;
      deletePty?.(ptyId, directory).catch((error) => {
      log('PTY delete failed', error);
    });
  }
}

function lingerAndRemoveShellWindow(ptyId: string) {
  const session = shellSessionsByPtyId.get(ptyId);
  if (!session || session.exiting) return;
  session.exiting = true;
  session.terminal.options.cursorBlink = false;
  // If socket is already closed, start linger timer immediately.
  // Otherwise the socket 'close' handler starts it after all data is flushed.
  if (!session.socket || session.socket.readyState >= WebSocket.CLOSING) {
    setTimeout(() => removeShellWindow(ptyId), SHELL_LINGER_MS);
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

function restoreAllMinimizedWindows() {
  for (const entry of fw.entries.value) {
    if (entry.minimized) fw.restore(entry.key);
  }
}

function handleFloatingWindowMinimize(key: string) {
  if (!showMinimizeButtons.value) return;
  fw.minimize(key);
}

async function handleFloatingWindowOpen(key: string) {
  if (!key.startsWith('file-viewer:')) return;
  const entry = fw.get(key);
  const absolutePath = entry?.props?.absolutePath;
  if (!absolutePath || typeof absolutePath !== 'string') return;

  const directory = activeDirectory.value.trim();
  if (!directory) return;

  // Escape path safely for shell: use single-quote wrapping with internal single-quote handling
  const escapedPath = absolutePath.replace(/'/g, "'\"'\"'");
  const pty = await createPtySession('/bin/sh', ['-c', `$EDITOR '${escapedPath}'`]);
  if (pty) {
    ptyToFileMap.set(pty.id, absolutePath);
    await ensureShellWindow(pty);
  }
}

function restoreFloatingWindow(key: string) {
  fw.restore(key);
  nextTick(() => {
    const body = document.querySelector(
      `[data-floating-key="${key}"] .floating-window-body`,
    ) as HTMLElement | null;
    body?.focus();

    if (key.startsWith('shell:')) {
      const ptyId = key.slice('shell:'.length);
      scheduleShellFit(ptyId);
      shellSessionsByPtyId.get(ptyId)?.terminal.focus();
    }
  });
}

function disposeShellWindows() {
  const ids = Array.from(shellSessionsByPtyId.keys());
  for (const ptyId of ids) {
    removeShellWindow(ptyId);
  }
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
      if (pty.title === 'One-shot PTY' || pty.title === 'Commit Snapshot') return;
      ensureShellWindow(pty);
    });
  } catch (error) {
    log('PTY restore failed', error);
  }
}

async function openShellFromInput(input: string) {
  if (!ptySupported.value) {
    setSendStatusKey('app.error.shellFailed', { message: t('app.error.unavailable', { action: t('topPanel.openShell') }) });
    return false;
  }
  try {
    const script = input.trim();
    const hasCommand = script.length > 0;
    const pty = hasCommand
      ? await createPtySession('/bin/sh', ['-c', script])
      : await createPtySession();
    if (!pty) {
      setSendStatusKey('app.error.shellFailed', { message: 'PTY creation returned no session.' });
      return false;
    }
    ensureShellWindow(pty);
    if (!hasCommand) return true;
    const session = shellSessionsByPtyId.get(pty.id);
    if (session) session.closeOnSuccess = true;
    return true;
  } catch (error) {
    setSendStatusKey('app.error.shellFailed', { message: toErrorMessage(error) });
    return false;
  }
}

async function runTreeShellCommand(command: string) {
  const script = command.trim();
  if (!script) return;
  const commandDirectory = activeDirectory.value.trim();
  const pty = await createPtySession('/bin/sh', ['-c', script]);
  if (!pty) return;
  ensureShellWindow(pty);
  const session = shellSessionsByPtyId.get(pty.id);
  if (session) session.closeOnSuccess = true;
  const exitCode = await new Promise<number>((resolve) => {
    shellExitWaiters.set(pty.id, resolve);
  });
  if (exitCode === 0) {
    invalidateDirectorySidebarCache(commandDirectory);
    if (activeDirectory.value.trim() !== commandDirectory) {
      return;
    }
    await reloadTree();
    await Promise.all([
      refreshGitStatus({ includeFileSnapshot: false }),
      refreshBranchEntries({ force: true }),
    ]);
  }
}

async function handleReloadSidebar() {
  if (treeLoading.value) return;
  await reloadTree();
  await Promise.all([
    refreshGitStatus({ includeFileSnapshot: false }),
    refreshBranchEntries({ force: true }),
  ]);
}

function decodeCommitSnapshotBase64(value: string) {
  if (!value) return '';
  return new TextDecoder().decode(toUint8ArrayFromBase64(value));
}

function parseCommitSnapshotOutput(rawOutput: string): CommitSnapshotResult {
  const files: CommitSnapshotEntry[] = [];
  let title = '';
  let section: 'none' | 'before' | 'after' = 'none';
  let current:
    | {
        status: string;
        file: string;
        before: string[];
        after: string[];
      }
    | undefined;

  const pushCurrent = () => {
    if (!current || !current.file) {
      current = undefined;
      section = 'none';
      return;
    }
    const beforeBase64 = current.before.join('');
    const afterBase64 = current.after.join('');
    const before = decodeCommitSnapshotBase64(beforeBase64);
    const after = decodeCommitSnapshotBase64(afterBase64);
    // Skip entries that represent empty directories (no content before or after)
    if (!before && !after && current.status !== 'D') {
      current = undefined;
      section = 'none';
      return;
    }
    files.push({
      status: current.status,
      file: current.file,
      before,
      after,
      beforeBase64,
      afterBase64,
    });
    current = undefined;
    section = 'none';
  };

  for (const rawLine of rawOutput.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('##TITLE\t')) {
      title = line.slice('##TITLE\t'.length);
      continue;
    }
    if (line.startsWith('##FILE\t')) {
      pushCurrent();
      const payload = line.slice('##FILE\t'.length);
      const separator = payload.indexOf('\t');
      const status = separator >= 0 ? payload.slice(0, separator) : payload;
      const file = separator >= 0 ? payload.slice(separator + 1) : '';
      current = { status, file, before: [], after: [] };
      section = 'none';
      continue;
    }
    if (line === '##BEFORE') {
      section = 'before';
      continue;
    }
    if (line === '##AFTER') {
      section = 'after';
      continue;
    }
    if (!current || line.length === 0) continue;
    if (section === 'before') {
      current.before.push(line);
    } else if (section === 'after') {
      current.after.push(line);
    }
  }

  pushCurrent();
  return { title, files };
}

function parseFileSnapshotOutput(rawOutput: string): FileSnapshotResult {
  const lines = rawOutput.split(/\r?\n/);
  let section: 'none' | 'before' | 'after' = 'none';
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines) {
    if (line === '##BEFORE') {
      section = 'before';
      continue;
    }
    if (line === '##AFTER') {
      section = 'after';
      continue;
    }
    if (!line) continue;
    if (section === 'before') {
      before.push(line);
      continue;
    }
    if (section === 'after') {
      after.push(line);
    }
  }

  const beforeBase64 = before.join('');
  const afterBase64 = after.join('');
  return {
    before: decodeCommitSnapshotBase64(beforeBase64),
    after: decodeCommitSnapshotBase64(afterBase64),
    beforeBase64,
    afterBase64,
  };
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

function findAgentByName(name: string): AgentInfo | null {
  const target = name.toLowerCase();
  return agents.value.find((agent) => agent.name.toLowerCase() === target) ?? null;
}

function parseAtAgent(input: string): { agent: string; text: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('@')) return null;
  const match = trimmed.slice(1).match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  const agent = match[1]?.trim();
  if (!agent) return null;
  const text = match[2] ?? '';
  return { agent, text };
}

const DEBUG_SUBCOMMANDS: Record<string, string> = {
  session: t('app.debug.session'),
  notification: t('app.debug.notification'),
};

function formatSessionGraphDump(): string {
  const lines: string[] = [];

  const allProjects = Object.values(serverState.projects).sort((a, b) =>
    a.worktree === b.worktree ? a.id.localeCompare(b.id) : a.worktree.localeCompare(b.worktree),
  );
  const totalSessions = allProjects.reduce((count, project) => {
    return (
      count +
      (Object.values(project.sandboxes) as SandboxState[]).reduce((projectCount, sandbox) => {
        return projectCount + Object.keys(sandbox.sessions).length;
      }, 0)
    );
  }, 0);

  lines.push(t('debug.projectTreeTitle'));
  lines.push(`  ${t('debug.projectsCount')}: ${allProjects.length}  ${t('debug.sessionsTotal')}: ${totalSessions}`);
  lines.push('');

  function fmtTime(ts?: number) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  }

  function fmtStatus(s: string) {
    if (s === 'busy') return t('debug.sessionStatus.busy');
    if (s === 'retry') return t('debug.sessionStatus.retry');
    if (s === 'idle') return t('debug.sessionStatus.idle');
    return `[${s}]`;
  }

  for (const project of allProjects) {
    lines.push(`${t('debug.projectLabel')} ${project.id}`);
    lines.push(`  ${t('debug.worktreeLabel')}: ${project.worktree || '-'}`);
    if (project.name) lines.push(`  ${t('debug.nameLabel')}: ${project.name}`);
    if (project.icon?.color) lines.push(`  ${t('debug.colorLabel')}: ${project.icon.color}`);
    lines.push(
      `  ${t('debug.timeLabel')}: ${t('debug.createdLabel')}=${fmtTime(project.time?.created)} ${t('debug.updatedLabel')}=${fmtTime(project.time?.updated)} ${t('debug.initializedLabel')}=${fmtTime(project.time?.initialized)}`,
    );

    const sandboxEntries = Object.entries(project.sandboxes).sort(([a], [b]) => a.localeCompare(b));
    if (sandboxEntries.length === 0) {
      lines.push(`  ${t('debug.noSandboxes')}`);
      lines.push('');
      continue;
    }

    for (let si = 0; si < sandboxEntries.length; si++) {
      const [sandboxDirectory, sandbox] = sandboxEntries[si];
      const isLastSandbox = si === sandboxEntries.length - 1;
      const sConnector = isLastSandbox ? '└── ' : '├── ';
      const sPrefix = isLastSandbox ? '    ' : '│   ';

      const branchMeta = sandbox.name ? `  (${t('debug.branchLabel')}: ${sandbox.name})` : '';
      lines.push(`${sConnector}${t('debug.sandboxLabel')} ${sandboxDirectory}${branchMeta}`);
      lines.push(`${sPrefix}${t('debug.rootSessionsLabel')}: [${sandbox.rootSessions.join(', ')}]`);

      const sessions = Object.values(sandbox.sessions).sort((a, b) => {
        const aTime = a.timeUpdated ?? a.timeCreated ?? 0;
        const bTime = b.timeUpdated ?? b.timeCreated ?? 0;
        return bTime - aTime;
      });

      if (sessions.length === 0) {
        lines.push(`${sPrefix}${t('debug.noSessions')}`);
        continue;
      }

      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        const isLastSession = i === sessions.length - 1;
        const sessionConnector = isLastSession ? '└── ' : '├── ';
        const sessionPrefix = `${sPrefix}${isLastSession ? '    ' : '│   '}`;
        const status = fmtStatus(session.status ?? 'unknown');
        const title = session.title ? `  "${session.title}"` : '';
        const slug = session.slug ? `  slug=${session.slug}` : '';
        lines.push(`${sPrefix}${sessionConnector}${session.id}  ${status}${title}${slug}`);
        const revertLabel = session.revert
          ? `msg=${session.revert.messageID}${session.revert.partID ? ` part=${session.revert.partID}` : ''}`
          : '-';
        lines.push(
          `${sessionPrefix}${t('debug.dirLabel')}=${session.directory || sandboxDirectory}  ${t('debug.parentLabel')}=${session.parentID || t('debug.root')}  ${t('debug.archivedLabel')}=${fmtTime(session.timeArchived)}  ${t('debug.revertLabel')}=${revertLabel}`,
        );
        lines.push(
          `${sessionPrefix}${t('debug.createdLabel')}=${fmtTime(session.timeCreated)}  ${t('debug.updatedLabel')}=${fmtTime(session.timeUpdated)}`,
        );
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
    component: ContentViewer,
    props: {
      fileContent: content,
      lang: 'text',
      gutterMode: 'none',
      theme: shikiTheme.value,
    },
    closable: true,
    resizable: true,
    focusOnOpen: true,
    scroll: 'manual',
    title: t('app.windowTitles.debugSessionGraph'),
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });
}

function formatNotificationDump(): string {
  const lines: string[] = [];
  const map = serverState.notifications;
  const order = notificationSessionOrder.value;
  const parentMap = sessionParentById.value;

  lines.push(t('app.debug.notificationState'));
  lines.push(`  pendingNotificationsBySessionId: ${Object.keys(map).length} session(s)`);
  lines.push(`  notificationSessionOrder: [${order.length}] ${order.join(', ') || '(empty)'}`);
  lines.push(`  selectedSessionId: ${selectedSessionId.value || '(none)'}`);
  lines.push(`  allowedSessionIds: [${allowedSessionIds.value.size}]`);
  lines.push('');

  // Computed notificationSessions (what TopPanel sees)
  const computed = notificationSessions.value;
  lines.push(
    `Computed notificationSessions (TopPanel badge): ${computed.length} entry(s), total count = ${computed.reduce((s, e) => s + e.count, 0)}`,
  );
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
  if (Object.keys(map).length === 0) {
    lines.push('  (empty)');
  }
  for (const entry of Object.values(map)) {
    const projectId = entry.projectId;
    const sessionId = entry.sessionId;
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
    lines.push(`  ${projectId}:${sessionId}  "${label}"${parentInfo}${flagStr}`);
    for (const requestId of entry.requestIds) {
      const isIdle = requestId.startsWith('idle:');
      const type = isIdle ? 'idle' : 'permission/question';
      lines.push(`    - ${requestId}  (${type})`);
    }
  }
  lines.push('');

  // Order vs Map consistency check
  const mapKeys = Object.keys(map);
  const orphanedInOrder = order.filter((id) => !mapKeys.includes(id));
  const missingFromOrder = mapKeys.filter((id) => !order.includes(id));
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
  // Single-pass iteration instead of two separate filters for better performance
  const permissionEntries: typeof fw.entries.value = [];
  const questionEntries: typeof fw.entries.value = [];
  for (const entry of fw.entries.value) {
    if (entry.key.startsWith('permission:')) permissionEntries.push(entry);
    else if (entry.key.startsWith('question:')) questionEntries.push(entry);
  }
  lines.push(`Active Floating Windows:`);
  lines.push(`  ${t('app.debug.permissionWindows')}: ${permissionEntries.length}`);
  for (const entry of permissionEntries) {
    const req = entry.props?.request as { id?: string; sessionID?: string } | undefined;
    lines.push(`    - ${entry.key}  session=${req?.sessionID ?? '?'}  request=${req?.id ?? '?'}`);
  }
  lines.push(`  ${t('app.debug.questionWindows')}: ${questionEntries.length}`);
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
    component: ContentViewer,
    props: {
      fileContent: content,
      lang: 'text',
      gutterMode: 'none',
      theme: shikiTheme.value,
    },
    closable: true,
    resizable: true,
    focusOnOpen: true,
    scroll: 'manual',
    title: t('app.windowTitles.debugNotifications'),
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
    const lines = [t('app.debug.availableSubcommands')];
    for (const [name, desc] of Object.entries(DEBUG_SUBCOMMANDS)) {
      lines.push(`  ${name} — ${desc}`);
    }
    return { ok: true, message: lines.join('\n') };
  }
  if (sub === 'session' || sub === 'sessions') {
    openDebugSessionViewer();
    return { ok: true, message: t('app.debug.sessionOpened') };
  }
  if (sub === 'notification' || sub === 'notifications') {
    openDebugNotificationViewer();
    return { ok: true, message: t('app.debug.notificationOpened') };
  }
  return { ok: false, message: t('app.debug.unknownSubcommand', { sub }) };
}

async function sendCommand(sessionId: string, command: CommandInfo, commandArgs: string) {
  if (!ensureConnectionReady(t('app.actions.sendingCommands'))) return;
  const directory = activeDirectory.value.trim();
    const sendCommand = requireBackendMethod(backend().sendCommand, 'session command sending');
    await sendCommand(sessionId, {
    directory: directory || undefined,
    command: command.name,
    arguments: commandArgs,
    agent: command.agent || selectedMode.value,
    model: command.model || selectedModel.value,
    variant: selectedThinking.value,
  });
}

async function sendMessage() {
  if (!ensureConnectionReady(t('app.actions.sending'))) return;
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
      setSendStatusKey('app.error.noSessionSelected');
      return;
    }
    selectedSessionId.value = fallback.id;
    sessionId = fallback.id;
  }
  const slash = hasText ? parseSlashCommand(text) : null;
  const commandMatch = slash ? findCommandByName(slash.name) : null;
  if (activeBackendKind.value === 'codex') {
    if (hasText) {
      recentUserInputs.push({ text, time: Date.now() });
      while (recentUserInputs.length > 20) recentUserInputs.shift();
    }
    messageInput.value = '';
    enableFollow();
    isSending.value = true;
    setSendStatusKey('app.status.sending');
    try {
      if (slash && slash.name.toLowerCase() === 'shell') {
        if (!await openShellFromInput(slash.arguments ?? '')) return;
        setSendStatusKey('app.status.shellReady');
        clearComposerDraftForCurrentContext();
        return;
      }
      if (slash && slash.name.toLowerCase() === 'debug') {
        const debugResult = runDebugCommand(slash.arguments ?? '');
        setSendStatusText(debugResult.message);
        clearComposerDraftForCurrentContext();
        return;
      }
      const atAgent = hasText ? parseAtAgent(text) : null;
      const messageText = atAgent ? atAgent.text : text;
      const attachmentText = attachments.value.map((item) => {
        if (item.lineComment) {
          return formatCommentNote(
            item.lineComment.path,
            item.lineComment.startLine,
            item.lineComment.endLine,
            item.lineComment.text,
          );
        }
        return `[file: ${item.filename}]`;
      });
      const prompt = [messageText, ...attachmentText].filter(Boolean).join('\n\n');
      const selectedModelIDs = parseProviderModelKey(selectedModel.value);
      const selectedCodexModel = selectedModelIDs.providerID === CODEX_PROJECT_ID
        ? selectedModelIDs.modelID
        : undefined;
      if (selectedCodexModel) codexApi.selectModel(selectedCodexModel);
      await codexApi.sendPrompt(prompt, {
        model: selectedCodexModel,
        effort: selectedThinking.value,
      });
      await codexApi.refreshThreads();
      if (codexApi.activeThreadId.value) {
        selectedSessionId.value = codexApi.activeThreadId.value;
      }
      attachments.value = [];
      clearComposerDraftForCurrentContext();
      setSendStatusKey('app.status.sent');
    } catch (error) {
      setSendStatusKey('app.error.sendFailed', { message: toErrorMessage(error) });
    } finally {
      isSending.value = false;
    }
    return;
  }
  const selectedInfo = modelOptions.value.find((model) => model.id === selectedModel.value);
  const selectedModelIDs = parseProviderModelKey(selectedModel.value);
  const providerID = selectedInfo?.providerID ?? (selectedModelIDs.providerID || undefined);
  const modelID = selectedInfo?.modelID ?? (selectedModelIDs.modelID || undefined);
  if (!providerID || !modelID || !isProviderEnabled(providerID) || !isModelAvailable(selectedModel.value)) {
    ensureSelectedModelAvailable();
    setSendStatusText('Select an enabled provider/model before sending.');
    return;
  }
  if (hasText) {
    recentUserInputs.push({ text, time: Date.now() });
    while (recentUserInputs.length > 20) recentUserInputs.shift();
  }
  messageInput.value = '';
  enableFollow();
  isSending.value = true;
  setSendStatusKey('app.status.sending');
  try {
    if (slash && slash.name.toLowerCase() === 'shell') {
      if (!await openShellFromInput(slash.arguments ?? '')) return;
      setSendStatusKey('app.status.shellReady');
      clearComposerDraftForCurrentContext();
      return;
    }
    if (slash && slash.name.toLowerCase() === 'debug') {
      const debugResult = runDebugCommand(slash.arguments ?? '');
      setSendStatusText(debugResult.message);
      clearComposerDraftForCurrentContext();
      return;
    }
    if (slash && commandMatch) {
      await sendCommand(sessionId, commandMatch, slash.arguments ?? '');
      setSendStatusKey('app.status.sent');
      clearComposerDraftForCurrentContext();
      return;
    }
    // Parse @agent syntax after slash command handling
    const atAgent = hasText ? parseAtAgent(text) : null;
    const agentMatch = atAgent ? findAgentByName(atAgent.agent) : null;
    const directory = requireSelectedWorktree('send');
    if (!directory) return;
    const parts = [] as Array<Record<string, unknown>>;
    // Use remaining text after @agent (or original text if no @agent)
    const messageText = atAgent ? atAgent.text : text;
    if (hasText && messageText) parts.push({ type: 'text', text: messageText });
    if (hasAttachments) {
      for (const item of attachments.value) {
        if (item.lineComment) {
          parts.push({
            type: 'text',
            text: formatCommentNote(
              item.lineComment.path,
              item.lineComment.startLine,
              item.lineComment.endLine,
              item.lineComment.text,
            ),
          });
          parts.push({
            type: 'file',
            mime: 'text/plain',
            url: buildLineCommentFileUrl(
              item.lineComment.path,
              item.lineComment.startLine,
              item.lineComment.endLine,
            ),
            filename: item.filename.split(':')[0] || item.filename,
          });
        } else {
          parts.push({
            type: 'file',
            mime: item.mime,
            url: item.dataUrl,
            filename: item.filename,
          });
        }
      }
    }
    const sendPromptAsync = requireBackendMethod(backend().sendPromptAsync, 'session prompt sending');
    await sendPromptAsync(sessionId, {
      directory,
      agent: agentMatch?.name ?? selectedMode.value,
      model: {
        providerID,
        modelID: modelID || '',
      },
      variant: selectedThinking.value,
      parts,
    });
    setSendStatusKey('app.status.sent');
    attachments.value = [];
    clearComposerDraftForCurrentContext();
  } catch (error) {
    setSendStatusKey('app.error.sendFailed', { message: toErrorMessage(error) });
  } finally {
    isSending.value = false;
  }
}

// ---------------------------------------------------------------------------
// Alt-Arrow session / project navigation helpers
// ---------------------------------------------------------------------------

function switchSessionByDirection(delta: number) {
  const tree = navigableTree.value;
  const currentProjectId = selectedProjectId.value;
  const worktree = tree.find((w) => w.projectId === currentProjectId);
  if (!worktree) return;

  // Flatten sessions across all sandboxes in display order
  const flatSessions = worktree.sandboxes.flatMap((s) => s.sessions);
  if (flatSessions.length === 0) return;

  const currentIndex = flatSessions.findIndex((s) => s.id === selectedSessionId.value);
  if (currentIndex < 0) {
    // Current session not in navigable list — jump to first
    void switchSessionSelection(currentProjectId, flatSessions[0].id);
    return;
  }

  const nextIndex = (currentIndex + delta + flatSessions.length) % flatSessions.length;
  const target = flatSessions[nextIndex];
  if (target.id !== selectedSessionId.value) {
    void switchSessionSelection(currentProjectId, target.id);
  }
}

function switchProjectByDirection(delta: number) {
  const tree = navigableTree.value;
  if (tree.length === 0) return;

  const currentIndex = tree.findIndex((w) => w.projectId === selectedProjectId.value);
  const baseIndex = currentIndex < 0 ? 0 : currentIndex;
  const nextIndex = (baseIndex + delta + tree.length) % tree.length;
  const target = tree[nextIndex];
  if (!target?.projectId) return;

  // Pick the most recently updated session in the target project
  const allSessions = target.sandboxes.flatMap((s) => s.sessions);
  if (allSessions.length === 0) return;

  const best = allSessions.reduce((a, b) => ((a.timeUpdated ?? 0) >= (b.timeUpdated ?? 0) ? a : b));
  void switchSessionSelection(target.projectId, best.id);
}

let lastEscTime = 0;
let lastCtrlGTime = 0;
const DOUBLE_ESC_THRESHOLD = 500;
const DOUBLE_CTRL_G_THRESHOLD = 500;

function handleGlobalKeydown(event: KeyboardEvent) {
  // Ctrl-A: select all content in focused div (floating window body)
  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'a'
  ) {
    const active = document.activeElement;
    if (active instanceof HTMLDivElement) {
      event.stopPropagation();
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(active);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }

  // Ctrl-;: new chat
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === ';') {
    event.preventDefault();
    createNewSession();
    return;
  }

  // Ctrl-G: single = open session dropdown, double = select notification
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    const now = Date.now();
    if (now - lastCtrlGTime < DOUBLE_CTRL_G_THRESHOLD) {
      lastCtrlGTime = 0;
      topPanelRef.value?.closeSessionDropdown();
      if (notificationSessions.value.length > 0) {
        handleNotificationSessionSelect();
      }
      focusInput();
    } else {
      lastCtrlGTime = now;
      topPanelRef.value?.toggleSessionDropdown();
    }
    return;
  }

  // Alt-N: new session
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    createNewSession();
    return;
  }

  // Alt-O: open shell
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    openShellFromInput('');
    return;
  }

  // Alt-Left/Right: switch session within the same project
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    event.preventDefault();
    switchSessionByDirection(event.key === 'ArrowLeft' ? 1 : -1);
    return;
  }

  // Alt-Up/Down: switch to a different project
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  ) {
    event.preventDefault();
    switchProjectByDirection(event.key === 'ArrowUp' ? -1 : 1);
    return;
  }

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

function focusInput() {
  nextTick(() => inputPanelRef.value?.focus());
}

async function abortSession() {
  if (!ensureConnectionReady(t('app.actions.stopping'))) return;
  const sessionId = selectedSessionId.value;
  if (!sessionId || isAborting.value) return;
  isAborting.value = true;
  setSendStatusKey('app.status.stopping');
  try {
    if (activeBackendKind.value === 'codex') {
      await codexApi.interruptActiveTurn();
      setSendStatusKey('app.status.stopped');
      return;
    }
    const directory = activeDirectory.value.trim();
    const busyDescendants = busyDescendantSessionIds.value;
    const abortPromises = [
      requireBackendMethod(backend().abortSession, 'session abort')(sessionId, directory || undefined),
      ...busyDescendants.map((sid) =>
      requireBackendMethod(backend().abortSession, 'session abort')(sid, directory || undefined).catch(() => {}),
      ),
    ];
    await Promise.all(abortPromises);
    setSendStatusKey('app.status.stopped');
  } catch (error) {
    setSendStatusKey('app.error.stopFailed', { message: toErrorMessage(error) });
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
  () => minimizedEntries.value.length,
  (count) => {
    syncFloatingExtent();
    if (!showMinimizeButtons.value && count > 0) {
      restoreAllMinimizedWindows();
    }
  },
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
      const nextProjectId = (pd || selectedProjectId.value).trim();
      const nextDirectory = ad.trim();
      const candidates = (sessionsByProject.value[nextProjectId] ?? []).filter((session) => {
        if (session.parentID || session.time?.archived) return false;
        if (!nextDirectory) return true;
        return !session.directory || session.directory === nextDirectory;
      });
      const nextSessionId = pickPreferredSessionId(candidates);
      if (nextProjectId && nextSessionId) {
        selectedProjectId.value = nextProjectId;
        selectedSessionId.value = nextSessionId;
      } else if (nextDirectory && activeBackendKind.value !== 'codex') {
        void createSessionInDirectory(nextDirectory);
      }
    }

    if (adChanged && ad) {
      void fetchCommands(ad);
    }
  },
  { immediate: true },
);

watch(
  filteredSessions,
  () => {
    if (!bootstrapReady.value && !isBootstrapping.value) return;
    if (isBootstrapping.value) return;
    if (!selectedSessionId.value) {
      const preferredId = pickPreferredSessionId(filteredSessions.value);
      if (preferredId) {
        selectedSessionId.value = preferredId;
      }
      return;
    }
    validateSelectedSession();
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

function waitForPendingRenders(timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unwatch();
      reject(new Error('Render timeout'));
    }, timeoutMs);
    const unwatch = watch(
      pendingWorkerRenders,
      (count) => {
        if (count === 0) {
          // Extra guard: after counter hits 0, wait one more frame to
          // ensure no new watchEffect (e.g. useAssistantPreRenderer)
          // submits additional worker tasks before we resolve.
          requestAnimationFrame(() => {
            if (pendingWorkerRenders.value === 0) {
              clearTimeout(timer);
              unwatch();
              resolve();
            }
          });
        }
      },
      { immediate: true },
    );
  });
}

async function reloadSelectedSessionState(newId?: string, oldId?: string) {
  const reloadRequestId = ++sessionReloadRequestId;
  if (newId && isBootstrapping.value && !activeDirectory.value) {
    deferredSessionReloadId.value = newId;
    return;
  }
  if (newId) {
    deferredSessionReloadId.value = null;
  }
  fw.closeAll({ exclude: (key) => key.startsWith('shell:') });
  await nextTick();
  if (oldId) {
    msg.saveSessionState(oldId);
  }
  msg.reset();
  resetFollow();
  reasoning.reset();
  subagentWindows.reset();
  retryStatus.value = null;
  todosBySessionId.value = {};
  todoLoadingBySessionId.value = {};
  todoErrorBySessionId.value = {};
  await nextTick();
  if (newId) {
    const sessionId = newId;
    if (activeBackendKind.value === 'codex') {
      isLoadingHistory.value = true;
      try {
        if (codexApi.activeThreadId.value !== sessionId) {
          await codexApi.selectThread(sessionId);
        } else if (codexWorkspace.history.value.length === 0) {
          await codexApi.selectThread(sessionId);
        }
        msg.loadHistory(codexWorkspace.history.value);
      } finally {
        if (reloadRequestId === sessionReloadRequestId) {
          isLoadingHistory.value = false;
        }
      }
      if (reloadRequestId !== sessionReloadRequestId) return;
      await anchorOutputToBottom();
      if (reloadRequestId !== sessionReloadRequestId) return;
      nextTick(() => inputPanelRef.value?.focus());
      return;
    }
    const cacheHit = msg.tryLoadFromCache(sessionId);
    if (!cacheHit) {
      isLoadingHistory.value = true;
      try {
        await fetchAllowedSessionHistories(sessionId);
        // Allow one paint frame so that useAssistantPreRenderer's
        // watchEffect fires and submits worker tasks before we wait.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await waitForPendingRenders();
      } catch {
        // Render timeout or error — still show what we have
      } finally {
        if (reloadRequestId === sessionReloadRequestId) {
          isLoadingHistory.value = false;
        }
      }
    }
    if (reloadRequestId !== sessionReloadRequestId) return;
    await anchorOutputToBottom();
    if (reloadRequestId !== sessionReloadRequestId) return;
    if (uiInitState.value === 'ready') {
      await restoreShellSessions();
    }
    void reloadTodosForAllowedSessions();
    const directory = activeDirectory.value || undefined;
    void fetchPendingPermissions(directory);
    void fetchPendingQuestions(directory);
  }
  if (reloadRequestId !== sessionReloadRequestId) return;
  nextTick(() => inputPanelRef.value?.focus());
}

watch(
  selectedSessionId,
  (contextKey, previousKey) => {
    const prevContextKey = previousKey ?? '';
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

watch(localPinnedSessionStore, (store) => {
  const limited = limitPinnedSessionStore(store, 10000);
  if (!isSamePinnedSessionStore(store, limited)) {
    localPinnedSessionStore.value = limited;
    return;
  }
  schedulePinnedSessionStoreWrite(limited);
});

watch(
  () => serverState.projects,
  (projects) => {
    if (!bootstrapReady.value) return;
    const next = pruneDeletedSandboxStore(
      deletedSandboxStore.value,
      collectLiveSandboxDirectoriesByProject(projects),
    );
    if (JSON.stringify(next) === JSON.stringify(deletedSandboxStore.value)) return;
    deletedSandboxStore.value = next;
    writeDeletedSandboxStore(next);
  },
  { deep: true, immediate: true },
);

watch(
  appMonospaceFontFamily,
  () => {
    syncAppMonospaceMetrics();
  },
  { immediate: true },
);

watch(
  terminalFontFamily,
  () => {
    void refreshOpenShellFonts();
  },
  { immediate: true },
);

watch(
  terminalFontSizePx,
  () => {
    syncCanvasTermMetrics();
    void refreshOpenShellFonts();
  },
  { immediate: true },
);

watch(
  appFontSizePx,
  () => {
    syncAppMonospaceMetrics();
  },
  { immediate: true },
);

watch(
  messageFontSizePx,
  () => {
    syncAppMonospaceMetrics();
  },
  { immediate: true },
);

watch(
  uiFontSizePx,
  () => {
    syncAppMonospaceMetrics();
  },
  { immediate: true },
);

// Computed that extracts only the session properties needed for pinned session reconciliation
// This avoids deep watching the entire projects object
const pinnedSessionReconciliationDeps = computed(() => {
  const deps: Array<[string, number | undefined, number | undefined, string | undefined]> = [];
  for (const project of Object.values(serverState.projects)) {
    for (const sandbox of (Object.values(project.sandboxes) as SandboxState[])) {
      for (const session of Object.values(sandbox.sessions)) {
        const key = pinnedSessionStoreKey(project.id, session.id);
        if (!key) continue;
        deps.push([key, session.timePinned, session.timeArchived, session.parentID]);
      }
    }
  }
  return deps;
});

watch(
  () => [selectedProjectId.value, selectedSessionId.value, activeDirectory.value],
  () => {
    reconcileLocalPinnedSessionStore();
  },
  { immediate: true },
);

watch(
  pinnedSessionReconciliationDeps,
  () => {
    reconcileLocalPinnedSessionStore();
  },
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
  // During bootstrap, modelOptions may not be loaded yet.
  // Skip normalization; fetchProviders will handle it once models are available.
  if (modelOptions.value.length === 0) return;
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

watch(hiddenModels, (value) => {
  writeHiddenModelsToStorage(value);
});

watch(activeDirectory, (directory) => {
  if (isBootstrapping.value) return;
  const activePath = directory || undefined;
  if (!activePath) {
    treeNodes.value = [];
    expandedTreePathSet.value = new Set();
    selectedTreePath.value = '';
    return;
  }
  if (activeDirectory.value && activePath !== activeDirectory.value) return;
  void fetchCommands(activePath);
  void reloadTodosForAllowedSessions();
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

const shikiTheme = ref(DEFAULT_SYNTAX_THEME);

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

function renderWorkerHtmlWithI18n(args: Omit<RenderRequest, 'copyButtonLabel' | 'copiedLabel' | 'copyCodeAriaLabel' | 'copyMarkdownAriaLabel'>) {
  return renderWorkerHtml({
    ...args,
    copyButtonLabel: t('render.copyCode'),
    copiedLabel: t('render.copied'),
    copyCodeAriaLabel: t('render.copyCodeAria'),
    copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
  });
}

const toolRendererHelpers = {
  [toolRendererReadTypesKey]: TOOL_RENDERER_READ_EVENT_TYPES,
  [toolRendererWriteTypesKey]: TOOL_RENDERER_WRITE_EVENT_TYPES,
  [toolRendererMessageTypesKey]: TOOL_RENDERER_MESSAGE_EVENTS,
  parsePatchTextBlocks,
  guessLanguage,
  shouldRenderToolWindow,
  extractToolOutputText: parseToolOutputText,
  formatToolValue,
  renderWorkerHtml: renderWorkerHtmlWithI18n,
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

const ge = useGlobalEvents(credentials);
ge.setWorkerMessageHandler(serverState.handleStateMessage);
serverState.setNotificationShowHandler((message) => {
  showBrowserNotification(message.projectId, message.sessionId, message.kind);
});
const deltaAccumulator = useDeltaAccumulator();
deltaAccumulator.listen(ge);
const sessionScope = ge.session(selectedSessionId, sessionParentRecord);
const msg = useMessages();
msg.bindScope(sessionScope);
reasoning.bindScope(sessionScope);
subagentWindows.bindScope(sessionScope);

watch(selectedSessionId, (newId, oldId) => reloadSelectedSessionState(newId, oldId), { immediate: true });

watch([selectedProjectId, selectedSessionId, activeDirectory], syncActiveSelectionToWorker, {
  immediate: true,
});

watchEffect(() => {
  configureOpenCodeBackend({
    baseUrl: credentials.baseUrl.value,
    authorization: credentials.authHeader.value,
  });
  configureCodexBackend({
    bridgeUrl: credentials.codexBridgeUrl.value,
    bridgeToken: credentials.codexBridgeToken.value,
  });
  codexApi.url.value = credentials.codexBridgeUrl.value;
  codexApi.bridgeToken.value = credentials.codexBridgeToken.value;
  activeBackendKind.value = credentials.backendKind.value;
  loginBackendKind.value = credentials.backendKind.value;
  setActiveBackendKind(credentials.backendKind.value);
});

watch(
  () => codexWorkspace.history.value,
  (history) => {
    if (activeBackendKind.value !== 'codex') return;
    if (!selectedSessionId.value) return;
    msg.loadHistory(history);
  },
);

function backend() {
  return getActiveBackendAdapter();
}

const ptySupported = computed(() => {
  const active = backend();
  return Boolean(active.createPty && active.createPtyWebSocketUrl && active.deletePty);
});

const projectPickerHomePath = computed(() => (
  activeBackendKind.value === 'codex'
    ? (codexApi.homeDir.value || homePath.value)
    : homePath.value
));

function requireBackendMethod<T>(method: T | undefined, name: string): T {
  if (!method) throw new Error(`Active backend does not support ${name}.`);
  return method;
}

function normalizeProjectDirectoryForActiveBackend(directory: string) {
  const trimmed = directory.trim();
  if (activeBackendKind.value !== 'codex') return normalizeDirectory(trimmed);
  const home = normalizeDirectory(codexApi.homeDir.value || homePath.value || '/');
  if (trimmed === '~') return home || '/';
  if (trimmed.startsWith('~/')) {
    const suffix = trimmed.slice(2).replace(/^\/+/, '');
    return normalizeDirectory(`${home.replace(/\/+$/u, '')}/${suffix}`);
  }
  return normalizeDirectory(trimmed || home || '/');
}

function splitFileContentPathForActiveBackend(targetPath: string, sandboxDirectory: string | null) {
  return splitFileContentDirectoryAndPath(targetPath, sandboxDirectory, {
    strictSandbox: activeBackendKind.value === 'codex',
  });
}

watch(
  [
    activeBackendKind,
    () => codexWorkspace.project.value,
    () => codexWorkspace.activeSessionId.value,
    () => codexApi.homeDir.value,
  ],
  ([backendKind, project, activeSessionId, homeDir]) => {
    if (backendKind !== 'codex') return;
    Object.keys(serverState.projects).forEach((key) => {
      if (key !== CODEX_PROJECT_ID) delete serverState.projects[key];
    });
    serverState.projects[CODEX_PROJECT_ID] = project;
    serverState.bootstrapped.value = true;
    selectedProjectId.value = CODEX_PROJECT_ID;
    const projectSandboxes = project.sandboxes;
    const hasSelectedSession = Boolean(
      selectedSessionId.value && Object.values(projectSandboxes).some((sandbox) => sandbox.sessions[selectedSessionId.value]),
    );
    if (!hasSelectedSession && activeSessionId && selectedSessionId.value !== activeSessionId) {
      selectedSessionId.value = activeSessionId;
    }
    if (homeDir && homePath.value !== homeDir) {
      homePath.value = homeDir;
    }
  },
  { immediate: true },
);

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
      theme: DEFAULT_SYNTAX_THEME,
      gutterMode,
    });

  const directory = activeDirectory.value.trim();
  if (!directory) return renderText(t('app.read.noActiveDirectory'));
  if (!params.path) return renderText(t('app.read.pathMissing'));

  const requestPath = splitFileContentPathForActiveBackend(params.path, directory);

  try {
    const listFiles = requireBackendMethod(backend().listFiles, 'file listing');
    const listData = await listFiles({
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
      const code = entries.length > 0 ? entries.join('\n') : t('app.read.emptyDirectory');
      return renderText(code, 'none');
    }
  } catch {
    // Not a directory, or listing failed — proceed to read as file content.
  }

  try {
    const readFileContent = requireBackendMethod(backend().readFileContent, 'file reading');
    const data = (await readFileContent({
      directory: requestPath.directory,
      path: requestPath.path,
    })) as FileContentResponse;
    const type = data?.type === 'binary' ? 'binary' : 'text';

    if (type === 'binary') {
      return renderText(t('app.read.binaryFile', { path: params.path }), 'none');
    }

    const code = decodeApiTextContent(data);
    return renderWorkerHtml({
      id: `read-${params.callId ?? 'unknown'}-${Date.now().toString(36)}`,
      code,
      lang: params.lang,
      theme: DEFAULT_SYNTAX_THEME,
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
        theme: DEFAULT_SYNTAX_THEME,
        gutterMode: 'single',
        lineOffset: params.lineOffset,
        lineLimit: params.lineLimit,
      });
    }
    return renderText(t('app.read.failedToLoad', { path: params.path ?? 'unknown file' }));
  }
}

function renderEditDiffHtml(params: {
  diff: string;
  code?: string;
  after?: string;
  patch?: string;
  lang: string;
}): () => Promise<string> {
  return () =>
    renderWorkerHtml({
      id: `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      code: params.code ?? '',
      after: params.after,
      patch: params.patch ?? params.diff,
      lang: params.lang,
      theme: DEFAULT_SYNTAX_THEME,
      gutterMode: 'double',
    });
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

function toUint8ArrayFromBase64(input: string) {
  const decoded = atob(input);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
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

async function openGitDiff(payload: { path: string; staged: boolean }) {
  const { path, staged } = payload;
  const key = `git-diff:${staged ? 'staged' : 'changes'}:${path}`;
  if (fw.has(key)) {
    fw.bringToFront(key);
    return;
  }

  const snapshotMode: WorktreeSnapshotMode = staged ? 'staged' : 'changes';
  const modeLabel = staged ? t('app.git.staged') : t('app.git.unstaged');
  const pos = getFileViewerPosition();
  await fw.open(key, {
    content: t('app.git.loadingDiff', { mode: modeLabel, path }),
    lang: 'text',
    variant: 'plain',
    closable: true,
    resizable: true,
    focusOnOpen: true,
    scroll: 'manual',
    title: `${path} (${modeLabel})`,
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });

  try {
    const output = await runOneShotPtyCommand('bash', [
      '--noprofile',
      '--norc',
      '-c',
      FILE_SNAPSHOT_SCRIPT,
      '_',
      snapshotMode,
      path,
    ]);
    const snapshot = parseFileSnapshotOutput(output);
    if (!fw.has(key)) return;
    await fw.open(key, {
      component: DiffViewer,
      props: {
        path,
        isDiff: true,
        diffCode: snapshot.before,
        diffAfter: snapshot.after,
        diffCodeBase64: snapshot.beforeBase64,
        diffAfterBase64: snapshot.afterBase64,
        gutterMode: 'double',
        lang: guessLanguage(path),
        theme: shikiTheme.value,
      },
      closable: true,
      resizable: true,
      focusOnOpen: true,
      scroll: 'manual',
      title: `${path} (${modeLabel})`,
      x: pos.x,
      y: pos.y,
      width: FILE_VIEWER_WINDOW_WIDTH,
      height: FILE_VIEWER_WINDOW_HEIGHT,
      expiry: Infinity,
    });
  } catch (error) {
    log('File snapshot failed', error);
    if (fw.has(key)) {
      await fw.close(key);
    }
  }
}

async function openAllGitDiff(mode: WorktreeSnapshotMode = 'all') {
  const key = `git-diff:${mode}`;
  if (fw.has(key)) {
    fw.bringToFront(key);
    return;
  }

  const pos = getFileViewerPosition();
  await fw.open(key, {
    content: t('app.git.loadingAllChanges'),
    lang: 'text',
    variant: 'plain',
    closable: true,
    resizable: true,
    focusOnOpen: true,
    scroll: 'manual',
    title: t('app.git.loading'),
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });

  try {
    const output = await runOneShotPtyCommand('bash', [
      '--noprofile',
      '--norc',
      '-c',
      buildWorktreeSnapshotScript(mode, t),
    ]);
    const snapshot = parseCommitSnapshotOutput(output);
    if (snapshot.files.length === 0) {
      throw new Error(t('errors.noFilesInWorktreeSnapshot'));
    }
    if (!fw.has(key)) return;

    const first = snapshot.files[0];
    const title =
      snapshot.files.length === 1 ? first.file : t('app.git.filesChanged', { count: snapshot.files.length });
    const diffTabs =
      snapshot.files.length > 1
        ? snapshot.files.map((entry) => ({
            file: entry.file,
            before: entry.before,
            after: entry.after,
            beforeBase64: entry.beforeBase64,
            afterBase64: entry.afterBase64,
          }))
        : undefined;

    await fw.open(key, {
      component: DiffViewer,
      props: {
        path: first.file,
        isDiff: true,
        diffCode: first.before,
        diffAfter: first.after,
        diffCodeBase64: first.beforeBase64,
        diffAfterBase64: first.afterBase64,
        diffTabs,
        gutterMode: 'double',
        lang: snapshot.files.length === 1 ? guessLanguage(first.file) : 'text',
        theme: shikiTheme.value,
      },
      title,
      closable: true,
      resizable: true,
      focusOnOpen: true,
      scroll: 'manual',
      x: pos.x,
      y: pos.y,
      width: FILE_VIEWER_WINDOW_WIDTH,
      height: FILE_VIEWER_WINDOW_HEIGHT,
      expiry: Infinity,
    });
  } catch (error) {
    log('Working tree snapshot failed', error);
    if (fw.has(key)) {
      await fw.close(key);
    }
  }
}

function handleOpenDiffAll(payload: { mode: WorktreeSnapshotMode }) {
  openAllGitDiff(payload.mode);
}

function handleShowMessageDiff(payload: { messageKey: string; diffs: Array<MessageDiffEntry> }) {
  const { messageKey, diffs } = payload;
  if (!diffs || diffs.length === 0) return;
  const key = `message-diff:${messageKey}`;
  if (fw.has(key)) {
    fw.bringToFront(key);
    return;
  }
  const fileCount = diffs.length;
  const title = fileCount === 1 ? diffs[0].file : t('app.git.filesChanged', { count: fileCount });
  const viewerEntries = diffs.map(toMessageDiffViewerEntry);
  const firstDiff = viewerEntries[0];
  const firstFile = firstDiff?.file ?? '';
  const diffTabs = fileCount > 1 ? viewerEntries : undefined;

  const pos = getFileViewerPosition();
  fw.open(key, {
    component: DiffViewer,
    props: {
      path: firstFile,
      isDiff: true,
      diffCode: firstDiff?.before ?? '',
      diffAfter: firstDiff?.after,
      diffPatch: firstDiff?.patch,
      diffTabs,
      gutterMode: 'double',
      lang: fileCount === 1 ? guessLanguage(firstFile) : 'text',
      theme: shikiTheme.value,
    },
    closable: true,
    resizable: true,
    focusOnOpen: true,
    scroll: 'manual',
    title,
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });
}

async function handleShowCommit(hashRaw: string) {
  const hash = hashRaw.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return;
  const key = `commit-diff:${hash}`;
  if (fw.has(key)) {
    fw.bringToFront(key);
    return;
  }

  const pos = getFileViewerPosition();
  await fw.open(key, {
    content: t('app.git.loadingCommit', { hash }),
    lang: 'text',
    variant: 'plain',
    closable: true,
    resizable: true,
    focusOnOpen: true,
    scroll: 'manual',
    title: t('app.git.commitTitle', { hash }),
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });

  try {
    const output = await runOneShotPtyCommand('bash', [
      '--noprofile',
      '--norc',
      '-c',
      COMMIT_SNAPSHOT_SCRIPT,
      '_',
      hash,
    ]);
    const snapshot = parseCommitSnapshotOutput(output);
    if (snapshot.files.length === 0) {
      throw new Error(t('errors.noFilesInCommitSnapshot'));
    }
    if (!fw.has(key)) return;

    const first = snapshot.files[0];
    const title =
      snapshot.title ||
      (snapshot.files.length === 1 ? first.file : t('app.git.filesChanged', { count: snapshot.files.length }));
    const diffTabs =
      snapshot.files.length > 1
        ? snapshot.files.map((entry) => ({
            file: entry.file,
            before: entry.before,
            after: entry.after,
            beforeBase64: entry.beforeBase64,
            afterBase64: entry.afterBase64,
          }))
        : undefined;

    await fw.open(key, {
      component: DiffViewer,
      props: {
        path: first.file,
        isDiff: true,
        diffCode: first.before,
        diffAfter: first.after,
        diffCodeBase64: first.beforeBase64,
        diffAfterBase64: first.afterBase64,
        diffTabs,
        gutterMode: 'double',
        lang: snapshot.files.length === 1 ? guessLanguage(first.file) : 'text',
        theme: shikiTheme.value,
      },
      title,
      closable: true,
      resizable: true,
      focusOnOpen: true,
      scroll: 'manual',
      x: pos.x,
      y: pos.y,
      width: FILE_VIEWER_WINDOW_WIDTH,
      height: FILE_VIEWER_WINDOW_HEIGHT,
      expiry: Infinity,
    });
  } catch (error) {
    log('Commit snapshot failed', error);
    if (fw.has(key)) {
      await fw.close(key);
    }
  }
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

  const patchEvents = extractToolPatch(payload, toolRendererHelpers as any, t);
  if (patchEvents) {
    patchEvents.forEach((patchEvent: any, index: number) => {
      const rawId = patchEvent.callId ?? `apply_patch:${index}`;
      const key = keyPrefix ? `${keyPrefix}${rawId}` : rawId;
      const patchLang = patchEvent.lang ?? 'text';
      fw.open(key, {
        content: renderEditDiffHtml({
          diff: '',
          code: patchEvent.code,
          after: patchEvent.after,
          patch: patchEvent.patch,
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
        closable: true,
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
    t,
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
        closable: true,
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
  const keys = openToolPartAsWindow(
    payload.part,
    {
      closable: true,
      resizable: true,
      focusOnOpen: true,
      expiry: Infinity,
      scroll: 'manual',
      x,
      y,
    },
    'history-tool:',
  );
  for (const key of keys) historyToolWindowKeys.add(key);
}

function handleOpenHistoryReasoning(payload: { part: ReasoningPart }) {
  closeHistoryToolWindows();
  const { width, height } = fw.getExtent();
  const winW = 600;
  const winH = 400;
  const x = Math.max(0, Math.round((width - winW) / 2));
  const y = Math.max(0, Math.round((height - winH) / 2));
  const key = `history-reasoning:${payload.part.id}`;
  historyToolWindowKeys.add(key);
  fw.open(key, {
    component: ReasoningContent,
      props: {
        entries: [{ id: payload.part.id, text: payload.part.text }],
        theme: DEFAULT_SYNTAX_THEME,
      },
    title: t('app.windowTitles.thought'),
    scroll: 'manual',
    closable: true,
    resizable: true,
    focusOnOpen: true,
    variant: 'message',
    expiry: Infinity,
    width: winW,
    height: winH,
    x,
    y,
  });
}

function handleShowThreadHistory(payload: { entries: HistoryWindowEntry[] }) {
  const entries = payload.entries.map((entry) => {
    if (entry.kind !== 'message' || !entry.sessionId) return entry;
    return {
      ...entry,
      sessionLabel: entry.sessionLabel || resolveSessionLabelById(entry.sessionId),
    };
  });
  const key = 'thread-history';
  if (fw.has(key)) {
    fw.updateOptions(key, { props: { entries } });
    fw.bringToFront(key);
    return;
  }
  const { width, height } = fw.getExtent();
  const winW = 720;
  const winH = 520;
  const x = Math.max(0, Math.round((width - winW) / 2));
  const y = Math.max(0, Math.round((height - winH) / 2));
  fw.open(key, {
    component: ThreadHistoryContent,
    props: {
      entries,
      theme: shikiTheme.value,
      onToolClick: (part: ToolPart) => handleOpenHistoryTool({ part }),
      onReasoningClick: (part: ReasoningPart) => handleOpenHistoryReasoning({ part }),
    },
    title: t('app.windowTitles.threadHistory'),
    scroll: 'follow',
    smoothEngine: 'native',
    closable: true,
    resizable: true,
    focusOnOpen: true,
    variant: 'message',
    expiry: Infinity,
    width: winW,
    height: winH,
    x,
    y,
    afterClose: closeHistoryToolWindows,
  });
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
    component: ContentViewer,
    props: {
      path: filename,
      imageSrc: url,
    },
    closable: true,
    resizable: true,
    focusOnOpen: true,
    scroll: 'manual',
    title: filename || t('app.windowTitles.image'),
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
    const nextText = await showPrompt(t('app.prompt.editMessage'), payload.part.text);
    if (nextText === null) return;
  const trimmed = nextText.trimEnd();
  if (!trimmed) return;
  if (trimmed === payload.part.text) return;
  try {
    const part = { ...payload.part, text: trimmed };
    const patchMessagePart = requireBackendMethod(backend().patchMessagePart, 'message part patching');
    await patchMessagePart({
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

function resolveFileViewerAbsolutePath(path: string) {
  const directory = activeDirectory.value.trim();
  const requestPath = splitFileContentPathForActiveBackend(path, directory || null);
  return requestPath.path === '.'
    ? requestPath.directory
    : requestPath.directory === '/'
      ? `/${requestPath.path}`
      : `${requestPath.directory.replace(/\/+$/, '')}/${requestPath.path}`;
}

function resolveSessionLabelById(sessionId: string) {
  const target = sessionId.trim();
  if (!target) return '';
  for (const projectSessions of Object.values(sessionsByProject.value)) {
    const session = projectSessions.find((entry) => entry.id === target);
    if (session) return sessionLabel(session);
  }
  return target;
}

function toFileViewerKey(path: string, lines?: string) {
  const normalizedPath = resolveFileViewerAbsolutePath(path);
  if (!lines) return `file-viewer:${normalizedPath}`;
  return `file-viewer:${normalizedPath}:${lines}`;
}

function toFileViewerTitle(path: string, lines?: string) {
  const base = resolveWorktreeRelativePath(path) || path;
  if (!lines) return base;
  return `${base}:${lines}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let base64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i] ?? 0;
    const b2 = bytes[i + 1] ?? 0;
    const b3 = bytes[i + 2] ?? 0;
    base64 += chars[b1 >> 2];
    base64 += chars[((b1 & 3) << 4) | (b2 >> 4)];
    base64 += i + 1 < bytes.length ? chars[((b2 & 15) << 2) | (b3 >> 6)] : '=';
    base64 += i + 2 < bytes.length ? chars[b3 & 63] : '=';
  }
  return base64;
}

async function refreshFileViewerWindow(key: string, options?: { bringToFront?: boolean }) {
  const entry = fw.get(key);
  if (!entry) {
    return;
  }

  const path = typeof entry.props?.path === 'string' ? entry.props.path : '';
  if (!path) return;
  const lines = typeof entry.props?.lines === 'string' ? entry.props.lines : undefined;
  const storedDirectory = typeof entry.props?.fileDirectory === 'string' ? entry.props.fileDirectory : '';
  const storedFilePath = typeof entry.props?.filePath === 'string' ? entry.props.filePath : '';
  const fallbackDirectory = activeDirectory.value.trim();
  const fallbackRequestPath = fallbackDirectory ? splitFileContentPathForActiveBackend(path, fallbackDirectory) : null;
  const directory = storedDirectory || fallbackRequestPath?.directory || '';
  const filePath = storedFilePath || fallbackRequestPath?.path || '';

  if (!directory) {
    fw.updateOptions(key, {
      props: {
        ...entry.props,
        path,
        rawHtml: t('app.read.noActiveDirectorySelected'),
        lines,
        gutterMode: 'none',
        theme: shikiTheme.value,
      },
    });
    return;
  }

  try {
    const readFileContent = requireBackendMethod(backend().readFileContent, 'file reading');
    const data = (await readFileContent({
      directory,
      path: filePath,
    })) as FileContentResponse;
    const type = data?.type === 'binary' ? 'binary' : 'text';
    const encoding = typeof data?.encoding === 'string' ? data.encoding : 'utf-8';
    const content = typeof data?.content === 'string' ? data.content : '';
    const isBase64Payload = encoding === 'base64';

    // Force binary treatment for PDF files
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const forceBinary = ext === 'pdf';

    if (type === 'binary' || isBase64Payload || forceBinary) {
      if (!content && !forceBinary) {
        fw.updateOptions(key, {
          props: {
            ...entry.props,
            path,
            fileDirectory: directory,
            filePath,
            rawHtml: t('app.read.binaryContentNotIncluded'),
            fileContent: undefined,
            binaryBase64: undefined,
            fileSizeBytes: 0,
            lines,
            gutterMode: 'none',
            theme: shikiTheme.value,
          },
        });
        return;
      }

      // For forced binary files (PDF), fetch the raw bytes directly if the
      // backend responded with text so the payload is not corrupted.
      let binaryContent: string;
      if (isBase64Payload) {
        binaryContent = content;
      } else if (forceBinary) {
        try {
    const readFileContentBytes = requireBackendMethod(backend().readFileContentBytes, 'binary file reading');
    const bytes = await readFileContentBytes({ directory, path: filePath });
          binaryContent = bytesToBase64(bytes);
          console.log('[App] Fetched raw binary data, size:', bytes.length);
        } catch (fetchError) {
          console.error('[App] Failed to fetch binary content:', fetchError);
          const encoder = new TextEncoder();
          binaryContent = bytesToBase64(encoder.encode(content));
        }
      } else {
        const encoder = new TextEncoder();
        binaryContent = bytesToBase64(encoder.encode(content));
      }

      fw.updateOptions(key, {
        props: {
          ...entry.props,
          path,
          fileDirectory: directory,
          filePath,
          rawHtml: undefined,
          fileContent: undefined,
          binaryBase64: binaryContent,
          fileSizeBytes: content.length,
          lang: guessLanguage(path),
          lines,
          gutterMode: 'default',
          theme: shikiTheme.value,
        },
      });
      return;
    }

    const textContent = content;
    const fileSizeBytes = new TextEncoder().encode(textContent).length;
    fw.updateOptions(key, {
      props: {
        ...entry.props,
        path,
        fileDirectory: directory,
        filePath,
        rawHtml: undefined,
        binaryBase64: undefined,
        fileSizeBytes,
        fileContent: textContent,
        lang: guessLanguage(path),
        lines,
        gutterMode: 'default',
        theme: shikiTheme.value,
      },
    });
  } catch (error) {
    fw.updateOptions(key, {
      props: {
        ...entry.props,
        path,
        fileDirectory: directory,
        filePath,
        rawHtml: t('app.error.fileLoadFailed', { message: toErrorMessage(error) }),
        fileContent: undefined,
        binaryBase64: undefined,
        lines,
        gutterMode: 'none',
        theme: shikiTheme.value,
      },
    });
  }

  if (options?.bringToFront) {
    fw.bringToFront(key);
  }
}

async function refreshOpenFileViewersForPath(filePath: string) {
  const normalizedTarget = resolveFileViewerAbsolutePath(filePath);
  const tasks = fw.entries.value
    .filter((entry) => entry.key.startsWith('file-viewer:'))
    .filter((entry) => {
      const entryAbsolutePath = typeof entry.props?.absolutePath === 'string'
        ? entry.props.absolutePath
        : resolveFileViewerAbsolutePath(typeof entry.props?.path === 'string' ? entry.props.path : '');
      return entryAbsolutePath === normalizedTarget;
    })
    .map((entry) => refreshFileViewerWindow(entry.key));
  await Promise.all(tasks);
}

async function openFileViewer(path: string, lines?: string) {
  const key = toFileViewerKey(path, lines);
  if (fw.has(key)) {
    if (fw.get(key)?.minimized) fw.restore(key);
    else fw.bringToFront(key);
    await refreshFileViewerWindow(key, { bringToFront: false });
    return;
  }
  const pos = getFileViewerPosition(0.18, 0.14);
  const lang = guessLanguage(path);
  const absolutePath = resolveFileViewerAbsolutePath(path);
  const requestPath = splitFileContentPathForActiveBackend(path, activeDirectory.value.trim() || null);
  fw.open(key, {
    component: ContentViewer,
    props: {
      path,
      absolutePath,
      fileDirectory: requestPath.directory,
      filePath: requestPath.path,
      lang,
      lines,
      gutterMode: 'default',
      onRequestAddLineComment: (payload: { path: string; startLine: number; endLine: number; text: string }) => {
        addLineComment(payload);
      },
      theme: shikiTheme.value,
    },
    closable: true,
    resizable: true,
    focusOnOpen: true,
    scroll: 'manual',
    title: toFileViewerTitle(path, lines),
    x: pos.x,
    y: pos.y,
    width: FILE_VIEWER_WINDOW_WIDTH,
    height: FILE_VIEWER_WINDOW_HEIGHT,
    expiry: Infinity,
  });
  await refreshFileViewerWindow(key);
}

function guessLanguage(path?: string, eventType?: string) {
  if (!path) {
    if (eventType && eventType.startsWith('session.diff')) return 'text';
    return 'text';
  }
  return guessLanguageFromPath(path);
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
    relative = t('time.inHours', { count: diffHour });
  } else if (diffMin > 1) {
    relative = t('time.inMinutes', { count: diffMin });
  } else {
    relative = t('time.inSeconds', { count: diffSec });
  }

  return `${absolute} (${relative})`;
}

function applySessionStatusEvent(
  sessionId: string,
  status: { type: 'busy' | 'idle' | 'retry'; message?: string; next?: number; attempt?: number },
) {
  const isAllowedSession = allowedSessionIds.value.has(sessionId);
  const isSelectedSession = sessionId === selectedSessionId.value;

  if (status.type === 'busy' || status.type === 'idle') {
    if (isAllowedSession) {
      if (isSelectedSession) retryStatus.value = null;
      updateReasoningExpiry(sessionId, status.type);
    }
    return;
  }

  if (status.type !== 'retry') return;

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
  exitCode?: number;
}) {
  const ptyId = event.id ?? event.info?.id;
  if (!ptyId) return;
  if (!shellSessionsByPtyId.has(ptyId)) return;
  if (event.type === 'pty.exited') {
    const exitCode = typeof event.exitCode === 'number' ? event.exitCode : -1;
    const waiter = shellExitWaiters.get(ptyId);
    if (waiter) {
      shellExitWaiters.delete(ptyId);
      waiter(exitCode);
    }
    const session = shellSessionsByPtyId.get(ptyId);
    if (session?.closeOnSuccess && exitCode !== 0) {
      session.terminal.write(`\r\n\u001b[31m[Command failed: ${exitCode}]\u001b[0m\r\n`);
      return;
    }
    lingerAndRemoveShellWindow(ptyId);
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
      if (existing?.closeOnSuccess) return;
      lingerAndRemoveShellWindow(event.info.id);
    }
  }
}

async function startInitialization() {
  if (initializationInFlight) return;
  if (credentials.backendKind.value === 'codex') {
    initializationInFlight = true;
    ge.disconnect();
    activeBackendKind.value = 'codex';
    setActiveBackendKind('codex');
    configureCodexBackend({
      bridgeUrl: credentials.codexBridgeUrl.value,
      bridgeToken: credentials.codexBridgeToken.value,
    });
    codexApi.url.value = credentials.codexBridgeUrl.value;
    codexApi.bridgeToken.value = credentials.codexBridgeToken.value;
    uiInitState.value = 'loading';
    initErrorMessage.value = '';
    try {
      connectionState.value = 'connecting';
      initLoadingMessage.value = t('app.connection.connecting');
      await codexApi.connect(credentials.codexBridgeUrl.value);
      const existingThreadId = codexApi.activeThreadId.value || codexApi.visibleThreads.value[0]?.id || '';
      const thread = existingThreadId
        ? undefined
        : await codexApi.startThread(codexApi.homeDir.value || '/');
      const nextThreadId = existingThreadId || thread?.id || '';
      if (nextThreadId) {
        await codexApi.selectThread(nextThreadId);
        selectedSessionId.value = nextThreadId;
      }
      await Promise.all([fetchGlobalProviderConfig(), fetchProviders(true), fetchAgents()]);
      connectionState.value = 'ready';
      uiInitState.value = 'ready';
      await nextTick();
      if (selectedSessionId.value) {
        await reloadSelectedSessionState(selectedSessionId.value);
      }
    } catch (error) {
      codexApi.disconnect();
      connectionState.value = 'error';
      initErrorMessage.value = toErrorMessage(error);
      uiInitState.value = 'login';
    } finally {
      initializationInFlight = false;
    }
    return;
  }
  initializationInFlight = true;
  activeBackendKind.value = 'opencode';
  setActiveBackendKind('opencode');
  uiInitState.value = 'loading';
  initErrorMessage.value = '';
  reconnectingMessage.value = '';
  try {
    connectionState.value = 'connecting';
    initLoadingMessage.value = t('app.connection.connecting');
    await ge.connect({ failFast: true, timeoutMs: 10000 });
    connectionState.value = 'bootstrapping';
    initLoadingMessage.value = t('app.status.loadingServerPath');
    await fetchHomePath();
    initLoadingMessage.value = t('app.status.loadingProjects');
    await bootstrapSelections();
    if (activeDirectory.value) {
      initLoadingMessage.value = t('app.status.loadingWorktreeState');
      const directory = activeDirectory.value || undefined;
      await Promise.all([
        fetchCommands(directory),
        fetchPendingPermissions(directory),
        fetchPendingQuestions(directory),
      ]);
      void refreshGitStatus();
    }
    connectionState.value = 'ready';
    uiInitState.value = 'ready';
    await Promise.all([fetchGlobalProviderConfig(), fetchProviders()]);
    await fetchAgents();
  } catch (error) {
    if (!initializationInFlight) return;
    ge.disconnect();
    const msg = toErrorMessage(error);
    connectionState.value = 'error';
    if (/\(40[13]\)/.test(msg)) {
      storageSet(StorageKeys.state.lastAuthError, msg);
      credentials.clear();
      initErrorMessage.value = msg;
      uiInitState.value = 'login';
    } else {
      initErrorMessage.value = msg;
      uiInitState.value = 'login';
    }
  } finally {
    initializationInFlight = false;
  }
}

function handleLogin() {
  if (loginBackendKind.value === 'codex') {
    credentials.saveCodex(loginCodexBridgeUrl.value, loginCodexBridgeToken.value);
    void startInitialization();
    return;
  }
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
  activeBackendKind.value = credentials.backendKind.value;
  loginBackendKind.value = credentials.backendKind.value;
  loginCodexBridgeUrl.value = credentials.codexBridgeUrl.value;
  loginCodexBridgeToken.value = credentials.codexBridgeToken.value;
  disposeShellWindows();
  uiInitState.value = 'login';
  initErrorMessage.value = '';
  connectionState.value = 'connecting';
}

onMounted(() => {
  ensureBrowserNotificationPermission();
  window.addEventListener('keydown', handleGlobalKeydown);
  handleWindowResize();
  if (typeof document !== 'undefined' && 'fonts' in document) {
    void document.fonts.ready.then(() => {
      handleWindowResize();
    });
  }
  credentials.load();
  activeBackendKind.value = credentials.backendKind.value;
  loginBackendKind.value = credentials.backendKind.value;
  loginCodexBridgeUrl.value = credentials.codexBridgeUrl.value;
  loginCodexBridgeToken.value = credentials.codexBridgeToken.value;

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
  window.addEventListener('storage', handlePinnedSessionStoreStorage);
  window.addEventListener('storage', handleModelVisibilityStorage);
  document.addEventListener('visibilitychange', handleWindowAttentionChange);
  window.addEventListener('focus', handleWindowAttentionChange);
  window.addEventListener('blur', handleWindowAttentionChange);
  updateFloatingExtentObserver();
  globalEventUnsubscribers.push(
    ge.on('connection.open', () => {
      if (connectionState.value === 'reconnecting' || connectionState.value === 'error') {
        connectionState.value = 'ready';
        reconnectingMessage.value = '';
        setSendStatusKey('app.connection.connected');
      }
      if (bootstrapReady.value) {
        syncActiveSelectionToWorker();
        return;
      }
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('connection.reconnected', () => {
      connectionState.value = 'ready';
      reconnectingMessage.value = '';
      setSendStatusKey('app.connection.connected');
      syncActiveSelectionToWorker();
      void Promise.all([fetchGlobalProviderConfig(), fetchProviders(true)]);
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
        initErrorMessage.value = t('app.errors.sseConnectFailed');
        uiInitState.value = 'login';
        return;
      }
      connectionState.value = 'reconnecting';
      reconnectingMessage.value = t('app.connection.reconnecting');
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('permission.asked', (packet) => {
      const request = packet as PermissionRequest;
      upsertPermissionEntry(request);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('permission.replied', ({ requestID }) => {
      removePermissionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('permission.replied', ({ requestID }) => {
      removePermissionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('question.asked', (packet) => {
      const request = packet as QuestionRequest;
      upsertQuestionEntry(request);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('question.replied', ({ requestID }) => {
      removeQuestionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('question.replied', ({ requestID }) => {
      removeQuestionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('question.rejected', ({ requestID }) => {
      removeQuestionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('question.rejected', ({ requestID }) => {
      removeQuestionEntry(requestID);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('worktree.ready', () => {
      // Worker owns project/worktree graph updates.
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('session.updated', () => {
      validateSelectedSession();
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('session.deleted', ({ info }) => {
      const sessionInfo = info as SessionInfo;
      notificationSessionOrder.value = notificationSessionOrder.value.filter(
        (notificationKey) => notificationKey !== sessionInfo.id,
      );
      validateSelectedSession();
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
        [sessionID]: normalizeTodoItems(todos),
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
    ge.on('pty.exited', ({ id, exitCode }) => {
      handlePtyEvent({ type: 'pty.exited', info: null, id, exitCode });
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('pty.deleted', ({ id }) => {
      const filePath = ptyToFileMap.get(id);
      if (filePath) {
        void refreshOpenFileViewersForPath(filePath);
        feed({ file: filePath, event: 'change' });
        ptyToFileMap.delete(id);
      }
      lingerAndRemoveShellWindow(id);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('file.edited', (payload) => {
      console.log('[file.edited]', payload);
    }),
  );
  globalEventUnsubscribers.push(
    ge.on('file.watcher.updated', (payload) => {
      feed(payload);
    }),
  );
  globalEventUnsubscribers.push(
    sessionScope.on('message.part.updated', ({ part }) => {
      if (part.type !== 'tool') return;
      if (suppressAutoWindows.value) return;
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
  window.removeEventListener('storage', handlePinnedSessionStoreStorage);
  window.removeEventListener('storage', handleModelVisibilityStorage);
  document.removeEventListener('visibilitychange', handleWindowAttentionChange);
  window.removeEventListener('focus', handleWindowAttentionChange);
  window.removeEventListener('blur', handleWindowAttentionChange);
  floatingExtentResizeObserver?.disconnect();
  floatingExtentResizeObserver = null;
  floatingExtentObservedEl = null;
  if (floatingExtentFrameId !== null) {
    cancelAnimationFrame(floatingExtentFrameId);
    floatingExtentFrameId = null;
  }
  if (shellFitAllFrameId !== null) {
    cancelAnimationFrame(shellFitAllFrameId);
    shellFitAllFrameId = null;
  }
  if (windowResizeFrameId !== null) {
    cancelAnimationFrame(windowResizeFrameId);
    windowResizeFrameId = null;
  }
  if (pointerMoveFrameId !== null) {
    cancelAnimationFrame(pointerMoveFrameId);
    pointerMoveFrameId = null;
  }
  pendingPointerEvent = null;
  while (globalEventUnsubscribers.length > 0) {
    const dispose = globalEventUnsubscribers.pop();
    dispose?.();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  sessionScope.dispose();
  ge.disconnect();
  disposeShellWindows();
});
</script>

<style>
html,
body,
#app {
  min-height: 100%;
  background: var(--theme-page-bg, var(--theme-surface-page));
  color: var(--theme-page-text, var(--theme-text-primary, #e2e8f0));
}

body {
  margin: 0;
}
</style>

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
  background: var(--theme-page-bg, var(--theme-surface-page));
  color: var(--theme-page-text, var(--theme-text-primary, #e2e8f0));
}

.app-dock-panel {
  flex: 0 0 auto;
  width: 100%;
  min-height: 0;
}

.app-loading-view {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
  z-index: 0;
}

.app-loading-card {
  position: relative;
  width: min(420px, 92vw);
  border: 1px solid var(--theme-login-border, var(--theme-border-default, #334155));
  background: var(--theme-login-bg, var(--theme-surface-panel-elevated, rgba(15, 23, 42, 0.92)));
  border-radius: 14px;
  padding: 20px;
  box-shadow: var(--theme-shadow-panel, 0 14px 34px rgba(2, 6, 23, 0.5));
  text-align: center;
  color: var(--theme-login-text, var(--theme-text-primary, #e2e8f0));
}

.app-loading-brand {
  display: inline-flex;
  align-items: center;
  gap: 0;
  border: 1px solid color-mix(in srgb, var(--theme-login-border, var(--theme-border-default, #334155)) 88%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--theme-login-control-bg, var(--theme-surface-panel-muted, #0b1320)) 96%, transparent);
  color: var(--theme-login-text, var(--theme-text-primary, #e2e8f0));
  padding: 8px 16px;
  box-shadow: var(--theme-shadow-panel, 0 12px 32px rgba(2, 6, 23, 0.45));
}

.app-loading-brand-accent {
  color: var(--theme-login-accent, var(--theme-accent-primary, #60a5fa));
}

.app-loading-spinner {
  width: 26px;
  height: 26px;
  margin: 0 auto 12px;
  border-radius: 50%;
  border: 3px solid color-mix(in srgb, var(--theme-login-text-muted, var(--theme-text-muted, #94a3b8)) 45%, transparent);
  border-top-color: var(--theme-login-text, var(--theme-text-primary, #e2e8f0));
  animation: app-loading-spin 0.85s linear infinite;
}

.app-loading-title {
  margin: 0;
  color: var(--theme-login-text, var(--theme-text-primary, #e2e8f0));
  font-size: 14px;
  font-weight: 600;
}

.app-loading-message {
  margin: 8px 0 0;
  color: var(--theme-login-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 12px;
}

.app-loading-retry {
  margin-top: 14px;
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid var(--theme-login-border, var(--theme-border-default, #334155));
  background: var(--theme-login-control-bg, var(--theme-surface-panel-muted, #1e293b));
  color: var(--theme-login-text, var(--theme-text-primary, #e2e8f0));
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: none;
  outline: none;
}

.app-loading-retry:hover {
  background: var(--theme-login-active-bg, var(--theme-surface-panel-active, #334155));
}

.app-loading-retry:focus-visible {
  border-color: var(--theme-login-accent, var(--theme-accent-primary, #60a5fa));
}

.app-loading-connect {
  border-color: color-mix(in srgb, var(--theme-login-accent, var(--theme-accent-primary, #60a5fa)) 42%, transparent);
  background: color-mix(in srgb, var(--theme-login-accent, var(--theme-accent-primary, #60a5fa)) 76%, transparent);
  color: var(--theme-login-active-text, var(--theme-text-inverse, #ffffff));
}

.app-loading-connect:hover {
  background: color-mix(in srgb, var(--theme-login-accent, var(--theme-accent-primary, #60a5fa)) 86%, transparent);
}

.app-loading-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.app-loading-abort {
  background: transparent;
  border-color: var(--theme-login-border, var(--theme-border-strong, #475569));
  color: var(--theme-login-text-muted, var(--theme-text-muted, #94a3b8));
}

.app-loading-abort:hover {
  background: var(--theme-login-control-bg, var(--theme-surface-panel-muted, #1e293b));
  color: var(--theme-login-text, var(--theme-text-primary, #e2e8f0));
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

.app-login-backends {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.app-login-backend {
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid var(--theme-login-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  background: var(--theme-login-control-bg, var(--theme-surface-panel-muted, #1e293b));
  color: var(--theme-login-text-muted, var(--theme-text-muted, #94a3b8));
  padding: 7px 10px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: none;
  outline: none;
}

.app-login-backend.active {
  border-color: color-mix(in srgb, var(--theme-login-accent, var(--theme-accent-primary, #60a5fa)) 60%, transparent);
  background: color-mix(in srgb, var(--theme-login-accent, var(--theme-accent-primary, #60a5fa)) 18%, var(--theme-login-control-bg, #1e293b));
  color: var(--theme-login-text, var(--theme-text-primary, #e2e8f0));
}

.app-login-hint {
  margin: 0;
  color: var(--theme-login-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 11px;
  line-height: 1.35;
  text-align: left;
}

.app-login-input {
  width: 100%;
  padding: 8px 12px;
  appearance: none;
  -webkit-appearance: none;
  background: var(--theme-login-control-bg, var(--theme-surface-panel-muted, #1e293b));
  border: 1px solid var(--theme-login-border, var(--theme-border-default, #334155));
  border-radius: 6px;
  color: var(--theme-login-text, var(--theme-text-primary, #e2e8f0));
  font-size: 13px;
  box-sizing: border-box;
  box-shadow: none;
  outline: none;
}

.app-login-input::placeholder {
  opacity: 1;
  color: var(--theme-login-text-muted, var(--theme-text-muted, #64748b));
}

.app-login-input:focus {
  border-color: var(--theme-login-accent, var(--theme-accent-primary, #475569));
  background: var(--theme-login-active-bg, var(--theme-surface-panel-active, #0f172a));
}

.app-login-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.app-login-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--theme-login-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.app-login-checkbox input {
  accent-color: var(--theme-login-accent, var(--theme-accent-primary, #60a5fa));
}

.app-error-message {
  color: var(--theme-status-danger, #f87171);
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
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-height: 0;
  min-height: 200px;
}

.app-input:focus-within {
  z-index: 30;
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
  background: var(--theme-dock-handle, rgba(148, 163, 184, 0.6));
  box-shadow: var(--theme-dock-handle-shadow, 0 0 0 1px rgba(15, 23, 42, 0.6));
}

.input-resizer:hover::before {
  background: var(--theme-dock-handle-hover, rgba(226, 232, 240, 0.7));
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
}

.output-split {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: stretch;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.app-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: var(--todo-panel-gap);
  --todo-panel-gap: 10px;
  --todo-panel-open-width: clamp(260px, 26vw, 380px);
  --todo-panel-collapsed-width: 30px;
  --todo-panel-width: var(--todo-panel-open-width);
}

.app-body.todo-collapsed {
  --todo-panel-width: var(--todo-panel-collapsed-width);
}

.app-main-column {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.side-panel-area {
  position: relative;
  flex: 0 0 var(--todo-panel-width);
  width: var(--todo-panel-width);
  min-height: 0;
}

.todo-panel {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.side-resizer {
  position: absolute;
  top: 8px;
  bottom: 8px;
  right: -7px;
  width: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ew-resize;
  touch-action: none;
}

.side-resizer::before {
  content: '';
  width: 3px;
  height: 44px;
  border-radius: 999px;
  background: var(--theme-dock-handle, rgba(148, 163, 184, 0.6));
  box-shadow: var(--theme-dock-handle-shadow, 0 0 0 1px rgba(15, 23, 42, 0.6));
}

.side-resizer:hover::before {
  background: var(--theme-dock-handle-hover, rgba(226, 232, 240, 0.7));
}

.is-disabled {
  opacity: 0.4;
  pointer-events: none;
}

.tool-window-canvas {
  position: fixed;
  top: var(--canvas-top, 0px);
  left: 0;
  width: 100vw;
  height: var(--canvas-height, 100%);
  pointer-events: none;
  overflow: visible;
  z-index: 20;
  --dock-reserved: 0px;
  --tool-top-offset: 0px;
  --tool-area-height: var(--canvas-height, 100%);
  --term-font-family:
    'FiraCode Nerd Font Mono', 'FiraCode Nerd Font Mono Med', 'CaskaydiaCove Nerd Font Mono',
    'CaskaydiaCove NFM', 'IosevkaTerm Nerd Font', 'Iosevka Term', 'Iosevka Fixed',
    'JetBrains Mono', 'Cascadia Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono',
    monospace;
  --term-font-size: 13px;
  --term-line-height: 1.1;
  --term-width: 670px;
  --term-height: 386px;
}

.window-dock-tray {
  position: relative;
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  pointer-events: auto;
  z-index: 20;
  background: var(--theme-dock-tray-bg, color-mix(in srgb, #0b1220 92%, transparent));
  border: 1px solid var(--theme-dock-tray-border, rgba(148, 163, 184, 0.25));
  border-radius: 10px;
  box-shadow: var(--theme-dock-tray-shadow, 0 6px 18px rgba(2, 6, 23, 0.32));
  backdrop-filter: blur(3px);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--theme-dock-thumb, rgba(148, 163, 184, 0.55)) transparent;
}

.window-dock-tray::-webkit-scrollbar {
  height: 5px;
}

.window-dock-tray::-webkit-scrollbar-track {
  background: transparent;
}

.window-dock-tray::-webkit-scrollbar-thumb {
  background: var(--theme-dock-thumb, rgba(148, 163, 184, 0.5));
  border-radius: 999px;
}

.window-dock-chip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  max-width: min(280px, 45vw);
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--theme-dock-chip-border, rgba(148, 163, 184, 0.35));
  background: var(--theme-dock-chip-bg, color-mix(in srgb, #1e293b 82%, #0f172a));
  color: var(--theme-dock-chip-text, #e2e8f0);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.window-dock-chip:hover {
  background: var(--theme-dock-chip-hover-bg, color-mix(in srgb, #334155 84%, #0f172a));
  border-color: var(--theme-dock-handle-hover, rgba(226, 232, 240, 0.45));
}

.window-dock-chip-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  transition:
    transform 0.15s ease-in,
    opacity 0.15s ease-in;
}

:deep(.scale-enter-from),
:deep(.scale-leave-to) {
  opacity: 0;
  --win-scale-x: 1.5;
  --win-scale-y: 0;
}

.prompt-dialog-backdrop {
  border: none;
  padding: 0;
  margin: 0;
  background: transparent;
  color: inherit;
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.prompt-dialog-backdrop:not([open]) {
  display: none;
}

.prompt-dialog-backdrop::backdrop {
  background: var(--theme-surface-overlay, rgba(2, 6, 23, 0.65));
}

.prompt-dialog {
  width: min(420px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  background: var(--theme-modal-bg, var(--theme-surface-panel-elevated, rgba(15, 23, 42, 0.98)));
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 12px;
  box-shadow: var(--theme-shadow-panel, 0 12px 32px rgba(2, 6, 23, 0.45));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: var(--app-monospace-font-family);
}

.prompt-dialog-title {
  font-size: 14px;
  font-weight: 600;
}

.prompt-dialog-input {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  background: var(--theme-modal-control-bg, var(--theme-surface-panel, #0f172a));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: inherit;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.prompt-dialog-input:focus {
  border-color: var(--theme-form-control-focus-border, var(--theme-accent-primary, #60a5fa));
}

.prompt-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.prompt-dialog-btn {
  padding: 7px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  background: var(--theme-modal-control-bg, transparent);
  color: var(--theme-modal-text, var(--theme-text-muted, #94a3b8));
}

.prompt-dialog-btn:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, #1e293b));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.prompt-dialog-btn-confirm {
  color: var(--theme-accent-primary, #60a5fa);
}

.prompt-dialog-btn-confirm:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, #1e293b));
  color: var(--theme-accent-primary, #60a5fa);
}

.confirm-dialog-backdrop {
  border: none;
  padding: 0;
  margin: 0;
  background: transparent;
  color: inherit;
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.confirm-dialog-backdrop:not([open]) {
  display: none;
}

.confirm-dialog-backdrop::backdrop {
  background: var(--theme-surface-overlay, rgba(2, 6, 23, 0.65));
}

.confirm-dialog {
  width: min(400px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
  background: var(--theme-modal-bg, var(--theme-surface-panel-elevated, rgba(15, 23, 42, 0.98)));
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 12px;
  box-shadow: var(--theme-shadow-panel, 0 12px 32px rgba(2, 6, 23, 0.45));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: var(--app-monospace-font-family);
}

.confirm-dialog-message {
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}

.confirm-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.confirm-dialog-btn {
  padding: 7px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  background: var(--theme-modal-control-bg, transparent);
  color: var(--theme-modal-text, var(--theme-text-muted, #94a3b8));
}

.confirm-dialog-btn:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, #1e293b));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.confirm-dialog-btn-confirm {
  color: var(--theme-accent-primary, #60a5fa);
}

.confirm-dialog-btn-confirm:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, #1e293b));
  color: var(--theme-accent-primary, #60a5fa);
}
</style>
