<template>
  <div class="subagent-content">
    <div
      v-for="(entry, index) in entries"
      :key="entry.id"
      class="subagent-entry"
      :class="{ 'subagent-entry-separator': index > 0 }"
    >
      <MessageViewer
        :code="entry.text"
        lang="markdown"
        :theme="theme"
        @rendered="handleRendered"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import MessageViewer from '../MessageViewer.vue';
import { useFloatingWindow } from '../../composables/useFloatingWindow';

export type SubagentEntry = {
  id: string;
  text: string;
};

withDefaults(
  defineProps<{
    entries: SubagentEntry[];
    theme?: string;
  }>(),
  {
    theme: 'github-dark',
  },
);

const floatingWindow = useFloatingWindow();

function handleRendered() {
  floatingWindow.notifyContentChange();
}
</script>

<style scoped>
.subagent-content {
  min-height: 100%;
}

.subagent-entry-separator {
  margin-top: 0.4em;
  padding-top: 0.4em;
  border-top: 1px solid rgba(148, 163, 184, 0.15);
}
</style>
