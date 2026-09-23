import type { KimiWebPage, KimiWebSession, KimiWebSubagent } from './kimiWeb';

type AgentRequest = <T>(spec: {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
}) => Promise<T>;

export function createKimiWebAgentClient(request: AgentRequest) {
  const path = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`;
  return {
    async listChildSessions(sessionId: string): Promise<KimiWebSession[]> {
      const items: KimiWebSession[] = [];
      const cursors = new Set<string>();
      let beforeId: string | undefined;
      do {
        const page = await request<KimiWebPage<KimiWebSession>>({ method: 'GET', path: `${path(sessionId)}/children`, query: { page_size: 100, before_id: beforeId } });
        items.push(...page.items);
        if (!page.has_more) return items;
        beforeId = page.items.at(-1)?.id;
        if (!beforeId || cursors.has(beforeId)) throw new Error('Kimi Web child-session pagination did not advance.');
        cursors.add(beforeId);
      } while (beforeId !== undefined);
      return items;
    },
    createChildSession: (sessionId: string, title: string) => request<KimiWebSession>({ method: 'POST', path: `${path(sessionId)}/children`, body: { title } }),
    listSessionTasks: (sessionId: string) => request<{ items: KimiWebSubagent[] }>({ method: 'GET', path: `${path(sessionId)}/tasks` }),
    cancelSessionTask: (sessionId: string, taskId: string) => request<{ cancelled: true }>({ method: 'POST', path: `${path(sessionId)}/tasks/${encodeURIComponent(taskId)}:cancel`, body: {} }),
  };
}
