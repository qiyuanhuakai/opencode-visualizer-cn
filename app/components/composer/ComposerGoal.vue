<script setup lang="ts">
import { Icon } from '@iconify/vue';
defineProps<{ label: string; summary: string; ariaLabel?: string; error?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <button type="button" class="composer-goal" :disabled="disabled" :title="ariaLabel ?? `${label}: ${summary}`" :aria-label="ariaLabel ?? `${label}: ${summary}`" @click="emit('open')">
    <span class="goal-label">{{ label }}</span>
    <span class="goal-summary summary" :role="error ? 'alert' : undefined">{{ summary }}</span>
    <Icon icon="lucide:pencil" :width="14" :height="14" aria-hidden="true" />
  </button>
</template>

<style scoped>
.composer-goal {
  display: flex; flex: 1 1 120px; min-width: 120px; max-width: none; align-items: center; gap: 8px;
  height: 28px; overflow: hidden; padding: 4px 8px; border: 1px solid transparent;
  border-radius: var(--radius-control, 8px); background: transparent;
  color: var(--theme-input-text, var(--theme-text-primary));
  font-family: inherit; font-size: var(--type-sm, 12px); text-align: left; cursor: pointer;
}
.goal-label, .composer-goal :deep(svg) { flex: 0 0 auto; }
.goal-label { color: var(--theme-input-text-muted, var(--theme-text-muted)); }
.goal-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-goal:hover:not(:disabled) { background: var(--theme-input-surface-hover, var(--theme-surface-panel-hover)); }
.composer-goal:focus-visible { outline: 2px solid var(--theme-input-accent, var(--theme-border-accent)); outline-offset: 2px; }
.composer-goal:disabled { opacity: .5; cursor: not-allowed; }
</style>
