<template>
  <section class="flex h-full min-h-0 flex-col gap-3 p-4 text-sm text-slate-200">
    <header class="space-y-1 border-b border-slate-700/70 pb-3">
      <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-300">
        <span class="h-2 w-2 rounded-full bg-blue-400" aria-hidden="true"></span>
        {{ t('codexPanel.elicitation.server') }} · {{ request.serverName }}
      </div>
      <p class="break-words text-sm leading-5 text-slate-200">{{ request.message }}</p>
    </header>

    <form
      v-if="request.mode === 'form'"
      class="min-h-0 flex-1 space-y-3 overflow-auto pr-1"
      autocomplete="off"
      @submit.prevent="submitForm"
    >
      <label
        v-for="field in request.fields"
        :key="field.key"
        class="block space-y-1.5 rounded border border-slate-700/60 bg-slate-900/35 p-3"
      >
        <span class="flex items-center gap-1 text-xs font-medium text-slate-200">
          {{ field.label }}
          <span v-if="field.required" class="text-amber-400">*</span>
        </span>
        <span v-if="field.description" class="block text-[11px] leading-4 text-slate-400">
          {{ field.description }}
        </span>

        <select
          v-if="field.type === 'select'"
          v-model="values[field.key]"
          :name="field.key"
          class="w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
        >
          <option value="">—</option>
          <option v-for="option in field.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <div v-else-if="field.type === 'multiselect'" class="space-y-1.5">
          <label
            v-for="option in field.options"
            :key="option.value"
            class="flex cursor-pointer items-center gap-2 text-xs text-slate-300"
          >
            <input
              type="checkbox"
              :name="field.key"
              :value="option.value"
              :checked="multiValues(field.key).includes(option.value)"
              class="accent-blue-500"
              @change="toggleMultiValue(field.key, option.value)"
            />
            {{ option.label }}
          </label>
        </div>

        <label v-else-if="field.type === 'boolean'" class="flex cursor-pointer items-center gap-2">
          <input v-model="values[field.key]" :name="field.key" type="checkbox" class="accent-blue-500" />
          <span class="text-xs text-slate-400">{{ field.label }}</span>
        </label>

        <input
          v-else-if="field.type === 'number' || field.type === 'integer'"
          v-model.number="values[field.key]"
          :name="field.key"
          type="number"
          :min="field.minimum"
          :max="field.maximum"
          :step="field.type === 'integer' ? 1 : 'any'"
          class="w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
        />

        <input
          v-else
          v-model="values[field.key]"
          :name="field.key"
          :type="field.format === 'password' ? 'password' : 'text'"
          :minlength="field.minLength"
          :maxlength="field.maxLength"
          :autocomplete="field.format === 'password' ? 'new-password' : 'off'"
          class="w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
        />
      </label>
    </form>

    <div v-else class="flex min-h-0 flex-1 flex-col justify-center gap-3 rounded border border-slate-700/60 bg-slate-900/35 p-4">
      <a
        data-action="open-link"
        :href="request.url"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex w-fit items-center gap-2 rounded border border-blue-500/60 bg-blue-500/10 px-3 py-2 text-xs font-semibold text-blue-300 hover:bg-blue-500/20"
      >
        {{ t('codexPanel.elicitation.openLink') }}
      </a>
      <code class="break-all text-[11px] leading-4 text-slate-500">{{ request.url }}</code>
    </div>

    <footer class="flex flex-wrap justify-end gap-2 border-t border-slate-700/70 pt-3">
      <button
        type="button"
        class="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
        @click="emit('reply', 'cancel')"
      >
        {{ t('codexPanel.elicitation.cancel') }}
      </button>
      <button
        type="button"
        class="rounded border border-rose-500/60 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10"
        @click="emit('reply', 'decline')"
      >
        {{ t('codexPanel.elicitation.decline') }}
      </button>
      <button
        data-action="accept"
        type="button"
        :disabled="request.mode === 'form' && !formValid"
        class="rounded border border-blue-500/70 bg-blue-500/15 px-3 py-1.5 text-xs font-semibold text-blue-200 hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-40"
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
  props.request.fields.every((field) => !field.required || hasValue(values[field.key])),
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
