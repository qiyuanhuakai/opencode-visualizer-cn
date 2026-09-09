<template>
  <article class="goal-editor" :aria-busy="saving || api.threadGoalLoading.value">
    <h3 class="goal-heading">{{ t('codexPanel.runtime.goal') }}</h3>
    <p class="goal-hint">{{ copy.help }}</p>
    <p v-if="availability" role="status" class="goal-hint">{{ availability }}</p>
    <p v-else-if="!api.threadGoal.value" class="goal-hint">{{ copy.empty }}</p>
    <div class="goal-form">
      <label class="goal-field">
        {{ t('codexPanel.runtime.objective') }}
        <textarea v-model="objective" name="objective" rows="3" maxlength="4000" class="goal-control goal-objective" :disabled="saving || !goalReady" :aria-invalid="objective.length > 4000" />
      </label>
      <p class="goal-hint">{{ objective.length }} / 4,000</p>
      <div class="goal-fields">
        <div class="goal-field">
          <span>{{ t('codexPanel.runtime.status') }}</span>
          <Dropdown v-model="goalStatus" class="goal-status-dropdown" button-class="goal-control" :disabled="saving || !goalReady" auto-close>
            <template #label>
              <span class="sr-only">{{ t('codexPanel.runtime.status') }}: </span>
              <span>{{ t(`codexPanel.runtime.${statusLabels[goalStatus]}`) }}</span>
            </template>
            <DropdownItem v-for="status in goalStatuses" :key="status" :value="status">
              {{ t(`codexPanel.runtime.${statusLabels[status]}`) }}
            </DropdownItem>
          </Dropdown>
        </div>
        <label class="goal-field">
          {{ t('codexPanel.runtime.tokenBudget') }}
          <input :value="budgetText" name="tokenBudget" type="number" min="1" step="1" class="goal-control" :disabled="saving || !goalReady" :aria-invalid="invalidBudget" @input="updateBudget" />
        </label>
      </div>
      <p class="goal-hint">{{ copy.budgetHelp }}</p>
      <p v-if="validationError" role="alert" class="goal-error">{{ validationError }}</p>
      <dl v-if="api.threadGoal.value && goalReady" class="goal-usage">
        <div><dt>{{ copy.tokensUsed }}</dt><dd>{{ formatNumber(api.threadGoal.value.tokensUsed) }}</dd></div>
        <div><dt>{{ copy.timeUsed }}</dt><dd>{{ formatNumber(api.threadGoal.value.timeUsedSeconds) }}</dd></div>
      </dl>
      <p v-if="feedback" :role="failed ? 'alert' : 'status'" :class="failed ? 'goal-error' : 'goal-success'">{{ feedback }}</p>
      <p v-if="mutationAvailability" role="status" class="goal-hint">{{ mutationAvailability }}</p>
      <div class="goal-actions">
        <button type="button" class="goal-button goal-clear" :disabled="saving || !goalReady || !api.threadGoal.value || operationBlocked('clear')" @click="mutate('clear')">{{ action === 'clear' ? copy.clearing : t('common.clear') }}</button>
        <button type="button" class="goal-button goal-save" :disabled="saving || !goalReady || !objective.trim() || !!validationError || operationBlocked('set')" @click="mutate('set')">{{ action === 'set' ? copy.saving : t('common.save') }}</button>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CodexThreadGoal, CodexThreadGoalStatus } from '../../backends/codex/codexAdapter';
import type { useCodexApi } from '../../composables/useCodexApi';
import { codexGoalUi } from '../../locales/codexGoalUi';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
const props = defineProps<{ api: ReturnType<typeof useCodexApi> }>();
const { t, locale } = useI18n();
const copy = computed(() => {
  switch (locale.value) {
    case 'zh-CN': case 'zh-TW': case 'ja': case 'eo': return codexGoalUi[locale.value];
    default: return codexGoalUi.en;
  }
});
const objective = ref('');
const budgetText = ref('');
const budgetBadInput = ref(false);
const goalStatus = ref<CodexThreadGoalStatus>('active');
const action = ref<'set' | 'clear' | null>(null);
const saving = computed(() => action.value !== null);
const feedback = ref('');
const failed = ref(false);
const loadFailed = ref(false);
const goalStatuses: readonly CodexThreadGoalStatus[] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'];
const statusLabels = { active: 'goalStatusActive', paused: 'goalStatusPaused', blocked: 'goalStatusBlocked', usageLimited: 'goalStatusUsageLimited', budgetLimited: 'goalStatusBudgetLimited', complete: 'goalStatusComplete' } as const;
function operationBlocked(operation: 'get' | 'set' | 'clear') {
  const state = props.api.runtimeCapabilities.value[`thread/goal/${operation}`];
  return state === 'unsupported' || state === 'gated';
}
const availability = computed(() => {
  if (!props.api.connected.value) return copy.value.disconnected;
  if (!props.api.activeThreadId.value) return copy.value.noThread;
  const state = props.api.runtimeCapabilities.value['thread/goal/get'];
  if (state === 'unsupported') return copy.value.unsupported;
  if (state === 'gated') return copy.value.gated;
  if (props.api.threadGoalLoading.value && !saving.value) return copy.value.loading;
  if (loadFailed.value || props.api.threadGoalThreadId.value !== props.api.activeThreadId.value) return copy.value.loadError;
  return '';
});
const mutationAvailability = computed(() => {
  const states = ['set', 'clear'].map(operation => props.api.runtimeCapabilities.value[`thread/goal/${operation}`]);
  return states.includes('unsupported') ? copy.value.unsupported : states.includes('gated') ? copy.value.gated : '';
});
const goalReady = computed(() => !availability.value && !props.api.threadGoalLoading.value);
const tokenBudget = computed(() => budgetText.value.trim() === '' ? null : Number(budgetText.value));
const invalidBudget = computed(() => budgetBadInput.value || (tokenBudget.value !== null && (!Number.isSafeInteger(tokenBudget.value) || tokenBudget.value <= 0)));
const validationError = computed(() => invalidBudget.value ? copy.value.invalidBudget : objective.value.length > 4000 ? copy.value.tooLong : '');
function updateBudget(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  budgetText.value = event.target.value;
  budgetBadInput.value = event.target.validity.badInput;
}
watch([() => props.api.threadGoal.value, () => props.api.threadGoalThreadId.value, () => props.api.activeThreadId.value, () => props.api.connected.value], ([goal, owner, active, connected], [previous, previousOwner, previousActive, previousConnected]) => {
  const current = owner === active ? goal : null;
  const reset = owner !== previousOwner || active !== previousActive || connected !== previousConnected;
  if (reset || objective.value === (previous?.objective ?? '')) objective.value = current?.objective ?? '';
  const previousBudget = previous?.tokenBudget == null ? '' : String(previous.tokenBudget);
  if (reset || (!budgetBadInput.value && budgetText.value === previousBudget)) {
    budgetText.value = current?.tokenBudget == null ? '' : String(current.tokenBudget);
    budgetBadInput.value = false;
  }
  if (reset || goalStatus.value === (previous?.status ?? 'active')) goalStatus.value = current?.status ?? 'active';
}, { immediate: true, flush: 'sync' });
let contextGeneration = 0;
watch([() => props.api.activeThreadId.value, () => props.api.connected.value], () => {
  contextGeneration += 1;
  action.value = null;
  feedback.value = '';
  void refresh();
}, { flush: 'sync' });
async function refresh() {
  const generation = contextGeneration;
  const threadId = props.api.activeThreadId.value;
  loadFailed.value = false;
  feedback.value = '';
  failed.value = false;
  if (!props.api.connected.value || !threadId) return;
  try {
    await props.api.refreshThreadGoal(threadId);
  } catch (error) {
    if (generation === contextGeneration) {
      loadFailed.value = true;
      feedback.value = error instanceof Error ? error.message : copy.value.loadError;
      failed.value = true;
    }
  }
}
function hydrateGoal(goal: CodexThreadGoal | null) {
  objective.value = goal?.objective ?? '';
  budgetText.value = goal?.tokenBudget == null ? '' : String(goal.tokenBudget);
  budgetBadInput.value = false;
  goalStatus.value = goal?.status ?? 'active';
}
async function mutate(operation: 'set' | 'clear') {
  if (!goalReady.value || saving.value || operationBlocked(operation)) return;
  if (operation === 'set' && (!objective.value.trim() || validationError.value)) return;
  const generation = contextGeneration;
  action.value = operation;
  feedback.value = '';
  failed.value = false;
  try {
    if (operation === 'set') {
      const result = await props.api.setThreadGoal({ objective: objective.value.trim(), status: goalStatus.value, tokenBudget: tokenBudget.value });
      if (generation === contextGeneration) hydrateGoal(result.goal);
    } else {
      await props.api.clearThreadGoal();
      if (generation === contextGeneration) hydrateGoal(null);
    }
    if (generation === contextGeneration) feedback.value = operation === 'set' ? copy.value.saved : copy.value.cleared;
  } catch (error) {
    if (generation === contextGeneration) {
      failed.value = true;
      feedback.value = error instanceof Error ? `${copy.value.failed} ${error.message}` : copy.value.failed;
    }
  } finally {
    if (generation === contextGeneration) action.value = null;
  }
}
function formatNumber(value: number | null | undefined) { return typeof value === 'number' ? new Intl.NumberFormat(locale.value).format(value) : '—'; }
defineExpose({ refresh });
</script>

<style src="./codexGoalEditor.css"></style>
