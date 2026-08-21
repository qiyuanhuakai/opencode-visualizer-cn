<template>
  <component :is="tag" class="setting-row">
    <div class="setting-info">
      <div :id="labelId" class="setting-label">{{ label }}</div>
      <div :id="descriptionId" class="setting-description">{{ description }}</div>
    </div>
    <slot />
  </component>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    description: string;
    tag?: 'div' | 'button';
    labelId?: string;
    descriptionId?: string;
  }>(),
  {
    tag: 'div',
  },
);
</script>

<style scoped>
.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.setting-description {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
}
</style>
