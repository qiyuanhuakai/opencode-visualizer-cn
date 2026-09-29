<template>
  <section class="rounded-lg border border-[var(--theme-border-subtle)] [background:var(--theme-card-bg)] p-2">
    <div class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--theme-text-muted)]">
      {{ t('codexPanel.fsInspector.title') }}
    </div>
    <div class="flex gap-2">
      <input
        v-model="path"
        class="min-w-0 flex-1 rounded-lg border border-[var(--theme-form-control-border)] [background:var(--theme-form-control-bg)] px-2 py-1.5 text-xs text-[var(--theme-text-primary)]"
        :placeholder="t('codexPanel.fsInspector.path')"
      />
      <button type="button" class="rounded-lg border border-[var(--theme-form-control-border)] px-2 py-1 text-xs" :disabled="busy || !path.trim()" @click="readMetadata">
        {{ t('codexPanel.fsInspector.metadata') }}
      </button>
      <button v-if="!watchId" type="button" class="rounded-lg border border-[var(--theme-form-control-border)] px-2 py-1 text-xs" :disabled="busy || !path.trim()" @click="startWatch">
        {{ t('codexPanel.fsInspector.watch') }}
      </button>
      <button v-else type="button" class="rounded-lg border border-[var(--codex-status-warning)] px-2 py-1 text-xs text-[var(--codex-status-warning)]" :disabled="busy" @click="stopWatch">
        {{ t('codexPanel.fsInspector.unwatch') }}
      </button>
    </div>
    <pre v-if="metadata" class="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-[var(--theme-text-muted)]">{{ metadata }}</pre>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';

let watchSequence = 0;
const props = defineProps<{ api: ReturnType<typeof useCodexApi> }>();
const { t } = useI18n();
const path = ref(props.api.previewFilePath.value || props.api.fsCwd.value);
const metadata = ref('');
const watchId = ref('');
const busy = ref(false);

watch(
  () => props.api.previewFilePath.value || props.api.fsCwd.value,
  (nextPath) => {
    if (!watchId.value && nextPath) path.value = nextPath;
  },
);

async function readMetadata() {
  busy.value = true;
  try {
    metadata.value = JSON.stringify(await props.api.fsGetMetadata(path.value.trim()), null, 2);
  } finally {
    busy.value = false;
  }
}

async function startWatch() {
  const id = `vis-fs:${Date.now()}:${++watchSequence}`;
  busy.value = true;
  try {
    await props.api.fsWatch(id, path.value.trim());
    watchId.value = id;
  } finally {
    busy.value = false;
  }
}

async function stopWatch() {
  const id = watchId.value;
  if (!id) return;
  busy.value = true;
  try {
    await props.api.fsUnwatch(id);
    watchId.value = '';
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(() => {
  if (watchId.value) void props.api.fsUnwatch(watchId.value);
});
</script>
