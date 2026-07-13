<template>
  <form class="forge-prompt-bar" data-forge-prompt-bar @submit.prevent="submitPrompt">
    <label class="forge-prompt-label" for="forge-prompt-input">{{ t('forgePanel.promptLabel') }}</label>
    <Dropdown
      v-model="selectedMode"
      class="forge-mode-dropdown"
      button-class="forge-mode-trigger"
      popup-class="forge-mode-popup"
      :auto-highlight="false"
    >
      <template #label>{{ t(selectedModeLabelKey) }}</template>
      <template #default="{ close }">
        <button
          v-for="mode in inputModes"
          :key="mode.command"
          type="button"
          class="forge-mode-option ui-input-candidate-item"
          :class="{ 'is-active': mode.command === selectedMode }"
          :data-forge-mode="mode.command"
          :data-value="JSON.stringify(mode.command)"
          @click="selectMode(mode.command, close)"
        >
        {{ t(mode.labelKey) }}
        </button>
      </template>
    </Dropdown>
    <input
      id="forge-prompt-input"
      v-model="prompt"
      name="forge-prompt"
      class="forge-prompt-input"
      type="text"
      :placeholder="t('forgePanel.promptPlaceholder')"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter.prevent="submitPrompt"
    />
    <button type="submit" class="forge-send-button" data-forge-action="send" :disabled="prompt.trim().length === 0">
      {{ t('forgePanel.send') }}
    </button>
  </form>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Dropdown from './Dropdown.vue';
import { FORGE_INPUT_MODES, toForgePromptLine, type ForgeInputMode } from '../utils/forgeCommands';

const props = defineProps<{
  onSendLine: (line: string) => void;
}>();

const { t } = useI18n();
const inputModes = FORGE_INPUT_MODES;
const selectedMode = ref<ForgeInputMode>('forge');
const prompt = ref('');
const selectedModeLabelKey = computed(() => inputModes.find((mode) => mode.command === selectedMode.value)?.labelKey ?? inputModes[0].labelKey);

function selectMode(mode: ForgeInputMode, close: () => void) {
  selectedMode.value = mode;
  close();
}

function submitPrompt() {
  const line = toForgePromptLine(selectedMode.value, prompt.value);
  if (!line) return;
  props.onSendLine(line);
  prompt.value = '';
}
</script>

<style scoped>
.forge-prompt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px;
  border-top: 1px solid var(--theme-border-muted, var(--color-region-border));
  background: var(--theme-surface-panel-muted, var(--color-region-control-bg));
}

.forge-prompt-label {
  color: var(--theme-text-muted, var(--color-text-300));
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  white-space: nowrap;
}

.forge-prompt-input {
  height: 28px;
  border: 1px solid var(--theme-border-default, var(--color-region-border));
  border-radius: 6px;
  background: var(--theme-surface-panel-muted, var(--color-region-control-bg));
  color: var(--theme-text-primary, var(--color-text-100));
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.forge-prompt-input {
  flex: 1 1 auto;
  min-width: 120px;
  padding: 0 8px;
}

.forge-prompt-input:focus,
.forge-mode-dropdown:focus-within :deep(.forge-mode-trigger) {
  border-color: var(--theme-accent-primary, var(--color-region-accent));
  box-shadow: 0 0 0 1px var(--theme-accent-primary, var(--color-region-accent));
}

.forge-mode-dropdown {
  flex: 0 0 132px;
}

:deep(.forge-mode-trigger) {
  height: 28px;
  padding: 0 6px;
  border-color: var(--theme-border-default, var(--color-region-border));
  border-radius: 6px;
  background: var(--theme-surface-panel-muted, var(--color-region-control-bg));
  color: var(--theme-text-primary, var(--color-text-100));
  font-family: inherit;
  font-size: 12px;
}

:deep(.forge-mode-popup) {
  min-width: 132px;
  border-radius: 6px;
  border-color: var(--theme-border-default, var(--color-region-border));
  background: var(
    --theme-top-dropdown-control-bg,
    var(--theme-dropdown-control-bg, var(--color-region-control-bg))
  );
}

.forge-mode-option {
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--theme-text-primary, var(--color-text-100));
  font: inherit;
  font-size: 11px;
  text-align: left;
}

.forge-mode-option:hover,
.forge-mode-option.is-active,
.forge-mode-option[aria-selected='true'] {
  background: var(--theme-surface-panel-hover, var(--color-surface-800));
}

.forge-send-button {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--theme-border-strong, var(--color-accent-400));
  border-radius: 6px;
  background: var(--theme-surface-active, var(--color-region-active-bg));
  color: var(--theme-text-primary, var(--color-text-100));
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.forge-send-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
</style>
