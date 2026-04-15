<script setup lang="ts">
import CodeContent from '../CodeContent.vue';
import { useI18n } from 'vue-i18n';

defineProps<{
  html: string;
  status?: string;
  tool?: string;
  url?: string;
  query?: string;
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="status === 'running'" class="tool-placeholder">
    <div v-if="url">{{ t('toolWindow.web.urlLabel') }} {{ url }}</div>
    <div v-if="query">{{ t('toolWindow.web.queryLabel') }} {{ query }}</div>
    <div v-if="!url && !query">{{ tool === 'webfetch' ? t('toolWindow.web.fetching') : t('toolWindow.web.searching') }}</div>
  </div>
  <CodeContent v-else :html="html" variant="plain" />
</template>

<style scoped>
.tool-placeholder {
  font-family: var(--app-monospace-font-family);
  font-size: 13px;
  line-height: 1.5;
  color: var(--theme-text-muted, #94a3b8);
  padding: 4px;
  white-space: pre-wrap;
}
</style>
