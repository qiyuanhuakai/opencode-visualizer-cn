<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { HarnessManifest } from '../../../shared/runtime/harnessContract.js';
import type { HarnessInstanceId } from '../../../shared/runtime/identity.js';
import { HARNESS_LABELS } from '../../composables/useRuntimeSessionTree';
defineProps<{ instances: readonly HarnessManifest[]; selected: HarnessInstanceId | null }>();
const emit = defineEmits<{ select: [instance: HarnessInstanceId] }>();
function select(value: unknown, instances: readonly HarnessManifest[]) {
  const instance = instances.find(entry => entry.harnessInstanceId === value);
  if (instance) emit('select', instance.harnessInstanceId);
}
function label(instance: HarnessManifest | undefined): string {
  return instance ? `${HARNESS_LABELS[instance.kind]} · ${instance.harnessInstanceId.slice(0, 8)}` : '—';
}
</script>
<template>
  <div class="agent-instance-selector" data-runtime-ui data-testid="management-agent-selector">
    <span id="management-agent-label">{{ rt("Agent") }}</span>
    <Dropdown :model-value="selected ?? undefined" aria-labelledby="management-agent-label" auto-close @update:model-value="select($event, instances)">
      <template #value>{{ label(instances.find(entry => entry.harnessInstanceId === selected)) }}</template>
      <DropdownItem v-for="instance in instances" :key="instance.harnessInstanceId" :value="instance.harnessInstanceId">
        {{ label(instance) }}
      </DropdownItem>
    </Dropdown>
  </div>
</template>
<style scoped>
.agent-instance-selector { display: flex; align-items: center; gap: var(--space-2); font-size: var(--type-sm); color: var(--theme-text-secondary); }
</style>
