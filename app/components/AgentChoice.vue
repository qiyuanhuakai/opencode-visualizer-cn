<template>
  <div class="agent-choice" :class="{ 'is-current': selected }">
    <div class="agent-choice-heading">
      <span class="agent-choice-name agent-dropdown-name" :style="color ? { color } : undefined">{{ name }}</span>
      <span v-if="selected" class="agent-choice-mark agent-dropdown-current-mark" aria-hidden="true">✓</span>
    </div>
    <span v-if="description" class="agent-choice-description agent-dropdown-description" :title="description">{{ description }}</span>
  </div>
</template>
<script setup lang="ts">
defineProps<{ name: string; description?: string; selected?: boolean; color?: string }>();
</script>
<style scoped>
.agent-choice { display: flex; flex-direction: column; gap: 2px; width: 100%; min-width: 0; }
.agent-choice-heading { display: flex; align-items: center; gap: var(--space-2); }
.agent-choice-name { flex: 1; min-width: 0; font-size: var(--type-sm); line-height: 1.2; color: var(--theme-input-text); }
.agent-choice-description { font-size: var(--type-caption); line-height: 1.3; color: var(--theme-input-text-muted); white-space: normal; overflow-wrap: anywhere; }
.agent-choice-mark { flex: 0 0 auto; color: var(--theme-input-text-muted); }
</style>
