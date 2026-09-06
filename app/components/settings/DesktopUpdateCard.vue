<template>
  <div class="setting-row desktop-update-card" :data-testid="`desktop-update-${state.component}`">
    <div class="desktop-update-header">
      <span class="desktop-update-name">{{ t(`desktopSettings.updates.components.${state.component}`) }}</span>
      <span class="desktop-update-badges">
        <span class="desktop-badge" :class="{ 'is-error': state.phase === 'error', 'is-success': state.phase === 'up-to-date' }">
          {{ t(`desktopSettings.updates.status.${statusKeys[state.phase]}`) }}
        </span>
        <span class="desktop-badge">{{ t(`desktopSettings.updates.installKind.${state.installKind}`) }}</span>
      </span>
    </div>
    <div class="desktop-update-versions">
      <span>{{ t('desktopSettings.updates.currentVersion', { version: state.currentVersion ?? t('desktopSettings.updates.unknownVersion') }) }}</span>
      <span v-if="state.availableVersion">{{ t('desktopSettings.updates.availableVersion', { version: state.availableVersion }) }}</span>
    </div>
    <div v-if="state.phase === 'downloading' && state.progress !== null" class="desktop-progress"
      role="progressbar" :aria-label="t('desktopSettings.updates.progressLabel')"
      :aria-valuenow="Math.round(state.progress)" aria-valuemin="0" aria-valuemax="100">
      <div class="desktop-progress-track"><div class="desktop-progress-fill" :style="{ width: `${state.progress}%` }" /></div>
      <span>{{ Math.round(state.progress) }}%</span>
    </div>
    <div v-if="errorText" class="desktop-error" role="alert">{{ errorText }}</div>
    <div v-if="state.phase === 'installer-opened'" class="desktop-notice">{{ t('desktopSettings.updates.manualInstallerOpenedNotice') }}</div>
    <div v-if="state.component === 'bridge' && interruptPhases.has(state.phase)" class="desktop-notice">{{ t('desktopSettings.updates.bridgeInterruptNotice') }}</div>
    <div v-if="state.phase === 'unsupported'" class="desktop-notice">{{ t('desktopSettings.updates.unsupportedNotice') }}</div>
    <div v-else class="desktop-update-actions">
      <button type="button" class="desktop-button" :disabled="busy" @click="$emit('check')">
        {{ t(state.phase === 'checking' ? 'desktopSettings.updates.actions.checking' : 'desktopSettings.updates.actions.check') }}
      </button>
      <button v-if="state.phase === 'available'" type="button" class="desktop-button" :disabled="busy" @click="$emit('download')">
        {{ t('desktopSettings.updates.actions.download') }}
      </button>
      <button v-if="state.phase === 'downloaded'" type="button" class="desktop-button desktop-button-accent" :disabled="busy" @click="$emit('install')">
        {{ t(state.installKind === 'manual' ? 'desktopSettings.updates.actions.openInstaller' : 'desktopSettings.updates.actions.installRestart') }}
      </button>
      <button v-if="state.phase === 'error'" type="button" class="desktop-button" :disabled="busy" @click="$emit('check')">
        {{ t('desktopSettings.updates.actions.retry') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DesktopUpdateState } from '../../types/desktop';

const props = defineProps<{ readonly state: DesktopUpdateState; readonly busy: boolean; readonly actionError: string | null }>();
defineEmits<{ check: []; download: []; install: [] }>();
const { t } = useI18n();
const errorText = computed(() => props.actionError ?? (props.state.phase === 'error' ? props.state.error : null));
const statusKeys: Record<DesktopUpdateState['phase'], string> = {
  idle: 'idle', checking: 'checking', available: 'available', downloading: 'downloading', downloaded: 'downloaded',
  installing: 'installing', 'installer-opened': 'installerOpened', 'up-to-date': 'upToDate', error: 'error', unsupported: 'unsupported',
};
const interruptPhases: ReadonlySet<DesktopUpdateState['phase']> = new Set(['downloading', 'downloaded', 'installing', 'installer-opened']);
</script>
