import { jsonValue, requireValue } from '../../shared/runtime/capabilities.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import type { HarnessKind } from '../../shared/runtime/harnessContract.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { encodeSessionKey } from '../../shared/runtime/identity.js';
import type { PermissionRequest, PermissionReply } from '../composables/usePermissions';
import type { QuestionInfo, QuestionRequest } from '../types/sse';
import { kimiWebQuestionAnswersFromLabels } from '../backends/kimiWeb/interactions';
import type { KimiWebQuestionItem } from '../utils/kimiWeb';

type Answer = Readonly<Record<string, JsonValue>>;
export type NativeInteractionView = {
  id: string;
  permission?: PermissionRequest;
  question?: QuestionRequest;
  answerPermission(reply: PermissionReply): Answer;
  answerQuestion(answers: string[][], reject?: boolean): Answer;
};
function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'interaction.object');
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; }
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : []; }
function answer(value: Record<string, unknown>): Answer { return object(jsonValue(value)) as Answer; }
function question(row: Record<string, unknown>): QuestionInfo {
  return { question: text(row.question, text(row.prompt)), header: text(row.header, text(row.question, 'Question')),
    options: rows(row.options).map(option => ({ label: text(option.label), description: text(option.description) })),
    multiple: row.multiple === true || row.multi_select === true, custom: row.custom !== false && row.allow_other !== false, secret: row.isSecret === true };
}

export function projectNativeInteraction(kind: HarnessKind, session: SessionRef, interactionId: string, payload: unknown): NativeInteractionView {
  const raw = object(payload);
  const id = `runtime:${encodeSessionKey(session)}:${interactionId}`;
  const permission: PermissionRequest = { id, sessionID: session.nativeSessionId, permission: 'Approval', patterns: [], metadata: {}, always: [] };
  let questions: QuestionInfo[] | undefined;
  let permissionAnswer: (reply: PermissionReply) => Answer = () => { throw new Error('Interaction is not a permission request'); };
  let questionAnswer: (answers: string[][], reject?: boolean) => Answer = () => { throw new Error('Interaction is not a question'); };
  if (kind === 'opencode') {
    const props = object(raw.properties);
    requireValue(raw.type === 'permission.asked' || raw.type === 'question.asked', 'interaction.opencode_type');
    if (raw.type === 'question.asked') {
      questions = rows(props.questions).map(question);
      questionAnswer = (answers, reject) => reject ? { reject: true } : answer({ answers });
    } else {
      permission.permission = text(props.permission, 'Approval'); permission.patterns = strings(props.patterns);
      permission.metadata = props.metadata ? object(props.metadata) : {}; permission.always = strings(props.always);
      permissionAnswer = reply => ({ reply });
    }
  } else if (kind === 'acp') {
    const tool = object(raw.toolCall ?? {}), options = rows(raw.options);
    permission.permission = text(tool.title, text(tool.kind, 'Tool permission'));
    permission.metadata = { ...tool }; permission.always = options.some(option => option.kind === 'allow_always') ? ['session'] : [];
    permissionAnswer = reply => {
      const desired = reply === 'reject' ? ['reject_once', 'reject_always'] : reply === 'always' ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always'];
      const selected = desired.map(kind => options.find(option => option.kind === kind)).find(Boolean);
      return selected ? answer({ outcome: { outcome: 'selected', optionId: text(selected.optionId) } }) : { outcome: { outcome: 'cancelled' } };
    };
  } else if (kind === 'dsh') {
    const request = object(raw.request);
    permission.permission = text(request.toolName, 'Approval'); permission.metadata = request;
    permissionAnswer = reply => ({ outcome: reply === 'reject' ? 'rejected' : 'allowed-once' });
  } else if (kind === 'kimi-web') {
    const details = object(raw.details);
    requireValue(raw.kind === 'approval' || raw.kind === 'question', 'interaction.kimi_kind');
    if (raw.kind === 'question') {
      const items: KimiWebQuestionItem[] = rows(details.questions).map(row => ({ id: text(row.id), question: text(row.question), header: text(row.header),
        options: rows(row.options).map(option => ({ id: text(option.id), label: text(option.label), description: text(option.description) })),
        multi_select: row.multi_select === true, allow_other: row.allow_other !== false }));
      questions = rows(details.questions).map(question);
      questionAnswer = (answers, reject) => {
        if (reject) return { dismiss: true };
        const result = kimiWebQuestionAnswersFromLabels({ kind: 'question', sessionId: session.nativeSessionId, id: text(raw.nativeRequestId), questions: items, source: 'event' }, answers);
        requireValue(result !== null, 'interaction.kimi_answer'); return answer(result);
      };
    } else {
      permission.permission = text(details.tool_name, text(details.toolName, 'Approval'));
      permission.patterns = [text(details.action)].filter(Boolean); permission.metadata = details; permission.always = ['session'];
      permissionAnswer = reply => answer(reply === 'reject' ? { decision: 'rejected' } : reply === 'always' ? { decision: 'approved', scope: 'session' } : { decision: 'approved' });
    }
  } else {
    const params = object(raw.params), method = text(raw.method);
    if (method === 'item/tool/requestUserInput') {
      const items = rows(params.questions); questions = items.map(question);
      questionAnswer = (answers, reject) => answer({ answers: Object.fromEntries(items.map((item, index) => [text(item.id), { answers: reject ? [] : answers[index] ?? [] }])) });
    } else if (method === 'item/tool/call') {
      questions = [{ question: `Provide the result for ${text(params.tool, 'tool')}`, header: 'Tool result', options: [], custom: true }];
      questionAnswer = (answers, reject) => answer({ success: !reject, contentItems: reject ? [] : [{ type: 'inputText', text: answers.flat().join('\n') }] });
    } else if (method === 'mcpServer/elicitation/request') {
      const schema = object(params.requestedSchema ?? {}), properties = object(schema.properties ?? {});
      const fields = Object.entries(properties).map(([name, value]) => ({ name, schema: object(value) }));
      questions = fields.map(field => ({ question: text(field.schema.description, field.name), header: field.name, options: strings(field.schema.enum).map(label => ({ label, description: '' })), custom: true }));
      questionAnswer = (answers, reject) => reject ? { action: 'decline', content: null } : answer({ action: 'accept', content: Object.fromEntries(fields.map((field, index) => {
        const value = answers[index]?.[0] ?? '';
        if (field.schema.type === 'boolean') return [field.name, value === 'true'];
        if (field.schema.type === 'number' || field.schema.type === 'integer') { const number = Number(value); requireValue(Number.isFinite(number) && (field.schema.type !== 'integer' || Number.isInteger(number)), 'interaction.number'); return [field.name, number]; }
        return [field.name, value];
      })) });
    } else {
      requireValue(method.endsWith('requestApproval'), 'interaction.codex_method');
      permission.permission = method; permission.metadata = params; permission.patterns = [text(params.command), text(params.reason)].filter(Boolean);
      permission.always = method === 'item/permissions/requestApproval' || (Array.isArray(params.availableDecisions) && params.availableDecisions.includes('acceptForSession')) ? ['session'] : [];
      permissionAnswer = reply => method === 'item/permissions/requestApproval'
        ? answer({ permissions: reply === 'reject' ? {} : params.permissions ?? {}, scope: reply === 'always' ? 'session' : 'turn' })
        : { decision: reply === 'reject' ? 'decline' : reply === 'always' && permission.always.length ? 'acceptForSession' : 'accept' };
    }
  }
  return { id, ...(questions ? { question: { id, sessionID: session.nativeSessionId, questions } } : { permission }), answerPermission: permissionAnswer, answerQuestion: questionAnswer };
}
