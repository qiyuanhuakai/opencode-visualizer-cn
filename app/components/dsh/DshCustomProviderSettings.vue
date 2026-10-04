<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import Dropdown from '../Dropdown.vue';
import DshProviderEditor from './DshProviderEditor.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { DshRpcClient } from '../../utils/dshRpc';
import { isDshProviderConflict } from '../../backends/dsh/dshProviderConfig';
import { customProviderKeyRef, readCustomProviderContext, writeCustomProvider, type CustomProviderContext } from './customProviderConfiguration';
const props = defineProps<{ rpc: DshRpcClient }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'providers-changed'): void }>();
const { t } = useI18n();
const context = shallowRef<CustomProviderContext>();
const form = reactive({ id: '', name: '', baseURL: '', protocol: '', apiKey: '', models: [{ id: '', name: '' }] });
const busy = ref(false);
const committed = ref(false);
const error = ref('');
let active = true;
onBeforeUnmount(() => { active = false; });
onMounted(() => { void load(); });
async function load() {
  busy.value = true;
  try {
    const result = await readCustomProviderContext(props.rpc);
    if (!active) return;
    context.value = result;
    if (!form.protocol) form.protocol = result.protocols[0] ?? '';
  } catch (reason) {
    if (active) error.value = reason instanceof Error ? reason.message : t('kimiWeb.providers.loadFailed');
  } finally { if (active) busy.value = false; }
}
async function save() {
  if (!context.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (!committed.value) {
      await writeCustomProvider(props.rpc, context.value, form);
      if (!active) return;
      committed.value = true;
      emit('providers-changed');
    }
    if (form.apiKey.trim()) await props.rpc.call('credentials', 'set', { ref: customProviderKeyRef(form.id), value: form.apiKey.trim() });
    if (!active) return;
    emit('providers-changed');
    emit('close');
  } catch (reason) {
    if (!active) return;
    error.value = reason instanceof Error ? reason.message : t('kimiWeb.providers.saveFailed');
    if (isDshProviderConflict(reason)) { error.value = t('dsh.providers.conflict'); await load(); }
  } finally { if (active) busy.value = false; }
}
</script>
<template>
  <DshProviderEditor class="dsh-custom-provider-settings" :title="t('providerManager.custom.title')" @back="emit('close')">
    <form @submit.prevent="save">
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="busy" role="status">{{ t('kimiWeb.providers.loading') }}</p>
      <p v-if="committed" role="status">{{ t('kimiWeb.providers.saved') }} {{ t('kimiWeb.providers.keyMissing') }}</p>
      <fieldset :disabled="busy || !context?.writable || committed">
        <label>{{ t('providerManager.custom.fields.providerId.label') }}<input v-model.trim="form.id" data-custom-field="id" required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" /></label>
        <label>{{ t('providerManager.custom.fields.name.label') }}<input v-model="form.name" data-custom-field="name" /></label>
        <label>{{ t('kimiWeb.providers.baseUrl') }}<input v-model.trim="form.baseURL" data-custom-field="baseURL" required /></label>
        <label>{{ t('dsh.providers.protocol') }}<Dropdown v-model="form.protocol" :disabled="busy || !context?.writable || committed" :aria-label="t('dsh.providers.protocol')"><DropdownItem v-for="protocol in context?.protocols" :key="protocol" :value="protocol">{{ protocol }}</DropdownItem></Dropdown></label>
        <strong>{{ t('kimiWeb.providers.models') }}</strong>
        <div v-for="(model, index) in form.models" :key="index" class="model-fields"><label>{{ t('providerManager.custom.models.id.label') }}<input v-model="model.id" :data-custom-model="index" required /></label><label>{{ t('providerManager.custom.fields.name.label') }}<input v-model="model.name" /></label><button type="button" :aria-label="t('providerManager.custom.models.remove')" @click="form.models.splice(index, 1)">×</button></div>
        <button type="button" @click="form.models.push({ id: '', name: '' })">{{ t('providerManager.custom.models.add') }}</button>
      </fieldset>
      <label>API Key<input v-model="form.apiKey" type="password" autocomplete="new-password" :disabled="busy || !context?.writable" /></label>
      <div class="kimi-web-provider-form-actions"><button type="submit" class="is-primary" :disabled="busy || !context?.writable">{{ t('kimiWeb.providers.save') }}</button><button type="button" @click="emit('close')">{{ t('kimiWeb.providers.cancel') }}</button></div>
    </form>
  </DshProviderEditor>
</template>
<style scoped>
.model-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: var(--space-2); align-items: end; }
@media (max-width: 640px) { .model-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
