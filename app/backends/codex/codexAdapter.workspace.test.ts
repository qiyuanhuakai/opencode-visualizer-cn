import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';
import {
  closeCodexTestSockets,
  CodexTestSocket as MockWebSocket,
  waitForSent,
} from './codexTestSocket';

describe('CodexAdapter', () => {
  afterEach(closeCodexTestSockets);

  it('exposes BackendAdapter wrapper methods', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const createSession = adapter.createSession('/repo');
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_new', preview: '', cwd: '/repo' } });
    await expect(createSession).resolves.toMatchObject({
      id: 'thr_new',
      projectID: 'codex',
      directory: '/repo',
      status: 'unknown',
    });
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/start',
      params: { cwd: '/repo' },
    });

    const forkSession = adapter.forkSession('thr_1', 'msg_1', '/repo');
    await waitForSent(socket, 4);
    socket.respond(3, { thread: { id: 'thr_fork', preview: '', cwd: '/repo' } });
    await expect(forkSession).resolves.toMatchObject({
      id: 'thr_fork',
      projectID: 'codex',
      directory: '/repo',
      status: 'unknown',
    });

    const revertSession = adapter.revertSession('thr_1', 'msg_1');
    await waitForSent(socket, 5);
    socket.respond(4, { thread: { id: 'thr_1', cwd: '/repo' } });
    await expect(revertSession).resolves.toMatchObject({
      id: 'thr_1',
      projectID: 'codex',
      directory: '/repo',
      status: 'unknown',
    });
    expect(JSON.parse(socket.sent[4] ?? '{}')).toEqual({
      id: 4,
      method: 'thread/rollback',
      params: { threadId: 'thr_1', numTurns: 1 },
    });

    const deleteSession = adapter.deleteSession('thr_1');
    await waitForSent(socket, 6);
    expect(JSON.parse(socket.sent[5] ?? '{}')).toEqual({
      id: 5,
      method: 'thread/archive',
      params: { threadId: 'thr_1' },
    });
    socket.respond(5, {});
    await expect(deleteSession).resolves.toBeUndefined();

    const listFiles = adapter.listFiles;
    await expect(listFiles({ directory: '/repo', path: '../secret' })).rejects.toThrow(
      'Codex file paths cannot contain parent-directory segments.',
    );
    await expect(
      adapter.readFileContent({ directory: '/repo', path: '/etc/passwd' }),
    ).rejects.toThrow('Codex file path is outside the active directory.');
    const readFileContent = adapter.readFileContent({ directory: '/repo', path: 'README.md' });
    await waitForSent(socket, 7);
    socket.respond(6, { dataBase64: 'aGVsbG8=' });
    await expect(readFileContent).resolves.toEqual({
      content: 'hello',
      encoding: 'utf-8',
      type: 'text',
    });

    const readPlainContent = adapter.readFileContent({ directory: '/repo', path: 'plain.txt' });
    await waitForSent(socket, 8);
    socket.respond(7, { content: 'plain text' });
    await expect(readPlainContent).resolves.toEqual({
      content: 'plain text',
      encoding: 'utf-8',
      type: 'text',
    });
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await expect(
        adapter.writeFileContent({ directory: '/repo', path: 'README.md', content: 'updated' }),
      ).resolves.toEqual({});
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toEqual([
      {
        input: 'http://localhost:4500/fs/writeFile',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/repo/README.md', root: '/repo', content: 'updated' }),
        },
      },
    ]);
    const getLspStatus = adapter.getLspStatus;
    await expect(getLspStatus()).resolves.toEqual([]);
  });

  it('allows listFiles under root "/" for subdirectory paths', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const result = adapter.listFiles({ directory: '/', path: 'subdir' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { entries: [{ fileName: 'index.ts', isDirectory: false }] });
    await waitForSent(socket, 4);
    expect(JSON.parse(socket.sent[3] ?? '{}')).toMatchObject({
      method: 'command/exec',
      params: {
        command: ['git', '-c', 'core.quotePath=false', 'check-ignore', '--', 'index.ts'],
        cwd: '/subdir',
      },
    });
    socket.respond(3, { exitCode: 1, stdout: '', stderr: '' });

    await expect(result).resolves.toEqual([
      { name: 'index.ts', path: 'subdir/index.ts', type: 'file' },
    ]);
  });

  describe('CodexAdapter extended APIs', () => {
    it('executes a standalone command', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const command = adapter.commandExec({
        command: ['ls', '-la'],
        cwd: '/tmp',
      });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {
        exitCode: 0,
        stdout: 'file1\nfile2',
        stderr: '',
      });

      await expect(command).resolves.toEqual({
        exitCode: 0,
        stdout: 'file1\nfile2',
        stderr: '',
      });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'command/exec',
        params: { command: ['ls', '-la'], cwd: '/tmp' },
      });
    });
  });
});
