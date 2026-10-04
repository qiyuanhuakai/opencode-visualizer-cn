<script setup lang="ts">
defineProps<{ active?: boolean; busy?: boolean; disabled?: boolean }>();
</script>

<template>
  <button type="button" class="composer-toggle" :class="{ 'is-active': active }" :aria-pressed="active === true" :aria-busy="busy === true" :disabled="disabled || busy">
    <slot />
  </button>
</template>

<style scoped>
.composer-toggle {
  display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px;
  height: 28px; padding: 4px 8px; border: 1px solid transparent;
  border-radius: var(--radius-control, 8px); background: transparent;
  color: var(--theme-input-text-muted, var(--theme-text-muted));
  font-family: inherit; font-size: var(--type-sm, 12px); white-space: nowrap; cursor: pointer;
}
.composer-toggle.is-active { color: var(--theme-input-accent, var(--theme-border-accent)); }
.composer-toggle:hover:not(:disabled) { background: var(--theme-input-surface-hover, var(--theme-surface-panel-hover)); }
.composer-toggle:focus-visible { outline: 2px solid var(--theme-input-accent, var(--theme-border-accent)); outline-offset: 2px; }
.composer-toggle:disabled { opacity: .5; cursor: not-allowed; }
</style>
