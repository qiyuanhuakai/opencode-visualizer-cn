<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  KimiWebPlugin,
  KimiWebPluginCatalogEntry,
  KimiWebPluginsClient,
} from '../../utils/kimiWebPlugins';
import { kimiWebPlugins } from '../../locales/kimiWebPlugins';

const props = defineProps<{ client: KimiWebPluginsClient }>();
const { locale } = useI18n();
const copy = computed(() => {
  switch (locale.value) {
    case 'zh-CN':
    case 'zh-TW':
    case 'ja':
    case 'eo':
      return kimiWebPlugins[locale.value];
    default:
      return kimiWebPlugins.en;
  }
});
const confirm = inject<((message: string) => Promise<boolean>) | undefined>('showConfirm');
const plugins = ref<readonly KimiWebPlugin[]>([]);
const catalog = ref<readonly KimiWebPluginCatalogEntry[]>([]);
const source = ref('');
const busy = ref(false);
const feedback = ref('');
const failed = ref(false);
const listReady = ref(false);
const catalogFailed = ref(false);
const available = computed(() =>
  catalog.value.filter((entry) => !plugins.value.some((plugin) => plugin.id === entry.id)),
);

async function load() {
  const [installed, market] = await Promise.allSettled([
    props.client.list(),
    props.client.marketplace(),
  ]);
  if (installed.status === 'rejected') {
    listReady.value = false;
    throw installed.reason;
  }
  plugins.value = installed.value;
  listReady.value = true;
  catalogFailed.value = market.status === 'rejected';
  catalog.value = market.status === 'fulfilled' ? market.value : [];
}

async function refresh() {
  if (busy.value) return;
  busy.value = true;
  feedback.value = '';
  failed.value = false;
  try {
    await load();
  } catch (error) {
    failed.value = true;
    feedback.value = error instanceof Error ? error.message : copy.value.failed;
  } finally {
    busy.value = false;
  }
}

async function mutate(operation: () => Promise<unknown>) {
  if (busy.value || !listReady.value) return;
  busy.value = true;
  feedback.value = '';
  failed.value = false;
  try {
    await operation();
    source.value = '';
    try {
      await load();
      feedback.value = copy.value.saved;
    } catch {
      failed.value = true;
      feedback.value = copy.value.refreshFailed;
    }
  } catch (error) {
    failed.value = true;
    feedback.value = error instanceof Error ? error.message : copy.value.failed;
  } finally {
    busy.value = false;
  }
}

function install(value: string) {
  const normalized = value.trim();
  if (normalized) void mutate(() => props.client.install(normalized));
}

async function remove(id: string) {
  if (!listReady.value) return;
  const accepted = confirm
    ? await confirm(copy.value.removeConfirm)
    : window.confirm(copy.value.removeConfirm);
  if (accepted) await mutate(() => props.client.action(id, 'remove'));
}

onMounted(refresh);
</script>

<template>
  <section class="kimi-plugins" :aria-label="copy.title" :aria-busy="busy">
    <header class="plugin-toolbar">
      <strong>{{ copy.title }}</strong>
      <button type="button" :disabled="busy" @click="refresh">{{ copy.refresh }}</button>
    </header>
    <form v-if="listReady" @submit.prevent="install(source)">
      <label
        >{{ copy.source }}<input v-model="source" :placeholder="copy.sourceHint" :disabled="busy"
      /></label>
      <button type="submit" :disabled="busy || !source.trim()">{{ copy.install }}</button>
    </form>
    <p v-if="feedback" :role="failed ? 'alert' : 'status'" :class="{ 'is-error': failed }">
      {{ feedback }}
    </p>
    <p v-if="busy" role="status">{{ copy.loading }}</p>
    <p v-else-if="!failed && plugins.length === 0">{{ copy.empty }}</p>
    <article v-for="plugin in plugins" :key="plugin.id" :data-plugin-id="plugin.id">
      <div class="identity">
        <strong :title="plugin.displayName">{{ plugin.displayName }}</strong>
        <div class="plugin-meta">
          <small :title="plugin.id">{{ plugin.id }} {{ plugin.version }}</small>
          <small
            class="plugin-state"
            :class="{
              'is-error': plugin.state === 'error',
              'is-enabled': plugin.enabled && plugin.state === 'ok',
            }"
            >{{
              plugin.state === 'error' ? copy.error : plugin.enabled ? copy.enabled : copy.disabled
            }}</small
          >
        </div>
      </div>
      <div class="actions">
        <button
          type="button"
          :disabled="busy || !listReady"
          :aria-pressed="plugin.enabled"
          @click="mutate(() => client.action(plugin.id, plugin.enabled ? 'disable' : 'enable'))"
        >
          {{ plugin.enabled ? copy.disable : copy.enable }}
        </button>
        <button type="button" class="is-danger" :disabled="busy || !listReady" @click="remove(plugin.id)">
          {{ copy.remove }}
        </button>
      </div>
    </article>
    <p v-if="catalogFailed" role="status">{{ copy.catalogFailed }}</p>
    <details v-if="listReady && available.length">
      <summary>{{ copy.marketplace }} ({{ available.length }})</summary>
      <article v-for="entry in available" :key="entry.id">
        <div class="identity">
          <strong :title="entry.displayName">{{ entry.displayName }}</strong>
          <small :title="entry.description || entry.source">{{
            entry.description || entry.source
          }}</small>
        </div>
        <button type="button" :disabled="busy" @click="install(entry.source)">
          {{ copy.install }}
        </button>
      </article>
    </details>
  </section>
</template>

<style scoped>
.kimi-plugins {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  font-family: var(--app-monospace-font-family);
  font-size: var(--type-body);
  line-height: 1.4;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}
.plugin-toolbar,
form,
article,
.actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
}

.plugin-toolbar strong {
  font-size: var(--type-sm);
  font-weight: 600;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

form {
  align-items: flex-end;
  padding-bottom: var(--space-1);
}

article {
  padding: 8px 12px;
  border: 1px solid
    var(--theme-list-row-border, var(--theme-modal-border, rgba(148, 163, 184, 0.12)));
  border-radius: var(--radius-control);
  background: var(--theme-list-row-bg, var(--theme-modal-control-bg, rgba(30, 41, 59, 0.55)));
  min-width: 0;
}
label,
.identity {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  flex: 1 1 180px;
  overflow-wrap: anywhere;
}

label {
  font-size: var(--type-sm);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.identity {
  gap: 2px;
}

.identity strong {
  font-size: var(--type-body);
  font-weight: 500;
  color: var(--theme-list-row-text, var(--theme-text-primary, #e2e8f0));
}

.identity strong,
.identity small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) 8px;
  min-width: 0;
}

.plugin-state {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.plugin-state::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--theme-status-neutral, #94a3b8);
}

.plugin-state.is-enabled::before {
  background: var(--theme-status-success, #86efac);
}
.plugin-state.is-error::before {
  background: var(--theme-status-danger, #fca5a5);
}

small,
p {
  color: var(--theme-list-row-text-muted, var(--theme-modal-text-muted, #94a3b8));
  font-size: var(--type-sm);
  margin: 0;
  overflow-wrap: anywhere;
}
input,
button {
  min-height: 28px;
  font-family: inherit;
  font-size: var(--type-sm);
  line-height: 1.4;
  color: var(--theme-action-button-text, var(--theme-modal-text, #e2e8f0));
  background: var(--theme-action-button-bg, var(--theme-modal-control-bg, transparent));
  border: 1px solid var(--theme-action-button-border, var(--theme-modal-border, #334155));
  border-radius: var(--radius-control);
  padding: 4px 8px;
}
input {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  color: var(--theme-search-text, var(--theme-modal-text, #e2e8f0));
  background: var(--theme-search-bg, var(--theme-modal-control-bg, transparent));
  border-color: var(--theme-search-border, var(--theme-modal-border, #334155));
}
input::placeholder {
  color: var(--theme-search-placeholder, var(--theme-modal-text-muted, #94a3b8));
}
button,
summary {
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: var(--theme-action-button-hover-bg, var(--theme-modal-active-bg, transparent));
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button:focus-visible,
input:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--theme-focus-ring, var(--theme-modal-accent, #3b82f6));
  outline-offset: 2px;
}
details article {
  margin-top: var(--space-2);
}

summary {
  padding: 4px 0;
  font-size: var(--type-sm);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.is-error,
button.is-danger {
  color: var(--theme-text-danger, #fca5a5);
}

@media (max-width: 480px) {
  article {
    padding: 8px;
  }
  .actions {
    margin-left: auto;
  }
  .identity {
    flex-basis: 140px;
  }
}
</style>
