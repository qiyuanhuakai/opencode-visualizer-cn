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

type AssistantRenderInput = {
  answerId: string;
  content: string;
  theme: string;
  locale: string;
};

type ActiveAssistantRender = {
  task: ReturnType<typeof startRenderWorkerHtml>;
  seq: number;
};

export function useAssistantPreRenderer(options: UseAssistantPreRendererOptions) {
  const { t, locale } = useI18n();
  const assistantHtmlCache = reactive(new Map<string, string>());
  const deferredKeyCache = reactive(new Map<string, string>());
  const activeRenderByRootId = new Map<string, ActiveAssistantRender>();
  const queuedRenderByRootId = new Map<string, AssistantRenderInput>();
  let deferredRenderBatchId: number | null = null;

  const submittedRootIds = new Set<string>();
  let submitSequence = 0;
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

  function startAssistantRender(rootId: string, input: AssistantRenderInput) {
    const seq = ++submitSequence;
    submittedRootIds.add(rootId);

    const requestId = `assistant-${rootId}-${seq}`;
    const task = startRenderWorkerHtml({
      id: requestId,
      code: input.content,
      lang: 'markdown',
      theme: input.theme,
      gutterMode: 'none',
      files: options.filesWithBasenames.value,
      copyButtonLabel: t('render.copyCode'),
      copiedLabel: t('render.copied'),
      copyCodeAriaLabel: t('render.copyCodeAria'),
      copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
    });
    activeRenderByRootId.set(rootId, { task, seq });
    void task.promise
      .then((html) => {
        if (activeRenderByRootId.get(rootId)?.task !== task) return;
        activeRenderByRootId.delete(rootId);
        const queued = queuedRenderByRootId.get(rootId);
        if (queued) {
          queuedRenderByRootId.delete(rootId);
          startAssistantRender(rootId, queued);
          return;
        }
        assistantHtmlCache.set(rootId, html);
        deferredKeyCache.set(rootId, input.answerId);
        options.onRendered(options.getThreadAssistantRenderKeyById(rootId, input.answerId));
      })
      .catch((error) => {
        if (activeRenderByRootId.get(rootId)?.task !== task) return;
        activeRenderByRootId.delete(rootId);
        const queued = queuedRenderByRootId.get(rootId);
        if (queued) {
          queuedRenderByRootId.delete(rootId);
          startAssistantRender(rootId, queued);
          return;
        }
        if (error instanceof RenderCancelledError) return;
        const escaped = input.content
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        assistantHtmlCache.set(rootId, `<div class="whitespace-pre-wrap">${escaped}</div>`);
        deferredKeyCache.set(rootId, input.answerId);
        options.onRendered(options.getThreadAssistantRenderKeyById(rootId, input.answerId));
      });
  }

  function submitAssistantRender(rootId: string, answerId: string, content: string, theme: string, localeKey: string) {
    const input = { answerId, content, theme, locale: localeKey };
    if (activeRenderByRootId.has(rootId)) {
      queuedRenderByRootId.set(rootId, input);
      return;
    }
    startAssistantRender(rootId, input);
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
      submitAssistantRender(entry.root.id, entry.answerId, entry.content, theme, localeKey);
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
    const visibleRoots = options.visibleRoots.value.filter(options.hasAssistantMessages);
    const visibleRootIds = new Set(visibleRoots.map((root) => root.id));
    for (const rootId of submittedRootIds) {
      if (visibleRootIds.has(rootId)) continue;
      activeRenderByRootId.get(rootId)?.task.cancel();
      activeRenderByRootId.delete(rootId);
      queuedRenderByRootId.delete(rootId);
      assistantHtmlCache.delete(rootId);
      deferredKeyCache.delete(rootId);
      lastSubmitted.delete(rootId);
      submittedRootIds.delete(rootId);
    }
    invalidateForFileRefsIfNeeded();
    const theme = options.theme.value;
    const localeKey = String(locale.value);
    const pendingRoots: Array<{ root: MessageInfo; answerId: string; content: string }> = [];
    for (const root of visibleRoots) {
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
    queuedRenderByRootId.clear();
    activeRenderByRootId.forEach(({ task }) => task.cancel());
    activeRenderByRootId.clear();
  });

  return {
    getAssistantHtml,
    getDeferredTransitionKey,
  };
}
