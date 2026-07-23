import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpAdapter } from './acpAdapter';
import { MockAcpWebSocket } from './acpTestHarness';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ACP workspace adapter', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it('uses the protected bridge FS surface for listing, reading, and writing', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ name: 'main.ts', path: 'src/main.ts', type: 'file' }]))
      .mockResolvedValueOnce(
        jsonResponse({ content: 'export {}', dataBase64: 'ZXhwb3J0IHt9', type: 'text' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: 'export {}', dataBase64: 'ZXhwb3J0IHt9', type: 'text' }),
      )
      .mockResolvedValueOnce(jsonResponse({ path: '/workspace/src/main.ts' }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createAcpAdapter({
      url: 'ws://bridge.test/acp/agent',
      bridgeUrl: 'ws://bridge.test',
      bridgeToken: 'secret',
      agentId: 'agent',
      webSocketCtor: MockAcpWebSocket,
    });

    expect(adapter.capabilities.files).toBe(true);
    await expect(adapter.listFiles?.({ directory: '/workspace', path: 'src' })).resolves.toEqual([
      { name: 'main.ts', path: 'src/main.ts', type: 'file' },
    ]);
    await expect(
      adapter.readFileContent?.({ directory: '/workspace', path: 'src/main.ts' }),
    ).resolves.toMatchObject({ content: 'export {}', type: 'text' });
    await expect(
      adapter.readFileContentBytes?.({ directory: '/workspace', path: 'src/main.ts' }),
    ).resolves.toEqual(new TextEncoder().encode('export {}'));
    await adapter.writeFileContent?.({
      directory: '/workspace',
      path: 'src/main.ts',
      content: 'export const value = 1;',
    });

    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get('Authorization')).toBe('Bearer secret');
    }
    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(listUrl.pathname).toBe('/fs/list');
    expect(listUrl.searchParams.get('root')).toBe('/workspace');
    expect(listUrl.searchParams.get('path')).toBe('src');
    const readUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(readUrl.pathname).toBe('/fs/readFile');
    expect(readUrl.searchParams.get('path')).toBe('/workspace/src/main.ts');
  });

  it('maps bridge PTYs, one-shot commands, and VCS metadata into BackendAdapter', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/pty' && init?.method === 'POST') return jsonResponse({ id: 'pty-1' });
      if (url.pathname === '/pty') return jsonResponse([{ id: 'pty-1', status: 'running' }]);
      if (url.pathname === '/pty/pty-1') return jsonResponse({});
      if (url.pathname === '/command/exec') {
        const payload = JSON.parse(String(init?.body)) as { args: string[] };
        const command = payload.args.join(' ');
        if (command.includes('--show-toplevel')) {
          return jsonResponse({ stdout: '/workspace\n', stderr: '', exitCode: 0 });
        }
        if (command.includes('--git-common-dir')) {
          return jsonResponse({ stdout: '.git\n', stderr: '', exitCode: 0 });
        }
        if (command.includes('--show-current')) {
          return jsonResponse({ stdout: 'main\n', stderr: '', exitCode: 0 });
        }
        if (command.includes('--short HEAD')) {
          return jsonResponse({ stdout: 'abc123\n', stderr: '', exitCode: 0 });
        }
        return jsonResponse({ stdout: 'ok\n', stderr: '', exitCode: 0 });
      }
      return jsonResponse({ error: 'unexpected request' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createAcpAdapter({
      url: 'ws://bridge.test/acp/agent',
      bridgeUrl: 'ws://bridge.test',
      bridgeToken: 'secret',
      agentId: 'agent',
      webSocketCtor: MockAcpWebSocket,
    });

    expect(adapter.capabilities.terminal).toBe(true);
    await expect(adapter.createPty?.({ directory: '/workspace' })).resolves.toEqual({
      id: 'pty-1',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      cwd: '/workspace',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      cwd: '/workspace',
    });
    await expect(adapter.listPtys?.()).resolves.toEqual([{ id: 'pty-1', status: 'running' }]);
    await adapter.updatePtySize?.('pty-1', { rows: 40, cols: 120 });
    await adapter.deletePty?.('pty-1');
    expect(adapter.createPtyWebSocketUrl?.('/pty/pty-1/connect')).toBe(
      'ws://bridge.test/pty/pty-1/connect?token=secret',
    );
    await expect(
      adapter.runOneShotCommand?.({
        directory: '/workspace',
        command: 'node',
        args: ['--version'],
      }),
    ).resolves.toBe('ok\n');
    await expect(adapter.getVcsInfo?.('/workspace')).resolves.toEqual({
      root: '/workspace',
      branch: 'main',
      commonRoot: '/workspace',
      sha: 'abc123',
    });
  });

});
