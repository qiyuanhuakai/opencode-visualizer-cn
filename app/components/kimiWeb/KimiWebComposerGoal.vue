<template>
  <button type="button" class="kimi-composer-goal" :disabled="disabled" :title="`${copy.title}: ${summary}`" :aria-label="`${copy.title}: ${summary}`" @click="emit('open')">
    <span class="goal-label">{{ copy.objective }}</span>
    <span class="goal-summary" :role="error ? 'alert' : undefined">{{ summary }}</span>
    <Icon icon="lucide:pencil" :width="14" :height="14" aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebGoal, type KimiWebGoalClient } from '../../composables/useKimiWebGoal';
import { kimiWebGoalUi } from '../../locales/kimiWebGoalUi';
const props = defineProps<{ client: KimiWebGoalClient | null; sessionId: string; connected: boolean; revision?: number }>();
const emit = defineEmits<{ open: [] }>();
const { t, locale } = useI18n();
const copy = computed(() => {
  switch (locale.value) {
    case 'zh-CN': case 'zh-TW': case 'ja': case 'eo': return kimiWebGoalUi[locale.value];
    default: return kimiWebGoalUi.en;
  }
});
const disabled = computed(() => !props.connected || !props.client || !props.sessionId.trim());
const { goal, pending, error } = useKimiWebGoal(() => props.connected && props.client && props.sessionId.trim()
  ? { sessionId: props.sessionId, client: props.client, revision: props.revision }
  : null);
const summary = computed(() => {
  if (!props.connected || !props.client) return t('app.error.notConnected');
  if (!props.sessionId.trim()) return t('app.error.noSessionSelected');
  if (pending.value) return copy.value.loading;
  return error.value || goal.value?.objective || copy.value.empty;
});
</script>

<style scoped>
.kimi-composer-goal { display: flex; flex: 1 1 120px; min-width: 120px; max-width: none; align-items: center; gap: var(--space-2); height: 28px; overflow: hidden; padding: 4px 8px; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--theme-input-text, var(--theme-text-primary)); font-family: inherit; font-size: var(--type-sm); text-align: left; cursor: pointer; }
.goal-label, .kimi-composer-goal :deep(svg) { flex: 0 0 auto; }
.goal-label { color: var(--theme-input-text-muted, var(--theme-text-muted)); }
.goal-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kimi-composer-goal:hover:not(:disabled) { background: var(--theme-surface-panel-hover); }
.kimi-composer-goal:focus-visible { outline: 2px solid var(--theme-input-accent, var(--theme-border-accent)); outline-offset: 2px; }
.kimi-composer-goal:disabled { opacity: .5; cursor: not-allowed; }
</style>
