<template>
  <div v-if="available" class="desktop-settings-page">
    <div class="desktop-page-description">{{ t('desktopSettings.pageDescription') }}</div>
    <div v-if="loading && !state" class="desktop-inline-status" role="status" data-testid="desktop-settings-loading">
      {{ t('desktopSettings.loading') }}
    </div>
    <div v-else-if="loadError && !state" class="desktop-inline-status desktop-error" role="alert" data-testid="desktop-settings-error">
      <span>{{ t('desktopSettings.loadError') }}: {{ loadError }}</span>
      <button type="button" class="desktop-button" @click="refresh">{{ t('desktopSettings.retry') }}</button>
    </div>
    <template v-else-if="state">
      <div class="desktop-section-title">{{ t('desktopSettings.sections.updates') }}</div>
      <DesktopUpdateCard
        v-for="component in components" :key="component"
        :state="state.updates[component]" :busy="isCardBusy(component)" :action-error="actionError(component)"
        :connected-bridge="component === 'bridge' ? connectedBridge : null"
        @check="checkComponent(component)" @download="downloadComponent(component)" @install="installComponent(component)"
      />
      <ToggleSettingRow v-for="key in updatePreferences" :key="key"
        :label-id="`desktop-label-${key}`" :aria-labelledby="`desktop-label-${key}`"
        :model-value="state.preferences[key]" :label="t(`desktopSettings.preferences.${key}.label`)"
        :description="t(`desktopSettings.preferences.${key}.description`)" :disabled="savingPreferences"
        :data-testid="`desktop-toggle-${key}`" @update:model-value="setPreference(key, $event === true)"
      />
      <div class="desktop-section-title">{{ t('desktopSettings.sections.tray') }}</div>
      <div v-if="!state.trayAvailable" class="desktop-hint" data-testid="desktop-tray-unavailable">
        {{ t('desktopSettings.preferences.trayUnavailable') }}
      </div>
      <ToggleSettingRow v-for="key in trayPreferences" :key="key"
        :label-id="`desktop-label-${key}`" :aria-labelledby="`desktop-label-${key}`"
        :model-value="state.preferences[key]" :label="t(`desktopSettings.preferences.${key}.label`)"
        :description="t(`desktopSettings.preferences.${key}.description`)" :disabled="savingPreferences || !state.trayAvailable"
        :data-testid="`desktop-toggle-${key}`" @update:model-value="setPreference(key, $event === true)"
      />
      <div class="desktop-section-title">{{ t('desktopSettings.sections.notifications') }}</div>
      <div v-if="!state.nativeNotificationsAvailable" class="desktop-hint" data-testid="desktop-notifications-unavailable">
        {{ t('desktopSettings.preferences.notificationsUnavailable') }}
      </div>
      <ToggleSettingRow v-for="key in notificationPreferences" :key="key"
        :label-id="`desktop-label-${key}`" :aria-labelledby="`desktop-label-${key}`"
        :model-value="state.preferences[key]" :label="t(`desktopSettings.preferences.${key}.label`)"
        :description="t(`desktopSettings.preferences.${key}.description`)" :disabled="savingPreferences"
        :data-testid="`desktop-toggle-${key}`" @update:model-value="setPreference(key, $event === true)"
      />
      <div v-if="preferenceError" class="desktop-error" role="alert">{{ preferenceError }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ToggleSettingRow from '../ToggleSettingRow.vue';
import DesktopUpdateCard from './DesktopUpdateCard.vue';
import { useDesktopSettings } from '../../composables/useDesktopSettings';
import type { ConnectedBridgeVersion } from '../../composables/useConnectedBridgeVersion';
import type { DesktopComponent } from '../../types/desktop';

const props = withDefaults(
  defineProps<{
    readonly connectedBridgeState?: ConnectedBridgeVersion | null;
    readonly refreshBridgeVersion?: () => Promise<boolean>;
  }>(),
  { connectedBridgeState: null, refreshBridgeVersion: undefined },
);
const { t } = useI18n();
const connectedBridge = computed<ConnectedBridgeVersion>(
  () => props.connectedBridgeState ?? { status: 'disconnected' },
);
const bridgeHealthBusy = ref(false);
const { available, state, loading, loadError, savingPreferences, preferenceError,
  isComponentBusy, actionError, refresh, setPreference, downloadComponent, installComponent,
  checkComponent: checkComponentNative,
} = useDesktopSettings();
const components = ['app', 'bridge'] as const;
const updatePreferences = ['autoCheckUpdates', 'autoDownloadUpdates'] as const;
const trayPreferences = ['minimizeToTray', 'closeToTray'] as const;
const notificationPreferences = ['idleNotifications', 'notificationSound'] as const;

async function checkComponent(component: DesktopComponent) {
  const refreshBridge = props.refreshBridgeVersion;
  if (component === 'bridge' && refreshBridge) {
    if (bridgeHealthBusy.value) return;
    bridgeHealthBusy.value = true;
    let accepted = false;
    try {
      accepted = await refreshBridge();
    } finally {
      bridgeHealthBusy.value = false;
    }
    if (!accepted) return;
  }
  await checkComponentNative(component);
}

function isCardBusy(component: DesktopComponent) {
  return isComponentBusy(component) || (component === 'bridge' && bridgeHealthBusy.value);
}
</script>

<style src="./desktop-settings.css"></style>
