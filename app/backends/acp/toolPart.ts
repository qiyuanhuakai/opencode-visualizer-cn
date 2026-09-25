import type { ToolPart } from '../../types/sse';
import { isHistoryToolName } from '../../utils/toolNames';
import { toRecord } from './wire';

function stringify(value: unknown) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function historyToolNameFromTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined;
  const name = title.trim().match(/^[a-z_]+/iu)?.[0]?.toLowerCase();
  return name && isHistoryToolName(name) ? name : undefined;
}

function createToolState(
  status: unknown,
  update: Record<string, unknown>,
  existing: ToolPart | undefined,
  now: number,
): ToolPart['state'] {
  const input = toRecord(update.rawInput) ?? (existing?.state.input ?? {});
  if (status === 'completed') {
    return {
      status,
      input,
      output: stringify(update.rawOutput),
      title: typeof update.title === 'string'
        ? update.title
        : existing?.state.status === 'running' ? existing.state.title ?? '' : '',
      metadata: {},
      time: { start: existing?.state.status === 'running' ? existing.state.time.start : now, end: now },
    };
  }
  if (status === 'failed') {
    return {
      status: 'error',
      input,
      error: stringify(update.rawOutput) || 'Tool call failed.',
      metadata: {},
      time: { start: now, end: now },
    };
  }
  if (status === 'in_progress') {
    return {
      status: 'running',
      input,
      title: typeof update.title === 'string' ? update.title : undefined,
      time: { start: now },
    };
  }
  return { status: 'pending', input, raw: stringify(update.rawInput) };
}

export function createAcpToolPart(
  sessionId: string,
  messageId: string,
  update: Record<string, unknown> & { toolCallId: string },
  existing: ToolPart | undefined,
  now: number,
): ToolPart {
  const titleName = historyToolNameFromTitle(update.title);
  const existingTitleName = historyToolNameFromTitle(existing?.metadata?.title);
  return {
    id: `${messageId}:tool:${update.toolCallId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'tool',
    callID: update.toolCallId,
    tool: titleName ?? existingTitleName ??
      (typeof update.kind === 'string' ? update.kind : existing?.tool ?? 'other'),
    state: createToolState(update.status, update, existing, now),
    metadata: typeof update.title === 'string' ? { title: update.title } : existing?.metadata,
  };
}
