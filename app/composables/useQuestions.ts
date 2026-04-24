import { useI18n } from 'vue-i18n';
import type { ComputedRef, Ref } from 'vue';
import QuestionContent from '../components/ToolWindow/Question.vue';
import * as opencodeApi from '../utils/opencode';
import { uniqueBy } from '../utils/array';
import type { useFloatingWindows } from './useFloatingWindows';
import { useDialogHandler } from './useDialogHandler';

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
};

export type QuestionAnswer = string[];

const QUESTION_WINDOW_WIDTH = 760;
const QUESTION_WINDOW_HEIGHT = 560;

export function useQuestions(options: {
  fw: ReturnType<typeof useFloatingWindows>;
  allowedSessionIds: ComputedRef<Set<string>>;
  activeDirectory: Ref<string>;
  ensureConnectionReady: (action: string) => boolean;
  getTextContent: (messageId: string) => string;
}) {
  const { t } = useI18n();
  const dialog = useDialogHandler<QuestionRequest>({
    fw: options.fw,
    allowedSessionIds: options.allowedSessionIds,
    kind: 'question',
  });

  const { handleReply } = dialog.makeReplyFlow({
    ensureConnectionReady: options.ensureConnectionReady,
    activeDirectory: options.activeDirectory,
    actionKey: 'app.actions.questionReply',
    sendReply: (requestId, answers) =>
      opencodeApi.replyQuestion(requestId, {
        directory: options.activeDirectory.value.trim() || undefined,
        answers: normalizeQuestionAnswers(answers as QuestionAnswer[]),
      }),
  });

  const { handleReject } = dialog.makeRejectFlow({
    ensureConnectionReady: options.ensureConnectionReady,
    activeDirectory: options.activeDirectory,
    actionKey: 'app.actions.questionReject',
    sendReject: (requestId) =>
      opencodeApi.rejectQuestion(requestId, options.activeDirectory.value.trim() || undefined),
  });

  function parseQuestionRequest(
    value: unknown,
    fallbackSessionId?: string,
  ): QuestionRequest | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id =
      (typeof record.id === 'string' && record.id) ||
      (typeof record.questionID === 'string' && record.questionID) ||
      (typeof record.requestID === 'string' && record.requestID)
        ? String(record.id ?? record.questionID ?? record.requestID)
        : undefined;
    const sessionID =
      (typeof record.sessionID === 'string' && record.sessionID) ||
      (typeof record.sessionId === 'string' && record.sessionId) ||
      (typeof record.session_id === 'string' && record.session_id) ||
      fallbackSessionId;
    const questionsRaw = Array.isArray(record.questions)
      ? record.questions
      : Array.isArray(record.items)
        ? record.items
        : [];
    const questions: QuestionInfo[] = [];
    questionsRaw.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const info = item as Record<string, unknown>;
      const question = typeof info.question === 'string' ? info.question.trim() : '';
      const header = typeof info.header === 'string' ? info.header.trim() : '';
      const optionsRaw = Array.isArray(info.options) ? info.options : [];
      const optionsList: QuestionOption[] = [];
      optionsRaw.forEach((option) => {
        if (!option || typeof option !== 'object') return;
        const optionInfo = option as Record<string, unknown>;
        const label = typeof optionInfo.label === 'string' ? optionInfo.label.trim() : '';
        const description =
          typeof optionInfo.description === 'string' ? optionInfo.description.trim() : '';
        if (!label || !description) return;
        optionsList.push({ label, description });
      });
      if (!question || !header || optionsList.length === 0) return;
      questions.push({
        question,
        header,
        options: optionsList,
        multiple: info.multiple === true,
        custom: info.custom !== false,
      });
    });
    const toolRaw =
      record.tool && typeof record.tool === 'object'
        ? (record.tool as Record<string, unknown>)
        : null;
    const toolMessageId =
      (typeof record.messageID === 'string' && record.messageID) ||
      (toolRaw && typeof toolRaw.messageID === 'string' ? toolRaw.messageID : undefined);
    const toolCallId =
      (typeof record.callID === 'string' && record.callID) ||
      (typeof record.callId === 'string' && record.callId) ||
      (toolRaw && typeof toolRaw.callID === 'string' ? toolRaw.callID : undefined);
    if (!id || !sessionID || questions.length === 0) return null;
    const tool =
      toolMessageId && toolCallId ? { messageID: toolMessageId, callID: toolCallId } : undefined;
    return {
      id,
      sessionID,
      questions,
      tool,
    };
  }

  function getQuestionContextText(request: QuestionRequest): string {
    if (!request.tool?.messageID) return '';
    return options.getTextContent(request.tool.messageID) || '';
  }

  function normalizeQuestionAnswers(answers: QuestionAnswer[]): QuestionAnswer[] {
    return answers.map((answer) => {
      if (!Array.isArray(answer)) return [];
      const cleaned = answer
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0);
      return uniqueBy(cleaned, x => x);
    });
  }

  function upsertQuestionEntry(request: QuestionRequest) {
    dialog.upsert(request, {
      component: QuestionContent,
      props: {
        contextText: getQuestionContextText(request),
        onReply: handleQuestionReply,
        onReject: handleQuestionReject,
      },
      title: t('app.windowTitles.question', { title: request.questions?.[0]?.header || 'request' }),
      width: QUESTION_WINDOW_WIDTH,
      height: QUESTION_WINDOW_HEIGHT,
      resizable: true,
      scroll: 'follow',
    });
  }

  function removeQuestionEntry(requestId: string) {
    dialog.remove(requestId);
  }

  function pruneQuestionEntries() {
    dialog.prune();
  }

  function isQuestionSessionAllowed(request: QuestionRequest): boolean {
    return dialog.isSessionAllowed(request);
  }

  async function handleQuestionReply(payload: { requestId: string; answers: QuestionAnswer[] }) {
    await handleReply(payload.requestId, payload.answers);
  }

  async function handleQuestionReject(requestId: string) {
    await handleReject(requestId);
  }

  async function fetchPendingQuestions(directory?: string) {
    try {
      const data = await opencodeApi.listPendingQuestions(directory);
      if (!Array.isArray(data)) return;
      data
        .map((entry) => parseQuestionRequest(entry))
        .filter((entry): entry is QuestionRequest => Boolean(entry))
        .filter((entry) => isQuestionSessionAllowed(entry))
        .forEach((entry) => {
          upsertQuestionEntry(entry);
        });
    } catch (error) {
      log('Question list failed', error);
    }
  }

  return {
    parseQuestionRequest,
    upsertQuestionEntry,
    removeQuestionEntry,
    pruneQuestionEntries,
    handleQuestionReply,
    handleQuestionReject,
    isQuestionSessionAllowed,
    fetchPendingQuestions,
  };
}

function log(..._args: unknown[]): void {}
