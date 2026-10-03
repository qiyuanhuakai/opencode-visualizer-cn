<template>
  <section class="dsh-plugin-manager" :aria-busy="pending">
    <header class="manager-header">
      <div><strong>{{ copy.title }} ({{ entries.length }})</strong><p>{{ copy.scope }}</p></div>
      <button type="button" :disabled="pending" @click="refresh">{{ copy.refresh }}</button>
    </header>
    <input v-model="query" type="search" :placeholder="copy.search" :aria-label="copy.search" />
    <p v-if="error" role="alert" class="feedback is-error">{{ error }}</p>
    <p v-else-if="notice" role="status" class="feedback">{{ notice }}</p>
    <p class="summary">{{ filtered.length }} / {{ entries.length }}</p>
    <div class="plugin-list">
      <article v-for="entry in filtered" :key="entry.id" class="plugin-row" :data-plugin-id="entry.id">
        <div class="plugin-copy">
          <strong>{{ entry.name }}</strong>
          <small>{{ entry.moduleName }}</small>
          <p v-if="entry.description">{{ entry.description }}</p>
          <small v-if="!entry.writable">{{ entry.readOnlyReason === 'management-required' ? copy.protected : copy.unaddressable }}</small>
          <small>{{ entry.phase || copy.inactive }}</small>
        </div>
        <label class="plugin-toggle">
          <span>{{ entry.enabled ? copy.enabled : copy.disabled }}</span>
          <input type="checkbox" :checked="entry.enabled" :disabled="pending || !entry.writable" :aria-label="`${copy.toggle}: ${entry.name}`" @change="toggle(entry, $event)" />
        </label>
      </article>
      <p v-if="!pending && !filtered.length" class="feedback">{{ copy.empty }}</p>
      <p v-if="pending && !entries.length" class="feedback">{{ copy.loading }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BackendPluginManagementEntry, BackendPluginChange } from '../../backends/types';

const props = defineProps<{ client: {
  getPluginManagementEntries(): Promise<BackendPluginManagementEntry[]>;
  setPluginEnabled(id: string, enabled: boolean): Promise<BackendPluginChange>;
} }>();
const { locale } = useI18n();
const copy = computed(() => locale.value.startsWith('zh') ? {
  title: '全局插件', scope: '修改当前 DSH 配置档，影响使用此配置档的会话。', refresh: '刷新', search: '搜索插件',
  protected: '运行管理所需，无法禁用', unaddressable: '此插件没有可修改的配置入口', inactive: '未运行',
  enabled: '已启用', disabled: '已禁用', toggle: '切换插件', empty: '没有匹配的插件', loading: '正在读取插件…',
  applied: '已应用，并重新读取插件状态。', restart: '已保存，需要重启 DSH 才能生效。', overridden: '已保存，但被其他配置覆盖；当前状态未必改变。',
} : {
  title: 'Global plugins', scope: 'Changes affect the current DSH profile and sessions using it.', refresh: 'Refresh', search: 'Search plugins',
  protected: 'Required for runtime management', unaddressable: 'No editable profile entry', inactive: 'Inactive',
  enabled: 'Enabled', disabled: 'Disabled', toggle: 'Toggle plugin', empty: 'No matching plugins', loading: 'Loading plugins…',
  applied: 'Applied; plugin status refreshed.', restart: 'Saved; restart DSH to apply.', overridden: 'Saved, but overridden by other configuration; the current state may remain unchanged.',
});
const entries = ref<BackendPluginManagementEntry[]>([]);
const query = ref('');
const pending = ref(false);
const error = ref('');
const notice = ref('');
let generation = 0;
const filtered = computed(() => {
  const term = query.value.trim().toLowerCase();
  return entries.value.filter((entry) => `${entry.name} ${entry.moduleName} ${entry.description ?? ''}`.toLowerCase().includes(term));
});

async function refresh() {
  const current = ++generation;
  const client = props.client;
  pending.value = true;
  error.value = '';
  try {
    const result = await client.getPluginManagementEntries();
    if (current === generation) entries.value = result;
  } catch (reason) {
    if (current === generation) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (current === generation) pending.value = false;
  }
}

async function toggle(entry: BackendPluginManagementEntry, event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  const requested = event.target.checked;
  event.target.checked = entry.enabled;
  if (pending.value || !entry.writable) return;
  const current = ++generation;
  const client = props.client;
  pending.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await client.setPluginEnabled(entry.id, requested);
    if (current !== generation) return;
    const fresh = await client.getPluginManagementEntries();
    if (current !== generation) return;
    entries.value = fresh;
    switch (result.application) {
      case 'applied': notice.value = copy.value.applied; break;
      case 'restart-required': notice.value = copy.value.restart; break;
      case 'overridden': notice.value = copy.value.overridden; break;
    }
  } catch (reason) {
    if (current === generation) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (current === generation) pending.value = false;
  }
}
watch(() => props.client, () => {
  entries.value = [];
  notice.value = '';
  void refresh();
}, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>

<style scoped>
.dsh-plugin-manager { display: flex; flex-direction: column; gap: var(--space-2); min-height: 0; max-height: 70vh; padding: var(--space-3); color: var(--theme-dropdown-text, var(--theme-text-primary)); background: var(--theme-dropdown-bg, var(--theme-surface-panel-elevated)); font-size: var(--type-sm); }
.manager-header { display: flex; gap: var(--space-2); align-items: start; justify-content: space-between; }
.manager-header strong { font-size: var(--type-heading); }
p { margin: var(--space-1) 0 0; }
.manager-header p, small, .summary, .feedback { color: var(--theme-text-muted); font-size: var(--type-caption); }
button, input[type="search"] { padding: var(--space-1) var(--space-2); border: 1px solid var(--theme-dropdown-border, var(--theme-border-default)); border-radius: var(--radius-control); background: var(--theme-dropdown-control-bg, var(--theme-surface-panel-muted)); color: inherit; font: inherit; }
button { cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
input[type="search"] { min-width: 0; width: 100%; box-sizing: border-box; }
.plugin-list { overflow: auto; min-height: 0; }
.plugin-row { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--theme-border-subtle); }
.plugin-copy { display: grid; gap: var(--space-1); min-width: 0; overflow-wrap: anywhere; }
.plugin-toggle { display: flex; align-items: center; gap: var(--space-2); flex-shrink: 0; font-size: var(--type-caption); }
.plugin-toggle input { accent-color: var(--theme-dropdown-accent, var(--theme-border-accent)); }
.is-error { color: var(--theme-status-error); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--theme-dropdown-accent, var(--theme-border-accent)); outline-offset: 2px; }
</style>
