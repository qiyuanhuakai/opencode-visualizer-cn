<template>
  <div class="shell-content">
    <div class="xterm-host" :data-shell-id="shellId"></div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  shellId: string;
}>();
</script>

<style scoped>
.shell-content {
  display: flex;
  flex-direction: column;
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: transparent;
  isolation: isolate;
}

.shell-content::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--terminal-shell-background-color, transparent);
  opacity: var(--terminal-shell-background-opacity, 1);
  pointer-events: none;
  z-index: 0;
}

.xterm-host {
  flex: 1;
  min-height: 0;
  position: relative;
  z-index: 1;
  background: transparent;
}

.xterm-host :deep(.xterm) {
  height: 100%;
  background: transparent;
}

.xterm-host :deep(.xterm-viewport) {
  overflow: auto;
  background: transparent !important;
}

.xterm-host :deep(.xterm-screen) {
  background: transparent;
}
</style>
