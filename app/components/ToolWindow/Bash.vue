<script setup lang="ts">
// Bash tool window - displays command and output with terminal styling
// Pre-rendered HTML is passed via props; no useCodeRender here

defineProps<{
  /** Plain text command (not HTML) */
  command?: string;
  /** Pre-rendered HTML for the output */
  outputHtml?: string;
}>();
</script>

<template>
  <div class="bash-content">
    <div v-if="command" class="bash-command">$ {{ command }}</div>
    <div v-if="outputHtml" class="bash-output" v-html="outputHtml" />
    <div v-else-if="!command" class="bash-empty">$</div>
  </div>
</template>

<style scoped>
.bash-content {
  font-family: var(--app-monospace-font-family);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre;
}

.bash-command {
  color: var(--theme-accent-primary, #a5b4fc);
}

.bash-output {
  margin-top: 8px;
}

.bash-output :deep(.shiki) {
  background: transparent !important;
}

.bash-empty {
  color: var(--theme-text-muted, #64748b);
}
</style>
