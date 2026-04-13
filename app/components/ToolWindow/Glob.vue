<script setup lang="ts">
import CodeContent from '../CodeContent.vue';
import { useI18n } from 'vue-i18n';

defineProps<{
  html: string;
  status?: string;
  pattern?: string;
  path?: string;
  include?: string;
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="status === 'running'" class="tool-placeholder">
    <div v-if="pattern">{{ t('toolWindow.glob.pattern') }} {{ pattern }}</div>
    <div v-if="path">{{ t('toolWindow.glob.directory') }} {{ path }}</div>
    <div v-if="include">{{ t('toolWindow.glob.includeLabel') }} {{ include }}</div>
    <div v-if="!pattern && !path && !include">{{ t('toolWindow.glob.running') }}</div>
  </div>
  <CodeContent v-else :html="html" variant="term" />
</template>

<style scoped>
.tool-placeholder {
  font-family: var(--app-monospace-font-family);
  font-size: 13px;
  line-height: 1.5;
  color: #94a3b8;
  padding: 4px;
  white-space: pre-wrap;
}
</style>
