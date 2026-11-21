<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { HarnessManifest } from '../../../shared/runtime/harnessContract.js';
import type { HarnessInstanceId } from '../../../shared/runtime/identity.js';
import { HARNESS_LABELS } from '../../composables/useRuntimeSessionTree';
const props = defineProps<{ instances: readonly HarnessManifest[]; selected: HarnessInstanceId | null; names?: Readonly<Record<string, string>> }>();
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
    <Dropdown :model-value="selected ?? undefined" :aria-label="`${rt('Agent')} · ${label(instances.find(entry => entry.harnessInstanceId === selected), instances)}`" auto-close @update:model-value="select($event, instances)">
      <template #value>{{ label(instances.find(entry => entry.harnessInstanceId === selected), instances) }}</template>
      <DropdownItem v-for="instance in instances" :key="instance.harnessInstanceId" :value="instance.harnessInstanceId">
        {{ label(instance, instances) }}
      </DropdownItem>
    </Dropdown>
  </div>
</template>
<style scoped>
.agent-instance-selector { display: flex; align-items: center; gap: var(--space-2); font-size: var(--type-sm); color: var(--theme-text-secondary); }
</style>
