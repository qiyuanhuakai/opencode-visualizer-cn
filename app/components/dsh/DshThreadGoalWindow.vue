<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DshPlanGoalControl } from '../../composables/useDshPlanGoal';
import { kimiWebGoalUi } from '../../locales/kimiWebGoalUi';
const props = defineProps<{ control: DshPlanGoalControl }>();
const { t, locale } = useI18n();
const copy = computed(() => {
  switch (locale.value) {
    case 'zh-CN': case 'zh-TW': case 'ja': case 'eo': return kimiWebGoalUi[locale.value];
    default: return kimiWebGoalUi.en;
  }
});
const help = computed(() => {
  switch (locale.value) {
    case 'zh-CN': return '目标属于当前会话。创建目标或恢复工作会启动原生自动续行，可能消耗 Token；清除会停止目标。';
    case 'zh-TW': return '目標屬於目前會話。建立目標或恢復工作會啟動原生自動續行，可能消耗 Token；清除會停止目標。';
    case 'ja': return '目標は現在のセッションに属します。作成・再開すると自動実行が始まり、トークンを使用する場合があります。クリアすると停止します。';
    case 'eo': return 'La celo apartenas al la aktuala sesio. Kreo aŭ rekomenco aktivigas aŭtomatan laboron kaj povas uzi ĵetonojn. Forigo haltigas la celon.';
    default: return 'This goal belongs to the current session. Creating or resuming starts native automatic work and may use tokens. Clearing stops the goal.';
  }
});
const objective = ref('');
watch(() => [props.control.sessionId.value, props.control.goal.value?.objective], () => { objective.value = props.control.goal.value?.objective ?? ''; }, { immediate: true });
const disabled = computed(() => props.control.pending.value || !props.control.loaded.value || !props.control.sessionId.value);
</script>

<template>
  <section class="dsh-goal-window">
    <div class="goal-editor" :aria-busy="control.pending.value">
      <h2 class="goal-heading">{{ copy.title }}</h2>
      <p class="goal-hint">{{ help }}</p>
      <p class="goal-session">{{ control.sessionId.value }}</p>
      <p v-if="control.pending.value" role="status">{{ control.loaded.value ? copy.saving : copy.loading }}</p>
      <p v-if="control.error.value" role="alert" class="goal-error">{{ control.error.value }}</p>
      <p v-if="control.loaded.value" role="status">{{ control.goal.value ? copy[control.goal.value.phase] : copy.empty }}</p>
      <p v-if="control.goal.value" class="goal-hint">{{ copy.turns }}: {{ control.goal.value.roundsStarted }} / {{ control.goal.value.maxGoalRounds }} · {{ control.goal.value.activation }}</p>
      <form class="goal-form" @submit.prevent="control.changeGoal('save', objective)">
        <label class="goal-field">{{ copy.objective }}<textarea v-model="objective" class="goal-control goal-objective" rows="5" :disabled="disabled" required /></label>
        <div class="goal-actions">
          <button type="button" class="goal-button goal-clear" :disabled="control.pending.value || !control.sessionId.value" @click="control.refresh()">{{ t('common.refresh') }}</button>
          <button type="submit" class="goal-button goal-save" :disabled="disabled || !objective.trim()">{{ t('common.save') }}</button>
        </div>
      </form>
      <div v-if="control.goal.value" class="goal-actions">
        <button v-if="control.goal.value.phase === 'active'" type="button" class="goal-button goal-clear" :disabled="disabled" @click="control.changeGoal('pause')">{{ copy.pause }}</button>
        <button v-if="control.goal.value.phase !== 'complete' && (control.goal.value.phase !== 'active' || control.goal.value.activation === 'disarmed')" type="button" class="goal-button goal-save" :disabled="disabled" @click="control.changeGoal('resume')">{{ copy.resume }}</button>
        <button type="button" class="goal-button goal-clear" :disabled="disabled" @click="control.changeGoal('clear')">{{ t('common.clear') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped src="../codex/codexGoalEditor.css"></style>
<style scoped>
.dsh-goal-window { height: 100%; overflow: auto; padding: 12px; box-sizing: border-box; background: var(--theme-floating-surface-base, var(--theme-surface-panel)); }
.goal-session { overflow-wrap: anywhere; color: var(--theme-floating-text-muted, var(--theme-text-muted)); }
</style>
