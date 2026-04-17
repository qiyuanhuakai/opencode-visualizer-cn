<template>
  <div class="content-viewer-root">
    <div v-if="showModeTabs" class="viewer-tabs">
      <button
        v-for="mode in availableModes"
        :key="mode.id"
        type="button"
        class="viewer-tab"
        :class="{ active: mode.id === activeMode }"
        @click="userSelectedMode = mode.id"
      >
        {{ mode.label }}
      </button>
    </div>
    <div class="viewer-body">
      <ImageRenderer v-if="activeMode === 'image'" :src="effectiveImageSrc || ''" :alt="path" />
      <MarkdownRenderer
        v-else-if="activeMode === 'rendered'"
        class="viewer-rendered-markdown"
        :code="effectiveFileContent || ''"
        lang="markdown"
        :theme="theme"
        :copy-button-label="t('render.copyCode')"
        :copied-label="t('render.copied')"
        :copy-code-aria-label="t('render.copyCodeAria')"
        :copy-markdown-aria-label="t('render.copyMarkdownAria')"
        @rendered="emit('rendered')"
      />
      <HexRenderer v-else-if="activeMode === 'hex'" :raw-html="effectiveRawHtml" />
      <CodeRenderer
        v-else
        :path="path"
        :absolute-path="absolutePath"
        :raw-html="effectiveRawHtml"
        :file-content="effectiveFileContent ?? ''"
        :lang="lang"
        :gutter-mode="gutterMode"
        :theme="theme"
        :lines="lines"
        :on-request-add-line-comment="onRequestAddLineComment"
        @rendered="emit('rendered')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import hexdump from '@kikuchan/hexdump';
import CodeRenderer from '../renderers/CodeRenderer.vue';
import HexRenderer from '../renderers/HexRenderer.vue';
import ImageRenderer from '../renderers/ImageRenderer.vue';
import MarkdownRenderer from '../renderers/MarkdownRenderer.vue';

const { t } = useI18n();

type ModeId = 'rendered' | 'source' | 'image' | 'hex';

const props = defineProps<{
  path?: string;
  absolutePath?: string;
  rawHtml?: string;
  fileContent?: string;
  binaryBase64?: string;
  lang?: string;
  gutterMode?: 'default' | 'none' | 'grep-source';
  theme?: string;
  lines?: string;
  imageSrc?: string;
  onRequestAddLineComment?: (payload: { path: string; startLine: number; endLine: number; text: string }) => void;
}>();

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const BITMAP_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

function mimeTypeFromExt(ext?: string) {
  switch ((ext ?? '').toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function decodeBase64ToBinaryString(input?: string) {
  if (!input) return undefined;
  try {
    return atob(input);
  } catch {
    return undefined;
  }
}

function encodeBinaryStringToBase64(input?: string) {
  if (input == null) return undefined;
  try {
    return btoa(input);
  } catch {
    return undefined;
  }
}

function toByteArray(input: string) {
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    bytes[i] = input.charCodeAt(i) & 0xff;
  }
  return bytes;
}

const pathExt = computed(() => props.path?.split('.').pop()?.toLowerCase());

const isMarkdown = computed(() => {
  if (props.lang === 'markdown') return true;
  return pathExt.value === 'md' || pathExt.value === 'markdown';
});

const isBitmapImage = computed(() => BITMAP_EXTENSIONS.has(pathExt.value ?? ''));
const canShowAsImage = computed(() => IMAGE_EXTENSIONS.has(pathExt.value ?? ''));

const normalizedBinaryContent = computed(() => decodeBase64ToBinaryString(props.binaryBase64));
const effectiveFileContent = computed(() => props.fileContent ?? normalizedBinaryContent.value);

const effectiveImageSrc = computed(() => {
  if (props.imageSrc) return props.imageSrc;
  if (!canShowAsImage.value) return undefined;
  const contentBase64 =
    props.binaryBase64 ?? encodeBinaryStringToBase64(effectiveFileContent.value);
  if (!contentBase64) return undefined;
  return `data:${mimeTypeFromExt(pathExt.value)};base64,${contentBase64}`;
});

const effectiveRawHtml = computed(() => {
  if (props.rawHtml) return props.rawHtml;
  if (!isBitmapImage.value) return undefined;
  if (!effectiveFileContent.value) return undefined;
  const dump = hexdump(toByteArray(effectiveFileContent.value), { color: 'html' });
  return `<pre class="shiki"><code>${dump}</code></pre>`;
});

const availableModes = computed<Array<{ id: ModeId; label: string }>>(() => {
  const modes: Array<{ id: ModeId; label: string }> = [];
  if (effectiveImageSrc.value) modes.push({ id: 'image', label: t('viewers.content.image') });
  if (isMarkdown.value && effectiveFileContent.value != null) {
    modes.push({ id: 'rendered', label: t('viewers.content.rendered') });
    modes.push({ id: 'source', label: t('viewers.content.source') });
  } else if (effectiveFileContent.value != null && !isBitmapImage.value) {
    modes.push({ id: 'source', label: t('viewers.content.source') });
  }
  if (effectiveRawHtml.value) modes.push({ id: 'hex', label: t('viewers.content.hex') });
  if (modes.length === 0) modes.push({ id: 'source', label: t('viewers.content.source') });
  return modes;
});

const preferredDefaultMode = computed<ModeId>(() => 'source');

// Explicit user tab selection (null = use type-based default)
const userSelectedMode = ref<ModeId | null>(null);

// Reset user selection when the viewed file changes
watch(
  () => props.path,
  () => {
    userSelectedMode.value = null;
  },
);

const activeMode = computed<ModeId>(() => {
  const modes = availableModes.value;
  // Honor explicit user choice if still valid
  if (userSelectedMode.value && modes.some((m) => m.id === userSelectedMode.value)) {
    return userSelectedMode.value;
  }
  // File-type preferred default
  const preferred = modes.find((m) => m.id === preferredDefaultMode.value);
  if (preferred) return preferred.id;
  // Fallback
  return modes[0]?.id ?? 'source';
});

const showModeTabs = computed(() => availableModes.value.length > 1);
</script>

<style scoped>
.content-viewer-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.viewer-tabs {
  display: flex;
  gap: 0;
  background: var(--floating-surface-muted, rgba(26, 29, 36, 0.95));
  border-bottom: 1px solid var(--floating-border-muted, rgba(90, 100, 120, 0.35));
  overflow-x: auto;
  scrollbar-width: none;
  flex-shrink: 0;
}

.viewer-tabs::-webkit-scrollbar {
  display: none;
}

.viewer-tab {
  border: 0;
  background: transparent;
  color: var(--floating-text-soft, #8a8f9a);
  font-size: 11px;
  font-family: inherit;
  padding: 3px 10px;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition:
    color 0.15s,
    border-color 0.15s;
}

.viewer-tab:hover {
  color: var(--floating-text-secondary, #cbd5e1);
}

.viewer-tab.active {
  color: var(--floating-text, #e2e8f0);
  border-bottom-color: color-mix(in srgb, var(--window-color, #3a4150) 50%, #60a5fa);
}

.viewer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.viewer-rendered-markdown {
  padding: 0.75em 1em;
}
</style>
