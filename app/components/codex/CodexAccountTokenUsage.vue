<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';
import { accountUsageCopy } from './accountUsageCopy';

const props = defineProps<{ api: ReturnType<typeof useCodexApi>; initialView?: 'daily' | 'weekly' | 'cumulative' }>();
const { locale } = useI18n();
const copy = computed(() => accountUsageCopy[locale.value.startsWith('zh') ? 'zh' : 'en']);
const error = ref('');
const section = ref<HTMLElement | null>(null);
watch([() => props.initialView, () => props.api.accountUsage.value], async () => {
  if (!props.initialView) return;
  await nextTick();
  section.value?.querySelector<HTMLElement>(`[data-view="${props.initialView}"]`)?.focus({ preventScroll: true });
}, { immediate: true });
const now = ref(Date.now());
const usage = computed(() => props.api.accountUsage.value);
const unsupported = computed(() => ['unsupported', 'gated'].includes(props.api.runtimeCapabilities.value['account/usage/read'] ?? '') || props.api.account.value?.type === 'apiKey');
const buckets = computed(() => [...(usage.value?.dailyUsageBuckets ?? [])].sort((a, b) => b.startDate.localeCompare(a.startDate)));
const totals = computed(() => {
  if (!usage.value?.dailyUsageBuckets) return { today: null, week: null };
  const today = new Date(now.value).toISOString().slice(0, 10);
  const weekStart = new Date(`${today}T00:00:00Z`).getTime() - 6 * 86400000;
  return buckets.value.reduce((result, bucket) => {
    const date = bucket.startDate.slice(0, 10);
    if (date === today) result.today += bucket.tokens;
    if (date <= today && Date.parse(`${date}T00:00:00Z`) >= weekStart) result.week += bucket.tokens;
    return result;
  }, { today: 0, week: 0 });
});
function number(value: number | null | undefined) {
  return value == null ? '—' : new Intl.NumberFormat(locale.value).format(value);
}
async function refresh() {
  error.value = '';
  now.value = Date.now();
  if (props.api.status.value !== 'connected' || unsupported.value || props.api.accountUsageLoading.value) return;
  try {
    await props.api.refreshAccountUsage();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : copy.value.failed;
  }
}
watch([() => props.api.status.value, () => props.api.account.value?.type], () => { void refresh(); }, { immediate: true });
defineExpose({ refresh });
</script>

<template>
  <section ref="section" class="account-token-usage" :aria-busy="api.accountUsageLoading.value">
    <header><h3>{{ copy.title }}</h3><button type="button" :disabled="api.status.value !== 'connected' || api.accountUsageLoading.value || unsupported" @click="refresh">{{ copy.refresh }}</button></header>
    <p class="usage-hint">{{ copy.hint }}</p>
    <p v-if="api.status.value !== 'connected'" role="status">{{ copy.disconnected }}</p>
    <p v-else-if="unsupported" role="status">{{ copy.unsupported }}</p>
    <template v-else>
      <p v-if="error" role="alert">{{ copy.failed }} {{ error }}</p>
      <p v-if="api.accountUsageLoading.value" role="status">{{ copy.loading }}</p>
      <p v-else-if="!usage && !error" role="status">{{ copy.empty }}</p>
      <template v-if="usage">
        <dl><div><dt>{{ copy.today }}</dt><dd>{{ number(totals.today) }}</dd></div><div tabindex="-1" data-view="weekly"><dt>{{ copy.week }}</dt><dd>{{ number(totals.week) }}</dd></div><div tabindex="-1" data-view="cumulative"><dt>{{ copy.lifetime }}</dt><dd>{{ number(usage.summary.lifetimeTokens) }}</dd></div></dl>
        <details v-if="buckets.length" :open="initialView === 'daily'"><summary data-view="daily">{{ copy.daily }}</summary><table><thead><tr><th scope="col">{{ copy.date }}</th><th scope="col">{{ copy.tokens }}</th></tr></thead><tbody><tr v-for="bucket in buckets" :key="bucket.startDate"><td>{{ bucket.startDate.slice(0, 10) }}</td><td>{{ number(bucket.tokens) }}</td></tr></tbody></table></details>
      </template>
    </template>
  </section>
</template>

<style scoped>
.account-token-usage { border-top: 1px solid var(--theme-border-default, #334155); padding-top: 16px; margin-top: 16px; font-size: 12px; color: var(--theme-text-primary, #e2e8f0); }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
h3 { font-size: 14px; font-weight: 600; }
button { color: inherit; font: inherit; background: transparent; cursor: pointer; border: 1px solid var(--theme-border-default, #334155); border-radius: 8px; padding: 4px 8px; }
button:disabled { opacity: .5; }
[data-view]:focus, button:focus-visible, summary:focus-visible { outline: 2px solid var(--color-region-accent, #3b82f6); outline-offset: 2px; }
p { margin-top: 8px; overflow-wrap: anywhere; }
.usage-hint, dt { color: var(--theme-text-secondary, #94a3b8); }
[role="alert"] { color: var(--theme-status-error, #f87171); }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 16px 0; }
dd { margin: 4px 0 0; font-variant-numeric: tabular-nums; }
summary { cursor: pointer; padding: 4px 0; }
table { color: inherit; font: inherit; width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--theme-border-default, #334155); }
th:last-child, td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
</style>
