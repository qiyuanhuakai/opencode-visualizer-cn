import { type Ref, type WatchSource, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import {
  RenderCancelledError,
  startRenderWorkerHtml,
} from './workerRenderer';
import { useI18n } from '../i18n/useI18n';

export type CodeRenderParams = {
  code: string;
  lang: string;
  theme: string;
  patch?: string;
  after?: string;
  gutterMode?: 'none' | 'single' | 'double';
  gutterLines?: string[];
  grepPattern?: string;
  lineOffset?: number;
  lineLimit?: number;
};

export type CodeRenderResult = {
  html: Ref<string>;
  error: Ref<string>;
};

export function useCodeRender(params: WatchSource<CodeRenderParams | null>): CodeRenderResult {
  const html = ref('');
  const error = ref('');
  let requestId = 0;
  let cancelActiveRender: (() => void) | null = null;
  const { t } = useI18n();

  watch(
    params,
    (p) => {
      requestId += 1;
      const current = requestId;
      cancelActiveRender?.();
      cancelActiveRender = null;

      if (!p) {
        html.value = '';
        error.value = '';
        return;
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const task = startRenderWorkerHtml({
        id,
        code: p.code,
        lang: p.lang,
        theme: p.theme,
        patch: p.patch,
        after: p.after,
        gutterMode: p.gutterMode ?? 'none',
        gutterLines: p.gutterLines ? toRaw(p.gutterLines) : undefined,
        grepPattern: p.grepPattern,
        lineOffset: p.lineOffset,
        lineLimit: p.lineLimit,
        copyButtonLabel: t('render.copyCode'),
        copiedLabel: t('render.copied'),
        copyCodeAriaLabel: t('render.copyCodeAria'),
        copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
        errorLabel: t('render.renderFailed'),
      });
      cancelActiveRender = task.cancel;
      task.promise
        .then((result) => {
          if (current !== requestId) return;
          cancelActiveRender = null;
          html.value = result;
          error.value = '';
        })
        .catch((err) => {
          if (current !== requestId) return;
          cancelActiveRender = null;
          if (err instanceof RenderCancelledError) return;
          error.value = err instanceof Error ? err.message : t('render.renderFailed');
        });
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    requestId += 1;
    cancelActiveRender?.();
    cancelActiveRender = null;
  });

  return { html, error };
}
