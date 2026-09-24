<script setup lang="ts" generic="Entry extends { id: string; name?: string }">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';

const props = defineProps<{ entries: readonly Entry[] }>();
const search = ref('');
const list = ref<HTMLElement | null>(null);
const visibleEntries = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return props.entries
    .filter((entry) => `${entry.name ?? ''}\n${entry.id}`.toLocaleLowerCase().includes(query))
    .sort(
      (a, b) =>
        displayName(a).localeCompare(displayName(b), 'en', { sensitivity: 'base' }) ||
        a.id.localeCompare(b.id),
    );
});

function displayName(entry: Entry) {
  return entry.name?.trim() || entry.id;
}

function initial(entry: Entry) {
  const letter = displayName(entry)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .charAt(0)
    .toUpperCase();
  return /^[A-Z]$/.test(letter) ? letter : '#';
}

const letters = computed(() => [...new Set(visibleEntries.value.map(initial))]);

function jumpToLetter(letter: string) {
  const row = list.value?.querySelector<HTMLElement>(`[data-provider-letter="${letter}"]`);
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'nearest' });
}
</script>

<template>
  <div class="provider-discovery">
    <label class="provider-discovery-search-field">
      <Icon icon="lucide:search" :width="14" :height="14" />
      <input
        v-model="search"
        class="provider-discovery-search"
        type="search"
        :aria-label="$t('providerManager.discovery.search')"
        :placeholder="$t('providerManager.discovery.search')"
      />
    </label>
    <div v-if="visibleEntries.length === 0" class="provider-discovery-empty" role="status">
      {{ $t('providerManager.discovery.empty') }}
    </div>
    <div v-else class="provider-discovery-body">
      <div ref="list" class="provider-discovery-list">
        <slot
          v-for="entry in visibleEntries"
          :key="entry.id"
          :entry="entry"
          :letter="initial(entry)"
        />
      </div>
      <nav class="provider-letter-nav" :aria-label="$t('providerManager.discovery.letters')">
        <button
          v-for="letter in letters"
          :key="letter"
          type="button"
          :aria-label="$t('providerManager.discovery.jump', { letter })"
          @click="jumpToLetter(letter)"
        >
          {{ letter }}
        </button>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.provider-discovery {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.provider-discovery-search-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--theme-search-border, var(--theme-modal-border));
  border-radius: var(--radius-control);
  background: var(--theme-search-bg, var(--theme-modal-control-bg));
  color: var(--theme-search-icon, var(--theme-modal-text-muted));
}
.provider-discovery-search {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--theme-search-text, var(--theme-modal-text));
  font: inherit;
  font-size: var(--type-sm);
}
.provider-discovery-search::placeholder {
  color: var(--theme-search-placeholder, var(--theme-modal-text-muted));
}
.provider-discovery-search-field:focus-within,
.provider-letter-nav button:focus-visible,
.provider-discovery-list :deep([data-provider-letter]:focus-visible) {
  outline: 2px solid var(--theme-focus-ring, var(--theme-modal-accent));
  outline-offset: -2px;
}
.provider-discovery-body {
  display: flex;
  gap: var(--space-2);
  min-width: 0;
  align-items: flex-start;
}
.provider-discovery-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  max-height: 48vh;
  overflow-y: auto;
}
.provider-letter-nav {
  display: flex;
  flex-direction: column;
  flex: none;
  max-height: 48vh;
  overflow-y: auto;
}
.provider-letter-nav button {
  flex: none;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--theme-modal-text-muted);
  font: inherit;
  font-size: var(--type-sm);
  cursor: pointer;
}
.provider-letter-nav button:hover {
  background: var(--theme-modal-control-hover-bg, var(--theme-modal-control-bg));
  color: var(--theme-modal-text);
}
.provider-discovery-empty {
  padding: var(--space-3);
  color: var(--theme-modal-text-muted);
  font-size: var(--type-sm);
}
@media (max-width: 640px) {
  .provider-discovery-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
