<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
defineEmits<{ connectRemote: []; openSettings: [] }>();
const { t } = useI18n();
const remoteIcon = {
  width: 24, height: 24,
  body: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4m-7 4v-4h14v4"/></g>',
};
</script>

<template>
  <div class="login-page-actions" data-testid="login-page-actions">
    <button type="button" :aria-label="t('app.runtimeConnection.sshSlurm')" :title="t('app.runtimeConnection.sshSlurm')" @click="$emit('connectRemote')">
      <Icon :icon="remoteIcon" :width="16" :height="16" aria-hidden="true" />
    </button>
    <button type="button" :aria-label="t('app.runtimeConnection.settings')" :title="t('app.runtimeConnection.settings')" @click="$emit('openSettings')">
      <Icon icon="lucide:settings" :width="16" :height="16" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.login-page-actions {
  position: absolute;
  inset-block-start: 8px;
  inset-inline-end: 12px;
  display: flex;
  gap: 8px;
}
button {
  display: grid;
  place-items: center;
  inline-size: 32px;
  block-size: 32px;
  padding: 0;
  border: none;
  border-radius: 8px;
  color: var(--theme-top-text-muted, var(--theme-text-muted));
  background: transparent;
  cursor: pointer;
}
button:hover { color: var(--theme-text-primary); }
</style>
