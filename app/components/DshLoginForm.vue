<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BackendKind } from '../backends/types';

/** The slice of `useCredentials()` this form touches — nothing else, on purpose. */
export type DshLoginCredentials = {
  dshBridgeUrl: { value: string };
  dshBridgeToken: { value: string };
  backendKind: { value: BackendKind };
  saveDsh: (bridgeUrl: string, bridgeToken: string) => void;
};

const DSH_ERROR_KEYS = [
  'bridgeUrlRequired',
  'missingCredential',
  'nativeServicesDisabled',
  'launchTokenMissing',
  'versionMismatch',
] as const;

export type DshLoginError = (typeof DSH_ERROR_KEYS)[number] | '';

const props = defineProps<{
  credentials: DshLoginCredentials;
  /** DSH error key to render, or '' when the bridge reported no error. */
  error?: DshLoginError;
}>();

const { t } = useI18n();

const bridgeUrl = ref(props.credentials.dshBridgeUrl.value);
const bridgeToken = ref(props.credentials.dshBridgeToken.value);

const errorCopy = computed(() => {
  const key = props.error;
  if (!key) return '';
  return t(`app.login.dshErrors.${key}`);
});

/**
 * What to render for the current state: the caller's connection error takes
 * precedence, otherwise an unusable bridge URL explains itself (malformed
 * input must not crash, and must not silently do nothing).
 */
const visibleError = computed(() =>
  isBridgeUrlUsable(bridgeUrl.value) ? errorCopy.value : t('app.login.dshErrors.bridgeUrlRequired'),
);

/** Bridge URLs must be ws:// or wss:// — the surface a user can actually type. */
function isBridgeUrlUsable(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
}

function handleConnect() {
  // Deliberately no API-key field and no extra persistence: saveDsh is the
  // only sink (it trims the URL and persists through the shared store).
  if (!isBridgeUrlUsable(bridgeUrl.value)) return;
  props.credentials.saveDsh(bridgeUrl.value.trim(), bridgeToken.value);
}
</script>

<template>
  <template v-if="credentials.backendKind.value === 'dsh'">
    <input
      v-model="bridgeUrl"
      type="text"
      class="app-login-input"
      :placeholder="t('app.login.dshBridgeUrl')"
      name="dshBridgeUrl"
      @keydown.enter="handleConnect"
    />
    <input
      v-model="bridgeToken"
      type="password"
      class="app-login-input"
      :placeholder="t('app.login.dshBridgeToken')"
      name="dshBridgeToken"
      @keydown.enter="handleConnect"
    />
    <p class="app-login-hint">{{ t('app.login.dshBridgeHint') }}</p>
    <p v-if="visibleError" class="app-loading-message app-error-message">
      {{ visibleError }}
    </p>
    <button type="button" class="app-loading-retry app-loading-connect" @click="handleConnect">
      {{ t('app.login.connect') }}
    </button>
  </template>
</template>

<style scoped>
/* Mirrors the kimi-web block: the login form owns these classes in App.vue. */
</style>
