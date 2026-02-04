<template>
  <div class="dock">
    <div
      class="message-dock"
    >
      <div
        ref="dockEl"
        class="message-scroll"
        @scroll="$emit('scroll')"
        @wheel="$emit('wheel', $event)"
        @touchmove="$emit('touchmove')"
      >
        <div
          v-for="q in queue.filter((entry) => entry.isMessage && !entry.isSubagentMessage)"
          :key="q.messageId ?? q.time"
          class="message-entry"
          :class="{ 'is-user': q.role === 'user' }"
        >
          <div
            class="message-inner"
            :class="{ 'is-scrolling': q.scroll }"
            :style="{
              '--scroll-distance': `${q.scrollDistance}px`,
              '--scroll-duration': `${q.scrollDuration}s`,
            }"
          >
            <div class="shiki-host is-message" v-html="q.html"></div>
          </div>
        </div>
        <button
          v-show="!isFollowing"
          type="button"
          class="follow-button"
          aria-label="Scroll to latest"
          @click="$emit('resume-follow')"
        >
          ↓
        </button>
      </div>
      <div class="statusbar" role="status" aria-live="polite">
        <div class="statusbar-section statusbar-left">
          <span class="statusbar-text">{{ isThinking ? 'Thinking' : 'Idle' }}</span>
        </div>
        <div class="statusbar-section statusbar-right" :class="{ 'is-error': isStatusError }">
          {{ statusText }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
type FileReadEntry = {
  time: number;
  expiresAt: number;
  x: number;
  y: number;
  header: string;
  content: string;
  scroll: boolean;
  scrollDistance: number;
  scrollDuration: number;
  html: string;
  isWrite: boolean;
  isMessage: boolean;
  isSubagentMessage?: boolean;
  sessionId?: string;
  role?: 'user' | 'assistant';
  toolStatus?: string;
  toolName?: string;
  messageId?: string;
  callId?: string;
};

defineProps<{
  queue: FileReadEntry[];
  isFollowing: boolean;
  statusText: string;
  isStatusError: boolean;
  isThinking: boolean;
}>();

defineEmits<{
  (event: 'scroll'): void;
  (event: 'wheel', eventArg: WheelEvent): void;
  (event: 'touchmove'): void;
  (event: 'resume-follow'): void;
}>();

const dockEl = ref<HTMLDivElement | null>(null);

defineExpose({ dockEl });
</script>

<style scoped>
.dock {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.message-dock {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  display: flex;
  flex-direction: column;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
}

.message-scroll {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
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

.message-inner {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  --message-line-height: 1;
  line-height: var(--message-line-height);
}

.message-dock .shiki-host {
  color: inherit;
  line-height: var(--message-line-height);
}

.message-dock .shiki-host :deep(pre),
.message-dock .shiki-host :deep(code),
.message-dock .shiki-host :deep(.line),
.message-dock .shiki-host :deep(.line)::before {
  line-height: var(--message-line-height) !important;
  color: inherit;
}

.message-dock .shiki-host :deep(pre),
.message-dock .shiki-host :deep(code) {
  white-space: normal;
}

.message-dock .shiki-host :deep(.line) {
  white-space: pre-wrap;
  word-break: break-word;
}

.message-dock .shiki-host :deep(.line) {
  min-height: 1em;
}

.message-dock .shiki-host :deep(.line:empty)::after {
  content: ' ';
}

.message-inner.is-scrolling {
  animation: scroll-down var(--scroll-duration) linear forwards;
}

.message-dock .message-inner.is-scrolling {
  animation: none;
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

.statusbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 12px;
  border-top: none;
  background: transparent;
  color: #94a3b8;
  font-size: 8pt;
  line-height: 1.2;
  margin: 0;
  border-radius: 0;
  box-sizing: border-box;
  z-index: 2;
}

.statusbar-section {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.statusbar-right {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.statusbar-right.is-error {
  color: #fecaca;
}

.follow-button:hover {
  background: rgba(30, 41, 59, 0.98);
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
}

.shiki-host :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.shiki-host :deep(pre.shiki span) {
  background-color: transparent !important;
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
  padding-left: 0;
  position: relative;
}

.shiki-host.is-message :deep(.line)::before {
  content: '';
}
</style>
