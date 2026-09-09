<template>
  <button
    type="button"
    class="codex-composer-goal"
    :disabled="disabled"
    :title="`${t('codexPanel.runtime.goal')}: ${summary}`"
    :aria-label="`${t('codexPanel.runtime.goal')}: ${summary}`"
    @click="emit('open')"
  >
    <span class="goal-label">{{ t('codexPanel.runtime.goal') }}</span>
    <span class="goal-summary" :role="loadError ? 'alert' : undefined">{{ summary }}</span>
    <Icon icon="lucide:pencil" :width="14" :height="14" aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';
import { codexGoalUi } from '../../locales/codexGoalUi';

type GoalApi = Pick<ReturnType<typeof useCodexApi>,
  'connected' | 'activeThreadId' | 'threadGoal' | 'threadGoalThreadId' |
  'threadGoalLoading' | 'runtimeCapabilities' | 'refreshThreadGoal'>;
const props = defineProps<{ api: GoalApi }>();
const emit = defineEmits<{ open: [] }>();
const { t, locale } = useI18n();
const copy = computed(() => {
  switch (locale.value) {
    case 'zh-CN': case 'zh-TW': case 'ja': case 'eo': return codexGoalUi[locale.value];
    default: return codexGoalUi.en;
  }
});
const disabled = computed(() => !props.api.connected.value || !props.api.activeThreadId.value);
const loadError = ref('');
const summary = computed(() => {
  if (!props.api.connected.value) return copy.value.disconnected;
  if (!props.api.activeThreadId.value) return copy.value.noThread;
  const capability = props.api.runtimeCapabilities.value['thread/goal/get'];
  if (capability === 'unsupported') return copy.value.unsupported;
  if (capability === 'gated') return copy.value.gated;
  if (props.api.threadGoalLoading.value) return copy.value.loading;
  if (props.api.threadGoalThreadId.value === props.api.activeThreadId.value) {
    return props.api.threadGoal.value?.objective || copy.value.setGoal;
  }
  return loadError.value || copy.value.loading;
});
watch([() => props.api.activeThreadId.value, () => props.api.connected.value], async ([threadId, connected], _, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  loadError.value = '';
  if (!connected || !threadId) return;
  try {
    await props.api.refreshThreadGoal(threadId);
  } catch (error) {
    if (current) loadError.value = error instanceof Error ? `${copy.value.loadError} ${error.message}` : copy.value.loadError;
  }
}, { immediate: true });
</script>

<style scoped>
.codex-composer-goal {
  display: flex;
  flex: 1 1 120px;
  min-width: 120px;
  max-width: none;
  align-items: center;
  gap: 8px;
  height: 28px;
  overflow: hidden;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--theme-input-text, var(--theme-text-primary));
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.goal-label, .codex-composer-goal :deep(svg) { flex: 0 0 auto; }
.goal-label { color: var(--theme-input-text-muted, var(--theme-text-muted)); }
.goal-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.codex-composer-goal:hover:not(:disabled) { background: var(--theme-surface-panel-hover); }
.codex-composer-goal:focus-visible { outline: 2px solid var(--theme-input-accent, var(--theme-border-accent)); outline-offset: 2px; }
.codex-composer-goal:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
