<template>
  <div class="discovery-status" :data-sources-total="props.sources.length" :data-sources-error="errorCount">
    <button
      type="button"
      class="discovery-status-summary"
      :class="{ 'has-error': errorCount > 0 }"
      :aria-expanded="open ? 'true' : 'false'"
      @click="open = !open"
    >
      <Icon class="discovery-status-summary-icon" :icon="errorCount > 0 ? 'lucide:triangle-alert' : 'lucide:radio-tower'" :width="13" :height="13" />
      <span class="discovery-status-summary-label">{{ $t('runtime.sessionTree.sources', 'Sources') }}</span>
      <span class="discovery-status-summary-count" data-testid="source-ready-count">{{ readyCount }}/{{ props.sources.length }}</span>
    </button>
    <ul v-if="open" class="discovery-status-list">
      <li
        v-for="source in props.sources"
        :key="source.harnessInstanceId"
        class="discovery-status-row"
        :class="`is-${source.status}`"
        :data-source="source.kind"
        :data-status="source.status"
      >
        <span class="discovery-status-dot" :class="`is-${source.status}`" aria-hidden="true"></span>
        <HarnessBadge class="discovery-status-badge" :harness="source.kind" :detail="source.reason ?? undefined" />
        <span class="discovery-status-state">{{ stateLabel(source.status) }}</span>
        <button
          v-if="source.status === 'error'"
          type="button"
          class="discovery-status-retry"
          data-testid="source-retry"
          :data-harness="source.kind"
          :disabled="props.retrying.has(source.harnessInstanceId)"
          :title="$t('runtime.sessionTree.retrySource', 'Retry source')"
          :aria-label="`${$t('runtime.sessionTree.retrySource', 'Retry source')}: ${HARNESS_LABELS[source.kind]}`"
          @click.stop="emit('retry', source.harnessInstanceId)"
        >
          <Icon
            class="discovery-status-retry-icon"
            :class="{ 'is-retrying': props.retrying.has(source.harnessInstanceId) }"
            :icon="props.retrying.has(source.harnessInstanceId) ? 'lucide:loader-2' : 'lucide:refresh-cw'"
            :width="12"
            :height="12"
          />
        </button>
      </li>
    </ul>
    <div v-if="props.viewError" class="discovery-status-error" role="alert" data-testid="source-view-error">
      <Icon :icon="'lucide:circle-alert'" :width="13" :height="13" />
      <span>{{ $t('runtime.sessionTree.viewError', 'Session index error') }}: {{ props.viewError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { HARNESS_LABELS } from '../../composables/useRuntimeSessionTree';
import type { HarnessEntry } from '../../composables/useRuntimeSessionTree';
import HarnessBadge from './HarnessBadge.vue';

const props = withDefaults(defineProps<{
  sources: readonly HarnessEntry[];
  retrying?: ReadonlySet<string>;
  viewError?: string | null;
}>(), { retrying: () => new Set<string>(), viewError: null });

const emit = defineEmits<{ (event: 'retry', harnessInstanceId: string): void }>();
const open = ref(false);
const readyCount = computed(() => props.sources.filter((source) => source.status === 'complete').length);
const errorCount = computed(() => props.sources.filter((source) => source.status === 'error').length);
watch(errorCount, (count) => { if (count > 0) open.value = true; });

function stateLabel(status: HarnessEntry['status']): string {
  if (status === 'complete') return 'ready';
  if (status === 'error') return 'failed';
  if (status === 'partial') return 'partial';
  return 'loading';
}
</script>

<style scoped>
.discovery-status {
  flex-shrink: 0;
  border-bottom: 1px solid var(--theme-side-border, var(--theme-border-muted, rgba(100, 116, 139, 0.28)));
}

.discovery-status-summary {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--theme-side-text-muted, #94a3b8);
  cursor: pointer;
  font-size: var(--sidebar-font-size, 12px);
  text-align: left;
}

.discovery-status-summary:hover {
  background: var(--theme-side-active-bg, rgba(51, 65, 85, 0.6));
}

.discovery-status-summary.has-error {
  color: var(--theme-status-danger, #f87171);
}

.discovery-status-summary-icon {
  flex-shrink: 0;
}

.discovery-status-summary-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.discovery-status-summary-count {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.discovery-status-list {
  list-style: none;
  margin: 0;
  padding: 2px 6px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 148px;
  overflow: auto;
}

.discovery-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 6px;
  min-height: 24px;
}

.discovery-status-row:hover {
  background: var(--theme-side-active-bg, rgba(51, 65, 85, 0.6));
}

.discovery-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--theme-status-neutral, #94a3b8);
}

.discovery-status-dot.is-complete { background: var(--theme-status-success, #4ade80); }
.discovery-status-dot.is-partial { background: var(--theme-status-warning, #fbbf24); }
.discovery-status-dot.is-loading { background: var(--theme-status-neutral, #94a3b8); }
.discovery-status-dot.is-error { background: var(--theme-status-danger, #f87171); }

.discovery-status-badge {
  min-width: 0;
}

.discovery-status-state {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(var(--sidebar-font-size, 12px) - 1px);
  color: var(--theme-side-text-muted, #94a3b8);
}

.discovery-status-row.is-error .discovery-status-state {
  color: var(--theme-status-danger, #f87171);
}

.discovery-status-retry {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--theme-side-text-muted, #94a3b8);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.discovery-status-retry:hover {
  background: var(--theme-side-active-bg, rgba(51, 65, 85, 0.6));
  color: var(--theme-side-text, #e2e8f0);
}

.discovery-status-retry:disabled {
  cursor: default;
  opacity: 0.6;
}

.discovery-status-retry-icon.is-retrying {
  animation: discovery-status-spin 0.9s linear infinite;
}

@keyframes discovery-status-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .discovery-status-retry-icon.is-retrying { animation: none; }
}

.discovery-status-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 6px 6px;
  padding: 4px 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--theme-status-danger, #f87171) 12%, transparent);
  color: var(--theme-status-danger, #f87171);
  font-size: calc(var(--sidebar-font-size, 12px) - 1px);
}
</style>
