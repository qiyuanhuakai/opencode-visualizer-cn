<template>
  <div class="top-panel" :style="regionStyle">
    <div class="top-row">
      <div class="top-left flex items-center gap-2" :title="gitRevision">
        <img width="48px" height="24px" src="/logo.svg" class="" />
        <div class="font-normal hidden lg:block relative top-0.5">{{ $t('topPanel.title') }}</div>
      </div>
      <div class="top-center">
        <button
          type="button"
          class="control-button notification-button"
          :class="{ 'has-notifications': notifications.length > 0 }"
          :title="
            notifications.length > 0
              ? $t('topPanel.pendingNotifications', { count: totalNotificationCount })
              : $t('topPanel.noNotifications')
          "
          :disabled="notifications.length === 0"
          @click="$emit('select-notification')"
        >
          <Icon
            :icon="notifications.length > 0 ? 'lucide:bell-ring' : 'lucide:bell'"
            :width="16"
            :height="16"
          />
          <span v-if="notifications.length > 0" class="notification-badge">{{
            totalNotificationCount
          }}</span>
        </button>
        <Dropdown
          v-model:open="treeDropdownOpen"
          class="tree-dropdown-root"
          :label="dropdownLabel"
          :placeholder="$t('topPanel.selectSession')"
          :title="$t('topPanel.selectSession') + ' (Ctrl-G)'"
          :auto-close="!managementMode"
          :popup-style="{ minWidth: '420px', width: 'min(680px, 90vw)', maxWidth: '90vw' }"
          popup-class="max-lg:left-0! max-lg:w-screen! max-lg:min-w-0! max-lg:max-w-none!"
          @select="onTreeSelect"
        >
          <template #label>
            <span v-if="selectedDisplay" class="selected-label">
              <span class="selected-status-icon">{{
                sessionStatusIcon(selectedDisplay.status)
              }}</span>
              <span class="selected-title">{{ selectedDisplay.title }}</span>
              <span class="selected-branch-badge">
                <Icon icon="lucide:git-branch" :width="11" :height="11" />
                {{ selectedDisplay.branch }}
              </span>
            </span>
            <span v-else class="selected-title">{{ $t('topPanel.selectSession') }}</span>
          </template>
          <template #default="{ close }">
            <div class="tree-menu">
              <DropdownSearch
                v-model="searchQuery"
                :placeholder="$t('topPanel.searchPlaceholder')"
                class="tree-search"
              >
                <template #before>
                  <Icon icon="lucide:search" class="search-icon" />
                </template>
                <template #after>
                  <button
                    v-if="searchQuery"
                    type="button"
                    class="clear-search"
                    @click.stop="searchQuery = ''"
                  >
                    <Icon icon="lucide:x" />
                  </button>
                </template>
              </DropdownSearch>

              <div v-if="managementMode" class="management-toolbar">
                <div class="management-title">
                  <Icon icon="lucide:check-check" :width="14" :height="14" />
                  <span>{{ $t('topPanel.management.title') }}</span>
                  <span class="management-count">{{ $t('topPanel.management.selectedCount', { count: selectedCount }) }}</span>
                </div>
                <div class="management-actions">
                  <button
                    type="button"
                    class="management-action"
                    @click.stop="toggleManagementMode"
                  >
                    {{ $t('topPanel.management.done') }}
                  </button>
                  <button
                    type="button"
                    class="management-action"
                    :disabled="visibleSessionKeys.length === 0"
                    @click.stop="toggleSelectAllVisible"
                  >
                    {{ $t(allVisibleSelected ? 'topPanel.management.unselectVisible' : 'topPanel.management.selectVisible') }}
                  </button>
                  <button
                    type="button"
                    class="management-action"
                    :disabled="selectedCount === 0"
                    @click.stop="clearManagedSessions"
                  >
                    {{ $t('topPanel.management.clear') }}
                  </button>
                  <button
                    type="button"
                    class="management-action"
                    :disabled="batchPinTargets.length === 0"
                    @click.stop="emitBatchSessionAction('pin')"
                  >
                    {{ $t('topPanel.management.pin') }} · {{ batchPinTargets.length }}
                  </button>
                  <button
                    type="button"
                    class="management-action"
                    :disabled="batchUnpinTargets.length === 0"
                    @click.stop="emitBatchSessionAction('unpin')"
                  >
                    {{ $t('topPanel.management.unpin') }} · {{ batchUnpinTargets.length }}
                  </button>
                  <button
                    type="button"
                    class="management-action"
                    :disabled="batchArchiveTargets.length === 0"
                    @click.stop="emitBatchSessionAction('archive')"
                  >
                    {{ $t('topPanel.management.archive') }} · {{ batchArchiveTargets.length }}
                  </button>
                  <button
                    type="button"
                    class="management-action"
                    :disabled="batchUnarchiveTargets.length === 0"
                    @click.stop="emitBatchSessionAction('unarchive')"
                  >
                    {{ $t('topPanel.management.unarchive') }} · {{ batchUnarchiveTargets.length }}
                  </button>
                  <button
                    type="button"
                    class="management-action is-danger"
                    :disabled="batchDeleteTargets.length === 0"
                    @click.stop="emitBatchSessionAction('delete')"
                  >
                    {{ $t('topPanel.management.delete') }} · {{ batchDeleteTargets.length }}
                  </button>
                </div>
              </div>

              <div class="tree-content">
                <div v-if="displayedTree.length === 0" class="tree-empty">
                  {{ searchQuery ? $t('topPanel.empty.noMatchingSessions') : $t('topPanel.empty.noWorktrees') }}
                </div>

                <div
                  v-for="worktree in displayedTree"
                  :key="worktree.directory"
                  class="tree-worktree"
                  :style="worktreeAccentStyle(worktree)"
                >
                  <div class="tree-worktree-header">
                    <div class="tree-header-main">
                      <Icon
                        :icon="worktree.projectId === 'global' ? 'lucide:globe' : 'lucide:package'"
                        class="tree-header-icon"
                      />
                      <div class="tree-label">
                        <span class="tree-label-name" :title="worktree.directory">{{
                          worktree.name || directoryBasename(worktree.directory)
                        }}</span>
                        <small class="tree-label-type" :title="worktree.directory">{{
                          shortenPath(worktree.directory)
                        }}</small>
                      </div>
                    </div>
                    <button
                      v-if="worktree.projectId && worktree.projectId !== 'global'"
                      type="button"
                      class="tree-action-button worktree-settings"
                      :title="$t('topPanel.projectSettings')"
                      @click.stop="
                        $emit('edit-project', {
                          projectId: worktree.projectId,
                          worktree: worktree.directory,
                        })
                      "
                    >
                      <Icon icon="lucide:settings" :width="14" :height="14" />
                    </button>
                  </div>

                  <div
                    v-for="sandbox in worktree.sandboxes"
                    :key="sandbox.directory"
                    class="tree-sandbox"
                  >
                    <div class="tree-sandbox-header">
                      <div class="tree-header-main">
                        <Icon
                          :icon="
                            worktree.projectId === 'global' ? 'lucide:folder' : 'lucide:git-branch'
                          "
                          class="tree-header-icon"
                        />
                        <div class="tree-label">
                          <span class="tree-label-name" :title="sandbox.directory">{{
                            sandbox.branch || directoryBasename(sandbox.directory)
                          }}</span>
                          <small class="tree-label-type" :title="sandbox.directory">{{
                            shortenPath(sandbox.directory)
                          }}</small>
                        </div>
                      </div>
                      <div class="tree-actions">
                        <button
                          type="button"
                          class="tree-action-button new-session"
                          :title="$t('topPanel.newSession')"
                          @click.stop="
                            handleCreateSessionIn(worktree.directory, sandbox.directory, close)
                          "
                        >
                          <Icon icon="lucide:message-circle-plus" :width="16" :height="16" />
                        </button>
                        <button
                          v-if="worktree.projectId !== 'global'"
                          type="button"
                          class="tree-action-button fork"
                          :title="$t('topPanel.createSandbox')"
                          @click.stop="handleCreateWorktree(sandbox.directory, close)"
                        >
                          <Icon icon="lucide:git-branch-plus" :width="16" :height="16" />
                        </button>
                        <button
                          v-if="
                            canDeleteSandbox(sandbox.directory, worktree.directory) &&
                            worktree.projectId !== 'global'
                          "
                          type="button"
                          class="tree-action-button danger"
                          @click.stop="handleSandboxDelete(worktree.projectId, worktree.directory, sandbox.directory, close)"
                        >
                          <Icon icon="lucide:trash-2" :width="16" :height="16" />
                        </button>
                      </div>
                    </div>

                    <div
                      v-for="session in sandbox.sessions"
                      :key="session.id"
                      class="tree-session-row"
                    >
                      <DropdownItem
                        v-if="!managementMode"
                        :href="sessionShareHref(worktree.projectId, session.id)"
                        :value="{
                          projectId: worktree.projectId,
                          worktree: worktree.directory,
                          directory: sandbox.directory,
                          sessionId: session.id,
                        }"
                        :active="session.id === selectedSessionId"
                      >
                        <div class="tree-session-main">
                          <span class="session-status-icon" :title="session.status">{{
                            sessionStatusIcon(session.status)
                          }}</span>
                          <div class="session-info">
                            <div class="session-info-top">
                              <span class="session-title">{{
                                session.title || session.slug || session.id
                              }}</span>
                              <span v-if="session.pinnedAt" class="session-badge-pinned">{{ $t('topPanel.badges.pinned') }}</span>
                              <span v-if="session.archivedAt" class="session-badge-archived"
                                >{{ $t('topPanel.badges.archived') }}</span
                              >
                            </div>
                            <span
                              v-if="session.timeCreated || session.timeUpdated"
                              class="session-time"
                            >
                              {{ formatSessionMetaTime(session) }}
                            </span>
                          </div>
                        </div>
                        <template #action>
                          <div class="tree-session-actions">
                            <button
                              v-if="!session.archivedAt"
                              type="button"
                              class="tree-action-button session-pin"
                              :class="session.pinnedAt ? 'pinned' : 'pin'"
                              :title="session.pinnedAt ? $t('topPanel.sessionActions.unpin') : $t('topPanel.sessionActions.pin')"
                              @click.stop.prevent="handleSessionPinToggle(session.id, session.pinnedAt)"
                            >
                              <Icon
                                :icon="session.pinnedAt ? 'lucide:pin-off' : 'lucide:pin'"
                                :width="16"
                                :height="16"
                              />
                            </button>
                            <button
                              v-else
                              type="button"
                              class="tree-action-button session-unarchive"
                              :title="$t('topPanel.sessionActions.unarchive')"
                              @click.stop.prevent="handleSessionUnarchive(session.id)"
                            >
                              <Icon icon="lucide:archive-restore" :width="16" :height="16" />
                            </button>
                            <button
                              v-if="!session.archivedAt"
                              type="button"
                              class="tree-action-button session-del"
                              :class="isShiftPressed ? 'danger' : 'archive'"
                              :title="
                                isShiftPressed
                                  ? $t('topPanel.sessionActions.deletePermanently')
                                  : $t('topPanel.sessionActions.archive')
                              "
                              @click.stop.prevent="handleSessionAction(session.id, close)"
                            >
                              <Icon
                                :icon="isShiftPressed ? 'lucide:trash-2' : 'lucide:archive'"
                                :width="16"
                                :height="16"
                              />
                            </button>
                          </div>
                        </template>
                      </DropdownItem>
                      <div
                        v-else
                        class="ui-dropdown-item ui-input-candidate-item management-session-item"
                        :class="{
                          'is-active': isManagedSessionSelected(
                            worktree.projectId,
                            sandbox.directory,
                            session.id,
                          ),
                        }"
                        :title="session.id"
                        @click.stop="toggleManagedSession(worktree.projectId, sandbox.directory, session.id)"
                      >
                        <button
                          type="button"
                          class="management-check"
                          :class="{
                            'is-selected': isManagedSessionSelected(
                              worktree.projectId,
                              sandbox.directory,
                              session.id,
                            ),
                          }"
                          :title="
                            isManagedSessionSelected(worktree.projectId, sandbox.directory, session.id)
                              ? $t('topPanel.sessionActions.unselect')
                              : $t('topPanel.sessionActions.select')
                          "
                          @click.stop="
                            toggleManagedSession(worktree.projectId, sandbox.directory, session.id)
                          "
                        >
                          <Icon
                            :icon="
                              isManagedSessionSelected(worktree.projectId, sandbox.directory, session.id)
                                ? 'lucide:check-square'
                                : 'lucide:square'
                            "
                            :width="16"
                            :height="16"
                          />
                        </button>
                        <div class="tree-session-main">
                          <span class="session-status-icon" :title="session.status">{{
                            sessionStatusIcon(session.status)
                          }}</span>
                          <div class="session-info">
                            <div class="session-info-top">
                              <span class="session-title">{{
                                session.title || session.slug || session.id
                              }}</span>
                              <span v-if="session.pinnedAt" class="session-badge-pinned">{{ $t('topPanel.badges.pinned') }}</span>
                              <span v-if="session.archivedAt" class="session-badge-archived"
                                >{{ $t('topPanel.badges.archived') }}</span
                              >
                            </div>
                            <span
                              v-if="session.timeCreated || session.timeUpdated"
                              class="session-time"
                            >
                              {{ formatSessionMetaTime(session) }}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="tree-footer">
                <button
                  type="button"
                  class="tree-footer-button"
                  @click="handleOpenDirectory(close)"
                >
                  <Icon icon="lucide:folder-open" :width="14" :height="14" />
                  {{ $t('topPanel.openProject') }}
                </button>
              </div>
            </div>
          </template>
        </Dropdown>

        <button
          type="button"
          class="control-button new-session-button"
          :disabled="!selectedSessionId"
          @click="$emit('new-session')"
          :title="$t('topPanel.newSessionShortcut')"
        >
          <Icon icon="lucide:message-circle-plus" :width="16" :height="16" />
        </button>
        <button
          type="button"
          class="control-button open-shell-button"
          :disabled="!activeDirectory"
          @click="$emit('open-shell')"
          :title="$t('topPanel.openShell')"
        >
          <Icon icon="lucide:terminal" :width="16" :height="16" />
        </button>
        <button
          type="button"
          class="control-button management-toggle-button"
          :class="{ 'is-active': managementMode }"
          :title="managementMode ? $t('topPanel.managementMode.exit') : $t('topPanel.managementMode.enter')"
          @pointerdown.stop.prevent
          @click.stop="toggleManagementMode"
        >
          <Icon
            :icon="managementMode ? 'lucide:check-check' : 'lucide:list-checks'"
            :width="16"
            :height="16"
          />
        </button>
      </div>
      <div class="top-right">
        <a
          href="https://github.com/xenodrive/vis/"
          target="_blank"
          rel="noopener noreferrer"
          class="control-button github-button"
          :title="$t('topPanel.github')"
        >
          <Icon icon="lucide:github" :width="16" :height="16" />
        </a>
        <button
          type="button"
          class="control-button settings-button"
          :title="$t('topPanel.settings')"
          @click="$emit('open-settings')"
        >
          <Icon icon="lucide:settings" :width="16" :height="16" />
        </button>
        <button
          type="button"
          class="control-button provider-manager-button"
          :title="$t('topPanel.providerManager')"
          @click="$emit('open-provider-manager')"
        >
          <Icon icon="lucide:plug-zap" :width="16" :height="16" />
        </button>
        <button
          type="button"
          class="control-button status-monitor-button"
          :title="$t('topPanel.statusMonitor')"
          @click="$emit('open-status-monitor')"
        >
          <Icon icon="lucide:activity" :width="16" :height="16" />
        </button>
        <button
          type="button"
          class="control-button suppress-button"
          :class="{ active: suppressAutoWindows }"
          :title="suppressAutoWindows ? $t('topPanel.autoWindowsSuppressed') : $t('topPanel.suppressAutoWindows')"
          @click="suppressAutoWindows = !suppressAutoWindows"
        >
          <Icon
            :icon="suppressAutoWindows ? 'lucide:eye-off' : 'lucide:eye'"
            :width="16"
            :height="16"
          />
        </button>
        <button
          type="button"
          class="control-button logout-button"
          :title="$t('topPanel.logout')"
          @click="$emit('logout')"
        >
          <Icon icon="lucide:log-out" :width="16" :height="16" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import Dropdown from './Dropdown.vue';
import DropdownItem from './Dropdown/Item.vue';
import DropdownSearch from './Dropdown/Search.vue';
import { useSettings } from '../composables/useSettings';

declare const __GIT_REVISION__: string;
const gitRevision = typeof __GIT_REVISION__ !== 'undefined' ? __GIT_REVISION__ : 'dev';
const { t } = useI18n();
const { suppressAutoWindows } = useSettings();

const regionStyle = computed(() => undefined);

export type TopPanelSession = {
  id: string;
  title?: string;
  slug?: string;
  status: 'busy' | 'idle' | 'retry' | 'unknown';
  timeCreated?: number;
  timeUpdated?: number;
  archivedAt?: number;
  pinnedAt?: number;
};

export type TopPanelSandbox = {
  directory: string;
  branch?: string;
  sessions: TopPanelSession[];
};

export type TopPanelWorktree = {
  directory: string;
  label: string;
  name?: string;
  projectId?: string;
  projectColor?: string;
  sandboxes: TopPanelSandbox[];
};

export type TopPanelNotificationSession = {
  projectId: string;
  sessionId: string;
  count: number;
};

export type TopPanelBatchSessionTarget = {
  sessionId: string;
  projectId?: string;
  directory: string;
};

export type TopPanelBatchSessionActionPayload = {
  action: 'pin' | 'unpin' | 'archive' | 'unarchive' | 'delete';
  sessions: TopPanelBatchSessionTarget[];
};

type SandboxDeletePayload = {
  projectId?: string;
  worktree: string;
  directory: string;
};

type SessionSelectPayload = {
  projectId?: string;
  worktree: string;
  directory: string;
  sessionId: string;
};

const props = defineProps<{
  treeData: TopPanelWorktree[];
  notificationSessions: TopPanelNotificationSession[];
  projectDirectory: string;
  activeDirectory: string;
  selectedSessionId: string;
  homePath?: string;
}>();

const notifications = computed(() => props.notificationSessions ?? []);
const totalNotificationCount = computed(() =>
  notifications.value.reduce((sum, item) => sum + item.count, 0),
);

const emit = defineEmits<{
  (event: 'select-notification'): void;
  (event: 'select-session', payload: SessionSelectPayload): void;
  (event: 'batch-session-action', payload: TopPanelBatchSessionActionPayload): void;
  (event: 'create-worktree-from', worktree: string): void;
  (event: 'new-session'): void;
  (event: 'new-session-in', payload: { worktree: string; directory: string }): void;
  (event: 'delete-active-directory', payload: SandboxDeletePayload): void;
  (event: 'delete-session', value: string): void;
  (event: 'archive-session', value: string): void;
  (event: 'unarchive-session', value: string): void;
  (event: 'pin-session', value: string): void;
  (event: 'unpin-session', value: string): void;
  (event: 'open-directory'): void;
  (event: 'open-shell'): void;
  (event: 'edit-project', payload: { projectId: string; worktree: string }): void;
  (event: 'open-settings'): void;
  (event: 'open-provider-manager'): void;
  (event: 'open-status-monitor'): void;
  (event: 'logout'): void;
  (event: 'dropdown-closed'): void;
}>();

const treeDropdownOpen = ref(false);

watch(treeDropdownOpen, (open) => {
  if (open) {
    searchQuery.value = '';
  }
  if (!open) {
    emit('dropdown-closed');
    managementMode.value = false;
    managedSessionKeys.value = [];
  }
});

function openSessionDropdown() {
  treeDropdownOpen.value = true;
}

function closeSessionDropdown() {
  treeDropdownOpen.value = false;
}

function toggleSessionDropdown() {
  treeDropdownOpen.value = !treeDropdownOpen.value;
}

defineExpose({ openSessionDropdown, closeSessionDropdown, toggleSessionDropdown });

const MAX_WORKTREES = Infinity;
const MAX_SANDBOXES = Infinity;
const MAX_SESSIONS = 5;

const searchQuery = ref('');
const isShiftPressed = ref(false);
const managementMode = ref(false);
const managedSessionKeys = ref<string[]>([]);

function managedSessionKey(projectId: string | undefined, directory: string, sessionId: string) {
  return `${projectId?.trim() ?? ''}::${directory.trim()}::${sessionId.trim()}`;
}

const sessionTargetMapByKey = computed(() => {
  const map = new Map<
    string,
    {
      target: TopPanelBatchSessionTarget;
      session: TopPanelSession;
    }
  >();
  props.treeData.forEach((worktree) => {
    worktree.sandboxes.forEach((sandbox) => {
      sandbox.sessions.forEach((session) => {
        const key = managedSessionKey(worktree.projectId, sandbox.directory, session.id);
        map.set(key, {
          target: {
            sessionId: session.id,
            projectId: worktree.projectId,
            directory: sandbox.directory,
          },
          session,
        });
      });
    });
  });
  return map;
});

const selectedCount = computed(() => managedSessionKeys.value.length);

const selectedEntries = computed(() =>
  managedSessionKeys.value
    .map((key) => sessionTargetMapByKey.value.get(key))
    .filter(
      (
        entry,
      ): entry is {
        target: TopPanelBatchSessionTarget;
        session: TopPanelSession;
      } => Boolean(entry),
    ),
);

const visibleSessionKeys = computed(() =>
  displayedTree.value.flatMap((worktree) =>
    worktree.sandboxes.flatMap((sandbox) =>
      sandbox.sessions.map((session) =>
        managedSessionKey(worktree.projectId, sandbox.directory, session.id),
      ),
    ),
  ),
);

const allVisibleSelected = computed(() => {
  if (visibleSessionKeys.value.length === 0) return false;
  const selected = new Set(managedSessionKeys.value);
  return visibleSessionKeys.value.every((key) => selected.has(key));
});

const batchPinTargets = computed(() =>
  selectedEntries.value
    .filter((entry) => !entry.session.archivedAt && !entry.session.pinnedAt)
    .map((entry) => entry.target),
);

const batchUnpinTargets = computed(() =>
  selectedEntries.value
    .filter((entry) => !entry.session.archivedAt && Boolean(entry.session.pinnedAt))
    .map((entry) => entry.target),
);

const batchArchiveTargets = computed(() =>
  selectedEntries.value
    .filter((entry) => !entry.session.archivedAt)
    .map((entry) => entry.target),
);

const batchUnarchiveTargets = computed(() =>
  selectedEntries.value
    .filter((entry) => Boolean(entry.session.archivedAt))
    .map((entry) => entry.target),
);

const batchDeleteTargets = computed(() => selectedEntries.value.map((entry) => entry.target));

const batchSessionTargetsByAction = computed(() => {
  return {
    pin: batchPinTargets.value,
    unpin: batchUnpinTargets.value,
    archive: batchArchiveTargets.value,
    unarchive: batchUnarchiveTargets.value,
    delete: batchDeleteTargets.value,
  };
});

watch(sessionTargetMapByKey, (map) => {
  if (managedSessionKeys.value.length === 0) return;
  managedSessionKeys.value = managedSessionKeys.value.filter((key) => map.has(key));
});

const selectedDisplay = computed(() => {
  const sid = props.selectedSessionId;
  if (!sid) return null;
  for (const worktree of props.treeData) {
    for (const sandbox of worktree.sandboxes) {
      const session = sandbox.sessions.find((candidate) => candidate.id === sid);
      if (!session) continue;
      const branch = sandbox.branch || directoryBasename(sandbox.directory);
      const title = session.title || session.slug || session.id;
      return { branch, title, status: session.status };
    }
  }
  return { branch: 'unknown', title: sid, status: 'unknown' as const };
});

const dropdownLabel = computed(() => {
  if (!selectedDisplay.value) return t('topPanel.selectSession');
  return `${selectedDisplay.value.branch} / ${selectedDisplay.value.title}`;
});

const displayedTree = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  let worktrees = props.treeData;

  if (query) {
    worktrees = worktrees
      .map((worktree) => {
        const worktreeMatches = matchesQuery(
          query,
          worktree.directory,
          worktree.label,
          worktree.name,
        );
        const sandboxes = worktree.sandboxes
          .map((sandbox) => {
            const sandboxMatches = matchesQuery(query, sandbox.directory, sandbox.branch);
            const sessions = sandbox.sessions.filter(
              (session) =>
                worktreeMatches ||
                sandboxMatches ||
                matchesQuery(
                  query,
                  session.title,
                  session.slug,
                  session.id,
                  session.archivedAt ? 'archived' : undefined,
                  session.pinnedAt ? 'pinned' : undefined,
                  session.timeCreated ? formatSessionTime(session.timeCreated) : undefined,
                  session.timeUpdated ? formatSessionTime(session.timeUpdated) : undefined,
                ),
            );
            if (!worktreeMatches && !sandboxMatches && sessions.length === 0) return null;
            return {
              ...sandbox,
              sessions: worktreeMatches || sandboxMatches ? sandbox.sessions : sessions,
            };
          })
          .filter((sandbox): sandbox is TopPanelSandbox => sandbox !== null);

        if (!worktreeMatches && sandboxes.length === 0) return null;
        return { ...worktree, sandboxes };
      })
      .filter((worktree): worktree is TopPanelWorktree => worktree !== null);
  } else {
    worktrees = worktrees
      .map((worktree) => ({
        ...worktree,
        sandboxes: worktree.sandboxes.map((sandbox) => ({
          ...sandbox,
          sessions: sandbox.sessions.filter((session) => !session.archivedAt),
        })),
      }))
      .filter((worktree) => worktree.sandboxes.some((sandbox) => sandbox.sessions.length > 0));
  }

  return worktrees.slice(0, MAX_WORKTREES).map((worktree) => ({
    ...worktree,
    sandboxes: worktree.sandboxes
      .filter((sandbox) => worktree.projectId !== 'global' || sandbox.sessions.length > 0)
      .slice(0, MAX_SANDBOXES)
      .map((sandbox) => ({
        ...sandbox,
        sessions: sandbox.sessions.slice(0, MAX_SESSIONS),
      })),
  }));
});

function matchesQuery(query: string, ...fields: (string | undefined)[]) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return false;
  return terms.every((term) => fields.some((field) => field?.toLowerCase().includes(term)));
}

function sessionShareHref(projectId: string | undefined, sessionId: string) {
  const params = new URLSearchParams();
  const normalizedProjectId = projectId?.trim() ?? '';
  const normalizedSessionId = sessionId.trim();
  if (normalizedProjectId) params.set('project', normalizedProjectId);
  if (normalizedSessionId) params.set('session', normalizedSessionId);
  return `?${params.toString()}`;
}

function shortenPath(path: string) {
  const homePath = props.homePath || '';
  if (homePath && path.startsWith(homePath)) {
    const replaced = path.replace(homePath, '~');
    return replaced || '~';
  }
  return path;
}

function directoryBasename(path: string) {
  return path.replace(/\/+$/, '').split('/').pop() ?? '';
}

function sessionStatusIcon(status: TopPanelSession['status']) {
  if (status === 'busy') return '🤔';
  if (status === 'retry') return '🔴';
  if (status === 'idle') return '🟢';
  return '⚪';
}

function formatSessionTime(timestamp: number) {
  const d = new Date(timestamp);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

function formatSessionMetaTime(session: TopPanelSession) {
  const created = session.timeCreated ? formatSessionTime(session.timeCreated) : undefined;
  const updated = session.timeUpdated ? formatSessionTime(session.timeUpdated) : undefined;
  if (created && updated) {
    return `${t('topPanel.meta.created')}: ${created} / ${t('topPanel.meta.updated')}: ${updated}`;
  }
  if (created) return `${t('topPanel.meta.created')}: ${created}`;
  if (updated) return `${t('topPanel.meta.updated')}: ${updated}`;
  return '';
}

function canDeleteSandbox(directory: string, worktreeDirectory: string) {
  const normalizedDirectory = directory.replace(/\/+$/, '');
  const normalizedWorktree = worktreeDirectory.replace(/\/+$/, '');
  return normalizedDirectory !== normalizedWorktree;
}

function worktreeAccentStyle(worktree: TopPanelWorktree) {
  if (!worktree.projectColor) return undefined;
  return {
    borderLeft: `3px solid ${worktree.projectColor}`,
  };
}

function onTreeSelect(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const value = payload as Partial<SessionSelectPayload>;
  if (!value.worktree || !value.directory || !value.sessionId) return;
  emit('select-session', {
    projectId: value.projectId,
    worktree: value.worktree,
    directory: value.directory,
    sessionId: value.sessionId,
  });
}

function handleCreateSessionIn(worktree: string, directory: string, close: () => void) {
  emit('new-session-in', { worktree, directory });
  close();
}

function handleCreateWorktree(worktree: string, close: () => void) {
  emit('create-worktree-from', worktree);
  close();
}

function handleSandboxDelete(
  projectId: string | undefined,
  worktree: string,
  directory: string,
  close?: () => void,
) {
  if (typeof window !== 'undefined') {
    const confirmed = window.confirm(t('topPanel.confirm.deleteWorktree', { directory }));
    if (!confirmed) return;
  }
  emit('delete-active-directory', {
    projectId,
    worktree,
    directory,
  });
  close?.();
}

function handleSessionDelete(sessionId: string, close?: () => void) {
  if (typeof window !== 'undefined') {
    const confirmed = window.confirm(t('topPanel.confirm.deleteSession'));
    if (!confirmed) return;
  }
  emit('delete-session', sessionId);
  close?.();
}

function handleSessionAction(sessionId: string, close?: () => void) {
  if (isShiftPressed.value) {
    handleSessionDelete(sessionId, close);
    return;
  }
  emit('archive-session', sessionId);
}

function handleSessionUnarchive(sessionId: string) {
  emit('unarchive-session', sessionId);
}

function handleSessionPinToggle(sessionId: string, pinnedAt?: number) {
  if (pinnedAt) {
    emit('unpin-session', sessionId);
    return;
  }
  emit('pin-session', sessionId);
}

function isManagedSessionSelected(projectId: string | undefined, directory: string, sessionId: string) {
  const key = managedSessionKey(projectId, directory, sessionId);
  return managedSessionKeys.value.includes(key);
}

function toggleManagedSession(projectId: string | undefined, directory: string, sessionId: string) {
  if (!sessionId) return;
  const key = managedSessionKey(projectId, directory, sessionId);
  const selected = new Set(managedSessionKeys.value);
  if (selected.has(key)) {
    selected.delete(key);
  } else {
    selected.add(key);
  }
  managedSessionKeys.value = Array.from(selected);
}

function clearManagedSessions() {
  managedSessionKeys.value = [];
}

function toggleSelectAllVisible() {
  if (visibleSessionKeys.value.length === 0) return;
  if (allVisibleSelected.value) {
    const visibleSet = new Set(visibleSessionKeys.value);
    managedSessionKeys.value = managedSessionKeys.value.filter((key) => !visibleSet.has(key));
    return;
  }
  const selected = new Set(managedSessionKeys.value);
  visibleSessionKeys.value.forEach((key) => {
    selected.add(key);
  });
  managedSessionKeys.value = Array.from(selected);
}

function toggleManagementMode() {
  const next = !managementMode.value;
  managementMode.value = next;
  if (next) {
    treeDropdownOpen.value = true;
  }
  if (!managementMode.value) {
    managedSessionKeys.value = [];
  }
}

function emitBatchSessionAction(action: TopPanelBatchSessionActionPayload['action']) {
  const sessions = batchSessionTargetsByAction.value[action];
  if (sessions.length === 0) return;

  if (action === 'delete' && typeof window !== 'undefined') {
    const confirmed = window.confirm(t('topPanel.confirm.deleteSessions', { count: sessions.length }));
    if (!confirmed) return;
  }

  emit('batch-session-action', {
    action,
    sessions,
  });

  if (action === 'delete' || action === 'archive' || action === 'unarchive') {
    const affected = new Set(
      sessions.map((session) =>
        managedSessionKey(session.projectId, session.directory, session.sessionId),
      ),
    );
    managedSessionKeys.value = managedSessionKeys.value.filter((key) => !affected.has(key));
    return;
  }

  managedSessionKeys.value = [...managedSessionKeys.value];
}

function handleGlobalKeydown(event: KeyboardEvent) {
  isShiftPressed.value = event.shiftKey;
}

function handleGlobalKeyup(event: KeyboardEvent) {
  isShiftPressed.value = event.shiftKey;
}

function resetShiftState() {
  isShiftPressed.value = false;
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown);
  window.addEventListener('keyup', handleGlobalKeyup);
  window.addEventListener('blur', resetShiftState);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('keyup', handleGlobalKeyup);
  window.removeEventListener('blur', resetShiftState);
});

function handleOpenDirectory(close: () => void) {
  emit('open-directory');
  close();
}
</script>

<style scoped>
.top-panel {
  position: relative;
  width: 100%;
  min-width: 0;
  /* Full-width background band that breaks out of parent padding */
  margin: -12px -12px 0;
  padding: 8px 12px;
  width: calc(100% + 24px);
  background: var(--theme-top-bg, rgba(15, 23, 42, 0.92));
  border-bottom: 1px solid var(--theme-top-border, #334155);
}

.top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.top-left {
  flex: 0 0 auto;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--theme-top-text, #f1f5f9);
}

.top-center {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  background: var(--theme-top-dropdown-bg, transparent);
  --theme-top-border: var(--theme-top-dropdown-border, #334155);
  --theme-top-control-bg: var(--theme-top-dropdown-control-bg, #0b1320);
  --theme-top-text: var(--theme-top-dropdown-text, #e2e8f0);
  --theme-top-bg: var(--theme-top-dropdown-bg, rgba(15, 23, 42, 0.92));
}

.top-right {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

.tree-dropdown-root {
  flex: 0 1 680px;
  width: min(680px, 70vw);
  min-width: 260px;
}

.tree-menu {
  display: flex;
  flex-direction: column;
   background: var(--theme-top-dropdown-bg, transparent);
   --theme-top-border: var(--theme-top-dropdown-border, #334155);
   --theme-top-control-bg: var(--theme-top-dropdown-control-bg, #0b1320);
   --theme-top-text: var(--theme-top-dropdown-text, #e2e8f0);
   --theme-top-bg: var(--theme-top-dropdown-bg, rgba(15, 23, 42, 0.92));
}

.tree-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--theme-top-dropdown-border, var(--theme-top-border, #334155));
  background: var(--theme-top-dropdown-bg, var(--theme-top-bg, rgba(15, 23, 42, 0.9)));
  --ui-dropdown-text-muted: var(--theme-top-dropdown-text-muted, var(--theme-text-muted, #64748b));
}

.search-icon {
  width: 14px;
  height: 14px;
  color: var(--theme-top-text-muted, var(--theme-text-muted, #64748b));
}

.tree-search :deep(.ui-dropdown-search-input) {
  border-radius: 8px;
  font-size: 12px;
  padding: 6px 8px;
}

.tree-search :deep(.ui-dropdown-search-input):focus {
  background: var(--theme-top-dropdown-active-bg, rgba(30, 64, 175, 0.15));
}

.clear-search {
  border: none;
  background: transparent;
  color: var(--theme-top-text-muted, #64748b);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}

.management-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--theme-top-dropdown-border, #334155);
  background: var(--theme-top-dropdown-control-bg, rgba(14, 24, 40, 0.95));
}

.management-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--theme-top-dropdown-text, #cbd5e1);
  font-size: 12px;
}

.management-count {
  color: var(--theme-status-git-attention, #93c5fd);
  font-variant-numeric: tabular-nums;
}

.management-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ui-action-gap);
}

.management-action {
  border: 1px solid var(--theme-top-dropdown-border, #334155);
  border-radius: 999px;
  background: var(--theme-top-dropdown-control-bg, #111a2c);
  color: var(--theme-top-dropdown-text, #cbd5e1);
  font-size: 11px;
  line-height: 1;
  padding: 5px 8px;
  cursor: pointer;
}

.management-action:hover {
  background: var(--theme-top-dropdown-active-bg, #1d2a45);
}

.management-action.is-danger {
  color: var(--theme-text-danger, #fca5a5);
  border-color: color-mix(in srgb, var(--theme-status-danger, #fca5a5) 45%, transparent);
}

.management-action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.tree-content {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
  padding: 6px 0;
}

.tree-worktree + .tree-worktree {
  border-top: 1px solid var(--theme-top-dropdown-border, #334155);
}

.tree-empty {
  padding: 14px;
  text-align: center;
  color: var(--theme-top-text-muted, #94a3b8);
  font-size: 12px;
}

.tree-worktree-header,
.tree-sandbox-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.tree-header-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 4px;
  row-gap: 0;
  min-width: 0;
  flex: 1 1 auto;
}

.tree-header-icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  color: var(--theme-top-text-muted, #64748b);
}

.tree-worktree-header {
  padding: 6px 8px;
}

.tree-sandbox-header {
  padding: 5px 8px 5px 24px;
}

.tree-label {
  display: contents;
}

.tree-label-name {
  font-size: 12px;
  color: var(--theme-top-dropdown-text, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1 1 auto;
}

.tree-label-type {
  font-size: 10px;
  color: var(--theme-top-text-muted, #64748b);
  flex-basis: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: var(--ui-action-gap);
  /* Reserve space for new-session + fork + delete buttons so layout doesn't shift when delete is hidden */
  min-width: calc(var(--ui-icon-action-size) * 3 + var(--ui-action-gap) * 2);
}

.tree-action-button.new-session {
  color: var(--theme-status-git-added-strong, #86efac);
}

.tree-action-button.fork {
  color: var(--theme-status-git-attention, #93c5fd);
}

.tree-action-button {
  border: 1px solid var(--ui-icon-action-border);
  border-radius: var(--ui-icon-action-radius);
  background: var(--ui-icon-action-bg);
  color: var(--theme-text-secondary, #cbd5e1);
  font-size: 10px;
  line-height: 1;
  width: var(--ui-icon-action-size);
  height: var(--ui-icon-action-size);
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
}

.tree-action-button:hover {
  background: var(--ui-icon-action-bg-hover);
}

.tree-action-button.worktree-settings {
  color: var(--theme-top-text-muted, var(--theme-text-muted, #94a3b8));
}

.tree-action-button.danger {
  color: var(--theme-text-danger, #fca5a5);
}

.tree-action-button.archive {
  color: var(--theme-status-git-archived, #c4b5fd);
}

.tree-action-button.pin {
  color: var(--theme-status-git-pinned, #fbbf24);
}

.tree-action-button.pinned {
  color: var(--theme-status-git-pinned-strong, #f59e0b);
  border-color: color-mix(in srgb, var(--theme-status-git-pinned-strong, #f59e0b) 55%, transparent);
  background: color-mix(in srgb, var(--theme-status-git-pinned-strong, #f59e0b) 12%, transparent);
}

/* Session rows: wrapper provides indentation via :deep() */
.tree-session-row :deep(.ui-dropdown-item) {
  padding-left: 40px;
  border-radius: 0;
  color: var(--theme-top-dropdown-text, #e2e8f0);
}

.tree-session-row :deep(.ui-dropdown-item:hover),
.tree-session-row :deep(.ui-dropdown-item[aria-selected='true']) {
  background: var(--theme-top-dropdown-active-bg, rgba(30, 41, 59, 0.8));
}

.tree-session-row :deep(.ui-dropdown-item.is-active) {
  background: var(--theme-top-dropdown-active-bg, rgba(59, 130, 246, 0.2));
  border: 1px solid var(--theme-top-dropdown-accent, rgba(59, 130, 246, 0.45));
}

.management-session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 8px;
  padding: 6px 8px 6px 40px;
  border-radius: 8px;
  color: var(--theme-top-dropdown-text, #e2e8f0);
  font-size: 12px;
  cursor: pointer;
}

.management-session-item:hover,
.management-session-item[aria-selected='true'] {
  background: var(--theme-top-dropdown-active-bg, rgba(30, 41, 59, 0.8));
}

.management-session-item.is-active {
  background: var(--theme-top-dropdown-active-bg, rgba(59, 130, 246, 0.18));
  border: 1px solid var(--theme-top-dropdown-accent, rgba(59, 130, 246, 0.35));
}

.management-check {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: 1px solid var(--theme-top-dropdown-border, #334155);
  border-radius: 6px;
  background: var(--theme-top-dropdown-control-bg, #111a2c);
  color: var(--theme-top-text-muted, #94a3b8);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.management-session-item .tree-session-main {
  min-width: 0;
}

.management-check:hover {
  background: var(--theme-top-dropdown-active-bg, #1d2a45);
}

.management-check.is-selected {
  color: var(--theme-accent-primary, #60a5fa);
  border-color: var(--theme-top-dropdown-accent, rgba(59, 130, 246, 0.45));
  background: var(--theme-top-dropdown-active-bg, rgba(30, 64, 175, 0.2));
}

/* ===== Tree branch connectors ===== */

/* --- Worktree → Sandbox branches --- */
.tree-sandbox {
  position: relative;
}

/* Non-last sandbox: ├── (vertical line continues to next sibling) */
.tree-sandbox:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 15px;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--theme-top-dropdown-border, var(--theme-status-git-connector, rgba(71, 85, 105, 0.5)));
  pointer-events: none;
}

.tree-sandbox:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 15px;
  top: 13px;
  width: 7px;
  height: 0;
  border-top: 1px solid var(--theme-top-dropdown-border, var(--theme-status-git-connector, rgba(71, 85, 105, 0.5)));
  pointer-events: none;
}

/* Last sandbox: └── (L-shape, no line below) */
.tree-sandbox:last-child::before {
  content: '';
  position: absolute;
  left: 15px;
  top: 0;
  width: 7px;
  height: 13px;
  border-left: 1px solid var(--theme-top-dropdown-border, var(--theme-status-git-connector, rgba(71, 85, 105, 0.5)));
  border-bottom: 1px solid var(--theme-top-dropdown-border, var(--theme-status-git-connector, rgba(71, 85, 105, 0.5)));
  border-bottom-left-radius: 4px;
  pointer-events: none;
}

/* --- Sandbox → Session branches --- */
.tree-session-row {
  position: relative;
}

/* Non-last session: ├── */
.tree-session-row:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 31px;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--theme-top-dropdown-border, var(--theme-status-git-connector, rgba(71, 85, 105, 0.4)));
  pointer-events: none;
}

.tree-session-row:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 31px;
  top: 14px;
  width: 7px;
  height: 0;
  border-top: 1px solid var(--theme-top-dropdown-border, var(--theme-status-git-connector, rgba(71, 85, 105, 0.4)));
  pointer-events: none;
}

/* Last session: └── */
.tree-session-row:last-child::before {
  content: '';
  position: absolute;
  left: 31px;
  top: 0;
  width: 7px;
  height: 14px;
  border-left: 1px solid var(--theme-top-dropdown-border, var(--theme-status-git-connector, rgba(71, 85, 105, 0.4)));
  border-bottom: 1px solid var(--theme-top-dropdown-border, var(--theme-status-git-connector, rgba(71, 85, 105, 0.4)));
  border-bottom-left-radius: 4px;
  pointer-events: none;
}

.tree-session-main {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  column-gap: 8px;
  row-gap: 2px;
  flex: 1 1 auto;
}

.tree-session-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--ui-action-gap);
  flex: 0 0 auto;
}

.session-status-icon {
  flex: 0 0 auto;
  width: 14px;
  text-align: center;
}

.session-title {
  color: var(--theme-top-dropdown-text, #e2e8f0);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.session-info {
  display: contents;
}

.session-info-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.session-time {
  font-size: 10px;
  color: var(--theme-top-text-muted, #64748b);
  white-space: nowrap;
  flex-basis: 100%;
}

.session-badge-archived {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 10px;
  line-height: 1;
  color: var(--theme-status-git-archived, #c4b5fd);
  background: color-mix(in srgb, var(--theme-status-git-archived, #c4b5fd) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-status-git-archived, #c4b5fd) 30%, transparent);
  border-radius: 999px;
  padding: 2px 6px;
}

.session-badge-pinned {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 10px;
  line-height: 1;
  color: var(--theme-status-git-pinned, #fbbf24);
  background: color-mix(in srgb, var(--theme-status-git-pinned, #fbbf24) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-status-git-pinned, #fbbf24) 30%, transparent);
  border-radius: 999px;
  padding: 2px 6px;
}

.session-del {
  flex: 0 0 auto;
}

.session-pin {
  flex: 0 0 auto;
}

.session-unarchive {
  flex: 0 0 auto;
  color: var(--theme-status-git-attention, #93c5fd);
}

.tree-footer {
  flex: 0 0 auto;
  border-top: 1px solid var(--theme-top-dropdown-border, #334155);
  padding: 8px 0 0;
  background: transparent;
}

.tree-footer-button {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid var(--theme-top-dropdown-border, #334155);
  border-radius: 8px;
  background: var(--theme-top-dropdown-control-bg, #111a2c);
  color: var(--theme-top-dropdown-text, #e2e8f0);
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: none;
  outline: none;
}

.tree-footer-button:hover {
  background: var(--theme-top-dropdown-active-bg, #1d2a45);
}

.tree-footer-button:focus-visible {
  border-color: var(--theme-top-dropdown-accent, rgba(59, 130, 246, 0.45));
}

.control-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  min-width: 32px;
  height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--theme-top-dropdown-border, #334155);
  border-radius: 8px;
  background: var(--theme-top-dropdown-control-bg, #0b1320);
  color: var(--theme-top-dropdown-text, #e2e8f0);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.new-session-button {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  justify-content: center;
  color: var(--theme-status-git-added-strong, #86efac);
}

.new-session-button:hover,
.open-shell-button:hover {
  background: var(--theme-top-dropdown-active-bg, #1d2a45);
}

.open-shell-button {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  justify-content: center;
  color: var(--theme-status-git-archived, #c4b5fd);
}

.management-toggle-button {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  justify-content: center;
  color: var(--theme-status-git-attention, #93c5fd);
}

.management-toggle-button.is-active {
  border-color: color-mix(in srgb, var(--theme-status-git-attention, #93c5fd) 45%, transparent);
  background: color-mix(in srgb, var(--theme-status-git-attention, #93c5fd) 16%, transparent);
  color: var(--theme-status-git-attention, #93c5fd);
}

.management-toggle-button:hover {
  background: var(--theme-top-dropdown-active-bg, #1d2a45);
}

.notification-button {
  position: relative;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  justify-content: center;
  color: var(--theme-top-dropdown-text, var(--theme-text-muted, #64748b));
}

.notification-button.has-notifications {
  color: var(--theme-top-dropdown-accent, var(--theme-status-git-pinned, #fbbf24));
}

.notification-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--theme-status-danger, #ef4444);
  color: var(--theme-text-inverse, #fff);
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.tree-dropdown-root :deep(.ui-dropdown-button) {
  background: var(--theme-top-dropdown-control-bg, #0b1320);
  border-color: var(--theme-top-dropdown-border, #334155);
  color: var(--theme-top-dropdown-text, #e2e8f0);
  box-shadow: none;
}

.tree-dropdown-root :deep(.ui-dropdown-menu) {
  background: var(--theme-top-dropdown-bg, #0b1320);
  border: 1px solid var(--theme-top-dropdown-border, #334155);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.selected-label {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.selected-status-icon {
  flex: 0 0 auto;
  width: 14px;
  text-align: center;
  font-size: 12px;
  line-height: 1;
}

.selected-title {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.selected-branch-badge {
  flex: 0 0 auto;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--theme-top-dropdown-border, #334155);
  border-radius: 999px;
  padding: 2px 6px;
  color: var(--theme-top-dropdown-text, #cbd5e1);
  background: var(--theme-top-dropdown-control-bg, #111a2c);
  font-size: 11px;
  line-height: 1;
}

.control-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.github-button {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  justify-content: center;
  text-decoration: none;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--theme-top-text-muted, var(--theme-text-muted, #94a3b8));
}

.github-button:hover {
  background: transparent;
  color: var(--theme-text-primary, #e2e8f0);
}

.settings-button,
.provider-manager-button,
.status-monitor-button,
.suppress-button,
.logout-button {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--theme-top-text-muted, var(--theme-text-muted, #94a3b8));
}

.settings-button:hover,
.provider-manager-button:hover,
.status-monitor-button:hover,
.suppress-button:hover,
.logout-button:hover {
  background: transparent;
  color: var(--theme-text-primary, #e2e8f0);
}

.suppress-button.active {
  color: var(--theme-status-danger, #f87171);
}

.suppress-button.active:hover {
  color: var(--theme-text-danger, #fca5a5);
}
</style>
