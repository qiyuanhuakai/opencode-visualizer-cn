<template>
  <section class="session-plugins" :aria-busy="pending" data-plugin-scope="session">
    <header><strong>{{ copy.title }} <span v-if="selected">({{ selected.rows.length }})</span></strong><button type="button" :disabled="pending || !rpc" @click="refresh">{{ copy.refresh }}</button></header>
    <p>{{ copy.scope }}</p>
    <p v-if="sessionId" class="identity">{{ copy.session }}: {{ sessionId }}</p>
    <p v-if="selected">{{ copy.preset }}: {{ selected.name || selected.id }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="pending" role="status">{{ copy.loading }}</p>
    <p v-else-if="!rpc">{{ copy.unavailable }}</p>
    <p v-else-if="!selected">{{ copy.unknown }}</p>
    <template v-else>
      <p v-if="selected.broken" role="alert">{{ selected.broken }}</p>
      <p>{{ copy.readonly }}</p>
      <input v-model="query" type="search" :aria-label="copy.search" :placeholder="copy.search" />
      <div class="session-plugin-list">
        <article v-for="(row, index) in filtered" :key="`${row.entryId}:${index}`" :data-session-plugin="row.moduleName">
          <strong>{{ sessionPluginText(row.title, locale) || row.moduleName }}</strong>
          <small>{{ row.moduleName }}</small>
          <p v-if="row.description">{{ sessionPluginText(row.description, locale) }}</p>
          <small>{{ row.enabled === 'conditional' ? copy.conditional : row.enabled ? copy.enabled : copy.disabled }}</small>
          <small v-if="row.condition">{{ copy.condition }}: {{ row.condition }}</small>
          <p v-if="row.metadataError" role="alert">{{ row.metadataError }}</p>
          <p v-if="row.fiberPhase === 'failed'" role="alert">{{ copy.failed }}</p>
        </article>
        <p v-if="!filtered.length">{{ copy.empty }}</p>
      </div>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { readSessionPluginPresets, sessionPluginText, type SessionPluginPreset, type SessionPluginRpc } from './sessionPluginInventory';
const props = defineProps<{ rpc?: SessionPluginRpc | null; sessionId?: string | null; presetId?: string | null }>();
const { locale } = useI18n();
const copy = computed(() => locale.value.startsWith('zh') ? {
  title: '会话插件', scope: '由 Agent 预设按会话组成', session: '会话', preset: '预设', refresh: '刷新', loading: '正在读取会话插件…',
  unavailable: '当前连接无法读取会话插件。', unknown: '无法确定此会话的预设，未显示其他预设的插件。',
  readonly: '以下为预设配置；此处只读，已启用不代表此会话中正在运行。', search: '搜索会话插件', conditional: '条件启用', enabled: '预设中启用', disabled: '预设中停用', condition: '禁用条件', failed: '预设组合启动失败', empty: '没有匹配的会话插件',
} : {
  title: 'Session plugins', scope: 'Composed per session by agent presets', session: 'Session', preset: 'Preset', refresh: 'Refresh', loading: 'Loading session plugins…',
  unavailable: 'Session plugin inventory is unavailable on this connection.', unknown: 'This session’s preset is unresolved; plugins from other presets are not shown.',
  readonly: 'Read-only preset configuration. Enabled does not mean running in this session.', search: 'Search session plugins', conditional: 'Conditional', enabled: 'Enabled in preset', disabled: 'Disabled in preset', condition: 'Disabled when', failed: 'Preset composition failed to start', empty: 'No matching session plugins',
});
const presets = ref<readonly SessionPluginPreset[]>([]);
const pending = ref(false);
const error = ref('');
const query = ref('');
let generation = 0;
const selected = computed(() => props.presetId ? presets.value.find((preset) => preset.id === props.presetId) : undefined);
const filtered = computed(() => {
  const term = query.value.trim().toLowerCase();
  return (selected.value?.rows ?? []).filter((row) => `${row.moduleName} ${row.entryId ?? ''} ${sessionPluginText(row.title, locale.value)} ${sessionPluginText(row.description, locale.value)}`.toLowerCase().includes(term));
});
async function refresh() {
  const current = ++generation;
  const rpc = props.rpc;
  error.value = '';
  pending.value = Boolean(rpc);
  if (!rpc) return;
  try {
    const result = await readSessionPluginPresets(rpc);
    if (current === generation) presets.value = result;
  } catch (reason) {
    if (current === generation) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (current === generation) pending.value = false;
  }
}
watch(() => [props.rpc, props.sessionId, props.presetId], () => { presets.value = []; query.value = ''; void refresh(); }, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>
<style scoped>
.session-plugins { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); color: var(--theme-dropdown-text, var(--theme-text-primary)); font-size: var(--type-sm); }
header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
header strong { font-size: var(--type-heading); }
p { margin: 0; }
p, small { color: var(--theme-text-muted); font-size: var(--type-caption); overflow-wrap: anywhere; }
.identity { overflow-wrap: anywhere; }
button, input { padding: var(--space-1) var(--space-2); border: 1px solid var(--theme-dropdown-border, var(--theme-border-default)); border-radius: var(--radius-control); background: var(--theme-dropdown-control-bg, var(--theme-surface-panel-muted)); color: inherit; font: inherit; min-width: 0; }
button { cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--theme-dropdown-accent, var(--theme-border-accent)); outline-offset: 2px; }
.session-plugin-list { max-height: 28vh; overflow: auto; }
article { display: grid; gap: var(--space-1); padding: var(--space-2) 0; border-bottom: 1px solid var(--theme-border-subtle); overflow-wrap: anywhere; }
[role="alert"] { color: var(--theme-status-error); }
</style>
