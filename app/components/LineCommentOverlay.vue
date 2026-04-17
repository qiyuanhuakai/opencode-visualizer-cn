<template>
  <div class="line-comment-overlay">
    <!-- Range highlight -->
    <template v-if="selectedRange">
      <div
        v-for="(style, i) in rangeHighlightStyles"
        :key="`range-${i}`"
        class="comment-range-highlight"
        :style="style"
      />
    </template>

    <!-- Editor -->
    <div
      v-if="editingLine != null && editRect"
      class="comment-editor"
      :style="editCardStyle"
    >
      <div v-if="editRangeLabel" class="comment-editor-label">{{ editRangeLabel }}</div>
      <textarea
        ref="textareaRef"
        v-model="text"
        class="comment-textarea"
        :placeholder="t('lineCommentOverlay.placeholder')"
        @keydown="onTextareaKeydown"
      />
      <div class="comment-actions">
        <button type="button" class="comment-btn comment-btn-cancel" @click="onCancel">
          {{ t('common.cancel') }}
        </button>
        <button type="button" class="comment-btn comment-btn-submit" @click="onSubmit">
          {{ t('lineCommentOverlay.comment') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{
  editingLine: number | null;
  selectedRange: { start: number; end: number } | null;
  rowRects: Array<{ top: number; height: number; right: number }>;
  containerWidth: number;
}>();

const emit = defineEmits<{
  (event: 'submit', text: string): void;
  (event: 'cancel'): void;
}>();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const POPUP_MAX_WIDTH = 360;
const POPUP_MARGIN = 16;

const editLine = computed(() => {
  if (props.editingLine != null) return props.editingLine;
  return null;
});

const editRect = computed(() => {
  const line = editLine.value;
  if (line == null) return null;
  return props.rowRects[line] ?? null;
});

const editRangeLabel = computed(() => {
  if (!props.selectedRange) return null;
  if (props.selectedRange.start === props.selectedRange.end) return null;
  return `Lines ${props.selectedRange.start + 1}–${props.selectedRange.end + 1}`;
});

const rangeHighlightStyles = computed(() => {
  if (!props.selectedRange) return [];
  const { start, end } = props.selectedRange;
  const styles: Array<Record<string, string>> = [];
  for (let i = start; i <= end; i++) {
    const rect = props.rowRects[i];
    if (!rect) continue;
    styles.push({
      top: `${rect.top}px`,
      left: '0',
      right: '0',
      height: `${rect.height}px`,
    });
  }
  return styles;
});

const editCardStyle = computed(() => {
  const rect = editRect.value;
  if (!rect) return {};
  const fitsRight = rect.right + POPUP_MAX_WIDTH + POPUP_MARGIN <= props.containerWidth;
  if (fitsRight) {
    return {
      top: `${rect.top + rect.height / 2}px`,
      left: `${rect.right}px`,
      transform: 'translate(-100%, -50%)',
    };
  }
  return {
    top: `${rect.top + rect.height / 2}px`,
    right: '8px',
    left: 'auto',
    transform: 'translate(0, -50%)',
  };
});

watch(
  () => props.editingLine,
  (line) => {
    if (line != null) {
      text.value = '';
      void nextTick(() => {
        textareaRef.value?.focus();
      });
    }
  },
);

function onSubmit() {
  const trimmed = text.value.trim();
  if (!trimmed) return;
  emit('submit', trimmed);
}

function onCancel() {
  emit('cancel');
}

function onTextareaKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    onCancel();
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    onSubmit();
  }
}
</script>

<style scoped>
.line-comment-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 50;
}

.comment-range-highlight {
  position: absolute;
  pointer-events: none;
  background: rgba(250, 204, 21, 0.18);
  border-left: 2px solid rgba(250, 204, 21, 0.55);
}

.comment-editor {
  position: absolute;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 240px;
  max-width: 360px;
  padding: 10px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: 10px;
  background: var(--theme-surface-panel-elevated, rgba(2, 6, 23, 0.98));
  box-shadow: var(--theme-dropdown-shadow, 0 12px 24px rgba(2, 6, 23, 0.45));
}

.comment-editor-label {
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
  font-weight: 600;
}

.comment-textarea {
  width: 100%;
  min-height: 64px;
  resize: vertical;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--theme-border-muted, rgba(148, 163, 184, 0.35));
  border-radius: 6px;
  background: var(--theme-surface-panel-muted, #0b1320);
  color: var(--theme-text-primary, #e2e8f0);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  outline: none;
}

.comment-textarea:focus {
  border-color: var(--theme-border-accent, rgba(96, 165, 250, 0.65));
}

.comment-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.comment-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 26px;
  padding: 0 10px;
  margin: 0;
  border: 1px solid var(--theme-border-muted, rgba(148, 163, 184, 0.45));
  border-radius: 6px;
  background: var(--theme-surface-chip, rgba(15, 23, 42, 0.75));
  color: var(--theme-text-primary, #bfdbfe);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}

.comment-btn:hover {
  background: var(--theme-surface-chip-hover, rgba(30, 41, 59, 0.92));
}

.comment-btn-submit {
  border-color: var(--theme-border-accent, rgba(96, 165, 250, 0.6));
  background: var(--theme-dropdown-active-bg, rgba(30, 58, 138, 0.35));
}

.comment-btn-submit:hover {
  background: var(--theme-chip-bg-hover, rgba(30, 64, 175, 0.55));
}
</style>
