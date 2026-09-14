<template>
  <section class="command-panel" :aria-label="t('permissions')" :aria-busy="saving">
    <p class="command-hint">{{ t('permissionHint') }}</p>
    <p v-if="!api.connected.value" role="status" class="command-hint">{{ t('disconnected') }}</p>
    <p v-else-if="!api.permissionModes.value.length" role="status" class="command-hint">{{ t('emptyModes') }}</p>
    <div v-else class="command-options">
      <button v-for="mode in api.permissionModes.value" :key="mode.id" type="button" class="command-option"
        :aria-pressed="api.selectedPermissionMode.value === mode.id" :disabled="saving"
        @click="selectMode(mode.id)">
        <span class="command-option-title">
          <strong>{{ t(modeCopy[mode.id].name) }}</strong>
          <span v-if="api.selectedPermissionMode.value === mode.id" class="command-selected">{{ t('selected') }}</span>
        </span>
        <span class="command-hint">{{ t(modeCopy[mode.id].description) }}</span>
      </button>
    </div>
    <p v-if="saving" role="status" class="command-hint">{{ t('saving') }}</p>
    <p v-if="error" role="alert" class="command-error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';
import { codexCommandUi } from '../../locales/codexCommandUi';
const props = defineProps<{
  api: Pick<ReturnType<typeof useCodexApi>, 'connected' | 'permissionModes' | 'selectedPermissionMode' | 'setPermissionMode'>;
}>();
const { t } = useI18n({ useScope: 'local', messages: codexCommandUi });
const modeCopy = {
  'read-only': { name: 'readOnly', description: 'readOnlyHint' },
  'workspace-write': { name: 'workspaceWrite', description: 'workspaceWriteHint' },
  'full-access': { name: 'fullAccess', description: 'fullAccessHint' },
} as const;
const saving = ref(false);
const error = ref('');
async function selectMode(id: string) {
  if (saving.value || !props.api.connected.value) return;
  saving.value = true;
  error.value = '';
  try {
    await props.api.setPermissionMode(id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped src="./codexCommandPanels.css"></style>
