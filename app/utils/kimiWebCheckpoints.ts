import type { KimiWebPage } from './kimiWeb';

type CheckpointRequest = <T>(spec: {
  method: 'GET' | 'POST'; path: string;
  query?: Record<string, string | number | undefined>; body?: unknown;
}) => Promise<T>;
export type KimiWebTranscriptTurn = {
  kind: string; ordinal: number; triggerPromptId?: string; turnId: string;
};
export type KimiWebFileChange = {
  path: string; status: 'added' | 'modified' | 'deleted'; binary?: boolean; oversize?: boolean;
};
export function createKimiWebCheckpointClient(request: CheckpointRequest) {
  const path = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`;
  return {
    undoSession: (id: string, count: number) => request<unknown>({ method: 'POST', path: `${path(id)}:undo`, body: { count } }),
    getTranscript: (id: string, beforeTurn?: string) => request<KimiWebPage<KimiWebTranscriptTurn>>({ method: 'GET', path: `${path(id)}/transcript`, query: { agent_id: 'main', page_size: 100, before_turn: beforeTurn } }),
    getTurnFileChanges: (id: string, turnId: number) => request<{ recorded: boolean; changes: KimiWebFileChange[] }>({ method: 'GET', path: `${path(id)}/file-history/changes`, query: { turn_id: turnId } }),
    getTurnFileContent: (id: string, turnId: number, file: string, phase: 'start' | 'end') => request<{ content: { content?: string; binary?: boolean } | null }>({ method: 'GET', path: `${path(id)}/file-history/content`, query: { turn_id: turnId, path: file, phase } }),
  };
}
