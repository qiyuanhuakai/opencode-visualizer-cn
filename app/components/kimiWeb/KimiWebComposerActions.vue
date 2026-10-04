<template>
  <ComposerDropdown control-role="settings" :menu-width="312" v-model:open="open" class="kimi-settings-dropdown" :disabled="disabled || !client || !sessionId" :label="t('settings.title')" menu-role="dialog" button-class="kimi-composer-agents" :auto-focus="false">
    <template #label><Icon icon="lucide:settings-2" :width="15" :height="15" aria-hidden="true" /><span class="visually-hidden">{{ t('settings.title') }}</span></template>
    <KimiWebAgentManager v-if="open && client && sessionId" :session-id="sessionId" :client="client" @tower-experiment-updated="emit('tower-experiment-updated', $event)" />
  </ComposerDropdown>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import ComposerDropdown from '../composer/ComposerDropdown.vue';
import KimiWebAgentManager from './KimiWebAgentManager.vue';
import type { KimiWebClient } from '../../utils/kimiWeb';
defineProps<{ disabled?: boolean; sessionId: string; client: KimiWebClient | null }>();
const emit = defineEmits<{ 'tower-experiment-updated': [enabled: boolean] }>();
const { t } = useI18n();
const open = ref(false);
defineExpose({ open: () => { open.value = true; } });
</script>

<style scoped>
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
