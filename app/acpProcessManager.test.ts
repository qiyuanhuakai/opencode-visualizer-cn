import { EventEmitter, once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createAcpProcessManager } from '../bridge/acpProcessManager.js';

class TestClient extends EventEmitter {
  sent: string[] = [];
  closed = false;
  failNextSend = false;

  send(message: string) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('simulated client send failure');
    }
    this.sent.push(message);
    this.emit('sent');
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

const echoAgentScript = [
  "const readline = require('node:readline');",
  'const input = readline.createInterface({ input: process.stdin });',
  "input.on('line', (line) => {",
  '  const message = JSON.parse(line);',
  "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }) + '\\n');",
  '});',
].join('\n');

const resistantAgentScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";

const reverseRequestAgentScript = [
  "const readline = require('node:readline');",
  'const input = readline.createInterface({ input: process.stdin });',
  'let initializeId;',
  "input.on('line', (line) => {",
  '  const message = JSON.parse(line);',
  "  if (message.method === 'initialize') {",
  '    initializeId = message.id;',
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'fs/read_text_file', params: { sessionId: 'session-1', path: '/workspace/a.txt' } }) + '\\n');",
  '    return;',
  '  }',
  '  if (message.id === 99) {',
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: initializeId, result: { protocolVersion: 1, content: message.result.content } }) + '\\n');",
  '  }',
  '});',
].join('\n');

const earlyExitAgentScript = [
  "process.stderr.write('ACP init failed');",
  'setTimeout(() => process.exit(23), 50);',
].join('\n');

describe('acpProcessManager', () => {
  it('starts enabled agents once and relays newline-delimited JSON-RPC bidirectionally', async () => {
    const manager = createAcpProcessManager();
    await manager.reconcile([
      {
        id: 'echo',
        name: 'Echo ACP',
        command: process.execPath,
        args: ['-e', echoAgentScript],
        enabled: true,
      },
    ]);
    const client = new TestClient();
    manager.attach('echo', client);

    client.emit(
      'message',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    await once(client, 'sent');

    expect(JSON.parse(client.sent[0])).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: 1 },
    });
    client.emit('close');
    expect(manager.getStatus()).toEqual([
      expect.objectContaining({ id: 'echo', state: 'running', connected: false, owned: true }),
    ]);
    await manager.stopAll();
  });

  it('handles ACP filesystem and terminal reverse requests inside the bridge', async () => {
    const handleClientRequest = vi.fn(async (request: { method: string }) => {
      expect(request.method).toBe('fs/read_text_file');
      return { content: 'bridge-owned content' };
    });
    const manager = createAcpProcessManager({ handleClientRequest });
    await manager.reconcile([
      {
        id: 'reverse',
        name: 'Reverse ACP',
        command: process.execPath,
        args: ['-e', reverseRequestAgentScript],
        enabled: true,
      },
    ]);
    const client = new TestClient();
    manager.attach('reverse', client);

    client.emit(
      'message',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    await once(client, 'sent');

    expect(handleClientRequest).toHaveBeenCalledWith(
      {
        jsonrpc: '2.0',
        id: 99,
        method: 'fs/read_text_file',
        params: { sessionId: 'session-1', path: '/workspace/a.txt' },
      },
      { agentId: 'reverse' },
    );
    expect(client.sent).toEqual([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: 1, content: 'bridge-owned content' },
      }),
    ]);
    await manager.stopAll();
  });

  it('reports an enabled missing executable without throwing', async () => {
    const manager = createAcpProcessManager();

    await manager.reconcile([
      {
        id: 'missing',
        name: 'Missing ACP',
        command: 'vis-definitely-missing-acp',
        args: [],
        enabled: true,
      },
    ]);

    expect(manager.getStatus()).toEqual([
      expect.objectContaining({
        id: 'missing',
        state: 'error',
        owned: false,
        error: expect.stringContaining('ENOENT'),
      }),
    ]);
    await manager.stopAll();
  });

  it('reports an ACP process that exits during its startup window', async () => {
    const manager = createAcpProcessManager();

    await manager.reconcile([
      {
        id: 'early-exit',
        name: 'Early Exit ACP',
        command: process.execPath,
        args: ['-e', earlyExitAgentScript],
        enabled: true,
      },
    ]);

    expect(manager.getStatus()).toEqual([
      expect.objectContaining({
        id: 'early-exit',
        state: 'error',
        owned: false,
        error: expect.stringContaining('ACP init failed'),
      }),
    ]);
    await manager.stopAll();
  });

  it('stops a running agent when user settings disable it', async () => {
    const manager = createAcpProcessManager();
    const agent = {
      id: 'echo',
      name: 'Echo ACP',
      command: process.execPath,
      args: ['-e', echoAgentScript],
      enabled: true,
    };
    await manager.reconcile([agent]);
    const pid = manager.getStatus()[0]?.pid;
    expect(pid).toEqual(expect.any(Number));

    await manager.reconcile([{ ...agent, enabled: false }]);

    const [status] = manager.getStatus();
    expect(status).toEqual(
      expect.objectContaining({ id: 'echo', state: 'disabled', owned: false }),
    );
    expect(status?.pid).toBeUndefined();
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
    await manager.stopAll();
  });

  it('keeps ownership of a replacement after the old ACP process exits late', { timeout: 10_000 }, async () => {
    const manager = createAcpProcessManager();
    const original = {
      id: 'replacement',
      name: 'Replacement ACP',
      command: process.execPath,
      args: ['-e', resistantAgentScript],
      enabled: true,
    };
    await manager.reconcile([original]);
    const originalPid = manager.getStatus()[0]?.pid;

    await manager.reconcile([{ ...original, args: ['-e', echoAgentScript] }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replacementPid = manager.getStatus()[0]?.pid;

    expect(replacementPid).toEqual(expect.any(Number));
    expect(replacementPid).not.toBe(originalPid);
    expect(manager.getStatus()[0]).toEqual(
      expect.objectContaining({ state: 'running', owned: true }),
    );
    await manager.stopAll();
    expect(() => process.kill(replacementPid ?? 0, 0)).toThrow();
  });

  it('rejects a second simultaneous client for the same ACP process', async () => {
    const manager = createAcpProcessManager();
    await manager.reconcile([
      {
        id: 'echo',
        name: 'Echo ACP',
        command: process.execPath,
        args: ['-e', echoAgentScript],
        enabled: true,
      },
    ]);
    manager.attach('echo', new TestClient());

    expect(() => manager.attach('echo', new TestClient())).toThrow(
      'already has a connected client',
    );
    await manager.stopAll();
  });

  it('continues relaying stdout after one client send failure', async () => {
    const manager = createAcpProcessManager();
    await manager.reconcile([
      {
        id: 'echo',
        name: 'Echo ACP',
        command: process.execPath,
        args: ['-e', echoAgentScript],
        enabled: true,
      },
    ]);
    const client = new TestClient();
    client.failNextSend = true;
    manager.attach('echo', client);

    client.emit(
      'message',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    client.emit(
      'message',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
    );

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(JSON.parse(client.sent[0] ?? '{}')).toEqual(expect.objectContaining({ id: 2 }));
    expect(manager.getStatus()[0]?.droppedFrames).toBe(1);
    await manager.stopAll();
  });
});
