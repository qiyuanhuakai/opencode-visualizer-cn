<template>
  <div v-if="filePopup.visible" class="file-ref-popup" :style="filePopup.style">
    <button
      v-for="candidate in filePopup.candidates"
      :key="candidate"
      type="button"
      class="file-ref-popup-item"
      @click.stop="openFileFromPopup(candidate)"
    >
      {{ candidate }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue';

const props = defineProps<{
  files: string[];
}>();

const emit = defineEmits<{
  (event: 'open-file', path: string, lines?: string): void;
}>();

const filePopup = reactive({
  visible: false,
  candidates: [] as string[],
  lines: undefined as string | undefined,
  style: {} as Record<string, string>,
});

function resolveFileRef(ref: string): string[] {
  if (!ref) return [];
  if (ref.includes('/')) {
    return props.files.filter((path) => path === ref || path.endsWith(`/${ref}`));
  }
  return props.files.filter((path) => path.split('/').at(-1) === ref);
}

function closeFilePopup() {
  filePopup.visible = false;
  filePopup.candidates = [];
  filePopup.lines = undefined;
}

function showFilePopup(anchorEl: HTMLElement, candidates: string[], lines?: string) {
  const rect = anchorEl.getBoundingClientRect();
  const maxWidth = Math.min(window.innerWidth - 16, 480);
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - maxWidth - 8));
  const top = Math.min(window.innerHeight - 12, rect.bottom + 6);
  filePopup.style = {
    left: `${left}px`,
    top: `${top}px`,
    maxWidth: `${maxWidth}px`,
  };
  filePopup.candidates = candidates;
  filePopup.lines = lines;
  filePopup.visible = true;
}

function openFileFromPopup(path: string) {
  const lines = filePopup.lines;
  closeFilePopup();
  emit('open-file', path, lines);
}

function handleContentClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (filePopup.visible && !target.closest('.file-ref-popup')) {
    closeFilePopup();
  }
  const fileRefEl = target.closest('[data-file-ref]');
  if (!(fileRefEl instanceof HTMLElement)) return;
  const rawRef = fileRefEl.dataset.fileRef;
  const ref = rawRef?.trim();
  if (!ref) return;
  const lines = fileRefEl.dataset.fileLines?.trim() || undefined;
  const candidates = resolveFileRef(ref);
  if (candidates.length === 0) return;
  if (candidates.length === 1) {
    emit('open-file', candidates[0], lines);
    return;
  }
  showFilePopup(fileRefEl, candidates, lines);
}

defineExpose({
  handleContentClick,
  closeFilePopup,
});
</script>

<style scoped>
.file-ref-popup {
  position: fixed;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--theme-output-border, #334155);
  background: var(--theme-output-bg, rgba(15, 23, 42, 0.98));
  box-shadow: var(--theme-shadow-panel, 0 14px 30px rgba(2, 6, 23, 0.5));
}

.file-ref-popup-item {
  border: 1px solid var(--theme-output-border, #334155);
  border-radius: 6px;
  background: var(--theme-output-control-bg, rgba(30, 41, 59, 0.7));
  color: var(--theme-output-text, #cbd5e1);
  text-align: left;
  font-size: 12px;
  line-height: 1.3;
  padding: 5px 8px;
  cursor: pointer;
}

.file-ref-popup-item:hover {
  border-color: var(--theme-output-accent, #7dd3fc);
  color: var(--theme-output-accent, #7dd3fc);
}
</style>
