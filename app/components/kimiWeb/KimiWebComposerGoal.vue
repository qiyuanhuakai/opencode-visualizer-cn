<template>
  <ComposerGoal class="kimi-composer-goal" :label="copy.objective" :summary="summary" :error="Boolean(error)" :disabled="disabled" :aria-label="`${copy.title}: ${summary}`" @open="emit('open')" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ComposerGoal from '../composer/ComposerGoal.vue';
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
