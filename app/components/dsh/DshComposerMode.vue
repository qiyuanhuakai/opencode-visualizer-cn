<template>
  <ComposerDropdown :menu-width="480" :model-value="current" :disabled="disabled || locked || !options.length" :title="locked ? t('inputPanel.dshPresetLocked') : options.find(option => option.id === current)?.label ?? current" button-class="dsh-mode-trigger" popup-class="input-dropdown-popup dsh-mode-popup" auto-close @select="select">
    <template #value>{{ options.find(option => option.id === current)?.label ?? current }}</template>
    <div class="dropdown-list">
      <DropdownItem v-for="option in options" :key="option.id" :value="option.id" :active="option.id === current">
        <AgentChoice :name="option.label" :description="option.description" :selected="option.id === current" />
      </DropdownItem>
    </div>
  </ComposerDropdown>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import ComposerDropdown from '../composer/ComposerDropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import AgentChoice from '../AgentChoice.vue';
const props = defineProps<{ current: string; options: Array<{ id: string; label: string; description?: string }>; disabled?: boolean; locked?: boolean }>();
const emit = defineEmits<{ select: [value: string] }>();
const { t } = useI18n();
function select(value: unknown) {
  if (typeof value === 'string' && !props.disabled && !props.locked && props.options.some(option => option.id === value)) emit('select', value);
}
</script>
<style scoped>
.dropdown-list { display: flex; flex-direction: column; gap: var(--space-1); }
</style>
