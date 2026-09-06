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
        :state="state.updates[component]" :busy="isComponentBusy(component)" :action-error="actionError(component)"
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
import { useI18n } from 'vue-i18n';
import ToggleSettingRow from '../ToggleSettingRow.vue';
import DesktopUpdateCard from './DesktopUpdateCard.vue';
import { useDesktopSettings } from '../../composables/useDesktopSettings';

const { t } = useI18n();
const { available, state, loading, loadError, savingPreferences, preferenceError,
  isComponentBusy, actionError, refresh, setPreference, checkComponent, downloadComponent, installComponent,
} = useDesktopSettings();
const components = ['app', 'bridge'] as const;
const updatePreferences = ['autoCheckUpdates', 'autoDownloadUpdates'] as const;
const trayPreferences = ['minimizeToTray', 'closeToTray'] as const;
const notificationPreferences = ['idleNotifications', 'notificationSound'] as const;
</script>

<style src="./desktop-settings.css"></style>
