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
        <span class="ib-token-in" :title="t('threadFooter.inputTokens')"
          ><Icon icon="lucide:arrow-up" :width="9" :height="9" />{{
            formatTokenCount(tokens.input)
          }}</span
        >
        <span class="ib-token-out" :title="t('threadFooter.outputTokens')"
          ><Icon icon="lucide:arrow-down" :width="9" :height="9" />{{
            formatTokenCount(tokens.output)
          }}</span
        >
        <span class="ib-token-reason" :title="t('threadFooter.reasoningTokens')"
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
        {{ t('threadFooter.diff') }}
      </button>
      <button
        v-if="canRevert"
        type="button"
        class="ib-action ib-action-danger"
        @click="$emit('revert')"
      >
        {{ t('threadFooter.revert') }}
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { MessageTokens } from '../types/message';
import { contextSeverityClass, formatTokenCount } from '../utils/formatters';

const { t } = useI18n();

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
  --ui-chip-border-neutral: var(--theme-chat-border, var(--theme-border-muted, rgba(148, 163, 184, 0.65)));
  --ui-chip-bg-neutral: var(--theme-chat-control-bg, var(--theme-surface-chip, rgba(15, 23, 42, 0.75)));
  --ui-chip-bg-hover: var(--theme-chat-active-bg, var(--theme-surface-chip-hover, rgba(30, 41, 59, 0.92)));
  --ui-chip-fg-neutral: var(--theme-chat-text, var(--theme-text-primary, #bfdbfe));
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
  gap: var(--ui-action-gap);
  flex: 0 0 auto;
}

.ib-action {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  flex: 0 0 auto;
  height: var(--ui-chip-height);
  border: 1px solid var(--ui-chip-border-neutral);
  border-radius: var(--ui-chip-radius);
  background: var(--ui-chip-bg-neutral);
  color: var(--ui-chip-fg-neutral);
  font-family: var(--ui-chip-font-family);
  font-size: var(--ui-chip-font-size);
  font-weight: 600;
  letter-spacing: var(--ui-chip-letter-spacing);
  line-height: 1;
  padding: 0 var(--ui-chip-padding-x);
  margin: 0;
  cursor: pointer;
  white-space: nowrap;
  vertical-align: top;
}

.ib-action:hover {
  background: var(--ui-chip-bg-hover);
}

.ib-action-diff {
  border-color: rgba(96, 165, 250, 0.7);
  background: rgba(30, 58, 138, 0.35);
  color: #bfdbfe;
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
