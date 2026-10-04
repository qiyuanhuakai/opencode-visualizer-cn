<script setup lang="ts" generic="T">
import { computed, type ClassValue, type StyleValue } from 'vue';
import Dropdown from '../Dropdown.vue';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  controlRole?: 'primary' | 'mode' | 'settings';
  menuWidth?: number;
  modelValue?: T;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  menuIcon?: string;
  buttonClass?: ClassValue;
  buttonStyle?: StyleValue;
  popupClass?: ClassValue;
  popupStyle?: StyleValue;
  autoClose?: boolean;
  disabled?: boolean;
  open?: boolean;
  autoFocus?: boolean;
  autoHighlight?: boolean;
  menuId?: string;
  menuRole?: 'listbox' | 'dialog';
  search?: (query: string, signal: AbortSignal) => Promise<unknown[]>;
  searchDebounce?: number;
}>(), { controlRole: 'mode', menuWidth: 240, autoFocus: true, autoHighlight: true, open: undefined });
const emit = defineEmits<{
  select: [T];
  'update:modelValue': [T];
  'update:open': [boolean];
  'highlight-change': [string | null];
}>();
const popupGeometry = computed(() => ({
  top: 'auto', bottom: 'anchor(top)',
  left: `clamp(8px, anchor(left), calc(100vw - min(${props.menuWidth}px, 100vw - 16px) - 8px))`,
  right: 'auto', width: `min(${props.menuWidth}px, calc(100vw - 16px))`,
  marginTop: '0', marginBottom: '6px',
}));
</script>

<template>
  <Dropdown
    v-bind="{ ...props, ...$attrs }"
    class="composer-dropdown"
    :class="`composer-dropdown--${controlRole}`"
    :menu-icon="menuIcon ?? 'lucide:chevron-up'"
    :button-class="['composer-dropdown-trigger', buttonClass]"
    :popup-class="['composer-dropdown-menu', popupClass]"
    :popup-style="[popupGeometry, popupStyle]"
    @select="emit('select', $event)"
    @update:model-value="emit('update:modelValue', $event)"
    @update:open="emit('update:open', $event)"
    @highlight-change="emit('highlight-change', $event)"
  >
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </Dropdown>
</template>

<style scoped>
.composer-dropdown { flex: 0 1 auto; min-width: 0; }
.composer-dropdown :deep(.composer-dropdown-trigger) {
  height: 28px; padding: 4px 8px; gap: 4px;
  border-color: transparent; border-radius: var(--radius-control, 8px);
  background: transparent; color: var(--theme-input-text-muted, var(--theme-text-muted));
  font-family: inherit; font-size: var(--type-sm, 12px);
}
.composer-dropdown--primary :deep(.composer-dropdown-trigger) { color: var(--theme-input-text, var(--theme-text-primary)); }
.composer-dropdown :deep(.composer-dropdown-trigger:hover:not(:disabled)) { background: var(--theme-input-surface-hover, var(--theme-surface-panel-hover)); }
.composer-dropdown :deep(.composer-dropdown-trigger:focus-visible) { outline: 2px solid var(--theme-input-accent, var(--theme-border-accent)); outline-offset: 2px; }
.composer-dropdown--settings { flex: 0 0 28px; width: 28px; min-width: 28px; }
.composer-dropdown--settings :deep(.composer-dropdown-trigger) { justify-content: center; padding: 4px; }
.composer-dropdown--settings :deep(.ui-dropdown-icon) { display: none; }
.composer-dropdown--settings :deep(.composer-dropdown-menu) { padding: 0; }
.composer-dropdown :deep(.composer-dropdown-menu) {
  --ui-dropdown-bg: var(--theme-input-bg, var(--theme-surface-panel));
  --ui-dropdown-border: var(--theme-input-border, var(--theme-border-default));
  --ui-dropdown-text: var(--theme-input-text, var(--theme-text-primary));
  --ui-dropdown-text-muted: var(--theme-input-text-muted, var(--theme-text-muted));
  --ui-dropdown-accent: var(--theme-input-accent, var(--theme-border-accent));
  --ui-dropdown-active-bg: var(--theme-input-active-bg, var(--theme-surface-panel-active));
  --ui-dropdown-hover-bg: var(--theme-input-control-bg, var(--theme-surface-panel-hover));
  max-height: min(360px, calc(100dvh - 64px));
  max-width: calc(100vw - 16px);
  overflow: auto;
  position-try-fallbacks: none;
}
</style>
