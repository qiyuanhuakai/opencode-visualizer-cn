<template>
  <div class="ib-footer">
    <span class="ib-footer-meta">
      <span v-if="timestamp" class="ib-meta-item">
        <Icon icon="lucide:clock" :width="10" :height="10" />
        {{ timestamp }}
      </span>
      <span v-if="elapsed" class="ib-meta-item">
        <Icon icon="lucide:timer" :width="10" :height="10" />
        {{ elapsed }}
      </span>
      <span
        v-if="contextPercent != null"
        class="ib-meta-item"
        :class="contextSeverityClass(contextPercent)"
      >
        <Icon icon="lucide:gauge" :width="10" :height="10" />
        {{ contextPercent }}%
      </span>
      <span v-if="tokens" class="ib-meta-item ib-meta-tokens">
        <span class="ib-token-in" title="Input tokens"
          ><Icon icon="lucide:arrow-up" :width="9" :height="9" />{{
            formatTokenCount(tokens.input)
          }}</span
        >
        <span class="ib-token-out" title="Output tokens"
          ><Icon icon="lucide:arrow-down" :width="9" :height="9" />{{
            formatTokenCount(tokens.output)
          }}</span
        >
        <span class="ib-token-reason" title="Reasoning tokens"
          ><Icon icon="lucide:brain" :width="9" :height="9" />{{
            formatTokenCount(tokens.reasoning)
          }}</span
        >
      </span>
    </span>
    <span class="ib-footer-actions">
      <button
        v-if="hasDiffs"
        type="button"
        class="ib-action ib-action-diff"
        @click="$emit('show-diff')"
      >
        DIFF
      </button>
      <button
        v-if="canRevert"
        type="button"
        class="ib-action ib-action-danger"
        @click="$emit('revert')"
      >
        REVERT
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import type { MessageTokens } from '../types/message';
import { contextSeverityClass, formatTokenCount } from '../utils/formatters';

defineProps<{
  timestamp: string;
  elapsed: string;
  contextPercent: number | null;
  tokens: MessageTokens | null;
  hasDiffs: boolean;
  canRevert: boolean;
}>();

defineEmits<{
  (event: 'show-diff'): void;
  (event: 'revert'): void;
}>();
</script>

<style scoped>
.ib-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.ib-footer-meta {
  font-size: 10px;
  color: rgba(148, 163, 184, 0.7);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.ib-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.ib-meta-tokens {
  gap: 6px;
}

.ib-token-in,
.ib-token-out,
.ib-token-reason {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.ib-ctx-low {
  color: rgba(96, 165, 250, 0.7);
}

.ib-ctx-moderate {
  color: rgba(251, 191, 36, 0.8);
}

.ib-ctx-high {
  color: rgba(249, 115, 22, 0.85);
}

.ib-ctx-critical {
  color: rgba(248, 113, 113, 0.9);
}

.ib-footer-actions {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
}

.ib-action {
  border: 1px solid rgba(148, 163, 184, 0.65);
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.75);
  color: #bfdbfe;
  font-size: 10px;
  line-height: 1;
  padding: 3px 7px;
  cursor: pointer;
  white-space: nowrap;
}

.ib-action:hover {
  background: rgba(30, 41, 59, 0.92);
}

.ib-action-diff {
  border-color: rgba(96, 165, 250, 0.7);
  background: rgba(30, 58, 138, 0.35);
  color: #bfdbfe;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.ib-action-diff:hover {
  background: rgba(30, 64, 175, 0.55);
}

.ib-action-danger {
  border-color: rgba(248, 113, 113, 0.7);
  background: rgba(127, 29, 29, 0.35);
  color: #fecaca;
}

.ib-action-danger:hover {
  background: rgba(153, 27, 27, 0.5);
}
</style>
