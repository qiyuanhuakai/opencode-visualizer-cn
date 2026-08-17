import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAuthorization, setBaseUrl, listProjects } from '../utils/opencode';
import { createOpenCodeAdapter, createOpenCodeWorkerAdapter } from './openCodeAdapter';

afterEach(() => {
  setAuthorization(undefined);
  setBaseUrl('');
  vi.unstubAllGlobals();
});

describe.each([
  ['main-thread', createOpenCodeAdapter],
  ['SharedWorker', createOpenCodeWorkerAdapter],
] as const)('%s OpenCode adapter authorization', (_name, createAdapter) => {
  it.each([
    ['the same host', 'https://authenticated.example'],
    ['a different host', 'https://anonymous.example'],
  ])('clears stale authorization before an unauthenticated request to %s', async (_case, nextBaseUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createAdapter();

    adapter.configure?.({
      baseUrl: 'https://authenticated.example',
      authorization: 'Bearer TOP-SECRET',
    });
    adapter.configure?.({ baseUrl: nextBaseUrl, authorization: undefined });
    await listProjects();

    const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(new Headers(request?.headers).has('Authorization')).toBe(false);
  });
});
