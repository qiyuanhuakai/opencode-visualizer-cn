import { describe, expect, it, vi } from 'vitest';
import { createKimiWebClient } from './kimiWeb';

describe('Kimi child sessions and same-session tasks', () => {
  it('loads both idle and busy child sessions using the required filter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const busy = new URL(String(input)).searchParams.get('busy');
      if (busy === null) return Response.json({ code: 40001, msg: 'busy is required' });
      return Response.json({ code: 0, data: { items: [{ id: busy === 'true' ? 'busy-child' : 'idle-child' }], has_more: false } });
    });
    const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher });
    await expect(client.listChildSessions('parent')).resolves.toEqual([{ id: 'idle-child' }, { id: 'busy-child' }]);
  });

  it('rejects a repeated child pagination cursor instead of looping forever', async () => {
    const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher: async () => Response.json({ code: 0, data: { items: [{ id: 'same' }], has_more: true } }) });
    await expect(client.listChildSessions('parent')).rejects.toThrow('pagination did not advance');
  });

  it('keeps child sessions separate from tasks and encodes task cancellation scope', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      return Response.json({ code: 0, data: path.endsWith(':cancel') ? { cancelled: true } : { items: [], has_more: false } });
    });
    const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher });
    await expect(client.listChildSessions('parent/id')).resolves.toEqual([]);
    await expect(client.listSessionTasks('parent/id')).resolves.toEqual({ items: [], has_more: false });
    await client.cancelSessionTask('parent/id', 'agent/task');
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/api/v1/sessions/parent%2Fid/children', '/api/v1/sessions/parent%2Fid/children', '/api/v1/sessions/parent%2Fid/tasks', '/api/v1/sessions/parent%2Fid/tasks/agent%2Ftask:cancel']);
    expect(fetcher.mock.calls.slice(0, 2).map(([input]) => new URL(String(input)).searchParams.get('busy'))).toEqual(['false', 'true']);
  });
});
