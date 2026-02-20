<template>
  <div
    ref="root"
    class="ui-dropdown"
    :class="{ 'is-open': isActive, 'is-disabled': props.disabled }"
    :style="rootStyle"
  >
    <slot name="trigger">
      <button
        type="button"
        class="ui-dropdown-button"
        :class="props.buttonClass"
        :style="props.buttonStyle"
        :disabled="props.disabled"
        @click.stop="toggle"
        @keydown="onKeyDown"
      >
        <slot name="label">
          <div class="ui-dropdown-label">
            <template v-if="props.modelValue != null">
              <slot name="value" :value="props.modelValue">{{ displayLabel }}</slot>
            </template>
            <template v-else>{{ displayLabel }}</template>
            <!-- for box size adjustment -->
            <div v-if="!props.label" class="ui-dropdown-sizer">
              <div v-for="(value, idx) in candidateValues" :key="idx">
                <slot name="value" :value="value">{{ value }}</slot>
              </div>
            </div>
          </div>
        </slot>
        <Icon
          class="ui-dropdown-icon"
          :icon="props.menuIcon ?? 'lucide:chevron-down'"
          :width="12"
          :height="12"
        />
      </button>
    </slot>
    <div
      ref="menu"
      class="ui-dropdown-menu"
      :class="[{ 'is-open': isActive }, props.popupClass]"
      :style="[props.popupStyle, menuStyle]"
      :inert="!isActive || undefined"
      role="listbox"
      title=""
      tabindex="-1"
      @click.stop
      @keydown="onKeyDown"
    >
      <slot :close="close" :search-results="searchResults" :search-loading="searchLoading" />
    </div>
  </div>
</template>

<script lang="ts" setup generic="T">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch,
  type StyleValue,
} from 'vue';
import { Icon } from '@iconify/vue';

export interface DropdownAPI {
  select: (item: unknown) => void;
  close: () => void;
  selected: unknown | undefined;
  update: () => Promise<void>;
  moveHighlight: (direction: 'up' | 'down') => void;
  selectHighlighted: () => boolean;
  updateSearch: (query: string) => void;
}

const props = withDefaults(
  defineProps<{
    menuIcon?: string;
    modelValue?: T;
    label?: string;
    placeholder?: string;
    buttonClass?: unknown;
    buttonStyle?: StyleValue;
    popupClass?: unknown;
    popupStyle?: StyleValue;
    autoClose?: boolean;
    disabled?: boolean;
    open?: boolean;
    search?: (query: string, signal: AbortSignal) => Promise<unknown[]>;
    searchDebounce?: number;
    autoFocus?: boolean;
    autoHighlight?: boolean;
  }>(),
  {
    autoFocus: true,
    autoHighlight: true,
  },
);

const emit = defineEmits<{
  select: [T];
  'update:modelValue': [T];
  'update:open': [boolean];
}>();

const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const isActive = ref(props.open ?? false);
const candidateValues = ref<T[]>([]);
const anchorName = `--ui-dropdown-anchor-${Math.random().toString(36).slice(2, 10)}`;

const searchResults = ref<unknown[]>([]);
const searchLoading = ref(false);
let searchController: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let lastSearchQuery: string | undefined;

const rootStyle = computed<StyleValue>(() => ({
  anchorName,
}));

const menuStyle = computed<StyleValue>(() => ({
  positionAnchor: anchorName,
}));

const displayLabel = computed(() => {
  if (props.label) return props.label;
  if (props.modelValue !== undefined && props.modelValue !== null) return String(props.modelValue);
  return props.placeholder ?? 'Select';
});

function updateCandidateValues() {
  if (!menu.value) return;
  const candidates = menu.value.querySelectorAll(
    '.ui-input-candidate-item[data-value]',
  ) as NodeListOf<Element>;
  const results: T[] = [];
  candidates.forEach((item) => {
    try {
      const value = JSON.parse(item.getAttribute('data-value') ?? 'null');
      if (value != null) results.push(value);
    } catch {
      // skip invalid values
    }
  });
  candidateValues.value = results;
}

function toggle() {
  if (props.disabled) return;
  isActive.value = !isActive.value;
}

function close() {
  isActive.value = false;
}

watch(isActive, (active) => {
  if (!active) clearHighlight();
  emit('update:open', active);
  if (active) {
    nextTick(() => {
      if (props.autoFocus !== false) {
        const autoFocusEl = menu.value?.querySelector('[autofocus]');
        if (autoFocusEl instanceof HTMLElement) autoFocusEl.focus();
        else menu.value?.focus();
      }
      highlightSelected();
    });
  }
  updateCandidateValues();
});

watch(
  () => props.open,
  (value) => {
    if (value !== undefined && value !== isActive.value) {
      isActive.value = value;
    }
  },
);

function getCandidateItems(): HTMLElement[] {
  if (!menu.value) return [];
  return Array.from(
    menu.value.querySelectorAll('.ui-input-candidate-item:not([aria-disabled="true"])'),
  );
}

function clearHighlight() {
  if (!menu.value) return;
  menu.value.querySelectorAll('.ui-input-candidate-item[aria-selected="true"]').forEach((el) => {
    el.setAttribute('aria-selected', 'false');
  });
}

function highlightItem(el: HTMLElement | undefined) {
  clearHighlight();
  if (!el) return;
  el.setAttribute('aria-selected', 'true');
  el.scrollIntoView({ block: 'nearest' });
}

function highlightSelected() {
  const items = getCandidateItems();
  const activeItem = items.find((el) => el.classList.contains('is-active'));
  if (activeItem) {
    highlightItem(activeItem);
    return;
  }
  // No selected item — preserve any highlight set by external caller (e.g. moveHighlight).
  const hasHighlight = items.some((el) => el.getAttribute('aria-selected') === 'true');
  if (hasHighlight) return;
  // No existing highlight — fall back to first item (unless autoHighlight is disabled).
  if (props.autoHighlight && items.length > 0) {
    highlightItem(items[0]);
  }
}

function moveHighlight(direction: 'up' | 'down') {
  const items = getCandidateItems();
  if (items.length === 0) return;
  const currentIndex = items.findIndex((el) => el.getAttribute('aria-selected') === 'true');
  let nextIndex: number;
  if (direction === 'down') {
    nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0;
  } else {
    nextIndex =
      currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : items.length - 1;
  }
  highlightItem(items[nextIndex]);
}

function selectHighlighted() {
  const items = getCandidateItems();
  const current = items.find((el) => el.getAttribute('aria-selected') === 'true');
  if (current) {
    current.click();
    return true;
  }
  return false;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (isActive.value) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    return;
  }

  if (!isActive.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    moveHighlight('down');
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    moveHighlight('up');
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    selectHighlighted();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    moveHighlight(e.shiftKey ? 'up' : 'down');
    return;
  }
}

function handlePointerDown(event: PointerEvent) {
  if (!root.value) return;
  if (root.value.contains(event.target as Node)) return;
  const menuEl = menu.value;
  if (menuEl && menuEl.contains(event.target as Node)) return;
  close();
}

// When the dropdown is open and the candidate items change (e.g. after filtering),
// ensure that a valid highlight exists. If the previously highlighted item is gone,
// automatically highlight the first available candidate.
let observer: MutationObserver | null = null;

function onMenuMutation() {
  if (!isActive.value) return;
  const items = getCandidateItems();
  if (items.length === 0) {
    clearHighlight();
    return;
  }
  const hasHighlight = items.some((el) => el.getAttribute('aria-selected') === 'true');
  if (props.autoHighlight === false) {
    if (!hasHighlight) clearHighlight();
    return;
  }
  if (!hasHighlight) {
    highlightItem(items[0]);
  }
}

function startObserver() {
  stopObserver();
  if (!menu.value) return;
  observer = new MutationObserver(onMenuMutation);
  observer.observe(menu.value, { childList: true, subtree: true });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

watch(isActive, (active) => {
  if (active) {
    nextTick(startObserver);
  } else {
    stopObserver();
  }
});

onMounted(() => {
  window.addEventListener('pointerdown', handlePointerDown);
  nextTick(() => {
    updateCandidateValues();
    // When the dropdown is created with open=true, the isActive watchers
    // never fire (no change from initial value). Start the observer here.
    if (isActive.value) {
      startObserver();
    }
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handlePointerDown);
  stopObserver();
  if (searchTimer) clearTimeout(searchTimer);
  if (searchController) searchController.abort();
});

function updateSearch(query: string) {
  if (!props.search) return;
  if (query === lastSearchQuery) return;
  lastSearchQuery = query;
  if (searchTimer) clearTimeout(searchTimer);
  if (searchController) {
    searchController.abort();
    searchController = null;
  }
  const debounce = props.searchDebounce ?? 0;
  const run = async () => {
    const controller = new AbortController();
    searchController = controller;
    searchLoading.value = true;
    try {
      const results = await props.search!(query, controller.signal);
      if (!controller.signal.aborted) searchResults.value = results;
    } catch {
      if (!controller.signal.aborted) searchResults.value = [];
    } finally {
      if (!controller.signal.aborted) searchLoading.value = false;
    }
  };
  if (debounce > 0) {
    searchTimer = setTimeout(run, debounce);
  } else {
    void run();
  }
}

const api = reactive({
  select(item: T) {
    if (props.autoClose !== false) close();
    if (item !== undefined) emit('update:modelValue', item);
    emit('select', item);
  },
  close,
  selected: computed(() => props.modelValue),
  async update() {
    await nextTick();
    updateCandidateValues();
  },
  moveHighlight,
  selectHighlighted,
  updateSearch,
});

provide('x-selectable', api);

defineExpose({ moveHighlight, selectHighlighted, updateSearch, clearHighlight });
</script>

<style scoped>
.ui-dropdown {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.ui-dropdown.is-disabled {
  opacity: 0.6;
}

.ui-dropdown-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: #0b1320;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  text-align: left;
}

.ui-dropdown-button:disabled {
  cursor: default;
}

.ui-dropdown-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-dropdown-sizer {
  display: block;
  width: 100%;
  height: 0;
  visibility: hidden;
  overflow: hidden;
}

.ui-dropdown-icon {
  opacity: 0.7;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
}

.ui-dropdown-menu {
  position: fixed;
  top: anchor(bottom);
  left: anchor(left);
  margin-top: 6px;
  width: anchor-size(width);
  max-width: calc(100vw - 16px);
  max-height: 60vh;
  position-try-fallbacks: flip-block;
  background: rgba(2, 6, 23, 0.98);
  border: 1px solid #334155;
  border-radius: 10px;
  padding: 6px;
  scroll-padding: 6px;
  box-shadow: 0 12px 24px rgba(2, 6, 23, 0.45);
  overflow: auto;
  z-index: 120;
}

.ui-dropdown-menu:not(.is-open) {
  visibility: hidden;
  pointer-events: none;
}
</style>
