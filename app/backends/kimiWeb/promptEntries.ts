import type { KimiWebContentPart } from '../../utils/kimiWeb';
import { kimiWebMessagesToHistoryEntries } from './historyEntries';
import type { KimiWebNormalizeOp } from './ops';
import { asNumber, asString, isRecord, type KimiWebPayload } from './wire';

export function submittedPromptOps(
  payload: KimiWebPayload,
  sessionId: string,
  now: () => number,
): KimiWebNormalizeOp[] {
  const id = asString(payload.userMessageId) || asString(payload.promptId);
  if (!id || !sessionId || !Array.isArray(payload.content)) return [];
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  const origin = isRecord(metadata?.origin) ? metadata.origin : payload.origin;
  if (isRecord(origin) && origin.kind === 'injection') return [];
  // Keep wire positions so text part IDs match REST history even beside media.
  const content = payload.content.map((part): KimiWebContentPart => ({
    type: 'text',
    text: isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
  }));
  const entries = kimiWebMessagesToHistoryEntries([{
    id, session_id: sessionId, role: 'user', content,
    created_at: asString(payload.createdAt) || new Date(asNumber(payload.time) ?? now()).toISOString(),
  }]);
  return entries.flatMap((entry): KimiWebNormalizeOp[] => [
    { kind: 'message', message: entry.info },
    ...entry.parts.map((part): KimiWebNormalizeOp => ({ kind: 'part', part })),
  ]);
}
