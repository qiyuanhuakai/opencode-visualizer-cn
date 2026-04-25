<template>
  <section class="codex-panel" aria-label="Codex">
    <header class="codex-panel-header">
      <label class="codex-url-field">
        <span>Codex WebSocket</span>
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
        <span>Token</span>
        <input
          v-model="api.bridgeToken.value"
          class="codex-input"
          type="password"
          autocomplete="off"
          :disabled="api.status.value === 'connecting' || api.connected.value"
          placeholder="optional"
        />
      </label>
      <button
        type="button"
        class="codex-primary-button"
        :disabled="api.status.value === 'connecting'"
        @click="api.connected.value ? api.disconnect() : connect()"
      >
        {{ api.connected.value ? 'Disconnect' : api.status.value === 'connecting' ? 'Connecting…' : 'Connect' }}
      </button>
    </header>

    <p v-if="api.errorMessage.value" class="codex-error" role="alert">
      {{ api.errorMessage.value }}
    </p>

    <div class="codex-panel-body">
      <aside class="codex-thread-list" aria-label="Codex threads">
        <div class="codex-section-title">
          <span>Threads</span>
          <div class="codex-thread-tools">
            <button
              type="button"
              class="codex-small-button"
              :class="{ active: showArchived }"
              :disabled="!api.connected.value"
              title="Show archived threads"
              @click="toggleArchived()"
            >
              A
            </button>
            <button
              type="button"
              class="codex-small-button"
              :disabled="!api.connected.value"
              title="Refresh threads"
              @click="refreshThreads()"
            >
              ↻
            </button>
          </div>
        </div>
        <button
          type="button"
          class="codex-thread-new"
          :disabled="!api.connected.value || showArchived"
          @click="startThread()"
        >
          New thread
        </button>
        <div v-if="api.threads.value.length === 0" class="codex-empty">
          {{ api.connected.value ? 'No threads yet.' : 'Connect to load threads.' }}
        </div>
        <div
          v-for="thread in api.threads.value"
          :key="thread.id"
          class="codex-thread-item"
          :class="{ active: thread.id === api.activeThreadId.value }"
        >
          <button
            type="button"
            class="codex-thread-select"
            :disabled="api.loadingThread.value"
            :title="thread.id"
            @click="selectThread(thread.id)"
          >
            <span class="codex-thread-title">{{ thread.name || thread.preview || thread.id }}</span>
            <small>{{ thread.id }}</small>
          </button>
          <button
            v-if="showArchived"
            type="button"
            class="codex-thread-action"
            :disabled="!api.connected.value"
            @click="unarchiveThread(thread.id)"
          >
            Restore
          </button>
        </div>
      </aside>

      <main class="codex-output" aria-live="polite">
        <div v-if="api.loadingThread.value" class="codex-loading-thread">
          Loading thread…
        </div>
        <div v-if="api.activeThreadId.value" class="codex-active-thread-tools">
          <label class="codex-rename-field">
            <span>Thread name</span>
            <input
              v-model="threadName"
              class="codex-input"
              type="text"
              :disabled="!api.connected.value"
              placeholder="Untitled thread"
            />
          </label>
          <button type="button" class="codex-small-text-button" :disabled="!api.connected.value" @click="renameThread()">
            Rename
          </button>
          <button type="button" class="codex-small-text-button" :disabled="!api.connected.value" @click="unsubscribeActiveThread()">
            Unsubscribe
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value || !api.activeTurn.value"
            @click="interruptTurn()"
          >
            Interrupt
          </button>
          <button type="button" class="codex-small-text-button danger" :disabled="!api.connected.value" @click="archiveActiveThread()">
            Archive
          </button>
          <span v-if="api.activeTurn.value" class="codex-turn-status">
            Turn {{ api.activeTurn.value.status || 'active' }}
          </span>
        </div>
        <div v-if="api.serverRequests.value.length > 0" class="codex-approval-list">
          <section v-for="request in api.serverRequests.value" :key="String(request.id)" class="codex-approval-card">
            <div class="codex-approval-title">{{ request.method }}</div>
            <div class="codex-approval-scope">Thread {{ request.threadId }} · Turn {{ request.turnId }}</div>
            <p v-if="approvalSummary(request.params)">{{ approvalSummary(request.params) }}</p>
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
        <div v-if="api.transcript.value.length === 0" class="codex-empty codex-output-empty">
          Connect to `vis_bridge`, choose or create a thread, then send a prompt.
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
        <details v-if="api.events.value.length > 0" class="codex-events">
          <summary>Events · {{ api.events.value.length }}</summary>
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
        placeholder="Ask Codex…"
        @keydown.enter.exact.prevent="sendPrompt"
      ></textarea>
      <button
        type="submit"
        class="codex-primary-button codex-send-button"
        :disabled="!api.connected.value || api.pending.value || promptText.trim().length === 0"
      >
        {{ api.pending.value ? 'Sending…' : 'Send' }}
      </button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CodexJsonRpcId } from '../backends/codex/jsonRpcClient';
import { useCodexApi } from '../composables/useCodexApi';

const api = useCodexApi();
const promptText = ref('');
const threadName = ref('');
const showArchived = ref(false);
const recentEvents = computed(() => api.events.value.slice(-8).reverse());
const activeThread = computed(() => api.threads.value.find((thread) => thread.id === api.activeThreadId.value) ?? null);

watch(activeThread, (thread) => {
  threadName.value = thread?.name ?? '';
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyCommand(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join(' ');
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
  await refreshThreads();
}

async function startThread() {
  showArchived.value = false;
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

function resolveRequest(id: CodexJsonRpcId, decision: string) {
  api.resolveServerRequest(id, decision);
}

async function sendPrompt() {
  const text = promptText.value.trim();
  if (!text) return;
  promptText.value = '';
  await api.sendPrompt(text);
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
.codex-thread-action {
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
  grid-template-columns: 220px minmax(0, 1fr);
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

.codex-thread-select {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px;
  text-align: left;
}

.codex-thread-item.active .codex-thread-select {
  background: rgba(37, 99, 235, 0.18);
}

.codex-thread-action {
  min-height: 26px;
  font-size: 11px;
}

.codex-thread-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
