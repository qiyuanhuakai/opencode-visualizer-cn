<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import type { DraftHeader } from '../../runtime/draftStore';
import type { createQualifiedComposerDrafts } from '../../runtime/qualifiedComposerDrafts';
const props = defineProps<{ context: string; header: DraftHeader; storage: ReturnType<typeof createQualifiedComposerDrafts> }>();
const emit = defineEmits<{ saved: [header: DraftHeader] }>();
const index = ref(0);
const text = ref('');
const original = ref('');
const busy = ref(false);
const error = ref('');
const body = computed(() => props.header.parts.find(part => part.name === 'body'));
const dirty = computed(() => text.value !== original.value);
let generation = 0;
let disposed = false;
let pendingSavedText: string | null = null;
function capture() {
  const token = ++generation, context = props.context, header = props.header, storage = props.storage;
  return { context, header, storage, current: () => !disposed && token === generation && props.context === context && props.header === header && props.storage === storage };
}
async function load(next: number) {
  const owner = capture(); busy.value = true; error.value = '';
  try { const value = await owner.storage.readBodySegment(owner.header, next); if (owner.current()) { index.value = next; text.value = value; original.value = value; } }
  catch (cause) { if (owner.current()) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (owner.current()) busy.value = false; }
}
async function save(): Promise<boolean> {
  if (busy.value || props.storage.recoveryPending) return false;
  const owner = capture(), value = text.value, segment = index.value;
  pendingSavedText = value;
  busy.value = true; error.value = '';
  try {
    const header = await owner.storage.saveBodySegment(owner.context, owner.header, segment, value);
    if (!owner.current()) return false;
    original.value = value; pendingSavedText = null; busy.value = false; emit('saved', header); return true;
  } catch (cause) { if (owner.current()) error.value = cause instanceof Error ? cause.message : String(cause); return false; }
  finally { if (owner.current()) busy.value = false; }
}
async function retry() {
  const owner = capture(); busy.value = true;
  const persistedText = pendingSavedText;
  try {
    const header = await owner.storage.retry();
    if (!owner.current()) return;
    busy.value = false; error.value = '';
    if (header) { original.value = persistedText ?? original.value; pendingSavedText = null; emit('saved', header); }
  } catch (cause) { if (owner.current()) error.value = String(cause); }
  finally { if (owner.current()) busy.value = false; }
}
defineExpose({ flush: async () => !busy.value && (!dirty.value || await save()) });
onBeforeUnmount(() => { disposed = true; generation++; });
async function exportPart(name: string) {
  type FilePicker = { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }> };
  const picker = (window as Window & FilePicker).showSaveFilePicker;
  if (!picker) { error.value = 'Streaming file export requires a browser with the file save picker.'; return; }
  const owner = capture();
  error.value = ''; busy.value = true;
  try {
    const handle = await picker({ suggestedName: `${name.replace(/[^a-z0-9._-]/gi, '_')}.txt` });
    const sink = await handle.createWritable();
    try { await owner.storage.exportPart(owner.header, name, sink); await sink.close(); }
    catch (cause) { await sink.abort(); throw cause; }
  } catch (cause) { if (owner.current()) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (owner.current()) busy.value = false; }
}
watch(() => props.context, () => { index.value = 0; if (body.value?.chunks) void load(0); }, { immediate: true });
</script>
<template>
  <section class="runtime-draft-editor" data-runtime-ui data-testid="runtime-draft-editor">
    <p>{{ rt('Large saved draft · {bytes} bytes. Edit one segment at a time. Export the body and reduce it before sending; native requests accept at most 1 MiB.', { bytes: body?.bytes ?? 0 }) }}</p>
    <template v-if="body?.chunks">
      <label for="runtime-draft-segment">{{ rt('Segment {index} / {total}', { index: index + 1, total: body.chunks }) }}</label>
      <textarea id="runtime-draft-segment" class="draft-segment" v-model="text" :disabled="busy" spellcheck="false" />
      <div class="actions">
        <button class="action-button" :disabled="busy || dirty || index === 0" @click="load(index - 1)">{{ rt('Previous') }}</button>
        <button class="action-button" :disabled="busy || dirty || index + 1 >= body.chunks" @click="load(index + 1)">{{ rt('Next') }}</button>
        <button class="action-button primary" :disabled="busy || !dirty || storage.recoveryPending" @click="save">{{ rt('Save segment') }}</button>
      </div>
    </template>
    <div class="actions"><button class="action-button" v-for="part in header.parts" :key="part.name" :disabled="busy || dirty" @click="exportPart(part.name)">{{ rt('Export {name} ({bytes} bytes)', { name: part.name, bytes: part.bytes }) }}</button></div>
    <p v-if="error" role="alert">{{ rt(error) }} <button class="action-button" @click="retry">{{ rt('Retry storage') }}</button></p>
  </section>
</template>
<style scoped>
.runtime-draft-editor { margin: var(--space-2); padding: var(--space-3); max-height: 45vh; min-width: 0; overflow: auto; box-sizing: border-box; border: 1px solid var(--theme-border-default); border-radius: var(--radius-control); font-size: var(--type-sm); color: var(--theme-text-primary); background: var(--theme-surface-panel); }
.runtime-draft-editor p { margin: 0 0 var(--space-2); font-size: var(--type-sm); }
label { display: block; margin-bottom: var(--space-1); font-size: var(--type-sm); }
textarea { display: block; width: 100%; height: 140px; box-sizing: border-box; padding: var(--space-2); border-radius: var(--radius-control); color: var(--ui-form-control-text); background: var(--ui-form-control-bg); border: 1px solid var(--ui-form-control-border); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
button { color: var(--ui-form-button-text); background: var(--ui-form-button-bg); border: 1px solid var(--ui-form-button-border); border-radius: var(--radius-control); padding: var(--space-1) var(--space-2); }
button:disabled { opacity: .5; }
</style>
