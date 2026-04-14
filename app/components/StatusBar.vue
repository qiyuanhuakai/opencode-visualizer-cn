<template>
  <div class="statusbar" role="status" aria-live="polite">
    <div class="statusbar-section statusbar-left">
      <span class="statusbar-text">{{ thinkingDisplayText }}</span>
    </div>
    <div
      class="statusbar-section statusbar-right"
      :class="{ 'is-error': isStatusError, 'is-retry': isRetryStatus }"
    >
      {{ statusText }}
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  thinkingDisplayText: string;
  statusText: string;
  isStatusError: boolean;
  isRetryStatus: boolean;
}>();
</script>

<style scoped>
.statusbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px 12px;
  border-top: none;
  background: transparent;
  color: var(--region-page-text-muted, #94a3b8);
  font-size: 8pt;
  line-height: 1.2;
  margin: 0;
  border-radius: 0;
  box-sizing: border-box;
  z-index: 2;
}

.statusbar-section {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.statusbar-right {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.statusbar-right.is-error,
.statusbar-right.is-retry {
  color: var(--theme-text-danger, #fecaca);
}
</style>
