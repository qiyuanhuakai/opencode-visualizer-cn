<template>
  <div class="welcome-content">
    <MessageViewer :code="markdown" lang="markdown" :theme="theme" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import MessageViewer from './MessageViewer.vue';

const { t } = useI18n();

defineProps<{
  theme: string;
}>();

const markdown = computed(() => {
  return `\
# ${t('welcome.title')}

${t('welcome.description')}
`;
});
</script>

<style scoped>
.welcome-content {
  text-align: left;
  font-size: 12px;
  line-height: 1.5;
  color: var(--theme-page-text-muted, var(--theme-text-muted, #94a3b8));
}
</style>
