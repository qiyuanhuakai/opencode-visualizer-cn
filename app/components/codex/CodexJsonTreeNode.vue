<template>
  <div class="codex-tree-node" :class="{ 'codex-tree-leaf': !isComplex }">
    <!-- Primitive value -->
    <template v-if="!isComplex">
      <span v-if="name" class="codex-tree-key">{{ name }}: </span>
      <span :class="valueClass">{{ formattedValue }}</span>
    </template>

    <!-- Empty object/array -->
    <template v-else-if="isEmpty">
      <span v-if="name" class="codex-tree-key">{{ name }}: </span>
      <span class="codex-tree-bracket">{{ type === 'array' ? '[]' : '{}' }}</span>
    </template>

    <!-- Complex value -->
    <template v-else>
      <div
        class="codex-tree-header"
        :style="{ paddingLeft: indent }"
        @click="isExpanded = !isExpanded"
      >
        <span class="codex-tree-toggle">
          <Icon
            :icon="isExpanded ? 'mdi:chevron-down' : 'mdi:chevron-right'"
            width="14"
          />
        </span>
        <span v-if="name" class="codex-tree-key">{{ name }}: </span>
        <span class="codex-tree-bracket">{{ type === 'array' ? '[' : '{' }}</span>
        <span v-if="!isExpanded" class="codex-tree-ellipsis">
          ...{{ entries.length }} items
        </span>
        <span v-if="!isExpanded" class="codex-tree-bracket">{{ type === 'array' ? ']' : '}' }}</span>
      </div>
      <div v-if="isExpanded" class="codex-tree-children">
        <CodexJsonTreeNode
          v-for="[key, value] in entries"
          :key="key"
          :data="value"
          :name="key"
          :depth="depth + 1"
        />
        <div class="codex-tree-closer" :style="{ paddingLeft: `calc(${indent} + 20px)` }">
          <span class="codex-tree-bracket">{{ type === 'array' ? ']' : '}' }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';

const props = defineProps<{
  data: unknown;
  name?: string;
  depth?: number;
}>();

const depth = computed(() => props.depth ?? 0);
const isExpanded = ref(depth.value < 2);
const indent = computed(() => `${depth.value * 16}px`);

const type = computed(() => {
  const v = props.data;
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
});

const isComplex = computed(() => type.value === 'object' || type.value === 'array');
const isEmpty = computed(() => {
  if (!isComplex.value) return false;
  return Object.keys(props.data as Record<string, unknown>).length === 0;
});

const entries = computed(() => {
  if (type.value === 'array') {
    return (props.data as unknown[]).map((item, index) => [String(index), item] as [string, unknown]);
  }
  return Object.entries(props.data as Record<string, unknown>);
});

const formattedValue = computed(() => {
  const v = props.data;
  const t = type.value;
  if (t === 'null') return 'null';
  if (t === 'string') return `"${String(v)}"`;
  if (t === 'boolean' || t === 'number') return String(v);
  return String(v);
});

const valueClass = computed(() => {
  const t = type.value;
  if (t === 'null') return 'codex-tree-null';
  if (t === 'string') return 'codex-tree-string';
  if (t === 'number') return 'codex-tree-number';
  if (t === 'boolean') return 'codex-tree-boolean';
  return '';
});
</script>

<style scoped>
.codex-tree-node {
  font-size: 12px;
  line-height: 1.6;
}

.codex-tree-header {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.codex-tree-header:hover {
  background: rgba(148, 163, 184, 0.08);
}

.codex-tree-toggle {
  display: inline-flex;
  align-items: center;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-tree-key {
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-tree-bracket {
  color: var(--theme-text-muted, #94a3b8);
}

.codex-tree-ellipsis {
  color: var(--theme-text-muted, #94a3b8);
  font-style: italic;
}

.codex-tree-string {
  color: #4ade80;
}

.codex-tree-number {
  color: #fbbf24;
}

.codex-tree-boolean {
  color: #60a5fa;
}

.codex-tree-null {
  color: var(--theme-text-muted, #94a3b8);
  font-style: italic;
}

.codex-tree-children {
  display: flex;
  flex-direction: column;
}

.codex-tree-closer {
  display: flex;
  align-items: center;
}

.codex-tree-leaf {
  padding-left: 20px;
}
</style>
