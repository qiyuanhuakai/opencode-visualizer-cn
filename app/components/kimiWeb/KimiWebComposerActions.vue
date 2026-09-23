<template>
  <Dropdown class="kimi-composer-actions" :disabled="disabled" :label="t('common.more')" :auto-close="true" menu-icon="lucide:chevron-up" :popup-style="{ top: 'auto', bottom: 'anchor(top)', marginTop: '0', marginBottom: '6px', width: 'max-content', minWidth: '180px' }" @select="select">
    <template #label><span class="actions-label"><Icon icon="lucide:ellipsis" :width="14" :height="14" aria-hidden="true" />{{ t('common.more') }}</span></template>
    <DropdownItem value="agents" :disabled="disabled"><Icon icon="lucide:users" :width="14" :height="14" />{{ t('topPanel.sessionActions.agents') }}</DropdownItem>
    <DropdownItem value="compact" :disabled="disabled || busy"><Icon icon="lucide:minimize-2" :width="14" :height="14" />{{ t('topPanel.sessionActions.compact') }}</DropdownItem>
    <DropdownItem value="fork" :disabled="disabled || busy"><Icon icon="lucide:git-fork" :width="14" :height="14" />{{ t('topPanel.sessionActions.fork') }}</DropdownItem>
  </Dropdown>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
const props = defineProps<{ disabled?: boolean; busy?: boolean }>();
const emit = defineEmits<{ agents: []; compact: []; fork: [] }>();
const { t } = useI18n();
function select(value: unknown) {
  if (props.disabled) return;
  switch (value) {
    case 'agents': emit('agents'); return;
    case 'compact': if (!props.busy) emit('compact'); return;
    case 'fork': if (!props.busy) emit('fork'); return;
  }
}
</script>

<style scoped>
.kimi-composer-actions { flex: 0 0 auto; }
.actions-label { display: inline-flex; align-items: center; gap: var(--space-1); }
.kimi-composer-actions :deep(.ui-dropdown-button) { height: 28px; border-color: transparent; background: transparent; padding: 4px 8px; font-size: var(--type-sm); }
.kimi-composer-actions :deep(.ui-dropdown-item-content) { display: flex; align-items: center; gap: var(--space-2); }
</style>
