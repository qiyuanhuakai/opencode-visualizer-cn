<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { useI18n } from 'vue-i18n';
import { DEFAULT_RUNTIME_BRIDGE_URL } from '../../runtime/connectionUrl';
const url = defineModel<string>('url', { required: true });
const token = defineModel<string>('token', { required: true });
defineProps<{ error: string }>();
defineEmits<{ connect: []; connectRemote: []; openSettings: [] }>();
const { t } = useI18n();
</script>

<template>
  <form class="bridge-login" data-runtime-ui data-testid="bridge-login" aria-labelledby="bridge-login-title" @submit.prevent="$emit('connect')">
    <h1 id="bridge-login-title">vis_bridge</h1>
    <p>{{ t('app.runtimeConnection.description') }}</p>
    <label for="bridge-url">{{ rt("Bridge URL") }}</label>
    <input id="bridge-url" v-model="url" class="bridge-control" name="bridgeUrl" required spellcheck="false" autocomplete="url" :placeholder="DEFAULT_RUNTIME_BRIDGE_URL" />
    <label for="bridge-token">{{ t('app.login.codexBridgeToken') }}</label>
    <input id="bridge-token" v-model="token" class="bridge-control" name="bridgeToken" type="password" autocomplete="current-password" />
    <p v-if="error" role="alert" class="bridge-error">{{ error }}</p>
    <button type="submit" class="action-button primary">{{ t('app.login.connect') }}</button>
    <div class="bridge-login-actions">
      <button type="button" class="action-button" @click="$emit('connectRemote')">{{ t('app.runtimeConnection.sshSlurm') }}</button>
      <button type="button" class="action-button" @click="$emit('openSettings')">{{ t('app.runtimeConnection.settings') }}</button>
    </div>
  </form>
</template>

<style scoped>
.bridge-login { display: grid; gap: var(--space-2); color: var(--theme-login-text, var(--theme-text-primary)); text-align: left; }
h1 { font-size: var(--type-heading); font-weight: 600; }
p, label { font-size: var(--type-sm); }
p { color: var(--theme-login-text-muted, var(--theme-text-muted)); }
input, button { border: 1px solid var(--theme-border-default); border-radius: var(--radius-control); padding: var(--space-2) var(--space-3); background: var(--theme-surface-panel); color: var(--theme-text-primary); font: inherit; }
button { cursor: pointer; }
.bridge-login-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.bridge-error { color: var(--codex-status-danger, var(--theme-text-primary)); overflow-wrap: anywhere; }
</style>
