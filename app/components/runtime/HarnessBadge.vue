<template>
  <span
    class="harness-badge"
    :class="`is-${props.harness}`"
    :data-harness="props.harness"
    :title="`${label}${props.detail ? ` — ${props.detail}` : ''}`"
  >
    <Icon class="harness-badge-icon" :icon="icon" :width="props.compact ? 12 : 11" :height="props.compact ? 12 : 11" />
    <span v-if="!props.compact" class="harness-badge-label">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import { HARNESS_LABELS, type SessionHarness } from '../../composables/useRuntimeSessionTree';

const props = withDefaults(defineProps<{
  harness: SessionHarness;
  compact?: boolean;
  detail?: string;
}>(), { compact: false, detail: '' });

const label = computed(() => HARNESS_LABELS[props.harness]);
const icon = computed(() => {
  if (props.harness === 'opencode') return 'lucide:terminal';
  if (props.harness === 'codex') return 'lucide:code';
  if (props.harness === 'kimi-web') return 'lucide:globe';
  if (props.harness === 'dsh') return 'lucide:waves';
  if (props.harness === 'acp') return 'lucide:plug';
  return 'lucide:help-circle';
});
</script>

<style scoped>
.harness-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--harness-badge-ink) 32%, transparent);
  background: color-mix(in srgb, var(--harness-badge-ink) 14%, transparent);
  color: var(--harness-badge-ink);
  font-size: calc(var(--sidebar-font-size, 12px) - 2px);
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
}

.harness-badge-icon {
  flex-shrink: 0;
}

.harness-badge-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.harness-badge.is-opencode { --harness-badge-ink: var(--theme-side-accent, #38bdf8); }
.harness-badge.is-codex { --harness-badge-ink: var(--theme-status-info, #7dd3fc); }
.harness-badge.is-kimi-web { --harness-badge-ink: var(--theme-status-warning, #fcd34d); }
.harness-badge.is-dsh { --harness-badge-ink: var(--theme-status-success, #86efac); }
.harness-badge.is-acp { --harness-badge-ink: var(--theme-status-neutral, #94a3b8); }
.harness-badge.is-unknown { --harness-badge-ink: var(--theme-side-text-muted, #94a3b8); }
</style>
