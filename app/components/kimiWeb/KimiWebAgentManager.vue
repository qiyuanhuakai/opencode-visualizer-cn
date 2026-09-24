<template>
  <section class="kimi-settings" :aria-busy="pending">
    <strong class="settings-title">{{ t('defaultSubagentModel') }}</strong>
    <div class="settings-fields">
      <div class="setting-field">
        <span>{{ t('model') }}</span>
        <Dropdown :label="selectedModelLabel" :disabled="pending || !availableSubagentModels.length" button-class="setting-select-trigger" popup-class="setting-select-menu" :popup-style="modelPopupStyle" @select="selectModel">
          <DropdownItem v-for="item in availableSubagentModels" :key="item.model" :value="item.model" :active="item.model === defaultSubagentModel">{{ item.display_name || item.model }}</DropdownItem>
        </Dropdown>
      </div>
      <div class="setting-field">
        <span>{{ t('thinking') }}</span>
        <Dropdown :label="defaultSubagentEffort || t('default')" :disabled="pending || !subagentEfforts.length" button-class="setting-select-trigger" popup-class="setting-select-menu" :popup-style="effortPopupStyle" @select="selectEffort">
          <DropdownItem v-for="effort in subagentEfforts" :key="effort" :value="effort" :active="effort === defaultSubagentEffort">{{ effort }}</DropdownItem>
        </Dropdown>
      </div>
    </div>
    <div class="settings-actions">
      <span class="settings-feedback" :class="{ 'is-error': Boolean(error) }" :role="error ? 'alert' : 'status'">{{ error || notice }}</span>
      <button type="button" class="save-button" :disabled="pending || !defaultSubagentModel" @click="saveDefaultSubagentModel">{{ t('save') }}</button>
    </div>
    <div class="settings-divider" />
    <label class="tower-toggle">
      <span class="tower-copy"><strong>tower</strong><small>{{ t('towerHint') }}</small></span>
      <input type="checkbox" :checked="towerExperimental" :disabled="pending" :aria-label="t('towerExperiment')" @change="setTowerExperiment" />
    </label>
    <button v-if="error" type="button" class="retry-button" :disabled="pending" @click="refresh">{{ t('refresh') }}</button>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { KimiWebClient, KimiWebModel } from '../../utils/kimiWeb';
import { kimiWebAgentsUi } from '../../locales/kimiWebAgentsUi';

const props = defineProps<{ sessionId: string; client: KimiWebClient }>();
const emit = defineEmits<{ 'tower-experiment-updated': [enabled: boolean] }>();
const { t } = useI18n({ useScope: 'local', messages: kimiWebAgentsUi });
const models = ref<KimiWebModel[]>([]);
const defaultSubagentModel = ref('');
const defaultSubagentEffort = ref('');
const configuredSubagentModels = ref<string[]>([]);
const towerExperimental = ref(false);
const pending = ref(false);
const error = ref('');
const notice = ref('');
const modelPopupStyle = { top: 'auto', bottom: 'anchor(top)', left: 'anchor(left)', right: 'auto', width: '220px', marginBottom: '4px' };
const effortPopupStyle = { top: 'auto', bottom: 'anchor(top)', left: 'anchor(left)', right: 'auto', width: '120px', marginBottom: '4px' };
const availableSubagentModels = computed(() => configuredSubagentModels.value.length
  ? models.value.filter((item) => configuredSubagentModels.value.includes(item.model))
  : models.value);
const subagentEfforts = computed(() => models.value.find((item) => item.model === defaultSubagentModel.value)?.support_efforts ?? []);
const selectedModelLabel = computed(() => availableSubagentModels.value.find((item) => item.model === defaultSubagentModel.value)?.display_name || defaultSubagentModel.value || t('loading'));
watch(defaultSubagentModel, () => {
  if (!subagentEfforts.value.includes(defaultSubagentEffort.value)) {
    defaultSubagentEffort.value = models.value.find((item) => item.model === defaultSubagentModel.value)?.default_effort ?? subagentEfforts.value[0] ?? '';
  }
});
function selectModel(value: unknown) { if (typeof value === 'string') defaultSubagentModel.value = value; }
function selectEffort(value: unknown) { if (typeof value === 'string') defaultSubagentEffort.value = value; }
type RequestScope = { readonly sessionId: string; readonly client: KimiWebClient; readonly current: () => boolean };
let generation = 0;
onBeforeUnmount(() => { generation++; });
async function run(operation: (scope: RequestScope) => Promise<void>, replace = false) {
  if (pending.value && !replace) return;
  const id = ++generation;
  const sessionId = props.sessionId;
  const client = props.client;
  const current = () => id === generation && sessionId === props.sessionId && client === props.client;
  pending.value = true; error.value = ''; notice.value = '';
  try { await operation({ sessionId, client, current }); }
  catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (current()) pending.value = false; }
}
async function load(scope: RequestScope) {
  const [nextModels, config] = await Promise.all([scope.client.listModels(), scope.client.getConfig()]);
  if (!scope.current()) return;
  models.value = nextModels.items;
  configuredSubagentModels.value = Object.keys(config.secondary_model?.models ?? {});
  defaultSubagentModel.value = config.secondary_model?.defaultModel ?? config.secondary_model?.default_model ?? config.default_model ?? nextModels.items[0]?.model ?? '';
  defaultSubagentEffort.value = config.secondary_model?.defaultEffort ?? config.secondary_model?.default_effort ?? nextModels.items.find((item) => item.model === defaultSubagentModel.value)?.default_effort ?? subagentEfforts.value[0] ?? '';
  towerExperimental.value = config.experimental?.tower === true;
}
function refresh() { return run(load); }
function saveDefaultSubagentModel() {
  const selected = defaultSubagentModel.value;
  const effort = defaultSubagentEffort.value;
  if (!selected || !availableSubagentModels.value.some((item) => item.model === selected)) return;
  return run(async (scope) => {
    await scope.client.updateConfig({ secondary_model: { default_model: selected, ...(effort ? { default_effort: effort } : {}) } });
    if (scope.current()) notice.value = t('saved');
  });
}
function setTowerExperiment(event: Event) {
  const input = event.target as HTMLInputElement;
  const requested = input.checked;
  input.checked = towerExperimental.value;
  return run(async (scope) => {
    const config = await scope.client.updateConfig({ experimental: { tower: requested } });
    if (!scope.current()) return;
    towerExperimental.value = config.experimental?.tower ?? requested;
    emit('tower-experiment-updated', towerExperimental.value);
    notice.value = t('saved');
  });
}
watch([() => props.sessionId, () => props.client], () => {
  models.value = []; configuredSubagentModels.value = []; defaultSubagentModel.value = ''; defaultSubagentEffort.value = '';
  void run(load, true);
}, { immediate: true, flush: 'sync' });
</script>

<style scoped>
.kimi-settings { display: grid; gap: var(--space-2); box-sizing: border-box; padding: var(--space-3); color: var(--theme-dropdown-text, var(--theme-text-primary)); background: var(--theme-dropdown-bg, var(--theme-surface-panel-elevated)); font-size: var(--type-sm); }
.settings-title { font-size: var(--type-heading); }
.settings-fields { display: grid; grid-template-columns: minmax(0, 2fr) minmax(88px, 1fr); gap: var(--space-2); }
.setting-field { display: grid; gap: var(--space-1); min-width: 0; color: var(--theme-text-muted); font-size: var(--type-caption); }
.settings-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.settings-feedback { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--theme-text-muted); font-size: var(--type-caption); }
.settings-feedback.is-error { color: var(--theme-status-error); }
.save-button, .retry-button { flex: 0 0 auto; padding: var(--space-1) var(--space-2); border: 1px solid var(--theme-dropdown-border, var(--theme-border-default)); border-radius: var(--radius-control); background: var(--theme-dropdown-control-bg, var(--theme-surface-panel-muted)); color: var(--theme-dropdown-text, var(--theme-text-primary)); font: inherit; cursor: pointer; }
.save-button:hover:not(:disabled), .retry-button:hover:not(:disabled) { background: var(--theme-dropdown-hover-bg, var(--theme-surface-panel-hover)); }
.save-button:disabled, .retry-button:disabled { opacity: .5; cursor: default; }
.settings-divider { height: 1px; background: var(--theme-dropdown-border, var(--theme-border-default)); }
.tower-toggle { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); cursor: pointer; }
.tower-copy { display: grid; gap: 2px; min-width: 0; }
.tower-copy strong { font-weight: 600; }
.tower-copy small { color: var(--theme-text-muted); font-size: var(--type-caption); }
.tower-toggle input { appearance: none; position: relative; width: 32px; height: 18px; flex: 0 0 32px; margin: 0; border: 1px solid var(--theme-dropdown-border, var(--theme-border-default)); border-radius: 999px; background: var(--theme-dropdown-control-bg, var(--theme-surface-panel-muted)); cursor: pointer; }
.tower-toggle input::before { content: ''; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; border-radius: 50%; background: var(--theme-dropdown-text, var(--theme-text-primary)); transition: transform 120ms ease-out; }
.tower-toggle input:checked { background: var(--theme-dropdown-accent, var(--theme-border-accent)); }
.tower-toggle input:checked::before { transform: translateX(14px); }
:deep(.setting-select-trigger) { height: 28px; min-width: 0; padding: var(--space-1) var(--space-2); border-radius: var(--radius-control); font-size: var(--type-sm); }
:deep(.setting-select-menu) { z-index: 121; min-width: 0; }
:deep(.setting-select-menu .ui-dropdown-item) { white-space: normal; overflow-wrap: anywhere; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--theme-dropdown-accent, var(--theme-border-accent)); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .tower-toggle input::before { transition: none; } }
</style>
