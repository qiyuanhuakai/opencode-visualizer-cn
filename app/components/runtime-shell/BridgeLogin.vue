<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { useI18n } from 'vue-i18n';
import { DEFAULT_RUNTIME_BRIDGE_URL } from '../../runtime/connectionUrl';
const url = defineModel<string>('url', { required: true });
const token = defineModel<string>('token', { required: true });
defineProps<{ error: string }>();
defineEmits<{ connect: []; connectRemote: []; openSettings: [] }>();
const { t } = useI18n();
const remoteIcon = {
  width: 24, height: 24,
  body: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></g>',
};
const settingsIcon = {
  width: 24, height: 24,
  body: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></g>',
};
</script>

<template>
  <form class="bridge-login" data-runtime-ui data-testid="bridge-login" aria-labelledby="bridge-login-title" @submit.prevent="$emit('connect')">
    <div class="bridge-login-header">
      <h1 id="bridge-login-title">vis_bridge</h1>
      <div class="bridge-login-actions">
        <button type="button" :aria-label="t('app.runtimeConnection.sshSlurm')" :title="t('app.runtimeConnection.sshSlurm')" @click="$emit('connectRemote')">
          <Icon :icon="remoteIcon" :width="16" :height="16" aria-hidden="true" />
        </button>
        <button type="button" :aria-label="t('app.runtimeConnection.settings')" :title="t('app.runtimeConnection.settings')" @click="$emit('openSettings')">
          <Icon :icon="settingsIcon" :width="16" :height="16" aria-hidden="true" />
        </button>
      </div>
    </div>
    <p>{{ t('app.runtimeConnection.description') }}</p>
    <label for="bridge-url">{{ rt("Bridge URL") }}</label>
    <input id="bridge-url" v-model="url" class="bridge-control" name="bridgeUrl" required spellcheck="false" autocomplete="url" :placeholder="DEFAULT_RUNTIME_BRIDGE_URL" />
    <label for="bridge-token">{{ t('app.login.codexBridgeToken') }}</label>
    <input id="bridge-token" v-model="token" class="bridge-control" name="bridgeToken" type="password" autocomplete="current-password" />
    <p v-if="error" role="alert" class="bridge-error">{{ error }}</p>
    <button type="submit" class="action-button primary">{{ t('app.login.connect') }}</button>
  </form>
</template>

<style scoped>
.bridge-login { display: grid; gap: var(--space-2); color: var(--theme-login-text, var(--theme-text-primary)); text-align: left; }
h1 { font-size: var(--type-heading); font-weight: 600; }
p, label { font-size: var(--type-sm); }
p { color: var(--theme-login-text-muted, var(--theme-text-muted)); }
input, button { border: 1px solid var(--theme-border-default); border-radius: var(--radius-control); padding: var(--space-2) var(--space-3); background: var(--theme-surface-panel); color: var(--theme-text-primary); font: inherit; }
button { cursor: pointer; }
.bridge-login-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.bridge-login-actions { display: flex; gap: var(--space-2); }
.bridge-login-actions button { display: grid; place-items: center; inline-size: 34px; block-size: 34px; padding: 0; }
.bridge-login-actions button:hover { background: var(--theme-surface-hover, var(--theme-surface-panel)); }
.bridge-error { color: var(--codex-status-danger, var(--theme-text-primary)); overflow-wrap: anywhere; }
</style>
