<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebGoal, type KimiWebGoalClient } from '../../composables/useKimiWebGoal';
import { kimiWebGoalUi } from '../../locales/kimiWebGoalUi';
import type { KimiWebGoalChange } from '../../backends/kimiWeb/goal';

const props = defineProps<{ sessionId: string; client: KimiWebGoalClient }>();
const emit = defineEmits<{ updated: [] }>();
const { t, locale } = useI18n();
const copy = computed(() => {
  switch (locale.value) {
    case 'zh-CN': case 'zh-TW': case 'ja': case 'eo': return kimiWebGoalUi[locale.value];
    default: return kimiWebGoalUi.en;
  }
});
const { goal, objective, pending, loaded, error, refresh } = useKimiWebGoal(
  () => ({ sessionId: props.sessionId, client: props.client }),
);
const disabled = computed(() => pending.value || !loaded.value);
async function updateGoal(change: KimiWebGoalChange) {
  if (await refresh(change)) emit('updated');
}
</script>

<template>
  <section class="kimi-goal-window">
    <div class="goal-editor" :aria-busy="pending">
      <h2 class="goal-heading">{{ copy.title }}</h2>
      <p class="goal-hint">{{ copy.help }}</p>
      <p class="goal-session">{{ sessionId }}</p>
      <p v-if="pending" role="status">{{ loaded ? copy.saving : copy.loading }}</p>
      <p v-if="error" role="alert" class="goal-error">{{ error }}</p>
      <template v-if="loaded">
        <p role="status">{{ goal ? copy[goal.status] : copy.empty }}</p>
        <p v-if="goal?.terminalReason" class="goal-hint">{{ goal.terminalReason }}</p>
        <p v-if="goal?.completionCriterion" class="goal-hint">{{ goal.completionCriterion }}</p>
        <dl v-if="goal" class="goal-usage">
          <div><dt>{{ copy.tokens }}</dt><dd>{{ goal.tokensUsed }}</dd></div>
          <div><dt>{{ copy.turns }}</dt><dd>{{ goal.turnsUsed }}</dd></div>
          <div><dt>{{ copy.seconds }}</dt><dd>{{ Math.floor(goal.wallClockMs / 1000) }}</dd></div>
        </dl>
      </template>
      <form class="goal-form" @submit.prevent="updateGoal({ goal_objective: objective.trim() })">
        <label class="goal-field">
          {{ copy.objective }}
          <textarea v-model="objective" class="goal-control goal-objective" rows="5" :disabled="disabled" required />
        </label>
        <div class="goal-actions">
          <button type="button" class="goal-button goal-clear" :disabled="pending" @click="refresh()">{{ t('common.refresh') }}</button>
          <button type="submit" class="goal-button goal-save" :disabled="disabled || !objective.trim()">{{ t('common.save') }}</button>
        </div>
      </form>
      <div v-if="loaded && goal && goal.status !== 'complete'" class="goal-actions">
        <button v-if="goal.status === 'active'" type="button" class="goal-button goal-clear" :disabled="disabled" @click="updateGoal({ goal_control: 'pause' })">{{ copy.pause }}</button>
        <button v-else type="button" class="goal-button goal-save" :disabled="disabled" :title="copy.help" @click="updateGoal({ goal_control: 'resume' })">{{ copy.resume }}</button>
        <button type="button" class="goal-button goal-clear" :disabled="disabled" @click="updateGoal({ goal_control: 'cancel' })">{{ copy.cancel }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped src="../codex/codexGoalEditor.css"></style>
<style scoped>
.kimi-goal-window { height: 100%; overflow: auto; padding: 12px; box-sizing: border-box; background: var(--theme-floating-surface-base, var(--theme-surface-panel)); }
.goal-session { overflow-wrap: anywhere; color: var(--theme-floating-text-muted, var(--theme-text-muted)); }
.goal-usage dd { margin: 0; }
</style>
