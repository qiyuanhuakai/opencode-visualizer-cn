<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { createKimiAccountClient, type KimiQuota } from '../../utils/kimiWebAccount';
import { kimiWebProxyHttpUrl, kimiWebWsUrl } from '../../utils/kimiWebWs';
import { DEFAULT_KIMI_WEB_BRIDGE_URL } from '../../backends/registry';
import { StorageKeys, storageGet } from '../../utils/storageKeys';
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith('zh'));
const quota = ref<KimiQuota | null>(null);
const plan = ref('');
const loading = ref(false);
const failed = ref(false);
let generation = 0;
const labels = computed<Record<string, string>>(() => zh.value
  ? { limit5h: '5 小时额度', limit7d: '7 天额度', monthTotal: '月度总额度', monthCode: '月度代码额度' }
  : { limit5h: '5-hour quota', limit7d: '7-day quota', monthTotal: 'Monthly quota', monthCode: 'Monthly code quota' });
function percent(ratio: number) { return Math.round(Math.max(0, Math.min(1, ratio)) * 100); }
function resetLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale.value);
}
async function refresh() {
  const request = ++generation;
  loading.value = true;
  failed.value = false;
  const url = storageGet(StorageKeys.auth.kimiWebBridgeUrl) ?? DEFAULT_KIMI_WEB_BRIDGE_URL;
  const token = storageGet(StorageKeys.auth.kimiWebBridgeToken) ?? '';
  const client = createKimiAccountClient(kimiWebProxyHttpUrl(kimiWebWsUrl(url, token)), token);
  const [usage, profile] = await Promise.allSettled([client.usage(), client.profile()]);
  if (request !== generation) return;
  quota.value = usage.status === 'fulfilled' ? usage.value : null;
  plan.value = profile.status === 'fulfilled' ? profile.value : '';
  failed.value = usage.status === 'rejected';
  loading.value = false;
}
onMounted(() => { void refresh(); });
onBeforeUnmount(() => { generation++; });
defineExpose({ refresh });
</script>

<template>
  <section class="kimi-account" :aria-label="zh ? 'Kimi 账户额度' : 'Kimi account quota'" :aria-busy="loading">
    <header class="account-heading"><h3>{{ zh ? 'Kimi 账户额度' : 'Kimi account quota' }}</h3><button type="button" :disabled="loading" @click="refresh">{{ zh ? '刷新' : 'Refresh' }}</button></header>
    <p v-if="plan" class="account-plan">{{ plan }}</p>
    <p v-if="loading" role="status">{{ zh ? '正在读取额度…' : 'Loading quota…' }}</p>
    <p v-else-if="failed" role="alert">{{ zh ? '无法读取账户额度，请检查 Kimi 登录状态后刷新。' : 'Account quota unavailable. Check Kimi sign-in and refresh.' }}</p>
    <p v-else-if="!quota?.windows.length">{{ zh ? '账户未提供额度窗口。' : 'No quota windows reported.' }}</p>
    <div v-for="entry in quota?.windows ?? []" v-else :key="entry.id" class="quota-window">
      <div class="quota-label"><span>{{ labels[entry.id] }}</span><span>{{ percent(entry.window.usedRatio) }}% {{ zh ? '已使用' : 'used' }}</span></div>
      <progress :value="percent(entry.window.usedRatio)" max="100" :aria-label="labels[entry.id]" />
      <small v-if="entry.window.resetAt">{{ zh ? '重置时间：' : 'Resets: ' }}{{ resetLabel(entry.window.resetAt) }}</small>
    </div>
  </section>
</template>

<style scoped>
.kimi-account { border-top: 1px solid var(--theme-border-default, #334155); margin-top: var(--space-4); padding-top: var(--space-4); font-size: var(--type-sm); color: var(--theme-text-primary, #e2e8f0); }
h3 { margin: 0; font-size: var(--type-heading); font-weight: 600; }
button { color: inherit; font: inherit; background: transparent; cursor: pointer; border: 1px solid var(--theme-border-default, #334155); border-radius: var(--radius-control); padding: 4px 8px; }
button:disabled { opacity: .5; }
button:focus-visible { outline: 2px solid var(--color-region-accent, #3b82f6); outline-offset: 2px; }
.account-plan { margin-top: var(--space-2); }
[role="alert"] { color: var(--theme-status-error, #f87171); }
.account-heading, .quota-label { display: flex; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
.quota-window { margin-top: var(--space-3); font-variant-numeric: tabular-nums; }
.quota-label { margin-bottom: var(--space-1); }
progress { width: 100%; height: 6px; appearance: none; border: 0; border-radius: 3px; overflow: hidden; background: var(--theme-modal-border, #334155); }
progress::-webkit-progress-bar { background: var(--theme-modal-border, #334155); }
progress::-webkit-progress-value { background: var(--color-region-accent, #3b82f6); }
progress::-moz-progress-bar { background: var(--color-region-accent, #3b82f6); }
small, p { color: var(--theme-text-secondary, #94a3b8); overflow-wrap: anywhere; }
</style>
