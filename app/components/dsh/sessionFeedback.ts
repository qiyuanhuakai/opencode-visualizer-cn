import type { DshRpcClient } from '../../utils/dshRpc';
import { DshRpcError } from '../../utils/dshRpc';
import type { DshJsonValue } from '../../backends/dsh/types';

export const DSH_FEEDBACK_CATEGORIES = ['task-result', 'instruction-following', 'product-interaction', 'service-stability', 'resource-cost', 'security-privacy-permission', 'other'] as const;
export type DshFeedbackCategory = typeof DSH_FEEDBACK_CATEGORIES[number];
type SessionFeedbackInput = { readonly sessionId: string; readonly text: string; readonly category: DshFeedbackCategory | '' };
function isObject(value: DshJsonValue | undefined): value is { readonly [key: string]: DshJsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export async function recordDshSessionFeedback(rpc: Pick<DshRpcClient, 'call'>, input: SessionFeedbackInput): Promise<void> {
  if (!input.sessionId.trim()) throw new DshRpcError('Select a session for feedback', { code: 'invalid-argument' });
  const request: Record<string, DshJsonValue> = { sessionId: input.sessionId };
  if (input.text.trim()) request.text = input.text.trim();
  if (input.category) request.category = input.category;
  const result = await rpc.call('sessionFeedback', 'record', { request });
  if (isObject(result) && result.ok === true && isObject(result.value) && result.value.recorded === true) return;
  const error = isObject(result) && isObject(result.error) ? result.error : undefined;
  const code = typeof error?.code === 'string' ? error.code : 'invalid-feedback-response';
  const message = typeof error?.message === 'string' ? error.message : code === 'session-not-found' ? 'The feedback session is no longer available' : 'Feedback was not recorded';
  throw new DshRpcError(message, { code });
}
