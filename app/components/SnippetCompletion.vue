<template>
  <div class="snippet-completion">
    <div class="snippet-completion-header">
      <span class="snippet-completion-name">{{ snippet.name }}</span>
      <code class="snippet-completion-trigger">{{ sequence }}</code>
    </div>
    <div v-if="snippet.description" class="snippet-completion-description">
      {{ snippet.description }}
    </div>
    <div class="snippet-completion-preview">{{ snippet.body }}</div>
    <div v-if="snippet.tags.length > 0" class="snippet-completion-tags">
      <span v-for="tag in snippet.tags" :key="tag" class="snippet-completion-tag">
        {{ tag }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TextTransformer } from '../utils/snippets';

defineProps<{
  snippet: TextTransformer;
  sequence: string;
}>();
</script>

<style scoped>
.snippet-completion {
  display: flex;
  min-width: 0;
  width: 100%;
  flex-direction: column;
  gap: 4px;
}

.snippet-completion-header {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.snippet-completion-name {
  overflow: hidden;
  color: var(--theme-input-text, var(--theme-modal-text, var(--theme-text-primary, #e2e8f0)));
  font-size: var(--ui-font-size, 12px);
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snippet-completion-trigger {
  flex: 0 0 auto;
  color: var(--theme-accent-primary, #60a5fa);
  font-size: 10px;
}

.snippet-completion-description,
.snippet-completion-preview {
  color: var(--theme-input-text-muted, var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8)));
  font-size: 10px;
  line-height: 1.35;
}

.snippet-completion-preview {
  display: -webkit-box;
  overflow: hidden;
  color: var(--theme-input-text, var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1)));
  white-space: pre-wrap;
  word-break: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.snippet-completion-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.snippet-completion-tag {
  border: 1px solid
    var(--theme-input-border, var(--theme-modal-border, var(--theme-border-default, #334155)));
  border-radius: 999px;
  padding: 1px 5px;
  color: var(--theme-input-text-muted, var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8)));
  font-size: 9px;
  line-height: 1.2;
}
</style>
