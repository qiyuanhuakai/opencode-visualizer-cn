<template>
  <section class="codex-panel" :aria-label="t('codexPanel.title')">
    <header class="codex-panel-header">
      <label class="codex-url-field">
        <span>{{ t('codexPanel.urlLabel') }}</span>
        <input
          v-model="api.url.value"
          class="codex-input"
          type="url"
          spellcheck="false"
          :disabled="api.status.value === 'connecting' || api.connected.value"
          placeholder="ws://localhost:23004/codex"
        />
      </label>
      <label class="codex-token-field">
        <span>{{ t('codexPanel.tokenLabel') }}</span>
        <input
          v-model="api.bridgeToken.value"
          class="codex-input"
          type="password"
          autocomplete="off"
          :disabled="api.status.value === 'connecting' || api.connected.value"
          :placeholder="t('common.optional')"
        />
      </label>
      <button
        type="button"
        class="codex-primary-button"
        :disabled="api.status.value === 'connecting'"
        @click="api.connected.value ? api.disconnect() : connect()"
      >
        {{
          api.connected.value
            ? t('codexPanel.disconnect')
            : api.status.value === 'connecting'
              ? t('codexPanel.connecting')
              : t('codexPanel.connect')
        }}
      </button>
    </header>

    <p v-if="api.errorMessage.value" class="codex-error" role="alert">
      {{ api.errorMessage.value }}
    </p>

    <div class="codex-panel-body">
      <aside class="codex-thread-list" :aria-label="t('codexPanel.threads')">
        <div class="codex-section-title">
          <span>{{ t('codexPanel.threads') }}</span>
          <div class="codex-thread-tools">
            <button
              type="button"
              class="codex-small-button"
              :class="{ active: showArchived }"
              :disabled="!api.connected.value || showHidden"
              :title="t('codexPanel.showArchived')"
              @click="toggleArchived()"
            >
              <Icon icon="mdi:archive" width="16" />
            </button>
            <button
              type="button"
              class="codex-small-button"
              :class="{ active: showHidden }"
              :disabled="!api.connected.value || showArchived"
              :title="t('codexPanel.showHidden')"
              @click="toggleHidden()"
            >
              <Icon icon="mdi:eye" width="16" />
            </button>
            <button
              type="button"
              class="codex-small-button"
              :disabled="!api.connected.value"
              :title="t('codexPanel.refreshThreads')"
              @click="refreshThreads()"
            >
              <Icon icon="mdi:refresh" width="16" />
            </button>
          </div>
        </div>
        <button
          type="button"
          class="codex-thread-new"
          :disabled="!api.connected.value || showArchived"
          @click="startThread()"
        >
          {{ t('codexPanel.newThread') }}
        </button>
        <div v-if="displayThreads.length === 0" class="codex-empty">
          {{
            api.connected.value
              ? showHidden
                ? t('codexPanel.noHiddenThreads')
                : t('codexPanel.noThreads')
              : t('codexPanel.connectToLoad')
          }}
        </div>
        <div
          v-for="thread in displayThreads"
          :key="thread.id"
          class="codex-thread-item"
          :class="{ active: thread.id === api.activeThreadId.value }"
        >
          <div class="codex-thread-row">
            <button
              type="button"
              class="codex-thread-select"
              :disabled="api.loadingThread.value"
              :title="thread.id"
              @click="selectThread(thread.id)"
            >
              <span class="codex-thread-title">
                <Icon
                  v-if="api.pinnedThreadIds.value.has(thread.id)"
                  icon="mdi:pin"
                  width="12"
                  class="codex-pin-icon"
                />
                {{ thread.name || thread.preview || thread.id }}
              </span>
              <small>{{ thread.id }}</small>
            </button>
            <div class="codex-thread-actions">
              <button
                v-if="!showArchived && !showHidden"
                type="button"
                class="codex-icon-button"
                :disabled="!api.connected.value"
                :title="
                  api.pinnedThreadIds.value.has(thread.id)
                    ? t('codexPanel.unpin')
                    : t('codexPanel.pin')
                "
                @click="togglePin(thread.id)"
              >
                <Icon
                  :icon="api.pinnedThreadIds.value.has(thread.id) ? 'mdi:pin-off' : 'mdi:pin'"
                  width="14"
                />
              </button>
              <button
                v-if="!showArchived && !showHidden"
                type="button"
                class="codex-icon-button"
                :disabled="!api.connected.value"
                :title="t('codexPanel.hide')"
                @click="api.hideThread(thread.id)"
              >
                <Icon icon="mdi:eye-off" width="14" />
              </button>
              <button
                v-if="showHidden"
                type="button"
                class="codex-small-text-button"
                :disabled="!api.connected.value"
                @click="api.unhideThread(thread.id)"
              >
                {{ t('codexPanel.unhide') }}
              </button>
              <button
                v-if="showArchived"
                type="button"
                class="codex-small-text-button"
                :disabled="!api.connected.value"
                @click="unarchiveThread(thread.id)"
              >
                {{ t('codexPanel.unarchive') }}
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main class="codex-output" aria-live="polite">
        <div v-if="api.loadingThread.value" class="codex-loading-thread">
          {{ t('codexPanel.loadingThread') }}
        </div>
        <div v-if="api.activeThreadId.value" class="codex-active-thread-tools">
          <label class="codex-rename-field">
            <span>{{ t('codexPanel.threadName') }}</span>
            <input
              v-model="threadName"
              class="codex-input"
              type="text"
              :disabled="!api.connected.value"
              :placeholder="t('codexPanel.renamePlaceholder')"
            />
          </label>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            @click="renameThread()"
          >
            {{ t('codexPanel.rename') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            @click="unsubscribeActiveThread()"
          >
            {{ t('codexPanel.unsubscribe') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value || !api.activeTurn.value"
            @click="interruptTurn()"
          >
            {{ t('codexPanel.interrupt') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            :title="t('codexPanel.fork')"
            @click="forkActiveThread()"
          >
            {{ t('codexPanel.fork') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            :title="t('codexPanel.rollbackTurns')"
            @click="rollbackActiveThread()"
          >
            {{ t('codexPanel.rollback') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            @click="togglePin(api.activeThreadId.value)"
          >
            {{
              api.pinnedThreadIds.value.has(api.activeThreadId.value)
                ? t('codexPanel.unpin')
                : t('codexPanel.pin')
            }}
          </button>
          <button
            type="button"
            class="codex-small-text-button danger"
            :disabled="!api.connected.value"
            @click="archiveActiveThread()"
          >
            {{ t('codexPanel.archive') }}
          </button>
          <span v-if="api.activeTurn.value" class="codex-turn-status">
            {{ t('codexPanel.turnStatus') }}
            {{ api.activeTurn.value.status || t('codexPanel.turnActive') }}
          </span>
        </div>
        <div v-if="api.serverRequests.value.length > 0" class="codex-approval-list">
          <section
            v-for="request in api.serverRequests.value"
            :key="String(request.id)"
            class="codex-approval-card"
          >
            <div class="codex-approval-title">{{ request.method }}</div>
            <div class="codex-approval-scope">
              {{ t('codexPanel.approvalScope') }} {{ request.threadId }} ·
              {{ t('codexPanel.turnLabel') }} {{ request.turnId }}
            </div>
            <p v-if="approvalSummary(request.params)">
              {{ approvalSummary(request.params) }}
            </p>
            <div class="codex-approval-actions">
              <button
                v-for="decision in request.availableDecisions"
                :key="decision"
                type="button"
                class="codex-small-text-button"
                @click="resolveRequest(request.id, decision)"
              >
                {{ decision }}
              </button>
            </div>
          </section>
        </div>
        <div
          v-if="api.transcript.value.length === 0"
          class="codex-empty codex-output-empty"
        >
          {{ t('codexPanel.noTranscript') }}
        </div>
        <article
          v-for="entry in api.transcript.value"
          :key="entry.id"
          class="codex-message"
          :class="`is-${entry.role}`"
        >
          <div class="codex-message-role">{{ entry.role }}</div>
          <pre>{{ entry.text }}</pre>
        </article>

        <div v-if="api.previewFilePath.value" class="codex-file-preview">
          <div class="codex-file-preview-header">
            <span>{{ api.previewFilePath.value }}</span>
            <button
              type="button"
              class="codex-icon-button"
              :title="t('codexPanel.closePreview')"
              @click="api.clearPreview()"
            >
              <Icon icon="mdi:close" width="14" />
            </button>
          </div>
          <pre class="codex-file-preview-body">{{ api.previewFileContent.value }}</pre>
        </div>

        <div v-if="api.activeThreadId.value" class="codex-sandbox">
          <div class="codex-section-title">
            <span>{{ t('codexPanel.sandbox') }}</span>
            <button
              type="button"
              class="codex-small-button"
              :disabled="!api.connected.value || !activeThread?.cwd"
              :title="activeThread?.cwd ? t('codexPanel.sandboxBrowse') : t('codexPanel.noSandboxCwd')"
              @click="browseCwd()"
            >
              <Icon icon="mdi:folder-open" width="14" />
            </button>
          </div>
          <div v-if="api.fsCwd.value" class="codex-sandbox-cwd">
            {{ t('codexPanel.sandboxCwd') }}: {{ api.fsCwd.value }}
          </div>
          <div v-if="api.fsLoading.value" class="codex-empty">
            {{ t('common.loading') }}
          </div>
          <div v-else-if="api.fsError.value" class="codex-error">
            {{ api.fsError.value }}
          </div>
          <div v-else-if="api.fsEntries.value.length === 0" class="codex-empty">
            {{ t('codexPanel.sandboxEmpty') }}
          </div>
          <div v-else class="codex-sandbox-list">
            <button
              v-for="entry in api.fsEntries.value"
              :key="entry.name"
              type="button"
              class="codex-sandbox-item"
              @click="handleFsEntryClick(entry)"
            >
              <Icon
                :icon="entry.type === 'directory' ? 'mdi:folder' : 'mdi:file'"
                width="14"
              />
              <span>{{ entry.name }}</span>
            </button>
          </div>
        </div>

        <div class="codex-todos-placeholder">
          <div class="codex-section-title">
            <span>{{ t('codexPanel.todo') }}</span>
          </div>
          <div class="codex-empty">
            {{ t('codexPanel.noTodos') }} — {{ t('codexPanel.noTodosDescription') }}
          </div>
        </div>

        <details v-if="api.events.value.length > 0" class="codex-events">
          <summary>
            {{ t('codexPanel.events') }} · {{ api.events.value.length }}
          </summary>
          <ol>
            <li v-for="event in recentEvents" :key="event.id">
              {{ event.method }}
            </li>
          </ol>
        </details>
      </main>
    </div>

    <form class="codex-prompt" @submit.prevent="sendPrompt">
      <textarea
        v-model="promptText"
        class="codex-prompt-input"
        rows="3"
        :disabled="!api.connected.value || api.pending.value"
        :placeholder="t('codexPanel.promptPlaceholder')"
        @keydown.enter.exact.prevent="sendPrompt"
      ></textarea>
      <button
        type="submit"
        class="codex-primary-button codex-send-button"
        :disabled="
          !api.connected.value || api.pending.value || promptText.trim().length === 0
        "
      >
        {{ api.pending.value ? t('codexPanel.sending') : t('codexPanel.send') }}
      </button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { CodexJsonRpcId } from '../backends/codex/jsonRpcClient';
import type { CodexFsDirectoryEntry } from '../backends/codex/codexAdapter';
import { useCodexApi } from '../composables/useCodexApi';

const { t } = useI18n();
const api = useCodexApi();
const promptText = ref('');
const threadName = ref('');
const showArchived = ref(false);
const showHidden = ref(false);
const recentEvents = computed(() => api.events.value.slice(-8).reverse());
const activeThread = computed(
  () =>
    api.threads.value.find((thread) => thread.id === api.activeThreadId.value) ??
    null,
);

const displayThreads = computed(() => {
  if (showHidden.value) return api.threads.value.filter((thread) => api.hiddenThreadIds.value.has(thread.id));
  if (showArchived.value) return api.threads.value;
  return api.visibleThreads.value;
});

watch(activeThread, (thread) => {
  threadName.value = thread?.name ?? '';
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyCommand(value: unknown) {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === 'string').join(' ');
  return typeof value === 'string' ? value : '';
}

function approvalSummary(params: unknown) {
  if (!isRecord(params)) return '';
  const reason = typeof params.reason === 'string' ? params.reason : '';
  const command = stringifyCommand(params.command);
  const cwd = typeof params.cwd === 'string' ? params.cwd : '';
  return [reason, command, cwd].filter(Boolean).join(' · ');
}

async function connect() {
  await api.connect(api.url.value);
}

async function refreshThreads() {
  await api.refreshThreads(showArchived.value ? { archived: true } : {});
}

async function toggleArchived() {
  showArchived.value = !showArchived.value;
  if (showArchived.value) showHidden.value = false;
  await refreshThreads();
}

async function toggleHidden() {
  showHidden.value = !showHidden.value;
  if (showHidden.value) showArchived.value = false;
  await refreshThreads();
}

async function startThread() {
  showArchived.value = false;
  showHidden.value = false;
  await api.startThread();
}

async function selectThread(threadId: string) {
  await api.selectThread(threadId);
}

async function renameThread() {
  if (!api.activeThreadId.value) return;
  await api.setThreadName(api.activeThreadId.value, threadName.value);
}

async function archiveActiveThread() {
  if (!api.activeThreadId.value) return;
  await api.archiveThread(api.activeThreadId.value);
}

async function unarchiveThread(threadId: string) {
  showArchived.value = false;
  await api.unarchiveThread(threadId);
}

async function unsubscribeActiveThread() {
  await api.unsubscribeThread();
}

async function interruptTurn() {
  await api.interruptActiveTurn();
}

async function forkActiveThread() {
  if (!api.activeThreadId.value) return;
  await api.forkThread(api.activeThreadId.value);
}

async function rollbackActiveThread() {
  if (!api.activeThreadId.value) return;
  await api.rollbackThread(api.activeThreadId.value, 1);
}

function togglePin(threadId: string) {
  if (api.pinnedThreadIds.value.has(threadId)) {
    api.unpinThread(threadId);
  } else {
    api.pinThread(threadId);
  }
}

function resolveRequest(id: CodexJsonRpcId, decision: string) {
  api.resolveServerRequest(id, decision);
}

async function sendPrompt() {
  const text = promptText.value.trim();
  if (!text) return;
  promptText.value = '';
  await api.sendPrompt(text);
}

async function browseCwd() {
  const path = activeThread.value?.cwd;
  if (!path) return;
  await api.readDirectory(path);
}

function joinFsPath(base: string, name: string): string {
  if (!base || base === '/') return `/${name}`;
  if (base.endsWith('/')) return `${base}${name}`;
  return `${base}/${name}`;
}

async function handleFsEntryClick(entry: CodexFsDirectoryEntry) {
  const path = joinFsPath(api.fsCwd.value, entry.name);
  if (entry.type === 'directory') {
    await api.readDirectory(path);
  } else {
    await api.readFile(path);
  }
}
</script>

<style scoped>
.codex-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  color: var(--theme-floating-text, #e2e8f0);
  background: var(--theme-floating-surface-base, rgba(15, 23, 42, 0.96));
  font-family: var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.codex-panel-header,
.codex-prompt {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
}

.codex-prompt {
  border-top: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-bottom: 0;
}

.codex-url-field,
.codex-token-field {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-token-field {
  flex: 0 0 160px;
}

.codex-input,
.codex-prompt-input {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  appearance: none;
  outline: none;
  background: var(--theme-input-bg, rgba(2, 6, 23, 0.65));
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-input {
  height: 34px;
  padding: 0 10px;
}

.codex-prompt-input {
  flex: 1 1 auto;
  resize: none;
  padding: 10px;
  line-height: 1.45;
}

.codex-primary-button,
.codex-small-button,
.codex-small-text-button,
.codex-thread-new,
.codex-thread-select,
.codex-thread-action,
.codex-icon-button {
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  appearance: none;
  outline: none;
  color: var(--theme-text-primary, #e2e8f0);
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.82));
  cursor: pointer;
}

.codex-primary-button {
  align-self: end;
  height: 34px;
  padding: 0 14px;
  font-weight: 700;
  background: var(--theme-accent-primary, #2563eb);
  border-color: transparent;
}

.codex-send-button {
  align-self: stretch;
  height: auto;
}

button:disabled,
textarea:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.codex-error {
  margin: 0;
  padding: 8px 12px;
  color: var(--theme-status-error, #f87171);
  background: rgba(127, 29, 29, 0.22);
  border-bottom: 1px solid rgba(248, 113, 113, 0.25);
}

.codex-panel-body {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
}

.codex-thread-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 12px;
  overflow: auto;
  border-right: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
}

.codex-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.codex-small-button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.codex-icon-button {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
}

.codex-small-button.active,
.codex-small-text-button.active {
  border-color: var(--theme-accent-primary, #60a5fa);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-small-text-button {
  min-height: 30px;
  padding: 0 10px;
  font-size: 12px;
}

.codex-small-text-button.danger {
  color: var(--theme-status-error, #f87171);
}

.codex-thread-tools {
  display: flex;
  gap: 6px;
}

.codex-thread-new {
  min-height: 32px;
  font-weight: 700;
}

.codex-thread-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.codex-thread-item.active {
  border-radius: 10px;
  outline: 1px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 0;
}

.codex-thread-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.codex-thread-select {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 9px;
  text-align: left;
}

.codex-thread-item.active .codex-thread-select {
  background: rgba(37, 99, 235, 0.18);
}

.codex-thread-actions {
  display: flex;
  gap: 2px;
  padding-right: 4px;
}

.codex-thread-action {
  min-height: 26px;
  font-size: 11px;
}

.codex-thread-title {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-pin-icon {
  flex-shrink: 0;
  color: var(--theme-accent-primary, #60a5fa);
}

.codex-thread-item small {
  overflow: hidden;
  color: var(--theme-text-muted, #94a3b8);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-output {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  padding: 14px;
  overflow: auto;
}

.codex-active-thread-tools,
.codex-approval-list {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
}

.codex-rename-field {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 4px;
  min-width: 180px;
  color: var(--theme-text-muted, #94a3b8);
  font-size: 11px;
}

.codex-turn-status {
  align-self: center;
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-approval-list {
  align-items: stretch;
}

.codex-approval-card {
  flex: 1 1 260px;
  padding: 10px 12px;
  border: 1px solid rgba(251, 191, 36, 0.32);
  border-radius: 12px;
  background: rgba(120, 53, 15, 0.2);
}

.codex-approval-title,
.codex-approval-scope {
  color: var(--theme-text-primary, #e2e8f0);
  font-weight: 700;
  font-size: 12px;
}

.codex-approval-scope {
  margin-top: 4px;
  color: var(--theme-text-muted, #94a3b8);
  font-weight: 400;
  word-break: break-word;
}

.codex-approval-card p {
  margin: 6px 0 0;
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
  word-break: break-word;
}

.codex-approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.codex-loading-thread {
  position: sticky;
  top: 0;
  z-index: 1;
  align-self: flex-start;
  padding: 4px 8px;
  border: 1px solid rgba(96, 165, 250, 0.32);
  border-radius: 999px;
  color: var(--theme-text-primary, #e2e8f0);
  background: rgba(37, 99, 235, 0.24);
  font-size: 11px;
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-output-empty {
  margin: auto;
  max-width: 320px;
  text-align: center;
}

.codex-message {
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.48);
}

.codex-message.is-user {
  border-color: rgba(96, 165, 250, 0.32);
}

.codex-message-role {
  margin-bottom: 6px;
  color: var(--theme-text-muted, #94a3b8);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.codex-message pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.codex-file-preview {
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
  overflow: hidden;
}

.codex-file-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
  background: rgba(15, 23, 42, 0.6);
  border-bottom: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
}

.codex-file-preview-body {
  margin: 0;
  padding: 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  color: var(--theme-text-primary, #e2e8f0);
  background: rgba(2, 6, 23, 0.45);
}

.codex-sandbox {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.35);
}

.codex-sandbox-cwd {
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
  word-break: break-word;
}

.codex-sandbox-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 4px;
}

.codex-sandbox-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.18));
  border-radius: 8px;
  font-size: 12px;
  color: var(--theme-text-primary, #e2e8f0);
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.6));
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-sandbox-item:hover {
  border-color: var(--theme-accent-primary, #60a5fa);
}

.codex-todos-placeholder {
  padding: 10px;
  border: 1px dashed var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
}

.codex-events {
  margin-top: auto;
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-events ol {
  margin: 8px 0 0;
  padding-left: 20px;
}
</style>
