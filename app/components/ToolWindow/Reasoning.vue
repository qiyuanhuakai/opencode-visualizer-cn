<template>
  <div class="reasoning-content">
    <div
      v-for="(entry, index) in entries"
      :key="entry.id"
      class="reasoning-entry"
      :class="{ 'reasoning-entry-separator': index > 0 }"
    >
      <MessageViewer :code="entry.text" lang="markdown" :theme="theme" @rendered="handleRendered" />
    </div>
  </div>
</template>

<script setup lang="ts">
import MessageViewer from '../MessageViewer.vue';
import { useFloatingWindow } from '../../composables/useFloatingWindow';
import { DEFAULT_SYNTAX_THEME } from '../../utils/themeTokens';

export type ReasoningEntry = {
  id: string;
  text: string;
};

withDefaults(
  defineProps<{
    entries: ReasoningEntry[];
    theme?: string;
  }>(),
  {
    theme: DEFAULT_SYNTAX_THEME,
  },
);

const floatingWindow = useFloatingWindow();

function handleRendered() {
  floatingWindow.notifyContentChange();
}
</script>

<style scoped>
.reasoning-content {
  min-height: 100%;
}

.reasoning-entry-separator {
  margin-top: 0.4em;
  padding-top: 0.4em;
  border-top: 1px solid rgba(148, 163, 184, 0.15);
}
</style>
