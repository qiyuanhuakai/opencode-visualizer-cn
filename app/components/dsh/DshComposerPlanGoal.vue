<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import ComposerToggle from '../composer/ComposerToggle.vue';
import ComposerGoal from '../composer/ComposerGoal.vue';
import { useI18n } from 'vue-i18n';
import type { DshPlanGoalControl } from '../../composables/useDshPlanGoal';
const props = defineProps<{ control: DshPlanGoalControl }>();
const emit = defineEmits<{ open: [] }>();
const { t, locale } = useI18n();
const enabled = computed(() => props.control.plan.value?.pending ? !props.control.plan.value.active : props.control.plan.value?.active === true);
const state = computed(() => locale.value.startsWith('zh') ? enabled.value ? '开启' : '关闭' : enabled.value ? 'On' : 'Off');
</script>

<template>
  <ComposerToggle class="dsh-plan" :class="{ active: enabled }" :active="enabled" :busy="control.pending.value" :disabled="!control.loaded.value || !control.plan.value || control.pending.value" :title="control.error.value || '/plan · /plan off'" @click="control.togglePlan()">
    <Icon icon="lucide:list-checks" :width="14" aria-hidden="true" /><span>plan</span><span>{{ state }}{{ control.plan.value?.pending ? '…' : '' }}</span>
  </ComposerToggle>
  <ComposerGoal class="dsh-goal" :label="t('codexPanel.runtime.goal')" :summary="control.pending.value ? '…' : control.error.value || control.goal.value?.objective || '—'" :error="Boolean(control.error.value)" :disabled="!control.sessionId.value" @open="emit('open')" />
</template>
