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
  const { t } = useI18n();
  const assistantHtmlCache = reactive(new Map<string, string>());
  const deferredKeyCache = reactive(new Map<string, string>());
  const cancelRenderByRootId = new Map<string, () => void>();

  const submitSeqMap = new Map<string, number>();
  const appliedSeqMap = new Map<string, number>();
  const lastSubmitted = new Map<
    string,
    { answerId: string; content: string; theme: string }
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

  watchEffect(() => {
    invalidateForFileRefsIfNeeded();
    const theme = options.theme.value;
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
        last.theme === theme
      ) {
        // Notify that cached HTML is already available so initial render
        // tracking can resolve the assistant key (prevents stuck spinner
        // when the same session is reloaded by FORK / REVERT / UNDO).
        if (assistantHtmlCache.has(root.id)) {
          options.onRendered(options.getThreadAssistantRenderKeyById(root.id, answerId));
        }
        continue;
      }
      lastSubmitted.set(root.id, {
        answerId,
        content,
        theme,
      });
      submitAssistantRender(root.id, answerId, content);
    }
  });

  onBeforeUnmount(() => {
    cancelRenderByRootId.forEach((cancel) => cancel());
    cancelRenderByRootId.clear();
  });

  return {
    getAssistantHtml,
    getDeferredTransitionKey,
  };
}
