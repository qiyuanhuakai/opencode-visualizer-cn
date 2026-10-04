<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DshRpcClient } from '../../utils/dshRpc';
import type { DshJsonValue } from '../../backends/dsh/types';
import { createDshProviderConfigClient, dshReasoningLevels, type DshProviderConfiguration } from '../../backends/dsh/dshProviderConfig';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
type Model = { [key: string]: DshJsonValue };
const props = defineProps<{ modelValue: DshJsonValue[] | undefined; provider: DshProviderConfiguration; rpc: DshRpcClient; draft: Readonly<Record<string, string>>; disabled: boolean }>();
const emit = defineEmits<{ (event: 'update:modelValue', value: DshJsonValue[] | undefined): void }>();
const { t } = useI18n();
const models = computed(() => (props.modelValue ?? []).filter((model): model is Model => Boolean(model) && typeof model === 'object' && !Array.isArray(model)));
const modalityField = computed(() => props.provider.fields.find((field) => field.kind === 'models')?.modelInputField ?? 'input');
const supportsEfforts = computed(() => props.provider.fields.find((field) => field.kind === 'models')?.modelReasoningEfforts === true);
function effortMode(model: Model): string { return model.reasoningEfforts === false ? 'disabled' : model.reasoningEfforts === undefined ? 'inherit' : 'custom'; }
function efforts(model: Model): Model { const value = model.reasoningEfforts; return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}; }
function setEffortMode(index: number, value: string) { update(index, 'reasoningEfforts', value === 'inherit' ? undefined : value === 'disabled' ? false : { high: 'high' }); }
function toggleEffort(index: number, level: string, event: Event) {
  const next = { ...efforts(models.value[index]) };
  if (event.target instanceof HTMLInputElement && event.target.checked) next[level] = level === 'off' ? null : level;
  else delete next[level];
  update(index, 'reasoningEfforts', next);
}
function wireEffort(index: number, level: string, event: Event) { const value = text(event); update(index, 'reasoningEfforts', { ...efforts(models.value[index]), [level]: level === 'off' && !value ? null : value }); }
const catalog = ref<Model[]>([]);
const checked = ref<string[]>([]);
const query = ref('');
const opened = ref(false);
const loading = ref(false);
const error = ref('');
let generation = 0;
let discoveryAbort: AbortController | undefined;
const existing = computed(() => new Set(models.value.map((model) => model.id)));
const visible = computed(() => catalog.value.filter((model) => `${model.id} ${model.name ?? ''}`.toLowerCase().includes(query.value.trim().toLowerCase())));
const selectable = computed(() => visible.value.filter((model) => !existing.value.has(model.id)));
const selected = computed(() => catalog.value.filter((model) => checked.value.includes(String(model.id)) && !existing.value.has(model.id)));
function resetDiscovery() { generation++; discoveryAbort?.abort(); opened.value = false; loading.value = false; catalog.value = []; checked.value = []; query.value = ''; error.value = ''; }
watch(() => [props.rpc, props.provider.provider, props.draft.baseURL, props.draft.api, props.draft.apiKey], resetDiscovery);
onBeforeUnmount(() => { generation++; discoveryAbort?.abort(); });
async function discover() {
  const current = ++generation;
  discoveryAbort?.abort();
  const controller = new AbortController();
  discoveryAbort = controller;
  const timeout = setTimeout(() => controller.abort(), 30000);
  opened.value = true; loading.value = true; error.value = ''; checked.value = []; catalog.value = [];
  try {
    const result = await createDshProviderConfigClient(props.rpc).discoverModels(props.provider, props.draft, controller.signal);
    if (current === generation) catalog.value = result;
  } catch (reason) {
    if (current === generation) error.value = reason instanceof Error ? reason.message : t('dsh.providers.discoveryFailed');
  } finally { clearTimeout(timeout); if (current === generation) loading.value = false; }
}
function update(index: number, field: string, value: DshJsonValue | undefined) {
  emit('update:modelValue', models.value.map((model, item) => {
    if (item !== index) return model;
    const next = { ...model };
    if (value === undefined) delete next[field]; else next[field] = value;
    return next;
  }));
}
function text(event: Event): string { return event.target instanceof HTMLInputElement ? event.target.value : ''; }
function capacity(index: number, field: string, event: Event) {
  const value = text(event).trim();
  update(index, field, value ? (/^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value) : undefined);
}
function imageEnabled(model: Model): boolean { const input = model[modalityField.value]; return Array.isArray(input) && input.includes('image'); }
function toggleImage(index: number, event: Event) { update(index, modalityField.value, event.target instanceof HTMLInputElement && event.target.checked ? ['text', 'image'] : ['text']); }
function addSelected() { emit('update:modelValue', [...models.value, ...selected.value]); checked.value = []; }
function selectAll() {
  const ids = selectable.value.map((model) => String(model.id));
  checked.value = ids.every((id) => checked.value.includes(id)) ? checked.value.filter((id) => !ids.includes(id)) : [...new Set([...checked.value, ...ids])];
}
</script>
<template>
  <section class="dsh-provider-models" :aria-label="t('kimiWeb.providers.models')">
    <div class="models-toolbar"><strong>{{ t('kimiWeb.providers.models') }}</strong><div class="models-actions">
      <button type="button" data-restore-models :disabled="disabled" @click="emit('update:modelValue', undefined)">{{ t('dsh.providers.restoreModels') }}</button>
      <button type="button" data-discover-models :disabled="disabled || loading" @click="discover">{{ t('dsh.providers.discoverModels') }}</button>
    </div></div>
    <p v-if="modelValue === undefined" class="models-hint">{{ t('dsh.providers.defaultModels') }}</p>
    <article v-for="(model, index) in models" :key="index" class="model-card" data-model-card>
      <div class="model-fields">
        <label>{{ t('kimiWeb.providers.modelId') }}<input :value="model.id" data-model-id type="text" required :disabled="disabled" @input="update(index, 'id', text($event))" /></label>
        <label>{{ t('kimiWeb.providers.modelName') }}<input :value="model.name" data-model-name type="text" :disabled="disabled" @input="update(index, 'name', text($event) || undefined)" /></label>
        <button type="button" data-remove-model :aria-label="t('kimiWeb.providers.removeModel')" :disabled="disabled" @click="emit('update:modelValue', models.filter((_, item) => item !== index))">{{ t('kimiWeb.providers.removeModel') }}</button>
      </div>
      <details><summary>{{ t('dsh.providers.modelDetails') }}</summary><div class="model-fields model-details">
        <label>{{ t('kimiWeb.providers.contextSize') }}<input :value="model.contextWindow" data-model-context type="text" inputmode="numeric" pattern="[1-9][0-9]*" :placeholder="t('dsh.providers.default')" :disabled="disabled" @input="capacity(index, 'contextWindow', $event)" /></label>
        <label>{{ t('dsh.providers.maxTokens') }}<input :value="model.maxTokens" data-model-max-tokens type="text" inputmode="numeric" pattern="[1-9][0-9]*" :placeholder="t('dsh.providers.default')" :disabled="disabled" @input="capacity(index, 'maxTokens', $event)" /></label>
        <fieldset class="model-modalities"><legend>{{ t('dsh.providers.inputTypes') }}</legend>
          <label class="checkbox-row"><input type="checkbox" checked disabled />{{ t('dsh.providers.textRequired') }}</label>
          <label class="checkbox-row"><input type="checkbox" :checked="imageEnabled(model)" :disabled="disabled" data-model-image @change="toggleImage(index, $event)" />{{ t('dsh.providers.imageInput') }}</label>
          <span v-if="model[modalityField] === undefined" class="models-hint">{{ t('dsh.providers.default') }}</span>
        </fieldset>
        <fieldset v-if="supportsEfforts" class="model-reasoning">
          <legend>{{ t('dsh.providers.reasoningEfforts') }}</legend>
          <Dropdown :model-value="effortMode(model)" :label="t(effortMode(model) === 'inherit' ? 'dsh.providers.inheritReasoning' : effortMode(model) === 'disabled' ? 'dsh.providers.disableReasoning' : 'dsh.providers.customReasoning')" :disabled="disabled" :aria-label="t('dsh.providers.reasoningEfforts')" @update:model-value="setEffortMode(index, String($event))">
            <DropdownItem value="inherit">{{ t('dsh.providers.inheritReasoning') }}</DropdownItem>
            <DropdownItem value="disabled">{{ t('dsh.providers.disableReasoning') }}</DropdownItem>
            <DropdownItem value="custom">{{ t('dsh.providers.customReasoning') }}</DropdownItem>
          </Dropdown>
          <template v-if="effortMode(model) === 'custom'">
            <p class="models-hint">{{ t('dsh.providers.reasoningHint') }}</p>
            <div v-for="level in dshReasoningLevels" :key="level" class="effort-row">
              <label class="checkbox-row"><input type="checkbox" :data-reasoning-level="level" :checked="Object.hasOwn(efforts(model), level)" :disabled="disabled" @change="toggleEffort(index, level, $event)" />{{ level }}</label>
              <input v-if="Object.hasOwn(efforts(model), level)" :value="efforts(model)[level] ?? ''" :data-reasoning-wire="level" type="text" :required="level !== 'off'" :disabled="disabled" :aria-label="t('dsh.providers.reasoningWire', { level })" :placeholder="level === 'off' ? t('dsh.providers.offWire') : level" @input="wireEffort(index, level, $event)" />
            </div>
          </template>
        </fieldset>
      </div></details>
    </article>
    <button type="button" data-add-model :disabled="disabled" @click="emit('update:modelValue', [...models, { id: '' }])">{{ t('kimiWeb.providers.addModel') }}</button>
    <section v-if="opened" class="model-discovery" :aria-busy="loading" :aria-label="t('dsh.providers.discoverModels')">
      <p v-if="loading" role="status">{{ t('dsh.providers.discoveringModels') }}</p>
      <template v-else-if="error"><p role="alert">{{ error }}</p><button type="button" data-retry-models :disabled="disabled" @click="discover">{{ t('common.retry') }}</button></template>
      <template v-else>
        <input v-model="query" type="search" data-model-search :placeholder="t('dsh.providers.searchModels')" :aria-label="t('dsh.providers.searchModels')" />
        <p v-if="!visible.length" role="status">{{ t('dsh.providers.noModels') }}</p>
        <div v-else class="model-candidates">
          <label v-for="model in visible" :key="String(model.id)" class="checkbox-row model-candidate">
            <input v-model="checked" type="checkbox" :value="model.id" :disabled="disabled || existing.has(model.id)" :aria-label="String(model.id)" />
            <span><strong>{{ model.name || model.id }}</strong><small>{{ model.id }}</small></span>
            <small v-if="existing.has(model.id)">{{ t('dsh.providers.modelAdded') }}</small>
          </label>
        </div>
        <div class="models-actions"><button type="button" data-select-models :disabled="disabled || !selectable.length" @click="selectAll">{{ t('dsh.providers.selectModels') }}</button><button type="button" data-add-selected :disabled="disabled || !selected.length" @click="addSelected">{{ t('dsh.providers.addSelected', { count: selected.length }) }}</button></div>
      </template>
    </section>
  </section>
</template>
<style scoped>
.dsh-provider-models, .model-card, .model-discovery { display: grid; gap: var(--space-3); min-width: 0; }
.models-toolbar, .models-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
.models-toolbar { justify-content: space-between; }
.model-card, .model-discovery { padding: var(--space-3); border: 1px solid var(--theme-card-border, var(--theme-modal-border)); border-radius: var(--radius-control); background: var(--theme-card-bg, var(--theme-modal-control-bg)); }
.model-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); align-items: end; }
.model-fields > button, .model-modalities { grid-column: 1 / -1; }
.model-fields > button { justify-self: end; }
.model-details { margin-top: var(--space-3); }
.model-reasoning { grid-column: 1 / -1; display: grid; gap: var(--space-2); min-width: 0; }
.effort-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: var(--space-2); align-items: center; }
summary { cursor: pointer; color: var(--theme-modal-text-muted, var(--theme-text-muted)); }
.model-modalities { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.checkbox-row { display: flex; flex-direction: row; align-items: center; gap: var(--space-2); }
.checkbox-row input[type='checkbox'] { width: auto; flex: 0 0 auto; margin: 0; accent-color: var(--theme-modal-accent); }
.model-candidates { max-height: 240px; overflow: auto; }
.model-candidate { padding: var(--space-2); border-radius: var(--radius-control); }
.model-candidate:has(input:checked), .model-candidate:hover { background: var(--theme-modal-item-hover-bg, var(--theme-modal-control-bg)); }
.model-candidate > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.model-candidate strong, .model-candidate small { display: block; }
.models-hint, small { color: var(--theme-modal-text-muted, var(--theme-text-muted)); font-size: var(--type-sm); }
@media (max-width: 480px) { .model-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
