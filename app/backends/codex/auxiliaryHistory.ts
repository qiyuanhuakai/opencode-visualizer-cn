import type { MessageInfo, ReasoningPart, ToolPart } from '../../types/sse';
import { StorageKeys, storageGetJSON, storageRemove, storageSetJSON } from '../../utils/storageKeys';
import type { CodexCanonicalHistoryEntry } from './normalize';

type AuxiliaryPart = ReasoningPart | ToolPart;

type AuxiliaryHistorySnapshot = {
  version: 1;
  threadId: string;
  entries: CodexCanonicalHistoryEntry[];
};

const TOOL_STATUSES = new Set(['pending', 'running', 'completed', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageInfo(value: unknown, threadId: string): value is MessageInfo {
  if (!isRecord(value) || !isRecord(value.time)) return false;
  return value.role === 'assistant'
    && value.sessionID === threadId
    && typeof value.id === 'string'
    && typeof value.time.created === 'number';
}

function isAuxiliaryPart(value: unknown, threadId: string): value is AuxiliaryPart {
  if (!isRecord(value)
    || value.sessionID !== threadId
    || typeof value.id !== 'string'
    || typeof value.messageID !== 'string') {
    return false;
  }
  if (value.type === 'reasoning') {
    return typeof value.text === 'string' && isRecord(value.time) && typeof value.time.start === 'number';
  }
  if (value.type !== 'tool'
    || typeof value.callID !== 'string'
    || typeof value.tool !== 'string'
    || !isRecord(value.state)
    || typeof value.state.status !== 'string'
    || !TOOL_STATUSES.has(value.state.status)) {
    return false;
  }
  return isRecord(value.state.input);
}

function snapshotKey(threadId: string) {
  return `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent(threadId)}`;
}

function isTerminalTool(part: AuxiliaryPart) {
  return part.type === 'tool' && (part.state.status === 'completed' || part.state.status === 'error');
}

function mergePart(existing: AuxiliaryPart | undefined, incoming: AuxiliaryPart) {
  if (existing && isTerminalTool(existing) && incoming.type === 'tool' && !isTerminalTool(incoming)) {
    return existing;
  }
  return incoming;
}

export function mergeCodexAuxiliaryHistory(
  threadId: string,
  ...sources: ReadonlyArray<ReadonlyArray<CodexCanonicalHistoryEntry>>
) {
  const entries = new Map<string, { info: MessageInfo; parts: Map<string, AuxiliaryPart> }>();
  for (const source of sources) {
    for (const entry of source) {
      if (entry.info.sessionID !== threadId || entry.info.role !== 'assistant') continue;
      const parts = entry.parts.filter((part): part is AuxiliaryPart =>
        (part.type === 'reasoning' || part.type === 'tool') && part.sessionID === threadId,
      );
      if (parts.length === 0) continue;
      const current = entries.get(entry.info.id) ?? { info: entry.info, parts: new Map<string, AuxiliaryPart>() };
      current.info = entry.info;
      for (const part of parts) {
        current.parts.set(part.id, mergePart(current.parts.get(part.id), part));
      }
      entries.set(entry.info.id, current);
    }
  }
  return [...entries.values()].map(({ info, parts }) => ({ info, parts: [...parts.values()] }));
}

export function loadCodexAuxiliaryHistory(threadId: string) {
  const snapshot = storageGetJSON<unknown>(snapshotKey(threadId));
  if (!isRecord(snapshot)
    || snapshot.version !== 1
    || snapshot.threadId !== threadId
    || !Array.isArray(snapshot.entries)) {
    return [];
  }
  const entries: CodexCanonicalHistoryEntry[] = [];
  for (const value of snapshot.entries) {
    if (!isRecord(value) || !isMessageInfo(value.info, threadId) || !Array.isArray(value.parts)) continue;
    const parts = value.parts.filter((part): part is AuxiliaryPart => isAuxiliaryPart(part, threadId));
    if (parts.length > 0) entries.push({ info: value.info, parts });
  }
  return mergeCodexAuxiliaryHistory(threadId, entries);
}

export function saveCodexAuxiliaryHistory(threadId: string, entries: ReadonlyArray<CodexCanonicalHistoryEntry>) {
  const auxiliaryEntries = mergeCodexAuxiliaryHistory(threadId, entries);
  if (auxiliaryEntries.length === 0) return;
  const snapshot: AuxiliaryHistorySnapshot = { version: 1, threadId, entries: auxiliaryEntries };
  storageSetJSON(snapshotKey(threadId), snapshot);
}

export function clearCodexAuxiliaryHistory(threadId: string) {
  storageRemove(snapshotKey(threadId));
}
