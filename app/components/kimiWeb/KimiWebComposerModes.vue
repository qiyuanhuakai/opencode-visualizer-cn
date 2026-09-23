<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { KimiWebPermissionMode } from '../../backends/kimiWeb/sessionModes';

type ModeField = 'planMode' | 'swarmMode' | 'towerMode';
const props = defineProps<{
  permissionMode?: KimiWebPermissionMode;
  planMode?: boolean;
  swarmMode?: boolean;
  towerMode?: boolean;
  towerEnabled: boolean;
  pendingField?: 'permissionMode' | ModeField;
  confidence: 'unknown' | 'accepted-locally' | 'confirmed' | 'stale';
  error?: { readonly kind: 'rejected'; readonly message: string } | { readonly kind: 'uncertain' };
  disabled?: boolean;
}>();
const emit = defineEmits<{
  'toggle-plan': [value: boolean];
  'toggle-swarm': [value: boolean];
  'toggle-tower': [value: boolean];
  retry: [];
}>();
const { t } = useI18n();
const specs = [
  { field: 'planMode', label: 'plan', description: 'kimiWeb.composer.planDescription' },
  { field: 'swarmMode', label: 'swarm', description: 'kimiWeb.composer.swarmDescription' },
  { field: 'towerMode', label: 'tower', description: 'kimiWeb.composer.towerDescription' },
] as const;
const modes = computed(() => specs.map((spec) => ({
  ...spec,
  active: props[spec.field] === true,
  disabled: Boolean(props.disabled) || props.pendingField === spec.field || (spec.field === 'towerMode' && !props.towerEnabled),
  description: t(spec.field === 'towerMode' && !props.towerEnabled ? 'kimiWeb.composer.towerDisabled' : spec.description),
  state: props.pendingField === spec.field ? t('kimiWeb.composer.saving')
    : props[spec.field] === undefined ? t('kimiWeb.composer.unconfirmed') : '',
})));
const label = computed(() => t('codexPanel.collaborationModeName'));
const errorText = computed(() => props.error?.kind === 'rejected' ? props.error.message : t('kimiWeb.composer.saveUncertain'));
function select(field: unknown) {
  const mode = modes.value.find((item) => item.field === field);
  if (!mode || mode.disabled) return;
  switch (field) {
    case 'planMode': emit('toggle-plan', !props.planMode); return;
    case 'swarmMode': emit('toggle-swarm', !props.swarmMode); return;
    case 'towerMode': emit('toggle-tower', !props.towerMode); return;
  }
}
</script>

<template>
  <div class="kimi-web-composer-modes">
    <Dropdown
      :label="label"
      :disabled="disabled"
      :auto-close="false"
      menu-icon="lucide:chevron-up"
      button-class="kimi-web-mode-trigger"
      :popup-style="{ top: 'auto', bottom: 'anchor(top)', left: 'clamp(8px, anchor(left), calc(100vw - 248px))', right: 'auto', marginTop: '0', marginBottom: '6px', minWidth: '240px' }"
      @select="select"
    >
      <DropdownItem v-for="mode in modes" :key="mode.field" :value="mode.field" :active="mode.active" :disabled="mode.disabled" :title="mode.description">
        <div class="kimi-web-mode-row">
          <div class="kimi-web-mode-heading">
            <span class="kimi-web-mode-label">{{ mode.label }}</span>
            <span v-if="mode.state" class="kimi-web-mode-state">{{ mode.state }}</span>
            <Icon v-if="mode.active" class="kimi-web-mode-check" icon="lucide:check" :width="12" :height="12" aria-hidden="true" />
          </div>
          <span class="kimi-web-mode-description">{{ mode.description }}</span>
        </div>
      </DropdownItem>
    </Dropdown>
    <div v-if="error || confidence === 'stale'" class="kimi-web-mode-status">
      <span v-if="error" class="kimi-web-mode-error" role="alert">{{ errorText }}</span>
      <span v-if="confidence === 'stale'" role="status">{{ t('kimiWeb.composer.stale') }}</span>
      <button v-if="error" type="button" class="kimi-web-mode-retry" @click="emit('retry')">{{ t('kimiWeb.composer.retry') }}</button>
    </div>
  </div>
</template>

<style scoped>
.kimi-web-composer-modes { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 0; }
.kimi-web-mode-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.kimi-web-mode-heading { display: flex; align-items: center; gap: var(--space-2); }
.kimi-web-mode-label { font-size: var(--type-sm); }
.kimi-web-mode-check { margin-left: auto; color: var(--theme-input-accent); }
.kimi-web-mode-description { font-size: var(--type-caption); color: var(--theme-text-muted); white-space: normal; }
.kimi-web-mode-state { font-size: var(--type-caption); color: var(--theme-text-muted); }
.kimi-web-mode-status { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--type-caption); }
.kimi-web-mode-error { color: var(--theme-status-error); }
.kimi-web-mode-retry { padding: 0 6px; height: 20px; border: 1px solid var(--theme-input-border); border-radius: 6px; background: transparent; color: var(--theme-input-text-muted); font-family: inherit; cursor: pointer; }
.kimi-web-mode-retry:focus-visible { outline: 2px solid var(--theme-input-accent); outline-offset: 2px; }
:deep(.kimi-web-mode-trigger) { height: 28px; padding: 4px 8px; border-color: transparent; background: transparent; color: var(--theme-input-text-muted); font-size: var(--type-sm); }
</style>
