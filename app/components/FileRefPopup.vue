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
  (event: 'open-file', path: string, line?: number, endLine?: number): void;
}>();

const filePopup = reactive({
  visible: false,
  candidates: [] as string[],
  line: undefined as number | undefined,
  endLine: undefined as number | undefined,
  style: {} as Record<string, string>,
});

function resolveFileRef(ref: string): string[] {
  if (!ref) return [];
  if (ref.includes('/')) {
    return props.files.filter((path) => path === ref);
  }
  return props.files.filter((path) => path.split('/').at(-1) === ref);
}

function closeFilePopup() {
  filePopup.visible = false;
  filePopup.candidates = [];
  filePopup.line = undefined;
  filePopup.endLine = undefined;
}

function showFilePopup(
  anchorEl: HTMLElement,
  candidates: string[],
  line?: number,
  endLine?: number,
) {
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
  filePopup.line = line;
  filePopup.endLine = endLine;
  filePopup.visible = true;
}

function openFileFromPopup(path: string) {
  const line = filePopup.line;
  const endLine = filePopup.endLine;
  closeFilePopup();
  emit('open-file', path, line, endLine);
}

function parsePositiveInt(raw?: string) {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
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

  const line = parsePositiveInt(fileRefEl.dataset.fileLine);
  let endLine = parsePositiveInt(fileRefEl.dataset.fileEndLine);
  if (line && endLine && endLine < line) {
    endLine = line;
  }

  const candidates = resolveFileRef(ref);
  if (candidates.length === 0) return;
  if (candidates.length === 1) {
    emit('open-file', candidates[0], line, endLine);
    return;
  }
  showFilePopup(fileRefEl, candidates, line, endLine);
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
  border: 1px solid #334155;
  background: rgba(15, 23, 42, 0.98);
  box-shadow: 0 14px 30px rgba(2, 6, 23, 0.5);
}

.file-ref-popup-item {
  border: 1px solid #334155;
  border-radius: 6px;
  background: rgba(30, 41, 59, 0.7);
  color: #cbd5e1;
  text-align: left;
  font-size: 12px;
  line-height: 1.3;
  padding: 5px 8px;
  cursor: pointer;
}

.file-ref-popup-item:hover {
  border-color: #7dd3fc;
  color: #7dd3fc;
}
</style>
