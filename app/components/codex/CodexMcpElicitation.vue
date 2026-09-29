<template>
  <section class="flex h-full min-h-0 flex-col gap-3 p-4 text-sm text-[var(--theme-text-primary)]">
    <header class="space-y-1 border-b border-[var(--theme-border-subtle)] pb-3">
      <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--theme-accent-primary)]">
        <span class="h-2 w-2 rounded-full [background:var(--theme-accent-primary)]" aria-hidden="true"></span>
        {{ t('codexPanel.elicitation.server') }} · {{ request.serverName }}
      </div>
      <p class="break-words text-sm leading-5 text-[var(--theme-text-primary)]">{{ request.message }}</p>
    </header>

    <form
      v-if="request.mode === 'form'"
      class="min-h-0 flex-1 space-y-3 overflow-auto pr-1"
      autocomplete="off"
      @submit.prevent="submitForm"
    >
      <div
        v-for="field in request.fields"
        :key="field.key"
        class="block space-y-1.5 rounded border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-3"
      >
        <span class="flex items-center gap-1 text-xs font-medium text-[var(--theme-text-primary)]">
          {{ field.label }}
          <span v-if="field.required" class="text-[var(--codex-status-warning)]">*</span>
        </span>
        <span v-if="field.description" class="block text-[11px] leading-4 text-[var(--theme-text-muted)]">
          {{ field.description }}
        </span>

        <Dropdown
          v-if="field.type === 'select'"
          v-model="values[field.key]"
          class="w-full"
          :label="field.options?.find((option) => option.value === values[field.key])?.label || '—'"
          :aria-label="field.label"
          auto-close
        >
          <DropdownItem value="">—</DropdownItem>
          <DropdownItem v-for="option in field.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </DropdownItem>
        </Dropdown>

        <div v-else-if="field.type === 'multiselect'" class="space-y-1.5">
          <label
            v-for="option in field.options"
            :key="option.value"
            class="flex cursor-pointer items-center gap-2 text-xs text-[var(--theme-text-secondary)]"
          >
            <input
              type="checkbox"
              :name="field.key"
              :value="option.value"
              :checked="multiValues(field.key).includes(option.value)"
              class="accent-[var(--theme-accent-primary)]"
              @change="toggleMultiValue(field.key, option.value)"
            />
            {{ option.label }}
          </label>
        </div>

        <label v-else-if="field.type === 'boolean'" class="flex cursor-pointer items-center gap-2">
          <input v-model="values[field.key]" :name="field.key" type="checkbox" class="accent-[var(--theme-accent-primary)]" />
          <span class="text-xs text-[var(--theme-text-muted)]">{{ field.label }}</span>
        </label>

        <input
          v-else-if="field.type === 'number' || field.type === 'integer'"
          v-model.number="values[field.key]"
          :name="field.key"
          :aria-label="field.label"
          type="text"
          :inputmode="field.type === 'integer' ? 'numeric' : 'decimal'"
          :min="field.minimum"
          :max="field.maximum"
          :step="field.type === 'integer' ? 1 : 'any'"
          class="w-full rounded border border-[var(--theme-form-control-border)] [background:var(--theme-form-control-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--theme-accent-primary)]"
        />

        <input
          v-else
          v-model="values[field.key]"
          :name="field.key"
          :aria-label="field.label"
          :type="field.format === 'password' ? 'password' : 'text'"
          :minlength="field.minLength"
          :maxlength="field.maxLength"
          :autocomplete="field.format === 'password' ? 'new-password' : 'off'"
          class="w-full rounded border border-[var(--theme-form-control-border)] [background:var(--theme-form-control-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--theme-accent-primary)]"
        />
      </div>
    </form>

    <div v-else class="flex min-h-0 flex-1 flex-col justify-center gap-3 rounded border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-4">
      <a
        data-action="open-link"
        :href="request.url"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex w-fit items-center gap-2 rounded border border-[var(--theme-border-accent)] [background:var(--theme-accent-soft)] px-3 py-2 text-xs font-semibold text-[var(--theme-accent-primary)] hover:[background:var(--theme-surface-panel-hover)]"
      >
        {{ t('codexPanel.elicitation.openLink') }}
      </a>
      <code class="break-all text-[11px] leading-4 text-[var(--theme-text-muted)]">{{ request.url }}</code>
    </div>

    <footer class="flex flex-wrap justify-end gap-2 border-t border-[var(--theme-border-subtle)] pt-3">
      <button
        type="button"
        class="rounded border border-[var(--theme-form-control-border)] px-3 py-1.5 text-xs text-[var(--theme-text-secondary)] hover:[background:var(--theme-form-button-bg)]"
        @click="emit('reply', 'cancel')"
      >
        {{ t('codexPanel.elicitation.cancel') }}
      </button>
      <button
        type="button"
        class="rounded border border-[var(--codex-status-danger)] px-3 py-1.5 text-xs text-[var(--codex-status-danger)] hover:[background:var(--theme-surface-danger-soft)]"
        @click="emit('reply', 'decline')"
      >
        {{ t('codexPanel.elicitation.decline') }}
      </button>
      <button
        data-action="accept"
        type="button"
        :disabled="request.mode === 'form' && !formValid"
        class="rounded border border-[var(--theme-border-accent)] [background:var(--theme-accent-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--theme-accent-primary)] hover:[background:var(--theme-surface-panel-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        @click="request.mode === 'form' ? submitForm() : emit('reply', 'accept')"
      >
        {{ t('codexPanel.elicitation.accept') }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type {
  McpElicitationAction,
  McpElicitationRequest,
} from '../../backends/codex/serverRequests';

const props = defineProps<{ request: McpElicitationRequest }>();
const emit = defineEmits<{
  reply: [action: McpElicitationAction, content?: Record<string, unknown>];
}>();
const { t } = useI18n();
const values = reactive<Record<string, unknown>>({});

if (props.request.mode === 'form') {
  for (const field of props.request.fields) {
    if (field.defaultValue !== undefined) values[field.key] = field.defaultValue;
    else if (field.type === 'multiselect') values[field.key] = [];
    else if (field.type === 'boolean') values[field.key] = false;
    else values[field.key] = '';
  }
}

function hasValue(value: unknown) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

const formValid = computed(() =>
  props.request.mode !== 'form' ||
  props.request.fields.every((field) => {
    const value = values[field.key];
    if (!hasValue(value)) return !field.required;
    if (field.type !== 'number' && field.type !== 'integer') return true;
    return typeof value === 'number' && Number.isFinite(value)
      && (field.type !== 'integer' || Number.isInteger(value))
      && (field.minimum === undefined || value >= field.minimum)
      && (field.maximum === undefined || value <= field.maximum);
  }),
);

function multiValues(key: string) {
  const value = values[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function toggleMultiValue(key: string, option: string) {
  const current = multiValues(key);
  values[key] = current.includes(option)
    ? current.filter((value) => value !== option)
    : [...current, option];
}

function submitForm() {
  if (props.request.mode !== 'form' || !formValid.value) return;
  emit('reply', 'accept', { ...values });
}
</script>
