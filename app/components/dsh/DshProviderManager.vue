<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DshRpcClient } from '../../utils/dshRpc';
import { createDshProviderConfigClient, type DshProviderConfiguration } from '../../backends/dsh/dshProviderConfig';
import DshProviderSettings from './DshProviderSettings.vue';
import DshCustomProviderSettings from './DshCustomProviderSettings.vue';

const props = withDefaults(defineProps<{ rpc: DshRpcClient; active?: boolean }>(), { active: true });
const emit = defineEmits<{
  (event: 'providers-changed'): void;
  (event: 'inventory', rows: DshProviderConfiguration[]): void;
  (event: 'editing-changed', value: boolean): void;
}>();
const { t } = useI18n();
const editing = ref('');
const creating = ref(false);
const loading = ref(false);
const error = ref('');
let generation = 0;
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const result = await createDshProviderConfigClient(props.rpc).load();
    if (current === generation) emit('inventory', result);
  } catch (reason) {
    if (current === generation) error.value = reason instanceof Error ? reason.message : t('kimiWeb.providers.loadFailed');
  } finally {
    if (current === generation) loading.value = false;
  }
}
function changed() { emit('providers-changed'); void load(); }
function closeEditor() { editing.value = ''; creating.value = false; emit('editing-changed', false); }
function openSettings(id: string) { editing.value = id; creating.value = false; emit('editing-changed', true); }
function openCreate() { editing.value = ''; creating.value = true; emit('editing-changed', true); }
defineExpose({ openSettings, openCreate });
watch(() => props.active, (active) => { if (!active) closeEditor(); });
watch(() => props.rpc, () => { closeEditor(); emit('inventory', []); void load(); }, { immediate: true });
onBeforeUnmount(() => { generation++; emit('editing-changed', false); });
</script>

<template>
  <p v-if="error" role="alert" class="provider-feedback">{{ error }} <button type="button" :disabled="loading" @click="load">{{ t('common.retry') }}</button></p>
  <p v-if="loading" role="status" class="provider-feedback">{{ t('kimiWeb.providers.loading') }}</p>
  <DshProviderSettings v-if="editing" :key="editing" :rpc="rpc" :provider-id="editing" @close="closeEditor" @providers-changed="changed" />
  <DshCustomProviderSettings v-if="creating" :rpc="rpc" @close="closeEditor" @providers-changed="changed" />
</template>

<style scoped>
.provider-feedback { margin: 0; color: var(--theme-modal-text-muted, var(--theme-text-muted)); font-size: var(--type-sm); }
[role='alert'] { color: var(--theme-text-danger); }
button { border: 1px solid var(--theme-modal-border); border-radius: var(--radius-control); background: var(--theme-modal-control-bg); color: var(--theme-modal-text); font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--theme-modal-accent); outline-offset: 2px; }
</style>
