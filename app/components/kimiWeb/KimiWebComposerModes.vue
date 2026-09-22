<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { KimiWebPermissionMode } from '../../backends/kimiWeb/sessionModes';

type KimiWebModeField = 'planMode' | 'swarmMode' | 'towerMode';

type KimiWebComposerModeError =
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'uncertain' };

type KimiWebModeSwitchState = 'on' | 'off' | 'unconfirmed';

type KimiWebModeSwitch = {
  readonly field: KimiWebModeField;
  readonly label: string;
  readonly state: KimiWebModeSwitchState;
  readonly ariaChecked: boolean | 'mixed';
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly title: string;
  readonly stateText: string;
  readonly toggle: () => void;
};

const props = defineProps<{
  permissionMode?: KimiWebPermissionMode;
  planMode?: boolean;
  swarmMode?: boolean;
  towerMode?: boolean;
  towerEnabled: boolean;
  pendingField?: 'permissionMode' | KimiWebModeField;
  confidence: 'unknown' | 'accepted-locally' | 'confirmed' | 'stale';
  error?: KimiWebComposerModeError;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'toggle-plan': [value: boolean];
  'toggle-swarm': [value: boolean];
  'toggle-tower': [value: boolean];
  retry: [];
}>();

const { t } = useI18n();

const MODE_SWITCH_SPECS: Readonly<
  Record<
    KimiWebModeField,
    {
      readonly labelKey: string;
      readonly descriptionKey: string;
      readonly toggle: (value: boolean) => void;
    }
  >
> = {
  planMode: {
    labelKey: 'kimiWeb.composer.plan',
    descriptionKey: 'kimiWeb.composer.planDescription',
    toggle: (value) => emit('toggle-plan', value),
  },
  swarmMode: {
    labelKey: 'kimiWeb.composer.swarm',
    descriptionKey: 'kimiWeb.composer.swarmDescription',
    toggle: (value) => emit('toggle-swarm', value),
  },
  towerMode: {
    labelKey: 'kimiWeb.composer.tower',
    descriptionKey: 'kimiWeb.composer.towerDescription',
    toggle: (value) => emit('toggle-tower', value),
  },
};

function describeSwitch(field: KimiWebModeField): KimiWebModeSwitch {
  const spec = MODE_SWITCH_SPECS[field];
  const value = props[field];
  const pending = props.pendingField === field;
  // tower_mode is rejected server-side unless the tower experiment is enabled.
  const gated = field === 'towerMode' && !props.towerEnabled;
  const state: KimiWebModeSwitchState =
    value === undefined ? 'unconfirmed' : value ? 'on' : 'off';
  return {
    field,
    label: t(spec.labelKey),
    state,
    ariaChecked: value === undefined ? 'mixed' : value,
    pending,
    disabled: Boolean(props.disabled) || pending || gated,
    title: gated ? t('kimiWeb.composer.towerDisabled') : t(spec.descriptionKey),
    stateText: pending
      ? t('kimiWeb.composer.saving')
      : state === 'unconfirmed'
        ? t('kimiWeb.composer.unconfirmed')
        : '',
    toggle: () => spec.toggle(!(value ?? false)),
  };
}

const modeSwitches = computed<KimiWebModeSwitch[]>(() =>
  (['planMode', 'swarmMode', 'towerMode'] as const).map(describeSwitch),
);

const errorText = computed(() => {
  if (!props.error) return '';
  return props.error.kind === 'rejected'
    ? props.error.message
    : t('kimiWeb.composer.saveUncertain');
});

const isStale = computed(() => props.confidence === 'stale');
</script>

<template>
  <div class="kimi-web-composer-modes">
    <button
      v-for="mode in modeSwitches"
      :key="mode.field"
      type="button"
      class="kimi-web-mode-switch"
      :class="`is-${mode.state}`"
      role="switch"
      :aria-checked="mode.ariaChecked"
      :aria-busy="mode.pending"
      :data-state="mode.state"
      :disabled="mode.disabled"
      :title="mode.title"
      @click="mode.toggle"
    >
      <span class="kimi-web-mode-indicator" aria-hidden="true" />
      <span class="kimi-web-mode-label">{{ mode.label }}</span>
      <span v-if="mode.stateText" class="kimi-web-mode-state">{{ mode.stateText }}</span>
    </button>
    <div v-if="error || isStale" class="kimi-web-mode-status">
      <span v-if="error" class="kimi-web-mode-error" role="alert">{{ errorText }}</span>
      <span v-if="isStale" class="kimi-web-mode-stale" role="status">{{
        $t('kimiWeb.composer.stale')
      }}</span>
      <button
        v-if="error"
        type="button"
        class="kimi-web-mode-retry"
        @click="emit('retry')"
      >
        {{ $t('kimiWeb.composer.retry') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.kimi-web-composer-modes {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.kimi-web-mode-switch {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--theme-input-text-muted, var(--theme-text-muted));
  font-family: inherit;
  font-size: 12px;
  white-space: nowrap;
}

.kimi-web-mode-switch.is-on {
  color: var(--theme-input-accent, var(--theme-border-accent));
}

.kimi-web-mode-switch.is-unconfirmed {
  border-style: dashed;
  border-color: var(--theme-input-border, var(--theme-border-default));
}

.kimi-web-mode-switch:hover:not(:disabled) {
  background: var(--theme-surface-panel-hover);
}

.kimi-web-mode-switch:focus-visible {
  outline: 2px solid var(--theme-input-accent, var(--theme-border-accent));
  outline-offset: 2px;
}

.kimi-web-mode-switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.kimi-web-mode-indicator {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border: 1px solid currentColor;
  border-radius: 2px;
}

.kimi-web-mode-switch.is-on .kimi-web-mode-indicator {
  background: currentColor;
}

.kimi-web-mode-switch.is-unconfirmed .kimi-web-mode-indicator {
  border-style: dashed;
}

.kimi-web-mode-state {
  font-size: 10px;
}

.kimi-web-mode-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
}

.kimi-web-mode-error {
  color: var(--theme-status-error, var(--theme-text-danger, #f87171));
  font-size: 11px;
}

.kimi-web-mode-stale {
  color: var(--theme-input-text-muted, var(--theme-text-muted));
  font-size: 11px;
}

.kimi-web-mode-retry {
  flex: 0 0 auto;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--theme-input-border, var(--theme-border-default));
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: var(--theme-input-text-muted, var(--theme-text-muted));
  font-family: inherit;
  font-size: 11px;
  white-space: nowrap;
}

.kimi-web-mode-retry:hover:not(:disabled) {
  background: var(--theme-surface-panel-hover);
}

.kimi-web-mode-retry:focus-visible {
  outline: 2px solid var(--theme-input-accent, var(--theme-border-accent));
  outline-offset: 2px;
}
</style>
