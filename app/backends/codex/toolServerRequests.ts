import type { CodexJsonRpcId, CodexJsonRpcServerRequest } from './jsonRpcClient';

export type CodexToolUserInputOption = {
  readonly label: string;
  readonly description: string;
};

export type CodexToolUserInputQuestion = {
  readonly id: string;
  readonly header: string;
  readonly text: string;
  readonly isOther: boolean;
  readonly isSecret: boolean;
  readonly options: readonly CodexToolUserInputOption[];
};

export type CodexToolUserInputRequest = {
  readonly requestId: CodexJsonRpcId;
  readonly itemId: string;
  readonly questions: readonly CodexToolUserInputQuestion[];
  readonly threadId: string;
  readonly turnId: string;
};

export type CodexDynamicToolCallRequest = {
  readonly requestId: CodexJsonRpcId;
  readonly callId: string;
  readonly namespace: string | null;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly threadId: string;
  readonly turnId: string;
};

export type CodexDynamicToolOutput =
  | { readonly type: 'inputText'; readonly text: string }
  | { readonly type: 'inputImage'; readonly imageUrl: string };

type ToolAnswer = {
  readonly questionId: string;
  readonly answers: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseOption(value: unknown): CodexToolUserInputOption | null {
  if (!isRecord(value)) return null;
  if (typeof value.label !== 'string' || typeof value.description !== 'string') return null;
  return { label: value.label, description: value.description };
}

function parseQuestion(value: unknown): CodexToolUserInputQuestion | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || typeof value.header !== 'string'
    || typeof value.question !== 'string'
    || typeof value.isOther !== 'boolean'
    || typeof value.isSecret !== 'boolean'
    || (value.options !== null && !Array.isArray(value.options))
  ) return null;
  const options = value.options === null
    ? []
    : value.options.map(parseOption);
  if (options.some((option) => option === null)) return null;
  return {
    id: value.id,
    header: value.header,
    text: value.question,
    isOther: value.isOther,
    isSecret: value.isSecret,
    options: options.filter((option): option is CodexToolUserInputOption => option !== null),
  };
}

export function parseToolUserInputRequest(
  request: CodexJsonRpcServerRequest,
): CodexToolUserInputRequest | null {
  if (request.method !== 'item/tool/requestUserInput' || !isRecord(request.params)) return null;
  const params = request.params;
  if (
    typeof params.threadId !== 'string'
    || typeof params.turnId !== 'string'
    || typeof params.itemId !== 'string'
    || !Array.isArray(params.questions)
  ) return null;
  const questions = params.questions.map(parseQuestion);
  if (questions.length === 0 || questions.some((question) => question === null)) return null;
  return {
    requestId: request.id,
    itemId: params.itemId,
    questions: questions.filter((question): question is CodexToolUserInputQuestion => question !== null),
    threadId: params.threadId,
    turnId: params.turnId,
  };
}

export function parseDynamicToolCallRequest(
  request: CodexJsonRpcServerRequest,
): CodexDynamicToolCallRequest | null {
  if (request.method !== 'item/tool/call' || !isRecord(request.params)) return null;
  const params = request.params;
  if (
    typeof params.threadId !== 'string'
    || typeof params.turnId !== 'string'
    || typeof params.callId !== 'string'
    || (params.namespace !== null && typeof params.namespace !== 'string')
    || typeof params.tool !== 'string'
    || !Object.hasOwn(params, 'arguments')
  ) return null;
  return {
    requestId: request.id,
    callId: params.callId,
    namespace: params.namespace,
    toolName: params.tool,
    arguments: params.arguments,
    threadId: params.threadId,
    turnId: params.turnId,
  };
}

export function buildToolUserInputResponse(entries: readonly ToolAnswer[]) {
  return {
    answers: Object.fromEntries(entries.map((entry) => [
      entry.questionId,
      { answers: [...entry.answers] },
    ])),
  };
}

export function buildDynamicToolCallResponse(
  contentItems: readonly CodexDynamicToolOutput[],
  success: boolean,
) {
  return { contentItems: [...contentItems], success };
}
