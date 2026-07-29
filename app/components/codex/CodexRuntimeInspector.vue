<template>
  <section class="flex h-full min-h-0 flex-col bg-slate-950/95 font-mono text-slate-200">
    <header class="flex shrink-0 items-center justify-between border-b border-slate-700/60 px-4 py-3">
      <h2 class="text-sm font-semibold">{{ t('codexPanel.runtime.title') }}</h2>
      <button
        type="button"
        class="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs hover:border-blue-400 disabled:opacity-50"
        :disabled="refreshing"
        @click="refreshAll"
      >
        {{ t('common.refresh') }}
      </button>
    </header>

    <div class="grid min-h-0 flex-1 gap-3 overflow-auto p-4 lg:grid-cols-2">
      <article class="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3 lg:col-span-2">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          {{ t('codexPanel.runtime.capabilities') }}
        </h3>
        <div class="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="entry in capabilityEntries" :key="entry.method" class="flex items-center justify-between gap-3 text-xs">
            <code class="truncate text-slate-300">{{ entry.method }}</code>
            <span class="shrink-0 rounded-full px-2 py-0.5" :class="capabilityClass(entry.state)">
              {{ t(`codexPanel.runtime.${entry.state}`) }}
            </span>
          </div>
        </div>
      </article>

      <article class="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
          {{ t('codexPanel.runtime.goal') }}
        </h3>
        <div class="space-y-2">
          <label class="block text-xs text-slate-400">
            {{ t('codexPanel.runtime.objective') }}
            <input v-model="objective" name="objective" class="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-2.5 py-2 text-slate-100" :disabled="saving || !goalReady" />
          </label>
          <div class="grid grid-cols-2 gap-2">
            <label class="block text-xs text-slate-400">
              {{ t('codexPanel.runtime.status') }}
              <select v-model="goalStatus" class="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-2 py-2 text-slate-100" :disabled="saving || !goalReady">
                <option v-for="status in goalStatuses" :key="status" :value="status">{{ goalStatusLabel(status) }}</option>
              </select>
            </label>
            <label class="block text-xs text-slate-400">
              {{ t('codexPanel.runtime.tokenBudget') }}
              <input v-model.number="tokenBudget" type="number" min="0" class="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-2.5 py-2 text-slate-100" :disabled="saving || !goalReady" />
            </label>
          </div>
          <div class="flex justify-end gap-2 pt-1">
            <button type="button" class="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:text-red-300" :disabled="saving || !goalReady" @click="clearGoal">
              {{ t('common.clear') }}
            </button>
            <button type="button" class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50" :disabled="saving || !goalReady || !objective.trim()" @click="saveGoal">
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </article>

      <article class="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{{ t('codexPanel.runtime.usage') }}</h3>
        <dl class="grid grid-cols-2 gap-3 text-xs">
          <div><dt class="text-slate-500">{{ t('codexPanel.runtime.lifetimeTokens') }}</dt><dd class="mt-1 text-base text-slate-100">{{ formatNumber(api.accountUsage.value?.summary.lifetimeTokens) }}</dd></div>
          <div><dt class="text-slate-500">{{ t('codexPanel.runtime.streakDays') }}</dt><dd class="mt-1 text-base text-slate-100">{{ formatNumber(api.accountUsage.value?.summary.currentStreakDays) }}</dd></div>
        </dl>
      </article>

      <article class="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{{ t('codexPanel.runtime.provider') }}</h3>
        <div class="space-y-1.5 text-xs">
          <div v-for="item in providerEntries" :key="item.key" class="flex justify-between"><span>{{ item.key }}</span><span :class="item.value ? 'text-emerald-400' : 'text-slate-500'">{{ t(`codexPanel.runtime.${item.value ? 'enabled' : 'disabled'}`) }}</span></div>
        </div>
      </article>

      <article class="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{{ t('codexPanel.runtime.permissionProfiles') }}</h3>
        <div class="space-y-2 text-xs"><div v-for="profile in api.permissionProfiles.value" :key="profile.id"><code class="text-blue-300">{{ profile.id }}</code><p v-if="profile.description" class="mt-0.5 text-slate-500">{{ profile.description }}</p></div></div>
      </article>

      <article class="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
        <div class="mb-3 flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400">{{ t('codexPanel.runtime.loadedThreads') }}</h3>
          <button type="button" class="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:border-amber-500 disabled:opacity-50" :disabled="cleaning || !api.activeThreadId.value" @click="cleanBackgroundTerminals">{{ t('codexPanel.runtime.cleanBackgroundTerminals') }}</button>
        </div>
        <div class="space-y-1 text-xs text-slate-400"><code v-for="threadId in api.loadedThreadIds.value" :key="threadId" class="block truncate">{{ threadId }}</code></div>
      </article>

      <article class="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3 lg:col-span-2">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{{ t('codexPanel.runtime.configRequirements') }}</h3>
        <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-400">{{ formattedRequirements }}</pre>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CodexCapabilityState } from '../../backends/codex/capabilityRegistry';
import type { CodexThreadGoalStatus } from '../../backends/codex/codexAdapter';
import type { useCodexApi } from '../../composables/useCodexApi';

const props = defineProps<{ api: ReturnType<typeof useCodexApi> }>();
const { t } = useI18n();
const refreshing = ref(false);
const saving = ref(false);
const cleaning = ref(false);
const objective = ref('');
const tokenBudget = ref<number | null>(null);
const goalStatus = ref<CodexThreadGoalStatus>('active');
const goalStatuses: CodexThreadGoalStatus[] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'];
const methods = ['thread/goal/get', 'account/usage/read', 'modelProvider/capabilities/read', 'permissionProfile/list', 'configRequirements/read', 'thread/loaded/list'];

const goalReady = computed(() => Boolean(
  props.api.activeThreadId.value
  && !props.api.threadGoalLoading.value
  && props.api.threadGoalThreadId.value === props.api.activeThreadId.value,
));

function resetGoalForm() {
  objective.value = '';
  tokenBudget.value = null;
  goalStatus.value = 'active';
}

watch(
  [
    () => props.api.threadGoal.value,
    () => props.api.threadGoalThreadId.value,
    () => props.api.activeThreadId.value,
  ],
  ([goal, goalThreadId, activeThreadId]) => {
    if (goalThreadId !== activeThreadId) {
      resetGoalForm();
      return;
    }
    objective.value = goal?.objective ?? '';
    tokenBudget.value = goal?.tokenBudget ?? null;
    goalStatus.value = goal?.status ?? 'active';
  },
  { immediate: true },
);

watch(() => props.api.activeThreadId.value, (threadId, previousThreadId) => {
  if (!threadId || threadId === previousThreadId) return;
  resetGoalForm();
  void Promise.allSettled([props.api.refreshThreadGoal(threadId)]);
});

const capabilityEntries = computed(() => methods.map((method) => ({
  method,
  state: props.api.runtimeCapabilities.value[method] ?? 'unknown' as CodexCapabilityState,
})));
const providerEntries = computed(() => Object.entries(props.api.modelProviderCapabilities.value ?? {}).map(([key, value]) => ({ key, value })));
const formattedRequirements = computed(() => JSON.stringify(props.api.configRequirements.value ?? {}, null, 2));

function capabilityClass(state: CodexCapabilityState) {
  if (state === 'supported') return 'bg-emerald-500/15 text-emerald-300';
  if (state === 'gated') return 'bg-amber-500/15 text-amber-300';
  if (state === 'unsupported') return 'bg-red-500/15 text-red-300';
  return 'bg-slate-700 text-slate-400';
}

function goalStatusLabel(status: CodexThreadGoalStatus) {
  switch (status) {
    case 'active': return t('codexPanel.runtime.goalStatusActive');
    case 'paused': return t('codexPanel.runtime.goalStatusPaused');
    case 'blocked': return t('codexPanel.runtime.goalStatusBlocked');
    case 'usageLimited': return t('codexPanel.runtime.goalStatusUsageLimited');
    case 'budgetLimited': return t('codexPanel.runtime.goalStatusBudgetLimited');
    case 'complete': return t('codexPanel.runtime.goalStatusComplete');
  }
}

function formatNumber(value: number | null | undefined) {
  return typeof value === 'number' ? new Intl.NumberFormat().format(value) : '—';
}

async function refreshAll() {
  refreshing.value = true;
  try {
    await Promise.allSettled([
      props.api.refreshThreadGoal(),
      props.api.refreshAccountUsage(),
      props.api.refreshModelProviderCapabilities(),
      props.api.refreshPermissionProfiles(),
      props.api.refreshConfigRequirements(),
      props.api.refreshLoadedThreads(),
    ]);
  } finally {
    refreshing.value = false;
  }
}

async function saveGoal() {
  if (!goalReady.value) return;
  saving.value = true;
  try {
    await props.api.setThreadGoal({ objective: objective.value.trim(), status: goalStatus.value, tokenBudget: tokenBudget.value });
  } finally {
    saving.value = false;
  }
}

async function clearGoal() {
  if (!goalReady.value) return;
  saving.value = true;
  try {
    await props.api.clearThreadGoal();
  } finally {
    saving.value = false;
  }
}

async function cleanBackgroundTerminals() {
  if (!props.api.activeThreadId.value) return;
  cleaning.value = true;
  try {
    await props.api.cleanThreadBackgroundTerminals(props.api.activeThreadId.value);
    await props.api.refreshLoadedThreads();
  } finally {
    cleaning.value = false;
  }
}

onMounted(refreshAll);
</script>
