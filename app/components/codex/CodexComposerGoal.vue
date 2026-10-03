<template>
  <ComposerGoal class="codex-composer-goal" :label="t('codexPanel.runtime.goal')" :summary="summary" :error="Boolean(loadError)" :disabled="disabled"  @open="emit('open')" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ComposerGoal from '../composer/ComposerGoal.vue';
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
watch([
  () => props.api.activeThreadId.value,
  () => props.api.connected.value,
  () => props.api.threadGoalThreadId.value === props.api.activeThreadId.value,
], async ([threadId, connected, goalCurrent], previous, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  loadError.value = '';
  if (!connected || !threadId) return;
  if (goalCurrent && previous[0] === threadId && previous[1] === connected) return;
  try {
    await props.api.refreshThreadGoal(threadId);
  } catch (error) {
    if (current) loadError.value = error instanceof Error ? `${copy.value.loadError} ${error.message}` : copy.value.loadError;
  }
}, { immediate: true });
</script>
