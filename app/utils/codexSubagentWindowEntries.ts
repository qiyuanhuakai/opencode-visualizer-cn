import type { AssistantMessageInfo, TextPart, ToolPart } from '../types/sse';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function codexSubagentWindowEntries(info: AssistantMessageInfo, part: ToolPart) {
  if (part.tool !== 'task' || part.state.status === 'pending') return [];
  const metadata = part.state.metadata;
  if (!metadata || (metadata.senderThreadId && metadata.senderThreadId !== info.sessionID)) return [];
  const ids = Array.isArray(metadata.sessionIds) ? metadata.sessionIds : [metadata.sessionId];
  const states = record(metadata.agentsStates);
  const prompt = typeof part.state.input.prompt === 'string' ? part.state.input.prompt : '';
  const model = typeof part.state.input.model === 'string' ? part.state.input.model : '';
  const entries: Array<{ info: AssistantMessageInfo; part: TextPart }> = [];
  for (const id of new Set(ids)) {
    if (typeof id !== 'string' || !id || id === info.sessionID) continue;
    const state = record(states?.[id]);
    const status = typeof state?.status === 'string' ? state.status : '';
    const message = typeof state?.message === 'string' ? state.message : '';
    const text = [status, message || prompt].filter(Boolean).join('\n\n');
    if (!text.trim()) continue;
    const completed = ['completed', 'interrupted', 'errored', 'shutdown', 'notFound'].includes(status);
    const messageId = `${part.messageID}:subagent:${id}`;
    entries.push({
      info: { ...info, id: messageId, sessionID: id, modelID: model, agent: '', time: { created: info.time.created } },
      part: {
        id: `${part.id}:subagent:${id}`,
        messageID: messageId,
        sessionID: id,
        type: 'text',
        text,
        time: { start: part.state.time.start, ...(completed ? { end: Date.now() } : {}) },
      },
    });
  }
  return entries;
}
