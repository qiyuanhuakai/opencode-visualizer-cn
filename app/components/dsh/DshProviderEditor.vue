<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
defineProps<{ title: string }>();
const emit = defineEmits<{ (event: 'back'): void }>();
const { t } = useI18n();
</script>
<template>
  <section class="kimi-web-provider-manager dsh-provider-editor" :aria-label="title">
    <header class="kimi-web-provider-toolbar">
      <button type="button" class="kimi-web-provider-action" data-provider-back @click="emit('back')"><Icon icon="lucide:arrow-left" :width="14" :height="14" aria-hidden="true" />{{ t('kimiWeb.providers.cancel') }}</button>
      <span class="kimi-web-provider-title">{{ title }}</span>
    </header>
    <slot />
  </section>
</template>
<style scoped>
.kimi-web-provider-manager { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding-right: var(--space-1); }
.kimi-web-provider-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.kimi-web-provider-title { font-size: var(--type-heading); font-weight: 700; color: var(--theme-modal-text, var(--theme-text-primary)); }
.kimi-web-provider-action, :deep(button) { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--theme-action-button-border, var(--theme-modal-border)); border-radius: var(--radius-control); background: var(--theme-action-button-bg, var(--theme-modal-control-bg)); color: var(--theme-action-button-text, var(--theme-modal-text)); font-size: var(--type-sm); font-family: inherit; min-height: 28px; padding: 4px 8px; cursor: pointer; }
:deep(.kimi-web-provider-form-actions) { display: flex; flex-wrap: wrap; gap: var(--space-2); }
:deep(button.is-primary) { border-color: var(--theme-action-button-accent-border, var(--theme-modal-accent)); background: var(--theme-action-button-accent-bg, color-mix(in srgb, var(--theme-modal-accent) 18%, transparent)); color: var(--theme-action-button-accent-text, var(--theme-modal-active-text)); }
:deep(button:disabled) { opacity: .5; cursor: default; }
:deep(form) { display: flex; flex-direction: column; gap: var(--space-3); padding: 12px; border: 1px solid var(--theme-card-border, var(--theme-modal-border)); border-radius: 12px; background: var(--theme-card-bg, var(--theme-modal-control-bg)); }
:deep(fieldset) { min-width: 0; padding: 0; margin: 0; border: 0; display: grid; gap: var(--space-3); }
:deep(label) { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: var(--theme-modal-text-muted, var(--theme-text-muted)); font-size: var(--type-sm); }
:deep(input:not([type='radio']):not([type='checkbox'])), :deep(textarea) { box-sizing: border-box; min-width: 0; width: 100%; border: 1px solid var(--theme-modal-border); border-radius: 9px; background: var(--theme-modal-control-bg); color: var(--theme-modal-text); font: inherit; padding: 8px 12px; }
:deep(textarea) { resize: vertical; }
:deep(.ui-dropdown-button) { min-height: 38px; border-radius: 9px; padding: 0 12px; }
:deep(:focus-visible) { outline: 2px solid var(--theme-modal-accent); outline-offset: 2px; }
:deep(p) { margin: 0; overflow-wrap: anywhere; }
:deep([role='alert']) { color: var(--theme-text-danger); }
</style>
