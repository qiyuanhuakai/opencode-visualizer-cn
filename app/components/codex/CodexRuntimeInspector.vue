<template>
  <section class="flex h-full min-h-0 flex-col [background:var(--theme-floating-surface-base)] font-mono text-[var(--theme-text-primary)]">
    <header class="flex shrink-0 items-center justify-between border-b border-[var(--theme-border-subtle)] px-4 py-3">
      <h2 class="text-sm font-semibold">{{ t('codexPanel.runtime.title') }}</h2>
      <button
        type="button"
        class="rounded-lg border border-[var(--theme-form-control-border)] [background:var(--theme-form-button-bg)] px-3 py-1.5 text-xs hover:border-[var(--theme-accent-primary)] disabled:opacity-50"
        :disabled="refreshing || api.threadGoalLoading.value"
        @click="refreshAll"
      >
        {{ t('common.refresh') }}
      </button>
    </header>

    <div class="grid min-h-0 flex-1 gap-3 overflow-auto p-4 lg:grid-cols-2">
      <article class="rounded-xl border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-3 lg:col-span-2">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-muted)]">
          {{ t('codexPanel.runtime.capabilities') }}
        </h3>
        <div class="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="entry in capabilityEntries" :key="entry.method" class="flex items-center justify-between gap-3 text-xs">
            <code class="truncate text-[var(--theme-text-secondary)]">{{ entry.method }}</code>
            <span class="shrink-0 rounded-full px-2 py-0.5" :class="capabilityClass(entry.state)">
              {{ t(`codexPanel.runtime.${entry.state}`) }}
            </span>
          </div>
        </div>
      </article>

      <CodexThreadGoalEditor ref="goalEditor" :api="api" />


      <article class="rounded-xl border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-3">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-muted)]">{{ t('codexPanel.runtime.provider') }}</h3>
        <div class="space-y-1.5 text-xs">
          <div v-for="item in providerEntries" :key="item.key" class="flex justify-between"><span>{{ item.key }}</span><span :class="item.value ? 'text-[var(--codex-status-success)]' : 'text-[var(--theme-text-muted)]'">{{ t(`codexPanel.runtime.${item.value ? 'enabled' : 'disabled'}`) }}</span></div>
        </div>
      </article>

      <article class="rounded-xl border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-3">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-muted)]">{{ t('codexPanel.runtime.permissionProfiles') }}</h3>
        <div class="space-y-2 text-xs"><div v-for="profile in api.permissionProfiles.value" :key="profile.id"><code class="text-[var(--theme-accent-primary)]">{{ profile.id }}</code><p v-if="profile.description" class="mt-0.5 text-[var(--theme-text-muted)]">{{ profile.description }}</p></div></div>
      </article>

      <article class="rounded-xl border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-3">
        <div class="mb-3 flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-muted)]">{{ t('codexPanel.runtime.loadedThreads') }}</h3>
          <button type="button" class="rounded border border-[var(--theme-form-control-border)] px-2 py-1 text-[11px] text-[var(--theme-text-secondary)] hover:border-[var(--codex-status-warning)] disabled:opacity-50" :disabled="cleaning || !api.activeThreadId.value" @click="cleanBackgroundTerminals">{{ t('codexPanel.runtime.cleanBackgroundTerminals') }}</button>
        </div>
        <div class="space-y-1 text-xs text-[var(--theme-text-muted)]"><code v-for="threadId in api.loadedThreadIds.value" :key="threadId" class="block truncate">{{ threadId }}</code></div>
      </article>

      <article class="rounded-xl border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-3 lg:col-span-2">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-muted)]">{{ t('codexPanel.runtime.configRequirements') }}</h3>
        <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--theme-text-muted)]">{{ formattedRequirements }}</pre>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CodexCapabilityState } from '../../backends/codex/capabilityRegistry';
import CodexThreadGoalEditor from './CodexThreadGoalEditor.vue';
import type { useCodexApi } from '../../composables/useCodexApi';

const props = defineProps<{ api: ReturnType<typeof useCodexApi> }>();
const { t } = useI18n();
const goalEditor = ref<InstanceType<typeof CodexThreadGoalEditor> | null>(null);
const refreshing = ref(false);
const cleaning = ref(false);
const methods = ['thread/goal/get', 'account/usage/read', 'modelProvider/capabilities/read', 'permissionProfile/list', 'configRequirements/read', 'thread/loaded/list'];

const capabilityEntries = computed(() => methods.map((method) => ({
  method,
  state: props.api.runtimeCapabilities.value[method] ?? 'unknown' as CodexCapabilityState,
})));
const providerEntries = computed(() => Object.entries(props.api.modelProviderCapabilities.value ?? {}).map(([key, value]) => ({ key, value })));
const formattedRequirements = computed(() => JSON.stringify(props.api.configRequirements.value ?? {}, null, 2));

function capabilityClass(state: CodexCapabilityState) {
  if (state === 'supported') return '[background:var(--theme-surface-success-soft)] text-[var(--codex-status-success)]';
  if (state === 'gated') return '[background:var(--theme-surface-warning-soft)] text-[var(--codex-status-warning)]';
  if (state === 'unsupported') return '[background:var(--theme-surface-danger-soft)] text-[var(--codex-status-danger)]';
  return '[background:var(--theme-surface-panel-hover)] text-[var(--theme-text-muted)]';
}

async function refreshAll() {
  refreshing.value = true;
  try {
    await Promise.allSettled([
      goalEditor.value?.refresh(),
      props.api.refreshModelProviderCapabilities(),
      props.api.refreshPermissionProfiles(),
      props.api.refreshConfigRequirements(),
      props.api.refreshLoadedThreads(),
    ]);
  } finally {
    refreshing.value = false;
  }
}

async function cleanBackgroundTerminals() {
  if (!props.api.activeThreadId.value) return;
  cleaning.value = true;
  try {
    await props.api.cleanThreadBackgroundTerminals(props.api.activeThreadId.value);
    await props.api.refreshLoadedThreads();
  } finally {
    cleaning.value = false;
  }
}

onMounted(refreshAll);
</script>
