import { reactive, watchEffect } from 'vue';
import type { Ref } from 'vue';
import type { MessageInfo } from '../types/sse';
import { renderWorkerHtml } from '../utils/workerRenderer';

type UseAssistantPreRendererOptions = {
  visibleRoots: Ref<MessageInfo[]>;
  theme: Ref<string>;
  fileCacheVersion: Ref<number>;
  filesWithBasenames: Ref<string[]>;
  getFinalAnswer: (root: MessageInfo) => MessageInfo | undefined;
  hasAssistantMessages: (root: MessageInfo) => boolean;
  getFinalAnswerContent: (root: MessageInfo) => string;
  getThreadTransitionKey: (root: MessageInfo) => string;
  getThreadAssistantRenderKeyById: (rootId: string, answerId?: string) => string;
  onRendered: (renderKey: string) => void;
};

export function useAssistantPreRenderer(options: UseAssistantPreRendererOptions) {
  const assistantHtmlCache = reactive(new Map<string, string>());
  const deferredKeyCache = reactive(new Map<string, string>());

  const submitSeqMap = new Map<string, number>();
  const appliedSeqMap = new Map<string, number>();
  const lastSubmitted = new Map<
    string,
    { answerId: string; content: string; theme: string; fileCacheVersion: number }
  >();

  function submitAssistantRender(rootId: string, answerId: string, content: string) {
    const seq = (submitSeqMap.get(rootId) ?? 0) + 1;
    submitSeqMap.set(rootId, seq);

    const requestId = `assistant-${rootId}-${seq}`;
    void renderWorkerHtml({
      id: requestId,
      code: content,
      lang: 'markdown',
      theme: options.theme.value,
      gutterMode: 'none',
      files: options.filesWithBasenames.value,
    }).then((html) => {
      const applied = appliedSeqMap.get(rootId) ?? 0;
      if (seq <= applied) return;
      appliedSeqMap.set(rootId, seq);
      assistantHtmlCache.set(rootId, html);
      deferredKeyCache.set(rootId, answerId);
      options.onRendered(options.getThreadAssistantRenderKeyById(rootId, answerId));
    });
  }

  function getAssistantHtml(rootId: string): string | undefined {
    return assistantHtmlCache.get(rootId);
  }

  function getDeferredTransitionKey(root: MessageInfo): string {
    return deferredKeyCache.get(root.id) ?? options.getThreadTransitionKey(root);
  }

  watchEffect(() => {
    const theme = options.theme.value;
    const nextFileCacheVersion = options.fileCacheVersion.value;
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
        last.fileCacheVersion === nextFileCacheVersion
      ) {
        continue;
      }
      lastSubmitted.set(root.id, {
        answerId,
        content,
        theme,
        fileCacheVersion: nextFileCacheVersion,
      });
      submitAssistantRender(root.id, answerId, content);
    }
  });

  return {
    getAssistantHtml,
    getDeferredTransitionKey,
  };
}
