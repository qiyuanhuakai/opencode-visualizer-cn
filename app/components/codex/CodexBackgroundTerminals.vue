<template>
  <section class="command-panel" :aria-label="t('title')">
    <p class="command-hint">{{ t('hint') }}</p>
    <p v-if="!terminals.length" role="status" class="command-hint">{{ t('empty') }}</p>
    <article v-for="terminal in terminals" :key="terminal.id" class="command-message terminal-item">
      <div class="command-option-title">
        <strong>{{ terminal.command || t('unknownCommand') }}</strong>
        <span class="command-hint">{{ t(terminal.status) }}</span>
      </div>
      <div class="terminal-meta command-hint">
        <span v-if="terminal.processId">{{ t('process') }} {{ terminal.processId }}</span>
        <span v-if="terminal.cwd">{{ terminal.cwd }}</span>
        <span v-if="terminal.exitCode !== undefined">{{ t('exit') }} {{ terminal.exitCode }}</span>
        <span v-if="terminal.interactionTime"
          >{{ t('interaction') }} {{ formatTime(terminal.interactionTime) }}</span
        >
      </div>
      <pre v-if="terminal.outputLines.length" class="terminal-output">{{
        terminal.outputLines.join('\n')
      }}</pre>
      <p v-else class="command-hint">{{ t('noOutput') }}</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';
import { observeCodexTerminals } from '../../backends/codex/observedTerminals';
const props = defineProps<{
  api: Pick<ReturnType<typeof useCodexApi>, 'events' | 'activeThreadId'>;
  threadId?: string;
}>();
const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    en: {
      title: 'Observed terminal activity',
      hint: 'Updates live from events observed for this conversation. Processes started before connecting may be absent; these are observed command states, not a complete live process list.',
      empty: 'No terminal activity observed for this conversation.',
      unknownCommand: 'Command not observed',
      process: 'Process',
      exit: 'Exit code',
      interaction: 'Last interaction',
      noOutput: 'No output observed.',
      inProgress: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      declined: 'Declined',
      unknown: 'State not observed',
    },
    zh: {
      title: '已观测的终端活动',
      hint: '根据当前会话收到的事件实时更新。连接前启动的进程可能不会显示；这里展示已观测的命令状态，并非完整的实时进程列表。',
      empty: '尚未观测到当前会话的终端活动。',
      unknownCommand: '未观测到命令',
      process: '进程',
      exit: '退出码',
      interaction: '最近交互',
      noOutput: '尚未观测到输出。',
      inProgress: '运行中',
      completed: '已完成',
      failed: '失败',
      declined: '已拒绝',
      unknown: '未观测到状态',
    },
  },
});
const terminals = computed(() =>
  observeCodexTerminals(props.api.events.value, props.threadId ?? props.api.activeThreadId.value),
);
function formatTime(time: number) {
  return new Date(time).toLocaleTimeString(locale.value);
}
</script>

<style scoped src="./codexCommandPanels.css"></style>
<style scoped>
.terminal-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.terminal-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  overflow-wrap: anywhere;
}
.terminal-output {
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.command-option-title strong {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
