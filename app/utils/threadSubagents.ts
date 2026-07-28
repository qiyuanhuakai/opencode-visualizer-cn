import type { MessagePart } from '../types/sse';

export type ThreadSubagentSession = { sessionId: string; label: string };
export type SessionHistoryMeta = { parentID?: string; label: string };

/**
 * Resolve the subagent sessions that were spawned by `task` tool calls inside
 * a single conversation thread. OpenCode's task tool records the child session
 * id in `part.state.metadata.sessionId`, so attribution is exact: a subagent
 * entry belongs only to the thread whose parts reference it.
 */
export function resolveThreadSubagentSessions(
  threadParts: MessagePart[],
  currentSessionId: string,
  metaById?: Record<string, SessionHistoryMeta>,
): ThreadSubagentSession[] {
  const sessionId = currentSessionId.trim();
  if (!sessionId) return [];
  const seen = new Map<string, string>();
  for (const part of threadParts) {
    if (part.type !== 'tool' || part.tool !== 'task') continue;
    const state = part.state;
    if (state.status === 'pending') continue;
    const rawChildId = state.metadata?.sessionId;
    if (typeof rawChildId !== 'string') continue;
    const childId = rawChildId.trim();
    if (!childId) continue;
    const meta = metaById?.[childId];
    if (meta && meta.parentID !== sessionId) continue;
    if (!seen.has(childId)) seen.set(childId, meta?.label || childId);
  }
  return Array.from(seen.entries()).map(([sessionId, label]) => ({ sessionId, label }));
}
