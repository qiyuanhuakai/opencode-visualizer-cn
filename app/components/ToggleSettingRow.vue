<template>
  <SettingRow
    :label="label"
    :description="description"
    :label-id="labelId"
    :description-id="descriptionId"
  >
    <label class="toggle-switch" :title="title">
      <input
        v-model="model"
        type="checkbox"
        class="toggle-input"
        :disabled="disabled"
        :aria-labelledby="ariaLabelledby"
        :aria-describedby="ariaDescribedby"
      />
      <span class="toggle-track" />
    </label>
  </SettingRow>
</template>

<script setup lang="ts">
import SettingRow from './SettingRow.vue';

const model = defineModel<boolean>();

defineProps<{
  label: string;
  description: string;
  labelId?: string;
  descriptionId?: string;
  title?: string;
  disabled?: boolean;
  ariaLabelledby?: string;
  ariaDescribedby?: string;
}>();
</script>

<style scoped>
.toggle-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-input:focus-visible + .toggle-track {
  outline: 2px solid var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6));
  outline-offset: 2px;
}

.toggle-track {
  width: 36px;
  height: 20px;
  background: var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--theme-modal-text, var(--theme-text-muted, #94a3b8));
  transition:
    transform 0.2s,
    background 0.2s;
}

.toggle-input:checked + .toggle-track {
  background: var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6));
}

.toggle-input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: var(--theme-modal-active-text, var(--theme-text-inverse, #fff));
}
</style>
