<template>
  <Dropdown v-model:open="open" class="kimi-settings-dropdown" :disabled="disabled || !client || !sessionId" :label="t('settings.title')" menu-role="dialog" button-class="kimi-composer-agents" :auto-focus="false" :popup-style="{ top: 'auto', bottom: 'anchor(top)', left: 'clamp(8px, anchor(left), calc(100vw - 320px))', right: 'auto', width: 'min(312px, calc(100vw - 16px))', marginBottom: '6px' }">
    <template #label><Icon icon="lucide:settings-2" :width="15" :height="15" aria-hidden="true" /><span class="visually-hidden">{{ t('settings.title') }}</span></template>
    <KimiWebAgentManager v-if="open && client && sessionId" :session-id="sessionId" :client="client" @tower-experiment-updated="emit('tower-experiment-updated', $event)" />
  </Dropdown>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import Dropdown from '../Dropdown.vue';
import KimiWebAgentManager from './KimiWebAgentManager.vue';
import type { KimiWebClient } from '../../utils/kimiWeb';
defineProps<{ disabled?: boolean; sessionId: string; client: KimiWebClient | null }>();
const emit = defineEmits<{ 'tower-experiment-updated': [enabled: boolean] }>();
const { t } = useI18n();
const open = ref(false);
defineExpose({ open: () => { open.value = true; } });
</script>

<style scoped>
.kimi-settings-dropdown { flex: 0 0 28px; width: 28px; min-width: 28px; }
:deep(.kimi-composer-agents) { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; height: 28px; padding: var(--space-1) var(--space-2); border: 1px solid transparent; border-radius: var(--ui-chip-radius); background: transparent; color: var(--theme-input-text-muted); font: inherit; font-size: var(--type-sm); cursor: pointer; }
:deep(.kimi-composer-agents:hover:not(:disabled)) { background: var(--theme-input-surface-hover, var(--theme-input-surface)); color: var(--theme-input-text); }
:deep(.kimi-composer-agents:focus-visible) { outline: 2px solid var(--theme-input-accent); outline-offset: 2px; }
:deep(.kimi-composer-agents .ui-dropdown-icon) { display: none; }
:deep(.kimi-settings-dropdown > .ui-dropdown-menu) { padding: 0; overflow: visible; border: 1px solid var(--theme-dropdown-border, var(--theme-border-default)); border-radius: var(--radius-panel); background: var(--theme-dropdown-bg, var(--theme-surface-panel-elevated)); box-shadow: var(--theme-dropdown-shadow); }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
