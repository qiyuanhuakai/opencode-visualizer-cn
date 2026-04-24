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
      <PdfRenderer v-else-if="activeMode === 'pdf'" :src="effectivePdfSrc || ''" @rendered="emit('rendered')" />
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
      <div v-else-if="activeMode === 'info'" class="file-info-panel">
        <div v-if="fileTypeInfo" class="file-type-info">
          <div class="file-type-header">{{ fileTypeInfo.type }}</div>
          <div class="file-type-desc">{{ fileTypeInfo.description }}</div>
          <div v-if="fileTypeInfo.details" class="file-type-details">{{ fileTypeInfo.details }}</div>
        </div>
        <div v-else class="file-type-info">
          <div class="file-type-header">Unknown</div>
          <div class="file-type-desc">Binary file</div>
        </div>
      </div>
      <ArchiveRenderer
        v-else-if="activeMode === 'archive'"
        :bytes="archiveBytes || fallbackEmptyBytes"
        :extension="pathExt || ''"
      />
      <HexRenderer v-else-if="activeMode === 'hex'" :bytes="hexBytes" />
      <CodeRenderer
        v-else
        :path="path"
        :absolute-path="absolutePath"
        :raw-html="undefined"
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
import CodeRenderer from '../renderers/CodeRenderer.vue';
import HexRenderer from '../renderers/HexRenderer.vue';
import ImageRenderer from '../renderers/ImageRenderer.vue';
import MarkdownRenderer from '../renderers/MarkdownRenderer.vue';
import ArchiveRenderer from '../renderers/ArchiveRenderer.vue';
import PdfRenderer from '../renderers/PdfRenderer.vue';
import { detectFileType } from '../../utils/fileTypeDetector';

const { t } = useI18n();

type ModeId = 'rendered' | 'source' | 'image' | 'hex' | 'info' | 'archive' | 'pdf';

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

const BITMAP_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const PDF_EXTENSIONS = new Set(['pdf']);

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
      case 'ico':
        return 'image/x-icon';
      case 'pdf':
       return 'application/pdf';
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

void (function _toByteArray(input: string) {
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    bytes[i] = input.charCodeAt(i) & 0xff;
  }
  return bytes;
});

function base64ToUint8Array(base64: string): Uint8Array {
  let cleaned = base64.replace(/\s/g, '');
  cleaned = cleaned.replace(/^data:[a-z]+;base64,/, '');
  cleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (cleaned.length % 4)) % 4;
  cleaned = cleaned + '='.repeat(padding);
  const binaryString = atob(cleaned);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Detect if content is binary by checking for null bytes and high-ratio non-printable characters.
 * This is a frontend fallback when the backend does not mark the file as binary.
 */
function isBinaryContent(content: string): boolean {
  if (!content || content.length === 0) return false;
  const sampleSize = Math.min(content.length, 8192);
  let nullCount = 0;
  let nonPrintableCount = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    const code = content.charCodeAt(i);
    if (code === 0) {
      nullCount += 1;
    } else if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintableCount += 1;
    }
  }
  // If any null bytes, treat as binary
  if (nullCount > 0) return true;
  // If > 10% non-printable characters in sample, treat as binary
  if (nonPrintableCount / sampleSize > 0.1) return true;
  return false;
}

/**
 * Known binary file extensions that should always be treated as binary.
 */
const KNOWN_BINARY_EXTENSIONS = new Set([
  // Images (pdf is treated separately, not binary; icns is binary but handled specially)
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff', 'tif', 'raw', 'psd', 'xcf',
  // Executables / Libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'elf',
  // Archives
  'zip', 'gz', 'bz2', 'xz', '7z', 'rar', 'tar', 'tgz', 'tbz',
  // Documents
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Media
  'mp3', 'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'ogg', 'wav', 'flac', 'aac',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Other
  'class', 'pyc', 'pyo', 'o', 'a', 'lib', 'obj',
  'db', 'sqlite', 'sqlite3',
  'wasm',
  'pak', 'sig', 'dmg', 'iso', 'img',
]);



const fallbackEmptyBytes = new Uint8Array(0);
const pathExt = computed(() => {
  const path = props.path || '';
  const lower = path.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tar.gz';
  if (lower.endsWith('.tar.bz2')) return 'tar.bz2';
  if (lower.endsWith('.tar.xz')) return 'tar.xz';
  if (lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.tbz2')) return 'tbz2';
  if (lower.endsWith('.tbz')) return 'tbz';
  if (lower.endsWith('.txz')) return 'txz';
  return path.split('.').pop()?.toLowerCase() || '';
});

const isMarkdown = computed(() => {
  if (props.lang === 'markdown') return true;
  return pathExt.value === 'md' || pathExt.value === 'markdown';
});

const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'tar',
  'gz', 'gzip',
  'tar.gz', 'tgz',
  'bz2', 'tar.bz2', 'tbz', 'tbz2',
  'xz', 'tar.xz', 'txz',
  '7z', 'rar',
]);

const isBitmapImage = computed(() => BITMAP_EXTENSIONS.has(pathExt.value ?? ''));
const canShowAsImage = computed(() => IMAGE_EXTENSIONS.has(pathExt.value ?? ''));
const hasKnownBinaryExt = computed(() => KNOWN_BINARY_EXTENSIONS.has(pathExt.value ?? ''));
const isArchive = computed(() => ARCHIVE_EXTENSIONS.has(pathExt.value ?? ''));
const isPdf = computed(() => PDF_EXTENSIONS.has(pathExt.value ?? ''));

const normalizedBinaryContent = computed(() => decodeBase64ToBinaryString(props.binaryBase64));

/**
 * The raw file content as a string.
 * - If the backend delivered base64 binary, decode it.
 * - Otherwise use the plain text content.
 */
const effectiveFileContent = computed(() => props.fileContent ?? normalizedBinaryContent.value);

/**
 * True when the content should be treated as binary.
 * Trusts the backend's binary flag first, then falls back to:
 * 1. Known binary file extensions
 * 2. Content-based heuristics (null bytes, non-printable ratio)
 */
const shouldTreatAsBinary = computed(() => {
  if (props.binaryBase64) return true;
  if (hasKnownBinaryExt.value) return true;
  if (props.fileContent && isBinaryContent(props.fileContent)) return true;
  return false;
});

const effectiveImageSrc = computed(() => {
  if (props.imageSrc) return props.imageSrc;
  if (!canShowAsImage.value) return undefined;
  // For binary files (like icns), use binaryBase64 directly
  // For text-based images (like svg), encode fileContent to base64
  const contentBase64 = props.binaryBase64 || encodeBinaryStringToBase64(props.fileContent);
  if (!contentBase64) return undefined;
  return `data:${mimeTypeFromExt(pathExt.value)};base64,${contentBase64}`;
});

const effectivePdfSrc = computed(() => {
  if (!isPdf.value) return undefined;
  const contentBase64 = props.binaryBase64 || encodeBinaryStringToBase64(props.fileContent);
  if (!contentBase64) return undefined;
  return `data:${mimeTypeFromExt(pathExt.value)};base64,${contentBase64}`;
});

/**
 * Raw bytes for hex view and archive parsing.
 * For binary files from backend (base64), decode directly to Uint8Array.
 * For text content, convert via toByteArray.
 */
const hexBytes = computed<Uint8Array | undefined>(() => {
  if (!shouldTreatAsBinary.value) return undefined;
  if (props.binaryBase64) {
    try {
      return base64ToUint8Array(props.binaryBase64);
    } catch {
      return undefined;
    }
  }
  // For text content that should be treated as binary (e.g. executable scripts
  // with shebang, or files where the backend did not send base64), convert the
  // text content to bytes so detectFileType can still work.
  if (props.fileContent) {
    try {
      const encoder = new TextEncoder();
      return encoder.encode(props.fileContent);
    } catch {
      return undefined;
    }
  }
  return undefined;
});

const archiveBytes = computed<Uint8Array | undefined>(() => {
  if (!isArchive.value) return undefined;
  if (props.binaryBase64) {
    try {
      return base64ToUint8Array(props.binaryBase64);
    } catch {
      return undefined;
    }
  }
  return undefined;
});

const fileTypeInfo = computed(() => {
  if (!hexBytes.value || hexBytes.value.length === 0) return null;
  return detectFileType(hexBytes.value);
});

const showBinaryInfo = computed(() => {
  return fileTypeInfo.value !== null;
});

const availableModes = computed<Array<{ id: ModeId; label: string }>>(() => {
  const modes: Array<{ id: ModeId; label: string }> = [];
  if (effectiveImageSrc.value) modes.push({ id: 'image', label: t('viewers.content.image') });
  if (isPdf.value && effectivePdfSrc.value) modes.push({ id: 'pdf', label: t('viewers.content.pdf') });
  if (isMarkdown.value && effectiveFileContent.value != null) {
    modes.push({ id: 'rendered', label: t('viewers.content.rendered') });
    modes.push({ id: 'source', label: t('viewers.content.source') });
  } else if (effectiveFileContent.value != null && !isBitmapImage.value && !showBinaryInfo.value && !isPdf.value) {
    modes.push({ id: 'source', label: t('viewers.content.source') });
  }
  if (showBinaryInfo.value) {
    modes.push({ id: 'info', label: t('viewers.content.info') });
  }
  if (isArchive.value) {
    modes.push({ id: 'archive', label: t('viewers.content.archive') });
  }
  if (hexBytes.value && !isPdf.value) modes.push({ id: 'hex', label: t('viewers.content.hex') });
  if (modes.length === 0) modes.push({ id: 'source', label: t('viewers.content.source') });
  return modes;
});

const preferredDefaultMode = computed<ModeId>(() => {
  if (isPdf.value) return 'pdf';
  if (showBinaryInfo.value) return 'info';
  return 'source';
});

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

.file-info-panel {
  height: 100%;
  overflow: auto;
}

.file-type-info {
  padding: 12px 16px;
  background: var(--floating-surface-muted, rgba(26, 29, 36, 0.95));
  border-bottom: 1px solid var(--floating-border-muted, rgba(90, 100, 120, 0.35));
  font-family: var(--term-font-family, 'JetBrains Mono', 'Fira Code', monospace);
}

.file-type-header {
  font-size: 14px;
  font-weight: 600;
  color: var(--floating-text, #e2e8f0);
  margin-bottom: 4px;
}

.file-type-desc {
  font-size: 12px;
  color: var(--floating-text-secondary, #cbd5e1);
  margin-bottom: 2px;
}

.file-type-details {
  font-size: 11px;
  color: var(--floating-text-soft, #8a8f9a);
}
</style>
