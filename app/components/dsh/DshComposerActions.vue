<template>
  <ComposerDropdown control-role="settings" :menu-width="400" v-model:open="open" class="dsh-settings-dropdown" :disabled="disabled" :label="t('settings.title')" menu-role="dialog" button-class="dsh-composer-settings" :auto-focus="false">
    <template #label><Icon icon="lucide:settings-2" :width="15" :height="15" aria-hidden="true" /><span class="visually-hidden">{{ t('settings.title') }}</span></template>
    <div v-if="open" class="dsh-plugin-scopes">
      <DshSessionPlugins :rpc="rpc" :session-id="sessionId" :preset-id="presetId" />
      <DshPluginManager :client="client" />
    </div>
  </ComposerDropdown>
</template>
<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { BackendPluginChange, BackendPluginManagementEntry } from '../../backends/types';
import ComposerDropdown from '../composer/ComposerDropdown.vue';
import type { SessionPluginRpc } from './sessionPluginInventory';
const DshSessionPlugins = defineAsyncComponent(() => import('./DshSessionPlugins.vue'));
const DshPluginManager = defineAsyncComponent(() => import('./DshPluginManager.vue'));
defineProps<{ disabled?: boolean; rpc?: SessionPluginRpc | null; sessionId?: string | null; presetId?: string | null; client: {
  getPluginManagementEntries(): Promise<BackendPluginManagementEntry[]>;
  setPluginEnabled(id: string, enabled: boolean): Promise<BackendPluginChange>;
} }>();
const { t } = useI18n();
const open = ref(false);
</script>
<style scoped>
.dsh-plugin-scopes { max-height: 70vh; overflow: auto; background: var(--theme-dropdown-bg, var(--theme-surface-panel-elevated)); }
.dsh-plugin-scopes :deep(.dsh-plugin-manager) { border-top: 1px solid var(--theme-border-subtle); max-height: 36vh; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
</style>
