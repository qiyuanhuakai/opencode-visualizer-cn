<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dropdown from '../Dropdown.vue';
import DshProviderEditor from './DshProviderEditor.vue';
import DshProviderModels from './DshProviderModels.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { DshRpcClient } from '../../utils/dshRpc';
import type { DshJsonValue } from '../../backends/dsh/types';
import { createDshProviderConfigClient, isDshProviderConflict, type DshProviderConfiguration, type DshProviderField, type DshProviderPatch } from '../../backends/dsh/dshProviderConfig';

const props = defineProps<{ rpc: DshRpcClient; providerId: string }>();
const emit = defineEmits<{ (event: 'providers-changed'): void; (event: 'close'): void }>();
const { t } = useI18n();
const showConfirm = inject<((message: string) => Promise<boolean>) | undefined>('showConfirm');
const providers = shallowRef<DshProviderConfiguration[]>([]);
const selected = ref(props.providerId);
const provider = computed(() => providers.value.find((row) => row.provider === selected.value));
const fields = ref<Record<string, string>>({});
const models = ref<DshJsonValue[] | undefined>();
let modelsBaseline = '';
const discoveryDraft = computed(() => ({ ...fields.value, ...(keyMode.value === 'replace' ? { apiKey: apiKey.value } : {}) }));
let draftBaseline: Record<string, string> = {};
const keyMode = ref<'keep' | 'replace' | 'remove'>('keep');
const apiKey = ref('');
const busy = ref(false);
const feedback = ref('');
const failed = ref(false);
let generation = 0;
onBeforeUnmount(() => { generation += 1; });
function draftValue(field: DshProviderField): string {
  return field.kind === 'models' ? JSON.stringify(field.value ?? [], null, 2) : typeof field.value === 'string' ? field.value : '';
}
function resetDraft() {
  fields.value = Object.fromEntries((provider.value?.fields ?? []).map((field) => [field.name, draftValue(field)]));
  draftBaseline = { ...fields.value };
  const value = provider.value?.fields.find((field) => field.kind === 'models')?.value;
  models.value = Array.isArray(value) ? value : undefined;
  modelsBaseline = JSON.stringify(models.value) ?? '';
  keyMode.value = 'keep';
  apiKey.value = '';
}
watch(selected, resetDraft);
async function load() {
  const current = ++generation;
  busy.value = true;
  feedback.value = '';
  failed.value = false;
  try {
    const rows = await createDshProviderConfigClient(props.rpc).load();
    if (current !== generation) return;
    providers.value = rows;
    selected.value = props.providerId;
    resetDraft();
  } catch (error) {
    if (current !== generation) return;
    failed.value = true;
    feedback.value = error instanceof Error ? error.message : t('kimiWeb.providers.loadFailed');
  } finally {
    if (current === generation) busy.value = false;
  }
}
watch(() => [props.rpc, props.providerId], () => { providers.value = []; selected.value = props.providerId; void load(); }, { immediate: true });
async function save() {
  const row = provider.value;
  if (!row || busy.value) return;
  if (keyMode.value === 'remove' && !(await showConfirm?.(t('kimiWeb.providers.removeKeyConfirm')))) return;
  const current = generation;
  const rpc = props.rpc;
  busy.value = true;
  feedback.value = '';
  failed.value = false;
  try {
    const changes: Record<string, DshJsonValue | undefined> = {};
    for (const field of row.fields) {
      if (field.kind === 'models') {
        if ((JSON.stringify(models.value) ?? '') !== modelsBaseline) changes[field.name] = models.value;
        continue;
      }
      const text = fields.value[field.name] ?? '';
      if (text === draftBaseline[field.name]) continue;
      changes[field.name] = text.trim() || undefined;
    }
    const key: DshProviderPatch['key'] = keyMode.value === 'replace' ? { kind: 'replace', value: apiKey.value } : { kind: keyMode.value };
    const rows = await createDshProviderConfigClient(rpc).save(row, { fields: changes, key });
    if (current !== generation) return;
    providers.value = rows;
    resetDraft();
    feedback.value = t('kimiWeb.providers.saved');
    emit('providers-changed');
  } catch (error) {
    if (current !== generation) return;
    failed.value = true;
    const message = isDshProviderConflict(error) ? t('dsh.providers.conflict') : error instanceof Error ? error.message : t('kimiWeb.providers.saveFailed');
    try {
      const refreshed = await createDshProviderConfigClient(rpc).load();
      if (current !== generation) return;
      providers.value = refreshed;
      feedback.value = message;
    } catch (refreshError) {
      if (current !== generation) return;
      feedback.value = `${message} · ${refreshError instanceof Error ? refreshError.message : t('kimiWeb.providers.loadFailed')}`;
    }
  } finally {
    if (current === generation) busy.value = false;
  }
}
function label(name: string) {
  if (name === 'reasoning') return t('dsh.providers.reasoning');
  if (name === 'baseURL') return t('kimiWeb.providers.baseUrl');
  if (name === 'models') return t('kimiWeb.providers.models');
  if (name === 'displayName') return t('dsh.providers.displayName');
  return name === 'api' ? t('dsh.providers.protocol') : t('dsh.providers.credentialRef');
}
</script>

<template>
  <DshProviderEditor class="dsh-provider-settings" :title="provider?.displayName || t('kimiWeb.providers.edit')" @back="emit('close')">
    <section class="dsh-provider-manager" :aria-busy="busy">
    <p v-if="feedback" :role="failed ? 'alert' : 'status'" :data-error="failed">{{ feedback }}</p>
    <p v-if="busy" role="status">{{ t('kimiWeb.providers.loading') }}</p>
    <form v-if="provider" @submit.prevent="save">
      <p class="dsh-provider-id">{{ provider.provider }}</p>
      <p v-if="!provider.writable">{{ t('dsh.providers.readonly') }}</p>
      <fieldset :disabled="busy || !provider.writable">
        <label v-for="field in provider.fields.filter((item) => item.kind !== 'models')" :key="field.name" class="dsh-provider-field">
          <span>{{ label(field.name) }}</span>
          <Dropdown v-if="field.kind === 'choice'" v-model="fields[field.name]" :disabled="busy || !provider.writable" :aria-label="label(field.name)">
            <DropdownItem value="">{{ t('dsh.providers.default') }}</DropdownItem>
            <DropdownItem v-for="choice in field.choices" :key="choice" :value="choice">{{ choice }}</DropdownItem>
          </Dropdown>
          <input v-else v-model="fields[field.name]" :data-field="field.name" type="text" :placeholder="field.name === 'apiKeyEnv' ? provider.credentialRef : undefined" autocomplete="off" />
        </label>
        <div v-if="provider.credential" class="dsh-provider-key">
          <p>{{ t(provider.credential.configured ? 'kimiWeb.providers.keyConfigured' : 'kimiWeb.providers.keyMissing') }}</p>
          <label v-for="mode in (['keep', 'replace', 'remove'] as const)" :key="mode">
            <input v-model="keyMode" type="radio" name="dsh-api-key-mode" :value="mode" :disabled="!provider.credential.writable && (!fields.apiKeyEnv || fields.apiKeyEnv === provider.credentialRef)" />
            {{ t(`dsh.providers.key.${mode}`) }}
          </label>
          <label v-if="keyMode === 'replace'" class="dsh-provider-field">
            <span>API Key</span><input v-model="apiKey" type="password" autocomplete="new-password" required />
          </label>
        </div>
        <DshProviderModels v-if="provider.fields.some((field) => field.kind === 'models')" v-model="models" :provider="provider" :rpc="rpc" :draft="discoveryDraft" :disabled="busy || !provider.writable" />
        <div class="kimi-web-provider-form-actions"><button type="submit" class="is-primary" :disabled="busy || !provider.writable">{{ t('kimiWeb.providers.save') }}</button><button type="button" @click="emit('close')">{{ t('kimiWeb.providers.cancel') }}</button></div>
      </fieldset>
    </form>
    </section>
  </DshProviderEditor>
</template>

<style scoped>
.dsh-provider-manager { display: grid; gap: var(--space-3); min-width: 0; color: var(--theme-modal-text, var(--theme-text-primary)); font-size: var(--type-body); }
.dsh-provider-id { color: var(--theme-modal-text-muted, var(--theme-text-muted)); }
.dsh-provider-key { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.dsh-provider-key p, .dsh-provider-key .dsh-provider-field { flex-basis: 100%; }
.dsh-provider-key > label { flex-direction: row; gap: var(--space-1); align-items: center; }
.dsh-provider-key > .dsh-provider-field { flex-direction: column; align-items: stretch; }
</style>
