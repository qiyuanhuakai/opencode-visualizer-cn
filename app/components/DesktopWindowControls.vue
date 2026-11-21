<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { onMounted, onUnmounted, ref } from 'vue';

type Controls = NonNullable<NonNullable<Window['electronAPI']>['windowControls']>;
const props = defineProps<{ controls: Controls }>();

const maximized = ref(false);
let unsubscribe: (() => void) | undefined;
onMounted(async () => {
  let updated = false;
  unsubscribe = props.controls.onMaximized((value) => {
    updated = true;
    maximized.value = value;
  });
  const initial = await props.controls.isMaximized();
  if (!updated) maximized.value = initial;
});
onUnmounted(() => unsubscribe?.());

// Native window controls must render before a Bridge connection is available.
const icons = {
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 8a7 7 0 0 1 12-2l2 6M4 12l2 6a7 7 0 0 0 12-2"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  restore: '<rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};

const buttons = [
  { label: 'refresh', action: 'refresh' },
  { label: 'minimize', action: 'minimize' },
  { label: 'maximize', action: 'toggleMaximize' },
  { label: 'close', action: 'close' },
] as const;
</script>

<template>
  <div class="window-controls">
    <button
      v-for="button in buttons"
      :key="button.action"
      type="button"
      :class="{ 'window-close': button.action === 'close' }"
      :title="$t('topPanel.windowControls.' + (button.label === 'maximize' && maximized ? 'restore' : button.label))"
      :aria-label="$t('topPanel.windowControls.' + (button.label === 'maximize' && maximized ? 'restore' : button.label))"
      @click="controls[button.action]()"
    >
      <Icon
        :icon="{
          width: 24,
          height: 24,
          body: '<g fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'>' +
            icons[button.label === 'maximize' && maximized ? 'restore' : button.label] + '</g>',
        }"
        :width="15"
        :height="15"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

<style scoped>
.window-controls {
  display: flex;
  flex: 0 0 auto;
  margin-inline-start: 4px;
  -webkit-app-region: no-drag;
}

button {
  display: grid;
  place-items: center;
  inline-size: 34px;
  block-size: 30px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--theme-top-text, var(--theme-text-primary));
  cursor: pointer;
}

button:hover,
button:focus-visible {
  background: var(--theme-top-control-bg, var(--theme-surface-panel-elevated));
}

.window-close:hover,
.window-close:focus-visible {
  color: var(--theme-text-danger, var(--theme-status-danger, currentColor));
}
</style>
