import { onBeforeUnmount, reactive, watchEffect } from 'vue';
import type { Ref } from 'vue';
import type { MessageInfo } from '../types/sse';
import {
  RenderCancelledError,
  startRenderWorkerHtml,
} from '../utils/workerRenderer';
import { useI18n } from '../i18n/useI18n';

type UseAssistantPreRendererOptions = {
  visibleRoots: Ref<MessageInfo[]>;
  theme: Ref<string>;
  filesWithBasenames: Ref<string[]>;
  getFinalAnswer: (root: MessageInfo) => MessageInfo | undefined;
  hasAssistantMessages: (root: MessageInfo) => boolean;
  getFinalAnswerContent: (root: MessageInfo) => string;
  getThreadTransitionKey: (root: MessageInfo) => string;
  getThreadAssistantRenderKeyById: (rootId: string, answerId?: string) => string;
  onRendered: (renderKey: string) => void;
};

export function useAssistantPreRenderer(options: UseAssistantPreRendererOptions) {
  const { t, locale } = useI18n();
  const assistantHtmlCache = reactive(new Map<string, string>());
  const deferredKeyCache = reactive(new Map<string, string>());
  const cancelRenderByRootId = new Map<string, () => void>();
  let deferredRenderBatchId: number | null = null;

  const submitSeqMap = new Map<string, number>();
  const appliedSeqMap = new Map<string, number>();
  const lastSubmitted = new Map<
    string,
    { answerId: string; content: string; theme: string; locale: string }
  >();
  let lastFileFingerprint = '';

  function getFileFingerprint() {
    return options.filesWithBasenames.value.join('\u0001');
  }

  function invalidateForFileRefsIfNeeded() {
    const nextFingerprint = getFileFingerprint();
    if (nextFingerprint === lastFileFingerprint) return;
    lastFileFingerprint = nextFingerprint;
    lastSubmitted.clear();
  }

  function submitAssistantRender(rootId: string, answerId: string, content: string) {
    const seq = (submitSeqMap.get(rootId) ?? 0) + 1;
    submitSeqMap.set(rootId, seq);
    cancelRenderByRootId.get(rootId)?.();
    cancelRenderByRootId.delete(rootId);

    const requestId = `assistant-${rootId}-${seq}`;
    const task = startRenderWorkerHtml({
      id: requestId,
      code: content,
      lang: 'markdown',
      theme: options.theme.value,
      gutterMode: 'none',
      files: options.filesWithBasenames.value,
      copyButtonLabel: t('render.copyCode'),
      copiedLabel: t('render.copied'),
      copyCodeAriaLabel: t('render.copyCodeAria'),
      copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
    });
    cancelRenderByRootId.set(rootId, task.cancel);
    void task.promise
      .then((html) => {
        cancelRenderByRootId.delete(rootId);
        const applied = appliedSeqMap.get(rootId) ?? 0;
        if (seq <= applied) return;
        appliedSeqMap.set(rootId, seq);
        assistantHtmlCache.set(rootId, html);
        deferredKeyCache.set(rootId, answerId);
        options.onRendered(options.getThreadAssistantRenderKeyById(rootId, answerId));
      })
      .catch((error) => {
        cancelRenderByRootId.delete(rootId);
        if (error instanceof RenderCancelledError) return;
      });
  }

  function getAssistantHtml(rootId: string): string | undefined {
    return assistantHtmlCache.get(rootId);
  }

  function getDeferredTransitionKey(root: MessageInfo): string {
    return deferredKeyCache.get(root.id) ?? options.getThreadTransitionKey(root);
  }

  function scheduleAssistantRenderBatch(
    roots: Array<{ root: MessageInfo; answerId: string; content: string }>,
    theme: string,
    localeKey: string,
  ) {
    const BATCH_PRIORITY_COUNT = 4;
    const orderedRoots = [...roots].reverse();
    const immediate = orderedRoots.slice(0, BATCH_PRIORITY_COUNT);
    const deferred = orderedRoots.slice(BATCH_PRIORITY_COUNT);

    const submit = (entry: { root: MessageInfo; answerId: string; content: string }) => {
      lastSubmitted.set(entry.root.id, {
        answerId: entry.answerId,
        content: entry.content,
        theme,
        locale: localeKey,
      });
      submitAssistantRender(entry.root.id, entry.answerId, entry.content);
    };

    for (const entry of immediate) {
      submit(entry);
    }

    if (deferredRenderBatchId !== null) {
      cancelAnimationFrame(deferredRenderBatchId);
      deferredRenderBatchId = null;
    }
    if (deferred.length === 0) return;
    for (const entry of deferred) {
      assistantHtmlCache.delete(entry.root.id);
      deferredKeyCache.delete(entry.root.id);
    }
    deferredRenderBatchId = requestAnimationFrame(() => {
      deferredRenderBatchId = null;
      for (const entry of deferred) {
        submit(entry);
      }
    });
  }

  watchEffect(() => {
    invalidateForFileRefsIfNeeded();
    const theme = options.theme.value;
    const localeKey = String(locale.value);
    const pendingRoots: Array<{ root: MessageInfo; answerId: string; content: string }> = [];
    for (const root of options.visibleRoots.value) {
      if (!options.hasAssistantMessages(root)) continue;
      const final = options.getFinalAnswer(root);
      const answerId = final?.id ?? root.id;
      const content = options.getFinalAnswerContent(root);

      const last = lastSubmitted.get(root.id);
      if (
        last &&
        last.answerId === answerId &&
        last.content === content &&
        last.theme === theme &&
        last.locale === localeKey
      ) {
        if (assistantHtmlCache.has(root.id)) {
          options.onRendered(options.getThreadAssistantRenderKeyById(root.id, answerId));
        }
        continue;
      }
      pendingRoots.push({ root, answerId, content });
    }
    scheduleAssistantRenderBatch(pendingRoots, theme, localeKey);
  });

  onBeforeUnmount(() => {
    if (deferredRenderBatchId !== null) {
      cancelAnimationFrame(deferredRenderBatchId);
      deferredRenderBatchId = null;
    }
    cancelRenderByRootId.forEach((cancel) => cancel());
    cancelRenderByRootId.clear();
  });

  return {
    getAssistantHtml,
    getDeferredTransitionKey,
  };
}
