<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { HarnessManifest } from '../../../shared/runtime/harnessContract.js';
import type { HarnessInstanceId } from '../../../shared/runtime/identity.js';
import { useI18n } from 'vue-i18n';
import type { HarnessEntry } from '../../composables/useRuntimeSessionTree';
import { HARNESS_LABELS } from '../../composables/useRuntimeSessionTree';
const { t } = useI18n();
const props = defineProps<{
  instances: readonly HarnessManifest[];
  selected: HarnessInstanceId | null;
  names?: Readonly<Record<string, string>>;
  sources?: readonly HarnessEntry[];
}>();
function sourceLabel(id: HarnessInstanceId): string {
  const source = props.sources?.find(entry => entry.harnessInstanceId === id);
  switch (source?.status) {
    case 'loading': return rt('loading');
    case 'partial': return rt('partial');
    case 'complete': return rt('ready');
    case 'error': return rt('failed');
    case 'disabled': return rt('disabled');
    case 'standby': return t('app.runtimeConnection.agentStandby');
    default: return '';
  }
}
const emit = defineEmits<{ select: [instance: HarnessInstanceId] }>();
function select(value: unknown, instances: readonly HarnessManifest[]) {
  const instance = instances.find(entry => entry.harnessInstanceId === value);
  if (instance) emit('select', instance.harnessInstanceId);
}
function label(instance: HarnessManifest | undefined, instances: readonly HarnessManifest[]): string {
  if (!instance) return '—';
  const nameFor = (peer: HarnessManifest) => {
    const configured = props.names?.[peer.harnessInstanceId];
    return configured ? `${HARNESS_LABELS[peer.kind]} · ${configured}` : HARNESS_LABELS[peer.kind];
  };
  const name = nameFor(instance);
  const peers = instances.filter(peer => nameFor(peer) === name);
  return peers.length === 1 ? name : `${name} ${peers.findIndex(peer => peer.harnessInstanceId === instance.harnessInstanceId) + 1}`;
}
</script>
<template>
  <div class="agent-instance-selector" data-runtime-ui data-testid="management-agent-selector">
    <span aria-hidden="true">{{ rt("Agent") }}</span>
    <Dropdown :model-value="selected ?? undefined" :aria-label="`${rt('Agent')} · ${label(instances.find(entry => entry.harnessInstanceId === selected), instances)}`" :popup-style="{ minWidth: 'max(100%, min(16rem, 85vw))', width: 'max-content', maxWidth: 'min(30rem, 90vw)' }" popup-class="agent-instance-options" auto-close @update:model-value="select($event, instances)">
      <template #value>{{ label(instances.find(entry => entry.harnessInstanceId === selected), instances) }}</template>
      <DropdownItem v-for="instance in instances" :key="instance.harnessInstanceId" :value="instance.harnessInstanceId">
        <div class="agent-instance-option">
          <span class="agent-instance-name" :title="label(instance, instances)">{{ label(instance, instances) }}</span>
          <span v-if="sourceLabel(instance.harnessInstanceId)" class="agent-instance-state">
            {{ sourceLabel(instance.harnessInstanceId) }}
          </span>
        </div>
      </DropdownItem>
    </Dropdown>
  </div>
</template>
<style scoped>
.agent-instance-selector { display: flex; align-items: center; gap: var(--space-2); font-size: var(--type-sm); color: var(--theme-text-secondary); }
.agent-instance-selector :deep(.ui-dropdown-button) { min-inline-size: min(12rem, 32vw); }
.agent-instance-option { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); white-space: nowrap; }
.agent-instance-name { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; }
.agent-instance-state { flex-shrink: 0; color: var(--theme-top-text-muted, var(--theme-text-muted)); }
</style>
