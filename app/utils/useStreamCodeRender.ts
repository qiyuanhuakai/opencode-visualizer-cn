/**
 * Streaming code render composable.
 *
 * Watches reactive code params and incrementally streams them to a dedicated
 * worker for highlighting. Batches are converted to row HTML and applied to a
 * container element via streamPatch. When the code stops changing (debounce),
 * the stream is closed and the converged final HTML replaces the container
 * content, matching the single-shot render output byte-for-byte.
 *
 * Contract:
 * - Code growth (prefix extension): only the diff suffix is sent via sendChunk
 * - Code shrink/replace (not a prefix extension): cancel current stream, reopen
 * - Lang/theme change: cancel and reopen with new params
 * - Debounce (300ms): close stream, finalize with converged HTML
 * - Unmount: cancel active stream
 */
import { type Ref, type WatchSource, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import { RenderCancelledError } from './renderErrors';
import {
  startRenderWorkerStream,
  type RenderWorkerStream,
} from './workerStream';
import { createStreamPatcher, type StreamPatcher } from './streamPatch';
import { batchToRows } from './streamRows';
import { useI18n } from '../i18n/useI18n';

export type StreamCodeRenderParams = {
  code: string;
  lang: string;
  theme: string;
  gutterMode?: 'none' | 'single' | 'double';
  gutterLines?: string[];
  grepPattern?: string;
  lineOffset?: number;
  lineLimit?: number;
};

export type StreamCodeRenderResult = {
  containerRef: Ref<HTMLElement | null>;
  html: Ref<string>;
  error: Ref<string>;
  done: Ref<boolean>;
  unmount: () => void;
};

const CLOSE_DEBOUNCE_MS = 300;

export function useStreamCodeRender(
  params: WatchSource<StreamCodeRenderParams | null>,
): StreamCodeRenderResult {
  const containerRef = ref<HTMLElement | null>(null);
  const html = ref('');
  const error = ref('');
  const done = ref(false);
  const { t } = useI18n();

  let activeStream: RenderWorkerStream | null = null;
  let patcher: StreamPatcher | null = null;
  let lastCode = '';
  let lastParams: StreamCodeRenderParams | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let requestId = 0;

  function cancelActiveStream() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (activeStream) {
      activeStream.cancel();
      activeStream = null;
    }
    patcher = null;
    // A cancelled session's rows are invalid for the next session; a fresh
    // patcher would reuse the existing pre.shiki > code and append after them.
    containerRef.value?.replaceChildren();
  }

  function openStream(p: StreamCodeRenderParams) {
    requestId += 1;
    const currentRequestId = requestId;

    cancelActiveStream();
    error.value = '';
    done.value = false;
    html.value = '';
    lastCode = p.code;
    lastParams = { ...p };

    activeStream = startRenderWorkerStream({
      lang: p.lang,
      theme: p.theme,
      gutterMode: p.gutterMode ?? 'none',
      gutterLines: p.gutterLines ? toRaw(p.gutterLines) : undefined,
      grepPattern: p.grepPattern,
      lineOffset: p.lineOffset,
      lineLimit: p.lineLimit,
    });

    activeStream.onBatch((batch) => {
      if (currentRequestId !== requestId) return;
      if (!patcher && containerRef.value) {
        patcher = createStreamPatcher(containerRef.value);
      }
      if (!patcher) return;
      const mode = p.gutterMode ?? 'none';
      const gutterLines = p.gutterLines ? toRaw(p.gutterLines) : undefined;
      const streamBatch = batchToRows(batch, mode, gutterLines);
      patcher.applyBatch(streamBatch);
    });

    activeStream.sendChunk(p.code);
    scheduleClose();
  }

  function scheduleClose() {
    if (closeTimer) {
      clearTimeout(closeTimer);
    }
    closeTimer = setTimeout(() => {
      closeStream();
    }, CLOSE_DEBOUNCE_MS);
  }

  async function closeStream() {
    if (!activeStream) return;
    const stream = activeStream;
    activeStream = null;

    try {
      const finalHtml = await stream.close();
      if (containerRef.value) {
        if (!patcher) {
          patcher = createStreamPatcher(containerRef.value);
        }
        patcher.finalize(finalHtml);
      }
      html.value = finalHtml;
      done.value = true;
      error.value = '';
      patcher = null;
    } catch (err) {
      patcher = null;
      if (err instanceof RenderCancelledError) return;
      error.value = err instanceof Error ? err.message : t('render.renderFailed');
    }
  }

  watch(
    params,
    (p) => {
      if (!p) {
        cancelActiveStream();
        html.value = '';
        error.value = '';
        done.value = false;
        lastCode = '';
        lastParams = null;
        return;
      }

      if (!activeStream || !lastParams) {
        openStream(p);
        return;
      }

      const newCode = p.code;
      const langThemeChanged = p.lang !== lastParams.lang || p.theme !== lastParams.theme;

      if (langThemeChanged || !newCode.startsWith(lastCode)) {
        openStream(p);
      } else {
        const suffix = newCode.slice(lastCode.length);
        lastCode = newCode;
        activeStream.sendChunk(suffix);
        scheduleClose();
      }
    },
    { immediate: true },
  );

  function unmount() {
    cancelActiveStream();
  }

  onBeforeUnmount(() => {
    cancelActiveStream();
  });

  return { containerRef, html, error, done, unmount };
}
