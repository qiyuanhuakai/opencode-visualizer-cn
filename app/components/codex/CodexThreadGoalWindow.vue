<template>
  <section class="goal-window">
    <div class="goal-window-tools">
      <button type="button" :disabled="!api.connected.value || api.threadGoalLoading.value" @click="editor?.refresh()">
        {{ t('common.refresh') }}
      </button>
    </div>
    <CodexThreadGoalEditor ref="editor" :api="api" />
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';
import CodexThreadGoalEditor from './CodexThreadGoalEditor.vue';

defineProps<{ api: ReturnType<typeof useCodexApi> }>();
const { t } = useI18n();
const editor = ref<InstanceType<typeof CodexThreadGoalEditor> | null>(null);
onMounted(() => editor.value?.refresh());
</script>

<style scoped>
.goal-window {
  height: 100%;
  overflow: auto;
  padding: 12px;
  box-sizing: border-box;
  border-radius: inherit;
  color: var(--theme-floating-text, var(--theme-text-primary));
  background: var(--theme-floating-surface-base, var(--theme-surface-panel));
}
.goal-window-tools { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.goal-window-tools button {
  border: 1px solid var(--theme-floating-border-muted, var(--theme-border-default));
  border-radius: 8px;
  background: var(--theme-floating-surface-subtle, var(--theme-surface-panel-muted));
  color: inherit;
  padding: 4px 8px;
  font: inherit;
  font-size: 12px;
}
.goal-window-tools button:hover:not(:disabled) { background: var(--theme-floating-surface-strong, var(--theme-surface-panel-hover)); }
.goal-window-tools button:focus-visible { outline: 2px solid var(--theme-border-accent); }
.goal-window-tools button:disabled { opacity: 0.5; }
</style>
