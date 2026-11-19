import { describe, expect, it } from 'vitest';
import { parseSessionRef } from '../../shared/runtime/identity.js';
import { projectNativeInteraction } from './nativeInteractions';
const session = parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'same' });

describe('native interaction dialog projection', () => {
  it('keeps same-native-id dialogs isolated by full SessionRef', () => {
    const payload = { type: 'permission.asked', properties: { permission: 'bash', patterns: ['pwd'], always: ['*'] } };
    const first = projectNativeInteraction('opencode', session, 'request', payload);
    const second = projectNativeInteraction('opencode', { ...session, harnessInstanceId: parseSessionRef({ ...session, harnessInstanceId: '33333333-3333-4333-8333-333333333333' }).harnessInstanceId }, 'request', payload);
    expect(first.id).not.toBe(second.id);
    expect(first.permission).toMatchObject({ permission: 'bash', patterns: ['pwd'] });
    expect(first.answerPermission('always')).toEqual({ reply: 'always' });
  });
  it('maps all five approval vocabularies without routing through native endpoints', () => {
    expect(projectNativeInteraction('codex', session, 'c', { method: 'item/commandExecution/requestApproval', params: { command: 'pwd', availableDecisions: ['accept', 'acceptForSession'] } }).answerPermission('always')).toEqual({ decision: 'acceptForSession' });
    const acp = projectNativeInteraction('acp', session, 'a', { toolCall: { title: 'Run command' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] });
    expect(acp.answerPermission('once')).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(acp.answerPermission('reject')).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    expect(projectNativeInteraction('dsh', session, 'd', { request: { toolName: 'Bash', reason: 'run command' } }).answerPermission('once')).toEqual({ outcome: 'allowed-once' });
    expect(projectNativeInteraction('kimi-web', session, 'k', { kind: 'approval', details: { tool_name: 'Shell', action: 'pwd' } }).answerPermission('always')).toEqual({ decision: 'approved', scope: 'session' });
  });
  it('retains native question identities and Kimi option ids', () => {
    const question = { id: 'color', question: 'Color?', options: [{ id: 'r', label: 'Red' }] };
    const kimi = projectNativeInteraction('kimi-web', session, 'k', { kind: 'question', nativeRequestId: 'q', details: { questions: [question] } });
    expect(kimi.question?.questions[0]?.options[0]?.label).toBe('Red');
    expect(kimi.answerQuestion([['Red']])).toEqual({ answers: { color: { kind: 'single', option_id: 'r' } } });
    expect(kimi.answerQuestion([], true)).toEqual({ dismiss: true });
    const codex = projectNativeInteraction('codex', session, 'c', { method: 'item/tool/requestUserInput', params: { questions: [question] } });
    expect(codex.answerQuestion([['Red']])).toEqual({ answers: { color: { answers: ['Red'] } } });
    const openCode = projectNativeInteraction('opencode', session, 'o', { type: 'question.asked', properties: { questions: [question] } });
    expect(openCode.answerQuestion([], true)).toEqual({ reject: true });
  });
  it('preserves structured Codex permissions and typed MCP elicitation fields', () => {
    const permission = projectNativeInteraction('codex', session, 'c', { method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } });
    expect(permission.answerPermission('once')).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(permission.answerPermission('reject')).toEqual({ permissions: {}, scope: 'turn' });
    const mcp = projectNativeInteraction('codex', session, 'm', { method: 'mcpServer/elicitation/request', params: { requestedSchema: { properties: { age: { type: 'integer' } } } } });
    expect(mcp.answerQuestion([['12']])).toEqual({ action: 'accept', content: { age: 12 } });
    expect(() => mcp.answerQuestion([['abc']])).toThrow('interaction.number');
  });
});
