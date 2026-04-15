<template>
  <div class="ui-dropdown-search" @click.stop>
    <slot name="before" />
    <input
      autofocus
      :value="modelValue"
      type="text"
      :placeholder="placeholder"
      class="ui-dropdown-search-input"
      @click.stop
      @input="onInput"
      @keydown="onKeydown"
    />
    <slot name="after" />
  </div>
</template>

<script lang="ts" setup>
import { inject } from 'vue';
import type { DropdownAPI } from '../Dropdown.vue';

defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const api = inject<DropdownAPI>('x-selectable');

function onInput(e: Event) {
  const value = (e.target as HTMLInputElement).value;
  emit('update:modelValue', value);
  api?.updateSearch(value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    api?.moveHighlight('down');
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    api?.moveHighlight('up');
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    api?.selectHighlighted();
    return;
  }
  // Escape: let it bubble to Dropdown.vue's onKeyDown handler
}
</script>

<style scoped>
.ui-dropdown-search {
  display: flex;
  align-items: center;
}

.ui-dropdown-search-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--ui-dropdown-border, var(--theme-dropdown-border, var(--theme-border-default, #334155)));
  border-radius: 5px;
  padding: 4px 10px;
  background: var(--ui-dropdown-control-bg, var(--theme-dropdown-control-bg, var(--theme-surface-panel-muted, rgba(30, 41, 59, 0.55))));
  color: var(--ui-dropdown-text, var(--theme-dropdown-text, var(--theme-text-primary, #e2e8f0)));
  outline: none;
  box-sizing: border-box;
  font-size: 12px;
}

.ui-dropdown-search-input:focus {
  border-color: var(--ui-dropdown-accent, var(--theme-dropdown-accent, var(--theme-border-accent, #60a5fa)));
}

.ui-dropdown-search-input::placeholder {
  color: var(--ui-dropdown-text-muted, var(--theme-dropdown-text-muted, var(--theme-text-muted, #64748b)));
  opacity: 1;
}
</style>
