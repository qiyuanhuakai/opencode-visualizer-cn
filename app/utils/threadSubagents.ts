import type { MessagePart } from '../types/sse';
import type { SessionState } from '../types/worker-state';
import {
  isMagicContextWorkerName,
  resolveTaskWorkerLabel,
} from './pluginCompatibility';

export type ThreadSubagentSession = { sessionId: string; label: string };
export type ThreadParts = { rootId: string; parts: MessagePart[] };
export type SessionHistoryMeta = {
  parentID?: string;
  label: string;
  status?: SessionState['status'];
};

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
    const fallbackLabel = meta?.label || childId;
    if (isMagicContextWorkerName(fallbackLabel)) continue;
    if (!seen.has(childId)) seen.set(childId, resolveTaskWorkerLabel(part, fallbackLabel));
  }
  return Array.from(seen.entries()).map(([sessionId, label]) => ({ sessionId, label }));
}

function taskDescription(part: MessagePart) {
  if (part.type !== 'tool' || part.tool !== 'task') return '';
  const input = part.state.input;
  if (!input || typeof input !== 'object') return '';
  const description = (input as Record<string, unknown>).description;
  return typeof description === 'string' ? description.trim().toLocaleLowerCase() : '';
}

export function resolveChildOwners(
  threads: ThreadParts[],
  currentSessionId: string,
  metaById: Record<string, SessionHistoryMeta>,
) {
  const exactIds = new Set<string>();
  const ownersByDescription = new Map<string, Set<string>>();
  threads.forEach(({ rootId, parts }) => {
    parts.forEach((part) => {
      if (part.type !== 'tool' || part.tool !== 'task') return;
      const rawChildId = 'metadata' in part.state ? part.state.metadata?.sessionId : undefined;
      if (typeof rawChildId === 'string' && rawChildId.trim()) {
        exactIds.add(rawChildId.trim());
      }
      const description = taskDescription(part);
      if (!description) return;
      const owners = ownersByDescription.get(description) ?? new Set<string>();
      owners.add(rootId);
      ownersByDescription.set(description, owners);
    });
  });

  const byRoot: Record<string, string[]> = {};
  const assignedIds = new Set<string>();
  Object.entries(metaById).forEach(([sessionId, meta]) => {
    if (
      meta.parentID !== currentSessionId
      || exactIds.has(sessionId)
      || isMagicContextWorkerName(meta.label)
    ) return;
    const owners = ownersByDescription.get(meta.label.trim().toLocaleLowerCase());
    if (owners?.size !== 1) return;
    const ownerRootId = [...owners][0];
    (byRoot[ownerRootId] ??= []).push(sessionId);
    assignedIds.add(sessionId);
  });
  const latestRootId = threads.at(-1)?.rootId;
  if (latestRootId) {
    Object.entries(metaById).forEach(([sessionId, meta]) => {
      if (
        meta.parentID !== currentSessionId ||
        exactIds.has(sessionId) ||
        assignedIds.has(sessionId) ||
        isMagicContextWorkerName(meta.label)
      ) {
        return;
      }
      (byRoot[latestRootId] ??= []).push(sessionId);
    });
  }
  return byRoot;
}
