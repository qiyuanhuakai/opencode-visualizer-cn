<template>
  <div v-if="hasTarget" class="ib-round-target">
    <span v-if="target.agent" class="ib-target-agent" :style="agentStyle">
      {{ target.agent }}
    </span>
    <span v-if="target.modelDisplayName" class="ib-target-model">
      {{ target.modelDisplayName }}
    </span>
    <span v-if="target.providerLabel" class="ib-target-provider">
      {{ target.providerLabel }}
    </span>
    <span v-if="target.variant" class="ib-target-separator">&middot;</span>
    <span v-if="target.variant" class="ib-target-variant">
      {{ target.variant }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ThreadTarget } from '../types/message';

const props = defineProps<{
  target: ThreadTarget;
  agentStyle: Record<string, string>;
}>();

const hasTarget = computed(() => {
  return Boolean(
    props.target.agent ||
    props.target.modelDisplayName ||
    props.target.providerLabel ||
    props.target.variant,
  );
});
</script>

<style scoped>
.ib-round-target {
  font-size: 10px;
  font-weight: 600;
  margin-top: 4px;
  opacity: 0.92;
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ib-target-agent,
.ib-target-model,
.ib-target-provider,
.ib-target-separator,
.ib-target-variant {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ib-target-model {
  color: #f8fafc;
}

.ib-target-provider {
  color: #94a3b8;
}

.ib-target-separator {
  color: #94a3b8;
}

.ib-target-variant {
  color: #f59e0b;
}
</style>
