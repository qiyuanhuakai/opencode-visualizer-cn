import { type Ref, type WatchSource, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import { renderWorkerHtml } from './workerRenderer';

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

export function useCodeRender(
  params: WatchSource<CodeRenderParams | null>,
): CodeRenderResult {
  const html = ref('');
  const error = ref('');
  let requestId = 0;

  watch(
    params,
    (p) => {
      requestId += 1;
      const current = requestId;

      if (!p) return;

      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      renderWorkerHtml({
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
      })
        .then((result) => {
          if (current !== requestId) return;
          html.value = result;
          error.value = '';
        })
        .catch((err) => {
          if (current !== requestId) return;
          error.value = err instanceof Error ? err.message : 'Render failed';
        });
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    requestId += 1;
  });

  return { html, error };
}
